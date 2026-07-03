import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
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
  const actual: TrendPoint[] = [
    { period: '2024-10', valueEur: 10, contracts: 5, partial: false },
    { period: '2024-11', valueEur: 12, contracts: 6, partial: false },
    { period: '2024-12', valueEur: 3, contracts: 2, partial: true }, // partial as_of tail
  ];

  it('drops the trailing partial month by default — the chart shows only complete periods', () => {
    const out = combineSeries(actual);
    expect(out.map((d) => d.period)).toEqual(['2024-10', '2024-11']);
    expect(out.every((d) => !d.partial)).toBe(true);
  });

  it('keeps the partial month when opted in („вкл. текущия месец"), still flagged partial', () => {
    const out = combineSeries(actual, true);
    expect(out.map((d) => d.period)).toEqual(['2024-10', '2024-11', '2024-12']);
    expect(out[2]!.partial).toBe(true); // rendered in the partial style, never as a complete month
    expect(out[2]!.valueEur).toBe(3); // the REAL accumulated value — nothing projected
  });
});

describe('aggregate', () => {
  const partialJan: TrendPoint = { period: '2024-01', valueEur: 4, contracts: 2, partial: true };
  const series = combineSeries([...months(2022, 12), ...months(2023, 12), partialJan], true);

  it('month step keeps every point and ticks at January', () => {
    const out = aggregate(series, 'month', null);
    expect(out).toHaveLength(25);
    expect(out[0]!.tick).toBe('2022');
    expect(out[1]!.tick).toBeNull();
    expect(out[12]!.tick).toBe('2023');
    expect(out.at(-1)!.partial).toBe(true); // the opted-in current month keeps its flag
  });

  it('quarter step folds three months per bucket and flags the partial bucket', () => {
    const out = aggregate(series, 'quarter', null);
    // 8 full quarters (2022/2023) + the partial Q1 2024
    expect(out).toHaveLength(9);
    expect(out[0]!.label).toBe('Q1 2022');
    expect(out[0]!.valueEur).toBe(30); // 3 months × 10
    expect(out[0]!.partial).toBe(false);
    expect(out.at(-1)!.partial).toBe(true);
  });

  it('year step folds twelve months per bucket', () => {
    const out = aggregate(series, 'year', null);
    expect(out.map((d) => d.label)).toEqual(['2022', '2023', '2024']);
    expect(out[0]!.valueEur).toBe(120);
    expect(out[2]!.partial).toBe(true);
  });

  it('an active year drills down to that year months', () => {
    const out = aggregate(series, 'month', 2023);
    expect(out).toHaveLength(12);
    expect(out[0]!.label).toBe('ян 2023');
    expect(out.every((d) => !d.partial)).toBe(true);
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
