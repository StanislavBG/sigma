// Pure log-MAD cohort statistics for the „Раздути спрямо сходни" price-anomaly rollups. No I/O — the
// reader (scripts/precompute-price-anomaly.mjs) feeds it the priced rows and persists the result. Kept
// pure so the robust-z maths is unit-tested in isolation (scripts/cohort-stats.test.mjs).
//
// METHODOLOGY (applied to TOTAL contract value amount_eur only — there are NO quantities, so this flags
// a contract for REVIEW vs its CPV peers, it never proves overpayment):
//   • Cohort  = 5-digit CPV prefix (the caller groups; this module is cohort-agnostic).
//   • Min n   = MIN_COHORT_SIZE (30). Smaller cohorts have too few peers and are excluded.
//   • Outlier = robust z on log(value): z = 0.6745·(ln v − median(ln v)) / MAD, where
//               MAD = median(|ln v − median(ln v)|). Flag v with z ≥ Z_THRESHOLD (3) AND v > median
//               (the inflated high tail only). A degenerate cohort (MAD = 0) is skipped — never a
//               divide-by-zero.

export const MIN_COHORT_SIZE = 30;
export const Z_THRESHOLD = 3;
export const MAD_TO_SIGMA = 0.6745; // 0.6745 ≈ Φ⁻¹(0.75): scales MAD to a normal-consistent σ estimate
export const SAMPLE_SIZE = 30; // quantile-spaced values kept per cohort for the distribution strip

/** Median of a numeric array. Returns NaN for an empty array. Does not mutate the input. */
export function median(values) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Robust log-MAD stats for ONE cohort's positive values. Returns null when the cohort is too small
 * (< MIN_COHORT_SIZE) or degenerate (MAD = 0). Otherwise: { n, medianEur, logMad, medianLog }.
 */
export function cohortLogMad(values, { minCohort = MIN_COHORT_SIZE } = {}) {
  if (values.length < minCohort) return null;
  const logs = values.map((v) => Math.log(v));
  const medianLog = median(logs);
  const logMad = median(logs.map((l) => Math.abs(l - medianLog)));
  if (!(logMad > 0)) return null; // degenerate cohort (every value identical in log space)
  return { n: values.length, medianEur: Math.exp(medianLog), logMad, medianLog };
}

/** Robust z on log(value) for a single value, given the cohort's median(ln) and MAD. */
export function robustZ(value, medianLog, logMad) {
  return (MAD_TO_SIGMA * (Math.log(value) - medianLog)) / logMad;
}

/**
 * Quantile-spaced sample of up to `size` values from a cohort, for the distribution strip. Picks values
 * at evenly-spaced rank positions across the sorted array, so the sample spans the cohort's spread
 * (low → high) rather than clustering. Returns the actual values (ascending), de-duplicated by position.
 */
export function quantileSample(values, size = SAMPLE_SIZE) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length <= size) return s;
  const out = [];
  for (let i = 0; i < size; i++) {
    const idx = Math.round((i * (s.length - 1)) / (size - 1));
    out.push(s[idx]);
  }
  return out;
}

/**
 * Compute the full rollup for a set of cohorts. `cohorts` is a Map<code, Array<{ id, value }>> of the
 * priced contracts (value = amount_eur > 0) grouped by CPV cohort code. Returns:
 *   stats:    one row per QUALIFYING cohort (n ≥ minCohort AND MAD > 0)
 *   outliers: the flagged contracts (z ≥ Z_THRESHOLD AND value > median), with mult + percentile
 *   samples:  up to SAMPLE_SIZE quantile-spaced values per qualifying cohort
 * Degenerate / too-small cohorts contribute nothing (honest exclusion). `labelFor(code, rows)` resolves
 * the cohort's human label.
 */
export function computeCohorts(
  cohorts,
  { minCohort = MIN_COHORT_SIZE, z = Z_THRESHOLD, labelFor } = {},
) {
  const stats = [];
  const outliers = [];
  const samples = [];
  let degenerate = 0;
  let tooSmall = 0;

  for (const [code, rows] of cohorts) {
    const values = rows.map((r) => r.value);
    if (values.length < minCohort) {
      tooSmall++;
      continue;
    }
    const stat = cohortLogMad(values, { minCohort });
    if (!stat) {
      degenerate++;
      continue;
    }
    const { n, medianEur, logMad, medianLog } = stat;

    // Cohort total (for the €-weighted inflated_share) and an ascending copy for percentile ranks.
    const cohortTotal = values.reduce((a, b) => a + b, 0);
    const ascending = [...values].sort((a, b) => a - b);

    let outlierValueTotal = 0;
    let outlierCount = 0;
    for (const r of rows) {
      const zScore = robustZ(r.value, medianLog, logMad);
      if (zScore >= z && r.value > medianEur) {
        outlierCount++;
        outlierValueTotal += r.value;
        // percentile = rank of the value within the cohort, 1..100. upperBound = # values ≤ r.value.
        const rank = upperBound(ascending, r.value);
        const percentile = Math.max(1, Math.min(100, Math.round((100 * rank) / n)));
        outliers.push({
          contractId: r.id,
          code,
          valueEur: r.value,
          mult: r.value / medianEur,
          percentile,
        });
      }
    }

    stats.push({
      code,
      label: labelFor ? labelFor(code, rows) : code,
      n,
      medianEur,
      logMad,
      outlierCount,
      inflatedShare: cohortTotal > 0 ? outlierValueTotal / cohortTotal : 0,
    });

    for (const value of quantileSample(values)) samples.push({ code, value });
  }

  return { stats, outliers, samples, degenerate, tooSmall };
}

/** Count of elements <= target in an ascending array (upper bound index). */
function upperBound(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
