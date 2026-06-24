#!/usr/bin/env node
// Publish the locally-built corpus to the live Replit site over HTTPS — the operator-only daily push.
//
//   local ETL (pnpm import / --catchup)  →  this script  →  POST /__ingest  →  live site hot-swaps it
//
// Uploads the served SQLite in small gzipped chunks (Replit's edge proxy 413s on large bodies), then
// commits. Auth is a bearer token only this machine holds, so only this machine can publish. Cron daily.
//
// Required env (read from .env.local / .env):
//   SIGMA_PUBLISH_URL   base URL of the live site, e.g. https://sigma-plus.replit.app
//   DATA_PUSH_TOKEN     shared secret; must match the Repl's DATA_PUSH_TOKEN secret
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const CHUNK = 8 * 1024 * 1024; // 8 MiB raw per request — safely under the proxy body limit, gzipped

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['.env.local', '.env']) {
  const file = resolve(root, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const base = process.env.SIGMA_PUBLISH_URL;
const token = process.env.DATA_PUSH_TOKEN;
if (!base || !token) {
  console.error('ERROR: set SIGMA_PUBLISH_URL and DATA_PUSH_TOKEN (in .env.local). See replit.md.');
  process.exit(1);
}

const d1Dir = join(root, 'apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const main = existsSync(d1Dir)
  ? readdirSync(d1Dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  : null;
if (!main) {
  console.error(
    `ERROR: no built corpus under ${d1Dir}. Run \`pnpm bootstrap\` / \`pnpm import\` first.`,
  );
  process.exit(1);
}
const dbPath = join(d1Dir, main);
const size = statSync(dbPath).size;
const lib = new URL(base).protocol === 'https:' ? https : http;

// POST one phase; gzip-compress the body if given. Resolves { status, body }.
function post(path, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    };
    if (body) headers['content-encoding'] = 'gzip';
    const req = lib.request(new URL(path, base), { method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

console.log(`==> publishing ${dbPath} (${(size / 1e9).toFixed(2)} GB) -> ${base}`);

const begin = await post('/__ingest/begin');
if (begin.status !== 200) {
  console.error(`!! begin failed: HTTP ${begin.status} ${begin.body}`);
  process.exit(1);
}

const fd = openSync(dbPath, 'r');
const buf = Buffer.allocUnsafe(CHUNK);
let offset = 0;
let n = 0;
try {
  while (offset < size) {
    const read = readSync(fd, buf, 0, CHUNK, offset);
    const r = await post('/__ingest/chunk', gzipSync(buf.subarray(0, read)));
    if (r.status !== 200) {
      console.error(`\n!! chunk ${n} failed: HTTP ${r.status} ${r.body}`);
      process.exit(1);
    }
    offset += read;
    n += 1;
    process.stdout.write(
      `\r  uploaded ${(offset / 1e9).toFixed(2)} / ${(size / 1e9).toFixed(2)} GB (${n} chunks)`,
    );
  }
} finally {
  closeSync(fd);
}
process.stdout.write('\n==> committing…\n');

const commit = await post('/__ingest/commit');
console.log(`<- HTTP ${commit.status}: ${commit.body}`);
process.exit(commit.status === 200 ? 0 : 1);
