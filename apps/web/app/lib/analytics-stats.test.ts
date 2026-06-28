import { describe, expect, it } from 'vitest';
import {
  formatPeakMonth,
  formatPpChange,
  formatYearlyGrowth,
  growthMultiple,
  opaqueHeadline,
  peakPoint,
  type OpaqueShareYear,
  type PeakablePoint,
} from './analytics-stats';

describe('growthMultiple', () => {
  it('turns a median overrun pct into 1 + pct as a ×-multiple', () => {
    expect(growthMultiple(2.1)).toBe('3,1×');
    expect(growthMultiple(0.5)).toBe('1,5×');
    expect(growthMultiple(0)).toBe('1,0×');
  });
  it('returns an em-dash for absent / non-finite input', () => {
    expect(growthMultiple(null)).toBe('—');
    expect(growthMultiple(undefined)).toBe('—');
    expect(growthMultiple(NaN)).toBe('—');
  });
});

describe('formatYearlyGrowth', () => {
  it('formats a ratio as a signed integer percent per year', () => {
    expect(formatYearlyGrowth(0.18)).toBe('+18%/год');
    expect(formatYearlyGrowth(-0.04)).toBe('−4%/год');
  });
  it('returns an em-dash for null', () => {
    expect(formatYearlyGrowth(null)).toBe('—');
  });
});

describe('peakPoint / formatPeakMonth', () => {
  const points: PeakablePoint[] = [
    { period: '2025-01', valueEur: 100 },
    { period: '2025-12', valueEur: 900 },
    { period: '2026-06', valueEur: 999, partial: true }, // partial — skipped
  ];
  it('finds the highest-value complete period', () => {
    expect(peakPoint(points)?.period).toBe('2025-12');
  });
  it('returns null for an empty / all-partial series', () => {
    expect(peakPoint([])).toBeNull();
    expect(peakPoint([{ period: '2026-06', valueEur: 5, partial: true }])).toBeNull();
  });
  it('abbreviates the month for the peak label', () => {
    expect(formatPeakMonth('2025-12')).toBe('дек 2025');
    expect(formatPeakMonth('2024-01')).toBe('яну 2024');
    expect(formatPeakMonth(null)).toBe('—');
  });
});

describe('opaqueHeadline / formatPpChange', () => {
  const rows: OpaqueShareYear[] = [
    { year: '2020', valueEur: 1000, singleOfferValueEur: 200 }, // 20%
    { year: '2021', valueEur: 0, singleOfferValueEur: 0 }, // no value — dropped
    { year: '2025', valueEur: 1000, singleOfferValueEur: 350 }, // 35%
  ];
  it('reads first vs latest single-offer value share and the pp swing', () => {
    const h = opaqueHeadline(rows)!;
    expect(h.firstYear).toBe('2020');
    expect(h.latestYear).toBe('2025');
    expect(h.firstShare).toBeCloseTo(0.2);
    expect(h.latestShare).toBeCloseTo(0.35);
    expect(h.ppChange).toBeCloseTo(0.15);
  });
  it('returns null when no year has value', () => {
    expect(opaqueHeadline([{ year: '2020', valueEur: 0, singleOfferValueEur: 0 }])).toBeNull();
    expect(opaqueHeadline([])).toBeNull();
  });
  it('formats a percentage-point swing', () => {
    expect(formatPpChange(0.15)).toBe('+15 пр.п.');
    expect(formatPpChange(-0.03)).toBe('−3 пр.п.');
    expect(formatPpChange(0)).toBe('0 пр.п.');
    expect(formatPpChange(null)).toBe('—');
  });
});
