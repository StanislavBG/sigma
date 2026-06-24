#!/usr/bin/env node
// Production entry for the Replit deploy (`pnpm start`). A thin Node front-controller that:
//   1. runs the proven SSR app (vite preview / workerd-miniflare) on a private internal port, and
//   2. exposes a token-protected POST /__ingest so ONLY this operator's machine (holding DATA_PUSH_TOKEN)
//      can publish a fresh corpus to the live site — daily, with no redeploy.
//
// Ingest streams the gzipped SQLite to the persistent disk, VALIDATES it is a real, non-empty corpus
// (never serve fabricated/empty data), atomically swaps it into the miniflare D1 path, and restarts the
// SSR child so it reopens the new database. Everything else is reverse-proxied to the SSR child.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
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

// Before the first data publish there is no corpus, so the SSR loaders would 500 (no tables) and the
// deploy health check would never pass. Apply the SCHEMA only (no data — real data only) so the app
// serves honest EMPTY pages until a real corpus is ingested. Idempotent: skipped once `contracts` exists.
function ensureSchema() {
  try {
    mkdirSync(D1_DIR, { recursive: true });
    const db = new Database(mainDbPath());
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contracts'")
      .get();
    if (!has) {
      db.exec(readFileSync(join(root, 'packages/db/migrations/0000_init.sql'), 'utf8'));
      console.log('[serve] applied empty schema — awaiting first data publish');
    }
    db.close();
  } catch (err) {
    console.error(`[serve] schema ensure failed (continuing): ${err.message}`);
  }
}

// ── SSR child (vite preview, internal) ────────────────────────────────────────────────────────────
let child = null;
let restarting = false;

function startChild() {
  child = spawn(
    'pnpm',
    [
      '--filter',
      '@sigma/web',
      'exec',
      'vite',
      'preview',
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

// ── POST /__ingest — publish a fresh corpus (operator-only) ───────────────────────────────────────
async function handleIngest(req, res) {
  if (!TOKEN) return json(res, 503, { error: 'publishing disabled: DATA_PUSH_TOKEN not set' });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

  const dbPath = mainDbPath();
  const incoming = `${dbPath}.incoming`;
  try {
    // Body is the gzipped SQLite (streamed straight to disk — never buffered in memory).
    await pipeline(req, createGunzip(), createWriteStream(incoming));
  } catch (err) {
    rmSync(incoming, { force: true });
    return json(res, 400, { error: `upload failed: ${err.message}` });
  }

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

  console.log(`[serve] published corpus: ${contracts} contracts, ${authorities} authorities`);
  return json(res, ready ? 200 : 502, { ok: ready, contracts, authorities });
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
  if (req.method === 'POST' && path === '/__ingest') return void handleIngest(req, res);
  return void proxy(req, res);
});
// 1.7 GB uploads take a while; don't let Node time them out.
server.requestTimeout = 0;
server.headersTimeout = 0;

ensureSchema();
startChild();
await waitReady();
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[serve] front-controller on :${PORT} -> SSR :${INTERNAL_PORT}; ingest ${TOKEN ? 'enabled' : 'DISABLED (no token)'}`,
  );
});
