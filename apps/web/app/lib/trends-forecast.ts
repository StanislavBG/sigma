// Seasonal forecast for the /trends combo chart. The projection is derived from the REAL monthly
// actuals: each future month = the same calendar month one year earlier × a year-over-year growth
// factor, so the full seasonal shape (year-end peaks, summer dips) is carried forward rather than a
// flat line. The growth factor is itself estimated from the actual complete-year totals — nothing
// here is fabricated. Forecast points are always flagged `forecast: true` so the UI can label them
// „ПРОГНОЗА" and never render them as actuals.

import type { TrendPoint } from '@sigma/api-contract';

export interface SeriesPoint {
  period: string; // 'YYYY-MM'
  valueEur: number;
  contracts: number;
  forecast: boolean;
  partial: boolean;
}

export interface GrowthFactors {
  value: number; // YoY multiplier for spend (1.0 = flat)
  count: number; // YoY multiplier for contract count
}

// Guard against a single freak year producing an absurd projection. A real YoY ratio for national
// procurement sits well inside this band; anything outside is treated as data noise and clamped.
const MIN_GROWTH = 0.5;
const MAX_GROWTH = 2;
// Project at most this many months forward (and never past the end of the year after the last actual).
const MAX_HORIZON = 18;

function clampGrowth(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_GROWTH, Math.max(MIN_GROWTH, ratio));
}

function addMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Estimate the YoY growth multiplier (spend + contract count) from the actual monthly series.
 * Only complete years (12 non-partial months with a positive total) feed the estimate; the partial
 * final year and a partial first year are ignored so a half-year never skews the ratio. The factor
 * is the geometric mean of consecutive complete-year ratios. Fewer than two complete years → flat.
 */
export function estimateYoyGrowth(points: TrendPoint[]): GrowthFactors {
  const byYear = new Map<
    number,
    { value: number; count: number; months: number; partial: boolean }
  >();
  for (const p of points) {
    const y = Number(p.period.slice(0, 4));
    const acc = byYear.get(y) ?? { value: 0, count: 0, months: 0, partial: false };
    acc.value += p.valueEur;
    acc.count += p.contracts;
    acc.months += 1;
    if (p.partial) acc.partial = true;
    byYear.set(y, acc);
  }
  const complete = [...byYear.entries()]
    .filter(([, v]) => v.months === 12 && !v.partial && v.value > 0)
    .sort((a, b) => a[0] - b[0]);
  if (complete.length < 2) return { value: 1, count: 1 };

  let valueProduct = 1;
  let countProduct = 1;
  let valueN = 0;
  let countN = 0;
  for (let i = 1; i < complete.length; i += 1) {
    const prev = complete[i - 1]![1];
    const cur = complete[i]![1];
    if (prev.value > 0) {
      valueProduct *= cur.value / prev.value;
      valueN += 1;
    }
    if (prev.count > 0) {
      countProduct *= cur.count / prev.count;
      countN += 1;
    }
  }
  return {
    value: clampGrowth(valueN ? valueProduct ** (1 / valueN) : 1),
    count: clampGrowth(countN ? countProduct ** (1 / countN) : 1),
  };
}

/**
 * Project future months from the actual monthly series. The forecast starts the month after the last
 * COMPLETE month — so the partial current month's understated value is replaced by a projection
 * rather than drawn as a real datapoint — and runs to the end of the year after the last actual
 * (capped at MAX_HORIZON months). Each month is seeded from the same calendar month one year earlier
 * (actual, or an already-projected month) × the growth factor, so seasonality dominates. A missing
 * seasonal base yields 0 (honest: we never invent a level we have no basis for).
 */
export function buildForecast(
  points: TrendPoint[],
  growth?: GrowthFactors,
  horizon = MAX_HORIZON,
): SeriesPoint[] {
  if (points.length === 0) return [];
  const g = growth ?? estimateYoyGrowth(points);

  const level = new Map<string, { value: number; count: number }>();
  for (const p of points) level.set(p.period, { value: p.valueEur, count: p.contracts });

  const lastComplete = [...points].reverse().find((p) => !p.partial) ?? points[points.length - 1]!;
  let [y, m] = lastComplete.period.split('-').map(Number) as [number, number];
  const endYear = Number(lastComplete.period.slice(0, 4)) + 1;

  const out: SeriesPoint[] = [];
  for (let i = 0; i < horizon; i += 1) {
    [y, m] = addMonth(y, m);
    if (y > endYear) break;
    const key = monthKey(y, m);
    const base = level.get(monthKey(y - 1, m)) ?? { value: 0, count: 0 };
    const value = base.value * g.value;
    const count = base.count * g.count;
    level.set(key, { value, count });
    out.push({ period: key, valueEur: value, contracts: count, forecast: true, partial: false });
  }
  // No prior-year seasonal base for the first projected month (the actuals don't yet span a full year
  // before the forecast start) → the projection opens at 0, a „ПРОГНОЗА" wedge crashing to zero that
  // reads as a predicted collapse. Suppress the forecast entirely rather than render that false cliff.
  if (out.length === 0 || out[0]!.valueEur === 0) return [];
  return out;
}
