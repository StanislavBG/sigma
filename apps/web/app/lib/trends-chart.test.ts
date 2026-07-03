import { describe, expect, it } from 'vitest';
import { buildChartModel } from './trends-chart';
import type { DisplayPoint } from './trends-series';

function pt(over: Partial<DisplayPoint> & { key: string }): DisplayPoint {
  return {
    label: over.key,
    tick: null,
    valueEur: 0,
    contracts: 0,
    partial: false,
    ...over,
  };
}

const actualThenPartial: DisplayPoint[] = [
  pt({ key: 'a', valueEur: 10, contracts: 5 }),
  pt({ key: 'b', valueEur: 40, contracts: 8 }), // peak
  pt({ key: 'c', valueEur: 25, contracts: 7 }),
  pt({ key: 'd', valueEur: 20, contracts: 6, partial: true }), // opted-in current month
];

describe('buildChartModel', () => {
  it('emits one bar and one hit box per point and finds the first partial index', () => {
    const m = buildChartModel(actualThenPartial);
    expect(m.bars).toHaveLength(4);
    expect(m.hits).toHaveLength(4);
    expect(m.points).toHaveLength(4);
    expect(m.firstPartialIndex).toBe(3);
    expect(m.bars[3]!.partial).toBe(true);
  });

  it('splits the € line: solid over complete points, dashed tail to the partial month', () => {
    const m = buildChartModel(actualThenPartial);
    expect(m.actualLine).not.toBe('');
    expect(m.partialLine).not.toBe('');
  });

  it('omits the dashed tail when no partial point is shown (the default view)', () => {
    const m = buildChartModel([
      pt({ key: 'a', valueEur: 10, contracts: 5 }),
      pt({ key: 'b', valueEur: 20, contracts: 6 }),
    ]);
    expect(m.firstPartialIndex).toBe(2);
    expect(m.partialLine).toBe('');
  });

  it('places the peak on the highest complete (non-partial) point', () => {
    const withHighPartial = [
      ...actualThenPartial.slice(0, 3),
      pt({ key: 'd', valueEur: 99, contracts: 6, partial: true }), // never the peak
    ];
    const m = buildChartModel(withHighPartial);
    expect(m.peak).not.toBeNull();
    expect(m.peak!.x).toBe(m.points[1]!.x);
  });

  it('hit boxes tile the full width', () => {
    const m = buildChartModel(actualThenPartial, { dims: { width: 100 } });
    expect(m.hits[0]!.x).toBe(0);
    const last = m.hits.at(-1)!;
    expect(last.x + last.w).toBeCloseTo(100, 5);
  });

  it('labels the zero gridline and emits four left-axis lines', () => {
    const m = buildChartModel(actualThenPartial);
    expect(m.gridLines).toHaveLength(4);
    expect(m.gridLines[0]!.label).toBe('0');
    expect(m.rightTicks).toHaveLength(2);
  });
});
