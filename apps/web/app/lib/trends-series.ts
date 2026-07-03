// Pure shaping of the trend series for the combo chart: pick the rendered actuals (the current
// partial period is excluded by default, opt-in via „вкл. текущия месец"), roll months up to the
// МЕСЕЧНО/ТРИМЕСЕЧНО/ГОДИШНО step (or down to a single clicked year), the centred moving average for
// the bold trend line, and the headline KPIs. All deterministic and SSR-safe — the component renders
// the same thing on the server and the client.

import type { TrendPoint } from '@sigma/api-contract';

export interface SeriesPoint {
  period: string; // 'YYYY-MM'
  valueEur: number;
  contracts: number;
  partial: boolean; // the in-progress as_of month (only present when opted in)
}

export type Step = 'month' | 'quarter' | 'year';

// Short Bulgarian month names, matching the design mock's x-axis + tooltip labels.
export const MONTHS_SHORT = [
  'ян',
  'фев',
  'мар',
  'апр',
  'май',
  'юни',
  'юли',
  'авг',
  'сеп',
  'окт',
  'ное',
  'дек',
] as const;

export interface DisplayPoint {
  key: string; // unique key for the rendered point/bucket
  label: string; // tooltip label, e.g. 'юни 2025' or 'Q3 2025' or '2025'
  tick: string | null; // x-axis tick label, or null when this point carries no tick
  valueEur: number;
  contracts: number;
  partial: boolean; // the bucket contains the partial as_of period
}

export interface TrendKpis {
  totalValueEur: number;
  contracts: number;
  avgEur: number; // mean € per contract over the actual period
  peak: { valueEur: number; period: string } | null; // highest-spend actual month
}

const monthOf = (period: string): number => Number(period.slice(5, 7));
const yearOf = (period: string): string => period.slice(0, 4);

/**
 * The rendered series: only real data. The trailing partial as_of month(s) are DROPPED by default —
 * their value is still being filled, so they read as an understated dip on the solid trend line.
 * `includeCurrent` (the „вкл. текущия месец" toggle, `?cur=1`) opts back in; the kept point stays
 * flagged `partial` so the chart renders it in the partial style, never as a complete month. Callers
 * keep the UNFILTERED actuals for `computeKpis`/coverage; only the rendered line applies this filter.
 */
export function combineSeries(actual: TrendPoint[], includeCurrent = false): SeriesPoint[] {
  return actual
    .filter((p) => includeCurrent || !p.partial)
    .map((p) => ({
      period: p.period,
      valueEur: p.valueEur,
      contracts: p.contracts,
      partial: p.partial,
    }));
}

/**
 * Roll the monthly series up to the requested step, or — when a year is clicked — down to that
 * year's months. Buckets accumulate value + count; a bucket is `partial` if it contains the as_of
 * period.
 */
export function aggregate(
  series: SeriesPoint[],
  step: Step,
  activeYear: number | null,
): DisplayPoint[] {
  if (activeYear != null) {
    return series
      .filter((d) => Number(yearOf(d.period)) === activeYear)
      .map((d) => {
        const m = monthOf(d.period);
        return {
          key: d.period,
          label: `${MONTHS_SHORT[m - 1]} ${activeYear}`,
          tick: MONTHS_SHORT[m - 1] ?? null,
          valueEur: d.valueEur,
          contracts: d.contracts,
          partial: d.partial,
        };
      });
  }

  if (step === 'month') {
    return series.map((d) => {
      const y = yearOf(d.period);
      const m = monthOf(d.period);
      return {
        key: d.period,
        label: `${MONTHS_SHORT[m - 1]} ${y}`,
        tick: m === 1 ? y : null, // a year label at each January
        valueEur: d.valueEur,
        contracts: d.contracts,
        partial: d.partial,
      };
    });
  }

  if (step === 'quarter') {
    const order: string[] = [];
    const map = new Map<string, DisplayPoint>();
    for (const d of series) {
      const y = yearOf(d.period);
      const q = Math.ceil(monthOf(d.period) / 3);
      const key = `${y}-Q${q}`;
      let bucket = map.get(key);
      if (!bucket) {
        bucket = {
          key,
          label: `Q${q} ${y}`,
          tick: q === 1 ? y : null,
          valueEur: 0,
          contracts: 0,
          partial: false,
        };
        map.set(key, bucket);
        order.push(key);
      }
      bucket.valueEur += d.valueEur;
      bucket.contracts += d.contracts;
      bucket.partial = bucket.partial || d.partial;
    }
    return order.map((k) => map.get(k)!);
  }

  // year
  const order: string[] = [];
  const map = new Map<string, DisplayPoint>();
  for (const d of series) {
    const y = yearOf(d.period);
    let bucket = map.get(y);
    if (!bucket) {
      bucket = {
        key: y,
        label: y,
        tick: y,
        valueEur: 0,
        contracts: 0,
        partial: false,
      };
      map.set(y, bucket);
      order.push(y);
    }
    bucket.valueEur += d.valueEur;
    bucket.contracts += d.contracts;
    bucket.partial = bucket.partial || d.partial;
  }
  return order.map((k) => map.get(k)!);
}

/** Centred moving average over `window` points (odd window centred; clamped at the edges). */
export function movingAverage(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k += 1) {
      const j = i + k;
      if (j >= 0 && j < values.length) {
        sum += values[j]!;
        n += 1;
      }
    }
    return n ? sum / n : 0;
  });
}

/**
 * Headline KPIs over the ACTUAL months. Total + contract count mirror the
 * site-wide value basis already used by the query; the peak is the highest-spend complete month, so
 * the partial as_of month's understated value can never masquerade as the peak.
 */
export function computeKpis(actual: TrendPoint[]): TrendKpis {
  let total = 0;
  let contracts = 0;
  let peak: { valueEur: number; period: string } | null = null;
  for (const p of actual) {
    total += p.valueEur;
    contracts += p.contracts;
    if (!p.partial && (peak === null || p.valueEur > peak.valueEur)) {
      peak = { valueEur: p.valueEur, period: p.period };
    }
  }
  return { totalValueEur: total, contracts, avgEur: contracts > 0 ? total / contracts : 0, peak };
}

/** Format a 'YYYY-MM' period as the short label „юни 2025" (used by the peak KPI caption). */
export function shortMonthLabel(period: string): string {
  const m = monthOf(period);
  return `${MONTHS_SHORT[m - 1] ?? ''} ${yearOf(period)}`.trim();
}
