// Pure, SSR-safe helpers for the „Договори — обзор" CPV lens (/trends?angle=cpv) — the merged home of
// the former /price-anomaly page. No DOM, no React: badge banding, deterministic jitter, the shared
// log-€ scale, and the mapping from the precomputed CPV-cohort rollups (cpv_cohort_stats +
// cpv_cohort_sample, filled by scripts/precompute-price-anomaly.mjs) to the lens' table rows.
//
// HONESTY: every figure is read from the rollups — medians and samples are real corpus values, never
// synthesised. p10/p90 are read off the stored quantile-spaced sample (the same points the strip
// draws), so the range sub-line and the box describe exactly the dots shown.

import type { CohortStatRow } from '@sigma/db';

/** One row of the lens' merged metrics + distribution table, shaped from the cohort rollup. */
export interface CpvLensGroup {
  /** 5-digit CPV group / cohort code. */
  group: string;
  /** Human label — the cohort's modal cpv_description. */
  name: string | null;
  /** Priced contracts in the cohort (rollup n). */
  contracts: number;
  /** Typical TOTAL contract value, exp(median(ln v)) — from the rollup, never recomputed. */
  medianEur: number;
  /** p10/p90 of the stored quantile-spaced sample — the distribution box + range sub-line. */
  p10Eur: number;
  p90Eur: number;
  /** Largest sampled value — drives the shared log-axis extent. */
  maxEur: number;
  /** The stored sample points (ascending) — each dot on the strip is a real contract value. */
  sampleEur: number[];
  /** Contracts flagged by the rollup (log-MAD z ≥ 3, high tail) in this cohort. */
  outlierCount: number;
}

/** Value at quantile q (0..1) of an ASCENDING sample — floor-rank, matching the rollup's convention. */
function sampleQuantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!;
}

/** Rollup row → lens table row. p10/p90/max are read off the real stored sample (no fabrication). */
export function toLensGroup(c: CohortStatRow): CpvLensGroup {
  const sample = [...c.sample].sort((a, b) => a - b);
  return {
    group: c.code,
    name: c.label || null,
    contracts: c.n,
    medianEur: c.medianEur,
    p10Eur: sample.length ? sampleQuantile(sample, 0.1) : c.medianEur,
    p90Eur: sample.length ? sampleQuantile(sample, 0.9) : c.medianEur,
    maxEur: sample.length ? sample[sample.length - 1]! : c.medianEur,
    sampleEur: sample,
    outlierCount: c.outlierCount,
  };
}

/** ×N with a Bulgarian decimal comma: 2.4 → '×2,4', 15 → '×15'. */
export function multText(mult: number): string {
  if (mult >= 10) return `×${Math.round(mult)}`;
  return `×${(Math.round(mult * 10) / 10).toString().replace('.', ',')}`;
}

/**
 * „Спрямо типичното" badge banding for the shared contract cards (design spec):
 * ≥1.3× the cohort median → accent „×N типичното"; ≤0.75× → „под типичното"; else „≈ типичното".
 * Classes are CSS tokens (ov-rel-*) — colors live in app.css, never inline hex.
 */
export function relLabel(valueEur: number, medianEur: number): { text: string; cls: string } {
  const mult = valueEur / medianEur;
  if (mult >= 1.3) return { text: `${multText(mult)} типичното`, cls: 'ov-rel-hi' };
  if (mult <= 0.75) return { text: 'под типичното', cls: 'ov-rel-lo' };
  return { text: '≈ типичното', cls: 'ov-rel-mid' };
}

/**
 * Deterministic jitter in [−0.5, 0.5) for the dot cloud (presentation only — the x positions are real
 * values). FNV-1a over `seed:i`, so SSR and client render identical geometry and no Math.random is
 * ever involved (repo rule: nothing non-deterministic in served data).
 */
export function jitter(seedText: string, i: number): number {
  let h = 2166136261;
  for (const ch of `${seedText}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 8) % 1000) / 1000 - 0.5;
}

/** Shared log-€ domain floor for the distribution strips. */
export const LOG_MIN = 1e3;

/** Shared log-axis ceiling: the next power of 10 above the largest sampled value on the page. */
export function logMax(groups: CpvLensGroup[]): number {
  const max = Math.max(1e6, ...groups.map((g) => g.maxEur));
  return 10 ** Math.ceil(Math.log10(max));
}

/** Tick label on the log axis: 1e3 → '1к', 1e6 → '1М'. */
export function axisLabel(v: number): string {
  return v >= 1e6 ? `${v / 1e6}М` : `${v / 1e3}к`;
}

/** log-€ → x in the 320-wide distribution strip. */
export function makeLx(gMax: number): (v: number) => number {
  const lo = Math.log10(LOG_MIN);
  const hi = Math.log10(gMax);
  return (v: number) =>
    6 + ((Math.log10(Math.min(gMax, Math.max(LOG_MIN, v))) - lo) / (hi - lo)) * 308;
}
