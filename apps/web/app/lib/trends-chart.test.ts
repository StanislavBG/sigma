import { describe, expect, it } from 'vitest';
import { buildChartModel } from './trends-chart';
import type { DisplayPoint } from './trends-series';

function pt(over: Partial<DisplayPoint> & { key: string }): DisplayPoint {
  return {
    label: over.key,
    tick: null,
    valueEur: 0,
    contracts: 0,
    forecast: false,
    partial: false,
    ...over,
  };
}

const actualThenForecast: DisplayPoint[] = [
  pt({ key: 'a', valueEur: 10, contracts: 5 }),
  pt({ key: 'b', valueEur: 40, contracts: 8 }), // peak
  pt({ key: 'c', valueEur: 20, contracts: 6, partial: true }),
  pt({ key: 'd', valueEur: 25, contracts: 7, forecast: true }),
  pt({ key: 'e', valueEur: 30, contracts: 9, forecast: true }),
];

describe('buildChartModel', () => {
  it('emits one bar and one hit box per point and finds the first forecast index', () => {
    const m = buildChartModel(actualThenForecast);
    expect(m.bars).toHaveLength(5);
    expect(m.hits).toHaveLength(5);
    expect(m.points).toHaveLength(5);
    expect(m.firstForecastIndex).toBe(3);
    expect(m.bars[3]!.forecast).toBe(true);
  });

  it('draws the forecast band + today divider only across the projected tail', () => {
    const m = buildChartModel(actualThenForecast);
    expect(m.todayX).not.toBeNull();
    expect(m.band).not.toBeNull();
    expect(m.band!.w).toBeGreaterThan(0);
    expect(m.actualLine).not.toBe('');
    expect(m.forecastLine).not.toBe('');
  });

  it('omits the band when there is no forecast', () => {
    const m = buildChartModel([
      pt({ key: 'a', valueEur: 10, contracts: 5 }),
      pt({ key: 'b', valueEur: 20, contracts: 6 }),
    ]);
    expect(m.firstForecastIndex).toBe(2);
    expect(m.band).toBeNull();
    expect(m.todayX).toBeNull();
    expect(m.forecastLine).toBe('');
  });

  it('places the peak on the highest complete (non-partial, non-forecast) point', () => {
    const m = buildChartModel(actualThenForecast);
    // peak is point index 1 (value 40); its x must match that point
    expect(m.peak).not.toBeNull();
    expect(m.peak!.x).toBe(m.points[1]!.x);
  });

  it('hit boxes tile the full width', () => {
    const m = buildChartModel(actualThenForecast, { dims: { width: 100 } });
    expect(m.hits[0]!.x).toBe(0);
    const last = m.hits.at(-1)!;
    expect(last.x + last.w).toBeCloseTo(100, 5);
  });

  it('labels the zero gridline and emits four left-axis lines', () => {
    const m = buildChartModel(actualThenForecast);
    expect(m.gridLines).toHaveLength(4);
    expect(m.gridLines[0]!.label).toBe('0');
    expect(m.rightTicks).toHaveLength(2);
  });
});
