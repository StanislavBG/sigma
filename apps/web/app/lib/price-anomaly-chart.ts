// Pure, SSR-safe geometry + formatting for the „Раздути спрямо сходни" (price-anomaly) dashboard. No
// DOM, no React — just maths over the precomputed cohort rollups, so the route stays a thin renderer
// and these helpers are unit-testable in isolation.
//
// Everything sits on a log10(value) axis: contract totals span many orders of magnitude, so a linear
// axis would crush the cohort into a single pixel. Two primitives:
//   1. cohortStripGeometry — the V3 per-cohort distribution strip, all cohorts sharing ONE log scale so
//      the strips are visually comparable (a cohort that sits further right is genuinely pricier).
//   2. cardStripGeometry — the V4 per-card peer strip on a LOCAL log scale (peers + the flagged value),
//      so the flagged contract's accent dot sits at the right edge against its own cohort.
//
// Honesty: extents are read from the real rows (never hard-coded mock maxima); empty inputs yield an
// empty (not NaN) strip; the median line is always derived from real numbers.

const round1 = (n: number): number => Math.round(n * 10) / 10;

// A multiple of the cohort median: „×3,4" under 20, „×604" at/above (integers read cleaner once huge).
// Mirrors the site's decimal-comma numerics. Non-finite ⇒ em-dash.
export function fmtMult(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—';
  return `×${m >= 20 ? Math.round(m).toString() : (Math.round(m * 10) / 10).toString().replace('.', ',')}`;
}

// „pN" percentile chip, clamped to p99 so an extreme tail never claims a fabricated p100.
export function fmtPercentile(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `p${Math.min(99, Math.max(1, Math.round(p)))}`;
}

const VBW = 360; // strip viewBox width
const PAD = 6; // horizontal padding inside the strip

// log10 with a floor so a stray ≤0 value (shouldn't occur for priced contracts) can't produce −∞.
const safeLog = (v: number): number => Math.log10(Math.max(1, v));

export interface StripDot {
  x: number;
  y: number;
  r: number;
  /** ≥ 5× the cohort median — the „аномалия" dots the design accents. */
  big: boolean;
}

export interface CohortStrip {
  dots: StripDot[];
  /** x of the accent median line. */
  medX: number;
}

// Deterministic vertical jitter so the SR-equivalent table stays the source of truth while the dots
// don't all stack on the baseline. Pure function of the index ⇒ stable across SSR/CSR (no Math.random).
const jitter = (i: number, height: number): number => {
  // A cheap hash → [-0.5, 0.5]; spreads dots within the band without a PRNG.
  const h = Math.sin(i * 12.9898) * 43758.5453;
  return (h - Math.floor(h) - 0.5) * height;
};

/**
 * One cohort's distribution strip on a SHARED log scale [domainMin, domainMax] (pass the corpus-wide
 * min/max so every strip is comparable). `sample` is the ascending quantile-spaced cohort values.
 */
export function cohortStripGeometry(
  sample: number[],
  medianEur: number,
  domainMin: number,
  domainMax: number,
  height = 16,
): CohortStrip {
  const lo = safeLog(domainMin);
  const hi = safeLog(domainMax);
  const span = hi - lo || 1;
  const xOf = (v: number) => round1(PAD + ((safeLog(v) - lo) / span) * (VBW - 2 * PAD));
  const cy = height; // baseline (caller's viewBox is 2*height tall)
  const dots: StripDot[] = sample.map((v, i) => {
    const big = medianEur > 0 && v >= medianEur * 5;
    return { x: xOf(v), y: round1(cy + jitter(i, height)), r: big ? 3 : 2, big };
  });
  return { dots, medX: xOf(medianEur) };
}

// Corpus-wide log domain across all loaded cohort samples + medians, so the V3 strips share one scale.
export function sharedDomain(
  cohorts: { sample: number[]; medianEur: number }[],
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of cohorts) {
    for (const v of c.sample) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (c.medianEur < min) min = c.medianEur;
    if (c.medianEur > max) max = c.medianEur;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 1e3, max: 1e6 };
  return { min: Math.max(1, min), max: Math.max(min * 10, max) };
}

export interface CardStrip {
  dots: StripDot[];
  medX: number;
  /** x of the flagged contract's accent dot. */
  hiX: number;
}

const CARD_VBW = 320;
const CARD_PAD = 6;

/**
 * The V4 card peer strip on a LOCAL log scale: the cohort `sample` plus the flagged `valueEur`, padded
 * so neither extreme touches the edge. When the cohort sample is unavailable (the flagged contract's
 * cohort fell outside the browsed set) the median is still placed from `medianEur` and only the peer
 * dots are omitted — never fabricated.
 */
export function cardStripGeometry(
  sample: number[],
  medianEur: number,
  valueEur: number,
  height = 16,
): CardStrip {
  const all = sample.length ? [...sample, valueEur, medianEur] : [valueEur, medianEur];
  const dMin = Math.max(1, Math.min(...all) * 0.7);
  const dMax = Math.max(dMin * 10, Math.max(...all) * 1.3);
  const lo = safeLog(dMin);
  const span = safeLog(dMax) - lo || 1;
  const xOf = (v: number) => round1(CARD_PAD + ((safeLog(v) - lo) / span) * (CARD_VBW - 2 * CARD_PAD));
  const cy = height;
  const dots: StripDot[] = sample.map((v, i) => ({
    x: xOf(v),
    y: round1(cy + jitter(i, height)),
    r: 2,
    big: medianEur > 0 && v >= medianEur * 5,
  }));
  return { dots, medX: xOf(medianEur), hiX: xOf(valueEur) };
}
