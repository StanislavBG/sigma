-- Price-anomaly rollups for the „Раздути спрямо сходни" dashboard — contracts whose TOTAL value
-- (amount_eur) is a high-tail outlier vs SIMILAR contracts in the same CPV cohort. These are
-- precomputed because the per-cohort median + log-MAD over ~190k priced contracts is far too costly to
-- run live on every request (D1 meters rows scanned). The computation lives in
-- scripts/precompute-price-anomaly.mjs (wired into the ETL precompute path in scripts/import.mjs); the
-- read queries live in packages/db/src/queries/price-anomaly.ts.
--
-- METHODOLOGY (documented here so the schema reads honestly):
--   • Cohort  = 5-digit CPV prefix substr(cpv_code,1,5). On the served corpus this yields 2044 distinct
--               cohorts (matches the design's „2045 CPV групи"); 2/3/4-digit prefixes give 45/297/962
--               cohorts (too coarse), 6/8-digit give 2946/3511 (too sparse). 5 digits is the level whose
--               cohorts are both numerous and populated enough for a robust median.
--   • Min n   = 30. Smaller cohorts are excluded — too few peers to call anything an outlier.
--   • Outlier = robust log-MAD z ≥ 3 on the HIGH tail only:
--                 z = 0.6745 · (ln v − median(ln v)) / MAD,  MAD = median(|ln v − median(ln v)|)
--               flagged when z ≥ 3 AND v > median (inflated side). Cohorts with MAD = 0 (degenerate —
--               every value identical in log space) are skipped, never divided by zero.
--
-- HONESTY: this flags a contract for REVIEW against its CPV peers — it is NOT proof of overpayment.
-- There are no quantities in the source, so a large total can be a legitimately large scope. Any
-- served text must say „за преглед", never assert waste.
--
-- IDEMPOTENT: the precompute step does DELETE + INSERT, so a re-run always reflects the current corpus.

-- ── Per-cohort distribution + outlier summary (the cohort-browse table) ──────────────────────────
--   median_eur     = exp(median(ln v)) — the cohort's typical TOTAL contract value.
--   log_mad        = MAD of ln(v) (the robust scale; 0 only for degenerate cohorts, which are excluded).
--   outlier_count  = # contracts with z ≥ 3 AND v > median.
--   inflated_share = Σ(outlier value) / Σ(cohort value) — the €-weighted share of the cohort's total
--                    value that sits in flagged contracts (value-share, not count-share, so one huge
--                    outlier reads as the large slice it is).
CREATE TABLE IF NOT EXISTS cpv_cohort_stats (
  code           TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  n              INTEGER NOT NULL,
  median_eur     REAL NOT NULL,
  log_mad        REAL NOT NULL,
  outlier_count  INTEGER NOT NULL,
  inflated_share REAL NOT NULL
);

-- A small per-cohort value sample for the distribution strips — up to ~30 quantile-spaced values per
-- cohort (capped, so the table stays tiny vs the full corpus). Quantile-spaced ranks give a faithful
-- shape for the strip without shipping every row.
CREATE TABLE IF NOT EXISTS cpv_cohort_sample (
  code      TEXT NOT NULL,
  value_eur REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cpv_cohort_sample_code ON cpv_cohort_sample(code);

-- ── The flagged contracts (z ≥ 3, high tail) ────────────────────────────────────────────────────
--   mult       = value_eur / cohort median_eur (the headline „× над типичното").
--   percentile = rank of the contract's value within its cohort, 1..100 (round(100 · rank_asc / n)).
CREATE TABLE IF NOT EXISTS cpv_cohort_outlier (
  contract_id TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  value_eur   REAL NOT NULL,
  mult        REAL NOT NULL,
  percentile  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cpv_cohort_outlier_code ON cpv_cohort_outlier(code);
CREATE INDEX IF NOT EXISTS idx_cpv_cohort_outlier_mult ON cpv_cohort_outlier(mult DESC);
