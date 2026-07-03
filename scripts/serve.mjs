#!/usr/bin/env node
// Production entry for the Replit deploy (`pnpm start`). A thin Node front-controller that:
//   1. runs the proven SSR app (vite preview / workerd-miniflare) on a private internal port, and
//   2. exposes a token-protected POST /__ingest so ONLY this operator's machine (holding DATA_PUSH_TOKEN)
//      can publish a fresh corpus to the live site — daily, with no redeploy.
//
// Ingest streams the gzipped SQLite to the persistent disk, VALIDATES it is a real, non-empty corpus
// (never serve fabricated/empty data), atomically swaps it into the miniflare D1 path, and restarts the
// SSR child so it reopens the new database. Everything else is reverse-proxied to the SSR child.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 5180);
const TOKEN = process.env.DATA_PUSH_TOKEN || '';
const D1_DIR = join(root, 'apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
// Deterministic miniflare D1 filename for the committed zero-UUID database_id. Used as the write target
// when no file exists yet; otherwise we sync the file already on disk.
const FALLBACK_DB = '9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite';

function mainDbPath() {
  const existing = existsSync(D1_DIR)
    ? readdirSync(D1_DIR).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    : null;
  return join(D1_DIR, existing || FALLBACK_DB);
}

// ── Persistence across redeploys ──────────────────────────────────────────────────────────────────
// A Replit redeploy rebuilds the app into a FRESH filesystem, wiping the on-disk D1. So the corpus is
// kept in Replit Object Storage (survives any redeploy/restart) and the on-disk D1 is just a cache:
// restored on boot if the local DB is empty, re-uploaded on every publish. Falls back gracefully when
// Object Storage is unavailable (e.g. local dev) — then we apply the empty schema and carry on.
const OBJECT_NAME = 'sigma-corpus.sqlite';
let objectClient; // undefined = not tried yet; null = unavailable

async function objectStorage() {
  if (objectClient !== undefined) return objectClient;
  try {
    const { Client } = await import('@replit/object-storage');
    objectClient = new Client();
  } catch (err) {
    console.warn(`[serve] Object Storage unavailable (${err.message}); persistence disabled`);
    objectClient = null;
  }
  return objectClient;
}

function hasData(path) {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    const n = db.prepare('SELECT count(*) AS c FROM contracts').get().c;
    db.close();
    return n > 0;
  } catch {
    return false;
  }
}

async function backupToObjectStorage(path) {
  const client = await objectStorage();
  if (!client) return;
  try {
    console.log('[serve] backing up corpus to Object Storage…');
    const res = await client.uploadFromFilename(OBJECT_NAME, path);
    console.log(
      res?.ok ? '[serve] backup ok' : `[serve] backup failed: ${res?.error?.message ?? 'unknown'}`,
    );
  } catch (err) {
    console.error(`[serve] backup error: ${err.message}`);
  }
}

// Apply the empty schema (real data only — never fabricated) so the app can serve honest empty pages
// IMMEDIATELY and pass the deploy health check, even before any corpus is restored.
function applySchemaIfEmpty(path) {
  try {
    mkdirSync(D1_DIR, { recursive: true });
    const db = new Database(path);
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contracts'")
      .get();
    if (!has) {
      db.exec(readFileSync(join(root, 'packages/db/migrations/0000_init.sql'), 'utf8'));
      console.log('[serve] applied empty schema — awaiting corpus');
    }
    db.close();
  } catch (err) {
    console.error(`[serve] schema ensure failed (continuing): ${err.message}`);
  }
}

