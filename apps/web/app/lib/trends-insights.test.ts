import { describe, expect, it } from 'vitest';
import {
  computeFundingSplit,
  computeSeasonality,
  computeTopMovers,
  type QuarterValue,
  type SectorYearValue,
} from './trends-insights';

describe('computeSeasonality', () => {
  const fullYear = (year: string, q: [number, number, number, number]): QuarterValue[] =>
    q.map((valueEur, i) => ({ year, quarter: i + 1, valueEur }));

  it('computes the Q4 share over complete years and the excess over an even split', () => {
    const rows = [
      ...fullYear('2021', [100, 100, 100, 200]),
      ...fullYear('2022', [100, 100, 100, 200]),
    ];
    const s = computeSeasonality(rows, { partialYear: null })!;
    expect(s.totalValueEur).toBe(1000);
    expect(s.q4ValueEur).toBe(400);
    expect(s.q4ShareRatio).toBeCloseTo(0.4);
    expect(s.completeYears).toBe(2);
    expect(s.excessOverEven).toBeCloseTo(0.15); // 0.40 − 0.25
  });

  it('excludes the partial (running) year so a mid-year as_of cannot understate Q4', () => {
    const rows = [
      ...fullYear('2022', [100, 100, 100, 200]),
      // 2023 is still running: only Q1 has landed; including it would dilute the Q4 share.
      { year: '2023', quarter: 1, valueEur: 500 },
    ];
    const s = computeSeasonality(rows, { partialYear: '2023' })!;
    expect(s.completeYears).toBe(1);
    expect(s.totalValueEur).toBe(500);
    expect(s.q4ShareRatio).toBeCloseTo(0.4);
  });

  it('returns null when no complete year has any value', () => {
    expect(computeSeasonality([], { partialYear: null })).toBeNull();
    expect(
      computeSeasonality([{ year: '2024', quarter: 1, valueEur: 999 }], { partialYear: '2024' }),
    ).toBeNull();
  });
});

describe('computeFundingSplit', () => {
  it('sums EU and derives national as the remainder', () => {
    const split = computeFundingSplit([
      { valueEur: 1000, euValueEur: 400 },
      { valueEur: 1000, euValueEur: 100 },
    ]);
    expect(split.totalEur).toBe(2000);
    expect(split.euEur).toBe(500);
    expect(split.nationalEur).toBe(1500);
    expect(split.euShareRatio).toBeCloseTo(0.25);
  });

  it('clamps national at zero and reports a zero share for an empty scope', () => {
    expect(computeFundingSplit([{ valueEur: 100, euValueEur: 150 }]).nationalEur).toBe(0);
    expect(computeFundingSplit([]).euShareRatio).toBe(0);
  });
});

describe('computeTopMovers', () => {
  const labels = new Map([
    ['45', 'Строителство'],
    ['33', 'Медицина'],
    ['72', 'ИТ услуги'],
  ]);
  const rows: SectorYearValue[] = [
    { division: '45', year: '2021', valueEur: 1000 },
    { division: '45', year: '2022', valueEur: 1600 }, // +600
    { division: '33', year: '2021', valueEur: 2000 },
    { division: '33', year: '2022', valueEur: 800 }, // −1200
    { division: '72', year: '2021', valueEur: 0 },
    { division: '72', year: '2022', valueEur: 300 }, // +300, no honest pct (prev 0)
  ];

  it('ranks the two most recent complete years by absolute euro change', () => {
    const m = computeTopMovers(rows, labels, { partialYear: null })!;
    expect(m.prevYear).toBe('2021');
    expect(m.curYear).toBe('2022');
    expect(m.risers.map((r) => r.division)).toEqual(['45', '72']);
    expect(m.fallers.map((r) => r.division)).toEqual(['33']);
    expect(m.risers[0]).toMatchObject({ label: 'Строителство', deltaEur: 600, yoyPct: 0.6 });
    expect(m.risers[1]!.yoyPct).toBeNull(); // 72 grew from a zero base
    expect(m.fallers[0]).toMatchObject({ deltaEur: -1200, yoyPct: -0.6 });
  });

  it('compares the last two complete years and ignores the partial year', () => {
    const withPartial = [...rows, { division: '45', year: '2023', valueEur: 99999 }];
    const m = computeTopMovers(withPartial, labels, { partialYear: '2023' })!;
    expect(m.curYear).toBe('2022');
    expect(m.prevYear).toBe('2021');
  });

  it('falls back to the raw division code when no label is known', () => {
    const m = computeTopMovers(
      [
        { division: '99', year: '2021', valueEur: 10 },
        { division: '99', year: '2022', valueEur: 40 },
      ],
      labels,
      { partialYear: null },
    )!;
    expect(m.risers[0]!.label).toBe('99');
  });

  it('returns null without two complete years to compare', () => {
    expect(
      computeTopMovers([{ division: '45', year: '2022', valueEur: 5 }], labels, {
        partialYear: null,
      }),
    ).toBeNull();
  });
});
