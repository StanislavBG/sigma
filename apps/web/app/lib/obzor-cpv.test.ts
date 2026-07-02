import { describe, expect, it } from 'vitest';
import type { CohortStatRow } from '@sigma/db';
import {
  axisLabel,
  jitter,
  LOG_MIN,
  logMax,
  makeLx,
  multText,
  relLabel,
  toLensGroup,
} from './obzor-cpv';

const cohort = (over: Partial<CohortStatRow> = {}): CohortStatRow => ({
  code: '45233',
  label: 'Строителни работи по пътища',
  n: 4200,
  medianEur: 150_000,
  logMad: 1.1,
  outlierCount: 17,
  inflatedShare: 0.31,
  sample: [1_000, 5_000, 20_000, 80_000, 150_000, 400_000, 900_000, 2_000_000, 9_000_000],
  ...over,
});

describe('toLensGroup — rollup row → lens table row', () => {
  it('carries the rollup figures through unchanged (median, n, outliers — never recomputed)', () => {
    const g = toLensGroup(cohort());
    expect(g.group).toBe('45233');
    expect(g.name).toBe('Строителни работи по пътища');
    expect(g.contracts).toBe(4200);
    expect(g.medianEur).toBe(150_000);
    expect(g.outlierCount).toBe(17);
    expect(g.sampleEur).toEqual(cohort().sample); // the real sampled values, none invented
  });

  it('reads p10/p90/max off the stored quantile sample', () => {
    const g = toLensGroup(cohort());
    // 9 points, floor-rank: p10 → idx 0, p90 → idx 7, max → last.
    expect(g.p10Eur).toBe(1_000);
    expect(g.p90Eur).toBe(2_000_000);
    expect(g.maxEur).toBe(9_000_000);
  });

  it('sorts a stray unsorted sample before deriving quantiles', () => {
    const g = toLensGroup(cohort({ sample: [500_000, 1_000, 90_000] }));
    expect(g.sampleEur).toEqual([1_000, 90_000, 500_000]);
    expect(g.p10Eur).toBe(1_000);
    expect(g.maxEur).toBe(500_000);
  });

  it('falls back to the median (not a fabricated spread) when the sample is empty', () => {
    const g = toLensGroup(cohort({ sample: [] }));
    expect(g.p10Eur).toBe(150_000);
    expect(g.p90Eur).toBe(150_000);
    expect(g.maxEur).toBe(150_000);
    expect(g.sampleEur).toEqual([]);
  });
});

describe('relLabel — „спрямо типичното" badge banding (design spec)', () => {
  it('flags ≥1.3× as „×N типичното" with the accent token', () => {
    expect(relLabel(130, 100)).toEqual({ text: '×1,3 типичното', cls: 'ov-rel-hi' });
    expect(relLabel(2_400, 1_000)).toEqual({ text: '×2,4 типичното', cls: 'ov-rel-hi' });
  });

  it('rounds huge multiples to an integer ×N', () => {
    expect(relLabel(15_400, 1_000)).toEqual({ text: '×15 типичното', cls: 'ov-rel-hi' });
  });

  it('flags ≤0.75× as „под типичното"', () => {
    expect(relLabel(75, 100)).toEqual({ text: 'под типичното', cls: 'ov-rel-lo' });
    expect(relLabel(10, 100).cls).toBe('ov-rel-lo');
  });

  it('reads the band between the thresholds as „≈ типичното"', () => {
    expect(relLabel(100, 100)).toEqual({ text: '≈ типичното', cls: 'ov-rel-mid' });
    expect(relLabel(129, 100).cls).toBe('ov-rel-mid'); // just under the 1.3 edge
    expect(relLabel(76, 100).cls).toBe('ov-rel-mid'); // just over the 0.75 edge
  });

  it('multText uses a Bulgarian decimal comma below ×10 and integers at/above', () => {
    expect(multText(2.44)).toBe('×2,4');
    expect(multText(9.96)).toBe('×10');
    expect(multText(15.4)).toBe('×15');
  });
});

describe('jitter — deterministic dot spread', () => {
  it('is pure: same seed + index ⇒ same value (SSR and client agree)', () => {
    expect(jitter('45233', 3)).toBe(jitter('45233', 3));
    expect(jitter('45233', 3)).not.toBe(jitter('45233', 4));
    expect(jitter('45233', 3)).not.toBe(jitter('15000', 3));
  });

  it('stays within the strip band [−0.5, 0.5)', () => {
    for (let i = 0; i < 200; i++) {
      const v = jitter('33600', i);
      expect(v).toBeGreaterThanOrEqual(-0.5);
      expect(v).toBeLessThan(0.5);
    }
  });
});

describe('log axis', () => {
  it('logMax snaps the page extent to the next power of 10, floored at 1M', () => {
    expect(logMax([toLensGroup(cohort())])).toBe(1e7); // max 9M → 10M
    expect(logMax([toLensGroup(cohort({ sample: [2_000] }))])).toBe(1e6); // tiny cohort → 1M floor
  });

  it('axisLabel renders the design ticks (1к … 100М)', () => {
    expect([1e3, 1e4, 1e5, 1e6, 1e7, 1e8].map(axisLabel)).toEqual([
      '1к',
      '10к',
      '100к',
      '1М',
      '10М',
      '100М',
    ]);
  });

  it('makeLx maps the log domain onto the 320px strip and clamps out-of-domain values', () => {
    const lx = makeLx(1e8);
    expect(lx(LOG_MIN)).toBeCloseTo(6, 5); // left pad
    expect(lx(1e8)).toBeCloseTo(314, 5); // right edge
    expect(lx(1)).toBeCloseTo(6, 5); // clamped low
    expect(lx(1e12)).toBeCloseTo(314, 5); // clamped high
    expect(lx(1e5) < lx(1e6)).toBe(true); // monotone
  });
});
