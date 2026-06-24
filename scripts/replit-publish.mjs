#!/usr/bin/env node
// Publish the locally-built corpus to the live Replit site over HTTPS — the operator-only daily push.
//
//   local ETL (pnpm import / --catchup)  →  this script  →  POST /__ingest  →  live site hot-swaps it
//
// Streams the served SQLite gzipped straight to the ingest endpoint (never buffers 1.7 GB). Auth is a
// bearer token only this machine holds, so only this machine can publish. Cron it daily.
//
// Required env (read from .env.local / .env):
//   SIGMA_PUBLISH_URL   base URL of the live site, e.g. https://sigma-plus.replit.app
//   DATA_PUSH_TOKEN     shared secret; must match the Repl's DATA_PUSH_TOKEN secret
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

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
const sizeGb = (statSync(dbPath).size / 1e9).toFixed(2);

const url = new URL('/__ingest', base);
const lib = url.protocol === 'https:' ? https : http;
console.log(`==> publishing ${dbPath} (${sizeGb} GB, gzipped) -> ${url.href}`);

const req = lib.request(
  url,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
    },
  },
  (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      console.log(`<- HTTP ${res.statusCode}: ${body}`);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);
req.on('error', (err) => {
  console.error(`!! request failed: ${err.message}`);
  process.exit(1);
});

await pipeline(createReadStream(dbPath), createGzip(), req);
