// Pure log-MAD cohort statistics for the „Раздути спрямо сходни" price-anomaly rollups. No I/O — the
// reader (scripts/precompute-price-anomaly.mjs) feeds it the priced rows and persists the result. Kept
// pure so the robust-z maths is unit-tested in isolation (scripts/cohort-stats.test.mjs).
//
// METHODOLOGY (applied to TOTAL contract value amount_eur only — there are NO quantities, so this flags
// a contract for REVIEW vs its CPV peers, it never proves overpayment):
//   • Cohort  = 5-digit CPV prefix AND ±WINDOW_DAYS of the contract's own signed_at (a per-contract
//               sliding window — see below). The caller groups by CPV; this module slides the time
//               window inside each group.
//   • Min n   = MIN_COHORT_SIZE (30). The n≥30 rule applies to the WINDOW: a contract is evaluated only
//               if its ±1-year same-CPV window holds ≥30 peers (itself included). Sparse CPV-years and
//               undated contracts are excluded — honestly, not silently flagged.
//   • Outlier = robust z on log(value): z = 0.6745·(ln v − median(ln v)) / MAD, where
//               MAD = median(|ln v − median(ln v)|). Flag v with z ≥ Z_THRESHOLD (3) AND v > median
//               (the inflated high tail only). A degenerate window (MAD = 0) is skipped — never a
//               divide-by-zero.
//
// WHY THE ±1-YEAR WINDOW (inflation adjustment): prices inflate across the corpus period, so comparing a
// 2018 contract to 2024 peers conflates inflation with anomaly — a contract that is merely *recent* would
// read as „expensive". Restricting each contract's cohort to peers signed within ±1 year holds time
// roughly constant, so the robust z becomes an inflation-adjusted „expensive vs similar-era peers"
// signal rather than „expensive vs the whole history". The group's all-period median/sample are still
// computed for DISPLAY context (the browse table's „ТИПИЧНА" and the distribution strip), but DETECTION
// is windowed: outlier_count / inflated_share count only the temporally-flagged contracts.

export const MIN_COHORT_SIZE = 30;
export const Z_THRESHOLD = 3;
export const WINDOW_DAYS = 365; // ±1-year temporal window for the per-contract inflation-adjusted cohort
export const MAD_TO_SIGMA = 0.6745; // 0.6745 ≈ Φ⁻¹(0.75): scales MAD to a normal-consistent σ estimate
export const SAMPLE_SIZE = 30; // quantile-spaced values kept per cohort for the distribution strip

const MS_PER_DAY = 86_400_000;

/** Parse a signed_at string to epoch ms, or null when missing/unparseable (excluded from detection). */
export function parseSignedAt(s) {
  if (s == null || s === '') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

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
 * Compute the full rollup for a set of cohorts. `cohorts` is a Map<code, Array<{ id, value, signedAt }>>
 * of the priced contracts (value = amount_eur > 0, signedAt = the contract's signed date string or
 * null) grouped by CPV cohort code. Returns:
 *   stats:    one row per QUALIFYING CPV group (group n ≥ minCohort AND group MAD > 0). `n` and
 *             `medianEur` are the group's ALL-PERIOD totals (display context); `outlierCount` and
 *             `inflatedShare` count only the TEMPORALLY-flagged (windowed) outliers.
 *   outliers: the windowed flagged contracts (z ≥ Z_THRESHOLD AND value > window median), each carrying
 *             the WINDOW-relative `valueEur`, `mult = value / windowMedian`, `percentile` within the
 *             window, and `windowMedianEur` (the ±1-year median it was judged against).
 *   samples:  up to SAMPLE_SIZE quantile-spaced ALL-PERIOD values per qualifying group (distribution
 *             strip context — all-period on purpose; the strip is context, the detection is windowed).
 * Detection is windowed: for each datable contract the cohort is its same-CPV peers signed within
 * ±windowDays. A two-pointer sweep over the time-sorted group keeps this O(n) in window moves; the
 * per-window median/MAD is recomputed on the window slice. Counters: `tooSmall` (group < minCohort),
 * `degenerate` (group MAD = 0), `undated` (no signed_at — can't be placed in time), `sparseWindow`
 * (datable but the ±window holds < minCohort peers). `labelFor(code, rows)` resolves the human label.
 */
export function computeCohorts(
  cohorts,
  { minCohort = MIN_COHORT_SIZE, z = Z_THRESHOLD, windowDays = WINDOW_DAYS, labelFor } = {},
) {
  const stats = [];
  const outliers = [];
  const samples = [];
  let degenerate = 0;
  let tooSmall = 0;
  let undated = 0;
  let sparseWindow = 0;
  const windowMs = windowDays * MS_PER_DAY;

  for (const [code, rows] of cohorts) {
    const values = rows.map((r) => r.value);
    if (values.length < minCohort) {
      tooSmall++;
      continue;
    }
    // Group-level (ALL-PERIOD) stats — for the browse table's „ТИПИЧНА" + the distribution strip only.
    const groupStat = cohortLogMad(values, { minCohort });
    if (!groupStat) {
      degenerate++;
      continue;
    }
    const { n, medianEur, logMad } = groupStat;
    const cohortTotal = values.reduce((a, b) => a + b, 0); // €-weighted inflated_share denominator

    // ── Windowed (±windowDays) detection ──────────────────────────────────────────────────────────
    // Place each contract in time; undated ones can't be windowed → excluded (counted, not flagged).
    const dated = [];
    for (const r of rows) {
      const t = parseSignedAt(r.signedAt);
      if (t == null) {
        undated++;
        continue;
      }
      dated.push({ id: r.id, value: r.value, t });
    }
    // Sort by time (tiebreak value, then id) so the two-pointer window is deterministic.
    dated.sort((a, b) => a.t - b.t || a.value - b.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let outlierValueTotal = 0;
    let outlierCount = 0;
    let lo = 0;
    let hi = 0; // window is [lo, hi); both pointers advance monotonically with i.
    for (let i = 0; i < dated.length; i++) {
      const ti = dated[i].t;
      while (dated[lo].t < ti - windowMs) lo++;
      if (hi < i) hi = i;
      while (hi < dated.length && dated[hi].t <= ti + windowMs) hi++;
      const windowSize = hi - lo;
      if (windowSize < minCohort) {
        sparseWindow++;
        continue;
      }
      const wv = new Array(windowSize);
      for (let k = lo; k < hi; k++) wv[k - lo] = dated[k].value;
      const wstat = cohortLogMad(wv, { minCohort });
      if (!wstat) continue; // degenerate window (every value identical in log space)
      const v = dated[i].value;
      const zScore = robustZ(v, wstat.medianLog, wstat.logMad);
      if (zScore >= z && v > wstat.medianEur) {
        outlierCount++;
        outlierValueTotal += v;
        // percentile = rank of the value within its WINDOW, 1..100.
        const ascending = [...wv].sort((a, b) => a - b);
        const rank = upperBound(ascending, v);
        const percentile = Math.max(1, Math.min(100, Math.round((100 * rank) / windowSize)));
        outliers.push({
          contractId: dated[i].id,
          code,
          valueEur: v,
          mult: v / wstat.medianEur,
          percentile,
          windowMedianEur: wstat.medianEur,
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

  return { stats, outliers, samples, degenerate, tooSmall, undated, sparseWindow };
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
