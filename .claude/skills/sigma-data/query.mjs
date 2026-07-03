#!/usr/bin/env node
// sigma-data: run a read-only SQL query against the live local Sigma D1 (miniflare sqlite).
//
// Usage:
//   node query.mjs "SELECT * FROM company_totals ORDER BY won_eur DESC LIMIT 10"
//   node query.mjs --json "SELECT ..."          # JSON array instead of table
//   echo "SELECT ..." | node query.mjs          # SQL from stdin
//   node query.mjs --schema                      # list tables + row counts
//   node query.mjs --db /path/to.sqlite "..."    # override db file
//
// Read-only by design: rejects anything that isn't SELECT / WITH / PRAGMA / EXPLAIN.
// The local D1 file is whatever `wrangler dev` / `pnpm run setup` created under .wrangler.

// Silence node:sqlite's ExperimentalWarning (kept stderr clean for tool output).
{
  const e = process.emit;
  process.emit = function (n, w) {
    return n === 'warning' && w?.name === 'ExperimentalWarning'
      ? false
      : e.apply(process, arguments);
  };
}
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  if (i === -1) return undefined;
  return argv[i + 1] ?? true;
};
const has = (n) => argv.includes(n);

// repo root = three levels up from .claude/skills/sigma-data/
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function resolveDb() {
  if (process.env.SIGMA_D1_SQLITE) return process.env.SIGMA_D1_SQLITE;
  const cli = flag('--db');
  if (typeof cli === 'string') return cli;
  // Prefer the web worker's D1 (the one the site serves); fall back to etl.
  for (const app of ['apps/web', 'apps/etl']) {
    const dir = resolve(ROOT, app, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
    if (hit) return resolve(dir, hit);
  }
  throw new Error('No local D1 sqlite found. Run `pnpm run setup` (or `pnpm dev`) first.');
}

function isReadOnly(sql) {
  const s = sql
    .trim()
    .replace(/^\((.*)\)$/s, '$1')
    .trimStart()
    .toUpperCase();
  return /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/.test(s);
}

function table(rows) {
  if (!rows.length) return '(0 rows)';
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  return [
    line(cols),
    w.map((n) => '-'.repeat(n)).join('  '),
    ...rows.map((r) => line(cols.map((c) => r[c]))),
  ].join('\n');
}

const dbPath = resolveDb();
const db = new DatabaseSync(dbPath, { readOnly: true });

if (has('--schema')) {
  const ts = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  console.error(`db: ${dbPath}\n`);
  for (const t of ts) {
    let c = '?';
    try {
      c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    } catch {}
    console.log(String(c).padStart(8), t);
  }
  process.exit(0);
}

let sql = argv
  .filter((a) => !a.startsWith('--') && a !== flag('--db'))
  .join(' ')
  .trim();
if (!sql && !process.stdin.isTTY) sql = readFileSync(0, 'utf8').trim();
if (!sql) {
  console.error('No SQL provided. See header of query.mjs for usage.');
  process.exit(1);
}
if (!isReadOnly(sql)) {
  console.error('Refused: read-only skill. Only SELECT/WITH/PRAGMA/EXPLAIN allowed.');
  process.exit(1);
}

try {
  const rows = db.prepare(sql).all();
  console.error(`db: ${dbPath}  |  ${rows.length} row(s)\n`);
  console.log(has('--json') ? JSON.stringify(rows, null, 2) : table(rows));
} catch (e) {
  console.error('Query error:', e.message);
  process.exit(1);
}
