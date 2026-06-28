import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import type { SeriesPoint } from './trends-forecast';
import {
  aggregate,
  combineSeries,
  computeKpis,
  movingAverage,
  shortMonthLabel,
} from './trends-series';

function months(y: number, count: number, value = 10, contracts = 5): TrendPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    period: `${y}-${String(i + 1).padStart(2, '0')}`,
    valueEur: value,
    contracts,
    partial: false,
  }));
}

describe('combineSeries', () => {
  it('tags actuals non-forecast and appends the projected tail', () => {
    const actual = months(2023, 2);
    const forecast: SeriesPoint[] = [
      { period: '2023-03', valueEur: 9, contracts: 4, forecast: true, partial: false },
    ];
    const out = combineSeries(actual, forecast);
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).every((d) => !d.forecast)).toBe(true);
    expect(out[2]!.forecast).toBe(true);
  });

  it('drops the trailing partial month the forecast replaces (no duplicate period)', () => {
    const actual: TrendPoint[] = [
      { period: '2024-10', valueEur: 10, contracts: 5, partial: false },
      { period: '2024-11', valueEur: 12, contracts: 6, partial: false },
      { period: '2024-12', valueEur: 3, contracts: 2, partial: true }, // partial as_of tail
    ];
    // buildForecast starts the month after the last COMPLETE month → it covers the partial month.
    const forecast: SeriesPoint[] = [
      { period: '2024-12', valueEur: 14, contracts: 7, forecast: true, partial: false },
    ];
    const out = combineSeries(actual, forecast);
    const periods = out.map((d) => d.period);
    expect(periods).toEqual(['2024-10', '2024-11', '2024-12']); // partial dropped, not duplicated
    expect(new Set(periods).size).toBe(periods.length); // no duplicate React key
    const dec = out.filter((d) => d.period === '2024-12');
    expect(dec).toHaveLength(1);
    expect(dec[0]!.forecast).toBe(true); // the projection REPLACES the partial month
    expect(dec[0]!.valueEur).toBe(14); // not the understated partial value (3)
  });
});

describe('aggregate', () => {
  const series = combineSeries(
    [...months(2022, 12), ...months(2023, 12)],
    [{ period: '2024-01', valueEur: 10, contracts: 5, forecast: true, partial: false }],
  );

  it('month step keeps every point and ticks at January', () => {
    const out = aggregate(series, 'month', null);
    expect(out).toHaveLength(25);
    expect(out[0]!.tick).toBe('2022');
    expect(out[1]!.tick).toBeNull();
    expect(out[12]!.tick).toBe('2023');
  });

  it('quarter step folds three months per bucket', () => {
    const out = aggregate(series, 'quarter', null);
    // 8 full quarters (2022/2023) + the forecast Q1 2024
    expect(out).toHaveLength(9);
    expect(out[0]!.label).toBe('Q1 2022');
    expect(out[0]!.valueEur).toBe(30); // 3 months × 10
    expect(out.at(-1)!.forecast).toBe(true);
  });

  it('year step folds twelve months per bucket', () => {
    const out = aggregate(series, 'year', null);
    expect(out.map((d) => d.label)).toEqual(['2022', '2023', '2024']);
    expect(out[0]!.valueEur).toBe(120);
    expect(out[2]!.forecast).toBe(true);
  });

  it('an active year drills down to that year months', () => {
    const out = aggregate(series, 'month', 2023);
    expect(out).toHaveLength(12);
    expect(out[0]!.label).toBe('ян 2023');
    expect(out.every((d) => !d.forecast)).toBe(true);
  });
});

describe('movingAverage', () => {
  it('centres the window and clamps at the edges', () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
  });
});

describe('computeKpis', () => {
  it('sums value + count and finds the peak among complete months', () => {
    const points: TrendPoint[] = [
      { period: '2023-01', valueEur: 10, contracts: 5, partial: false },
      { period: '2023-02', valueEur: 30, contracts: 7, partial: false },
      { period: '2023-03', valueEur: 99, contracts: 9, partial: true }, // partial — never the peak
    ];
    const k = computeKpis(points);
    expect(k.totalValueEur).toBe(139);
    expect(k.contracts).toBe(21);
    expect(k.avgEur).toBeCloseTo(139 / 21, 6);
    expect(k.peak).toEqual({ valueEur: 30, period: '2023-02' });
  });

  it('handles an empty series', () => {
    expect(computeKpis([])).toEqual({ totalValueEur: 0, contracts: 0, avgEur: 0, peak: null });
  });
});

describe('shortMonthLabel', () => {
  it('formats a period as the short Bulgarian month + year', () => {
    expect(shortMonthLabel('2025-06')).toBe('юни 2025');
  });
});