// After the app is already serving (so the health check has passed), restore the corpus from Object
// Storage in the background and hot-swap it in. No-op if the disk already has real data or the bucket is
// empty — so a redeploy self-heals: serve empty, then the real data swaps in ~moments later.
async function restoreInBackground() {
  const path = mainDbPath();
  if (hasData(path)) return;
  const client = await objectStorage();
  if (!client) return;
  try {
    const ex = await client.exists(OBJECT_NAME);
    if (!(ex?.ok && ex.value)) {
      console.log('[serve] no corpus in Object Storage yet — awaiting first publish');
      return;
    }
    console.log('[serve] restoring corpus from Object Storage (background)…');
    const tmp = `${path}.restore`;
    const res = await client.downloadToFilename(OBJECT_NAME, tmp);
    if (!res?.ok || !hasData(tmp)) {
      rmSync(tmp, { force: true });
      console.error('[serve] restore failed or invalid corpus');
      return;
    }
    restarting = true;
    await stopChild();
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${path}${suffix}`, { force: true });
    renameSync(tmp, path);
    restarting = false;
    startChild();
    await waitReady();
    console.log('[serve] corpus restored from Object Storage');
  } catch (err) {
    console.error(`[serve] background restore error: ${err.message}`);
  }
}

// ── SSR child (vite preview, internal) ────────────────────────────────────────────────────────────
let child = null;
let restarting = false;

// The Replit vite/wrangler config (no `ai`/`vectorize` bindings): those are remote-only — with them
// in scope `vite preview` tries to open a remote wrangler session, which needs a Cloudflare login the
// Repl doesn't have, and the SSR child crash-loops. The assistant route degrades to 503 without them.
const REPLIT_VITE_CONFIG = 'vite.config.replit.mts';

// Guard against a build made with the default (Cloudflare) config — e.g. a stale image or a plain
// `pnpm build`: its build/server/wrangler.json still carries the remote-only bindings, so rebuild
// once with the Replit config before serving.
function ensureReplitBuild() {
  const builtCfg = join(root, 'apps/web/build/server/wrangler.json');
  let needs = true;
  try {
    const cfg = readFileSync(builtCfg, 'utf8');
    // Non-empty vectorize list or an ai binding object ⇒ built with the Cloudflare config.
    needs = /"vectorize":\s*\[\s*\{/.test(cfg) || /"ai":\s*\{/.test(cfg);
  } catch {
    needs = true; // no build at all
  }
  if (!needs) return;
  console.log(
    '[serve] build was made with remote-only bindings (or missing) — rebuilding with the Replit config…',
  );
  const res = spawnSync('pnpm', ['--filter', '@sigma/web', 'run', 'build:replit'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0)
    console.error('[serve] replit rebuild failed; starting anyway with the existing build');
}

function startChild() {
  child = spawn(
    'pnpm',
    [
      '--filter',
      '@sigma/web',
      'exec',
      'vite',
      'preview',
      '--config',
      REPLIT_VITE_CONFIG,
      '--host',
      '127.0.0.1',
      '--port',
      String(INTERNAL_PORT),
    ],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  child.on('exit', (code) => {
    child = null;
    if (!restarting) {
      console.error(`[serve] SSR child exited (${code}); restarting in 1s`);
      setTimeout(startChild, 1000);
    }
  });
}

function stopChild() {
  return new Promise((res) => {
    if (!child) return res();
    const c = child;
    c.once('exit', () => res());
    c.kill('SIGTERM');
    setTimeout(() => c.kill('SIGKILL'), 5000);
  });
}

async function waitReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const r = http.request(
        { host: '127.0.0.1', port: INTERNAL_PORT, path: '/', method: 'HEAD', timeout: 2000 },
        (resp) => {
          resp.resume();
          res(true);
        },
      );
      r.on('error', () => res(false));
      r.on('timeout', () => {
        r.destroy();
        res(false);
      });
      r.end();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── token check (constant-time, length-safe via fixed-size hashes) ────────────────────────────────
function authorized(req) {
  if (!TOKEN) return false;
  const got = createHash('sha256')
    .update(req.headers['authorization'] || '')
    .digest();
  const want = createHash('sha256').update(`Bearer ${TOKEN}`).digest();
  return timingSafeEqual(got, want);
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ── POST /__ingest/{begin,chunk,commit} — publish a fresh corpus (operator-only) ──────────────────
// Chunked because Replit's edge proxy rejects large request bodies (413). The corpus is uploaded in
// small gzipped pieces appended to a temp file, then committed: validated as a real non-empty corpus,
// atomically swapped onto disk, and the SSR child restarted to reopen it.
async function handleIngest(req, res, path) {
  if (!TOKEN) return json(res, 503, { error: 'publishing disabled: DATA_PUSH_TOKEN not set' });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

  const dbPath = mainDbPath();
  const incoming = `${dbPath}.incoming`;

  if (path === '/__ingest/begin') {
    mkdirSync(dirname(incoming), { recursive: true });
    writeFileSync(incoming, Buffer.alloc(0)); // truncate any partial upload
    return json(res, 200, { ok: true });
  }

  if (path === '/__ingest/chunk') {
    try {
      let buf = await readBody(req);
      if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
      appendFileSync(incoming, buf);
    } catch (err) {
      return json(res, 400, { error: `chunk failed: ${err.message}` });
    }
    return json(res, 200, { ok: true, size: existsSync(incoming) ? statSync(incoming).size : 0 });
  }

  if (path === '/__ingest/commit') {
    if (!existsSync(incoming)) return json(res, 400, { error: 'no upload in progress' });
    // Validate it is a real, non-empty corpus before swapping it in. Reject anything else.
    let contracts = 0;
    let authorities = 0;
    try {
      const db = new Database(incoming, { readonly: true, fileMustExist: true });
      contracts = db.prepare('SELECT count(*) AS c FROM contracts').get().c;
      authorities = db.prepare('SELECT count(*) AS c FROM authorities').get().c;
      db.close();
    } catch (err) {
      rmSync(incoming, { force: true });
      return json(res, 422, { error: `not a valid corpus: ${err.message}` });
    }
    if (!(contracts > 0 && authorities > 0)) {
      rmSync(incoming, { force: true });
      return json(res, 422, { error: 'refused: corpus is empty', contracts, authorities });
    }

    // Atomic-ish swap: stop the SSR child so it releases the file, replace it (+ drop stale wal/shm),
    // restart, and wait until it serves again.
    restarting = true;
    await stopChild();
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${dbPath}${suffix}`, { force: true });
    renameSync(incoming, dbPath);
    restarting = false;
    startChild();
    const ready = await waitReady();
    // Persist the new corpus so it survives the next redeploy (the live site is already serving it).
    await backupToObjectStorage(dbPath);

    console.log(`[serve] published corpus: ${contracts} contracts, ${authorities} authorities`);
    return json(res, ready ? 200 : 502, { ok: ready, contracts, authorities });
  }

  return json(res, 400, { error: 'unknown phase; use /__ingest/{begin,chunk,commit}' });
}

// ── reverse proxy everything else to the SSR child ────────────────────────────────────────────────
function proxy(req, res) {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: INTERNAL_PORT,
      method: req.method,
      path: req.url,
      // Replit terminates TLS; tell the app the client scheme so it never self-redirects.
      headers: { ...req.headers, 'x-forwarded-proto': 'https' },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Upstream not ready');
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'POST' && path.startsWith('/__ingest'))
    return void handleIngest(req, res, path);
  return void proxy(req, res);
});
// 1.7 GB uploads take a while; don't let Node time them out.
server.requestTimeout = 0;
server.headersTimeout = 0;

applySchemaIfEmpty(mainDbPath());
ensureReplitBuild();
startChild();
await waitReady();
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[serve] front-controller on :${PORT} -> SSR :${INTERNAL_PORT}; ingest ${TOKEN ? 'enabled' : 'DISABLED (no token)'}`,
  );
  // Now that we're serving (health check can pass), restore the corpus from Object Storage if needed.
  void restoreInBackground();
});
