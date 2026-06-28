// Precompute the price-anomaly rollups for the „Раздути спрямо сходни" dashboard. Populates
// cpv_cohort_stats / cpv_cohort_sample / cpv_cohort_outlier (migration 0003) from the served corpus:
// flags contracts whose TOTAL value (amount_eur) is a high-tail log-MAD outlier vs SIMILAR contracts in
// the same 5-digit CPV cohort. See scripts/cohort-stats.mjs for the maths and migration 0003 for the
// schema + methodology/honesty notes.
//
// WHY a node step (not pure SQL in precompute.sql): the per-cohort median + MAD over ~190k priced
// contracts needs two median passes and is far cleaner — and unit-testable — in JS than in window-SQL.
// It reads the served sqlite directly via node:sqlite (fast, local), and writes the rollups in one
// transaction. Wired into the local ETL precompute path in scripts/import.mjs (runFullDerive).
//
// USAGE:
//   node scripts/precompute-price-anomaly.mjs                # auto-resolves apps/web/.wrangler local D1
//   node scripts/precompute-price-anomaly.mjs --db <path>    # explicit sqlite file or state dir
//
// IDEMPOTENT: DELETE + INSERT inside a transaction, so a re-run always reflects the current corpus.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

import { computeCohorts, MIN_COHORT_SIZE, Z_THRESHOLD } from './cohort-stats.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

// Resolve the served sqlite file: an explicit --db (file or dir), else the local miniflare D1 state.
function findSqlite(path) {
  if (statSync(path).isFile()) return path;
  let best = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.sqlite') &&
        entry.name !== 'metadata.sqlite'
      ) {
        const size = statSync(child).size;
        if (!best || size > best.size) best = { path: child, size };
      }
    }
  };
  walk(path);
  if (!best) throw new Error(`no sqlite database found under ${path}`);
  return best.path;
}

// CREATE guards mirror migration 0003 so the step self-bootstraps a DB created before the migration ran
// (same discipline as scripts/precompute.sql). The migration remains the canonical schema.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cpv_cohort_stats (
  code TEXT PRIMARY KEY, label TEXT NOT NULL, n INTEGER NOT NULL, median_eur REAL NOT NULL,
  log_mad REAL NOT NULL, outlier_count INTEGER NOT NULL, inflated_share REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cpv_cohort_sample (code TEXT NOT NULL, value_eur REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cpv_cohort_sample_code ON cpv_cohort_sample(code);
CREATE TABLE IF NOT EXISTS cpv_cohort_outlier (
  contract_id TEXT PRIMARY KEY, code TEXT NOT NULL, value_eur REAL NOT NULL,
  mult REAL NOT NULL, percentile INTEGER NOT NULL, window_median_eur REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cpv_cohort_outlier_code ON cpv_cohort_outlier(code);
CREATE INDEX IF NOT EXISTS idx_cpv_cohort_outlier_mult ON cpv_cohort_outlier(mult DESC);
`;

function main() {
  const dbArg = arg('db');
  const target = findSqlite(
    dbArg && dbArg !== true
      ? resolve(String(dbArg))
      : resolve(root, 'apps/web/.wrangler/state/v3/d1'),
  );
  console.log(`==> price-anomaly precompute → ${target}`);

  const db = new DatabaseSync(target);
  db.exec(SCHEMA);

  // Self-bootstrap the temporal window column (migration 0004) on a DB created before that migration —
  // CREATE IF NOT EXISTS above won't add a column to an existing table. Mirrors the migration exactly.
  const outlierCols = db
    .prepare('PRAGMA table_info(cpv_cohort_outlier)')
    .all()
    .map((c) => c.name);
  if (!outlierCols.includes('window_median_eur')) {
    db.exec('ALTER TABLE cpv_cohort_outlier ADD COLUMN window_median_eur REAL NOT NULL DEFAULT 0');
  }

  // ── Read the priced corpus, grouped by 5-digit CPV cohort ──────────────────────────────────────
  // Base = contracts with a clean positive amount_eur and a CPV code at least 5 chars long. amount_eur
  // is the canonical headline value (same base the other rollups use). v > 0 so ln(v) is defined.
  const rows = db
    .prepare(
      `SELECT c.id AS id, substr(t.cpv_code, 1, 5) AS code, c.amount_eur AS value,
              c.signed_at AS signed_at, t.cpv_description AS descr
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       WHERE c.amount_eur IS NOT NULL AND c.amount_eur > 0 AND length(t.cpv_code) >= 5`,
    )
    .all();

  const cohorts = new Map();
  const descCounts = new Map(); // code → Map<description, count> for the modal-label fallback
  for (const r of rows) {
    let bucket = cohorts.get(r.code);
    if (!bucket) {
      bucket = [];
      cohorts.set(r.code, bucket);
      descCounts.set(r.code, new Map());
    }
    bucket.push({ id: r.id, value: r.value, signedAt: r.signed_at });
    const d = (r.descr ?? '').trim();
    if (d) {
      const dc = descCounts.get(r.code);
      dc.set(d, (dc.get(d) ?? 0) + 1);
    }
  }

  // label = the cohort's modal (most common) non-empty cpv_description. @sigma/config's CPV taxonomy
  // only carries 2-digit division names, so for a 5-digit cohort the modal source description IS the
  // best human label. Falls back to the bare code when no description is present.
  const labelFor = (code) => {
    const dc = descCounts.get(code);
    let best = null;
    let bestN = 0;
    for (const [d, n] of dc) {
      if (n > bestN || (n === bestN && best !== null && d < best)) {
        best = d;
        bestN = n;
      }
    }
    return best ?? `CPV ${code}`;
  };

  const { stats, outliers, samples, degenerate, tooSmall, undated, sparseWindow } = computeCohorts(
    cohorts,
    { labelFor },
  );

  // ── Write the rollups in one transaction (DELETE + INSERT) ─────────────────────────────────────
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM cpv_cohort_outlier');
    db.exec('DELETE FROM cpv_cohort_sample');
    db.exec('DELETE FROM cpv_cohort_stats');

    const insStat = db.prepare(
      `INSERT INTO cpv_cohort_stats (code, label, n, median_eur, log_mad, outlier_count, inflated_share)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of stats)
      insStat.run(s.code, s.label, s.n, s.medianEur, s.logMad, s.outlierCount, s.inflatedShare);

    const insSample = db.prepare('INSERT INTO cpv_cohort_sample (code, value_eur) VALUES (?, ?)');
    for (const s of samples) insSample.run(s.code, s.value);

    const insOut = db.prepare(
      `INSERT INTO cpv_cohort_outlier (contract_id, code, value_eur, mult, percentile, window_median_eur)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const o of outliers)
      insOut.run(o.contractId, o.code, o.valueEur, o.mult, o.percentile, o.windowMedianEur);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const totalCohorts = cohorts.size;
  console.log(
    `   cohorts(5-digit CPV)=${totalCohorts}  qualifying(n≥${MIN_COHORT_SIZE},MAD>0)=${stats.length}  ` +
      `tooSmall=${tooSmall}  degenerate=${degenerate}`,
  );
  console.log(
    `   flagged contracts (z≥${Z_THRESHOLD}, high tail, ±1yr window)=${outliers.length}  ` +
      `sample rows=${samples.length}`,
  );
  console.log(
    `   excluded from windowed detection: undated=${undated}  sparseWindow(<${MIN_COHORT_SIZE} temporal peers)=${sparseWindow}`,
  );
  db.close();
}

main();
