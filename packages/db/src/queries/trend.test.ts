import { describe, expect, it } from 'vitest';
import {
  getCpvGroupMedians,
  getCpvGroupStats,
  getSpendingTrend,
  listOverviewContracts,
} from './trend';

// Fake D1 keyed by call type (same approach as competition.test.ts / regions.test.ts). Verifies the
// JS-side shaping: zero-filling gaps in the period series, the per-year summary with year-over-year
// change, coverage, and that the SQL uses month vs year substr and joins tenders only when filtering
// by sector.

const SERIES = [
  { period: '2022-01', value_eur: 1000, eu_value_eur: 400, contracts: 10 },
  { period: '2022-03', value_eur: 3000, eu_value_eur: 0, contracts: 30 }, // gap at 2022-02
  { period: '2023-01', value_eur: 5000, eu_value_eur: 2500, contracts: 50 },
];
const QUARTERS = [
  { year: '2022', quarter: 1, value_eur: 1000 },
  { year: '2022', quarter: 4, value_eur: 3000 },
  { year: '2023', quarter: 1, value_eur: 5000 },
];
const SECTOR_YEARS = [
  { division: '45', year: '2022', value_eur: 1000 },
  { division: '45', year: '2023', value_eur: 2000 },
];
const COVERAGE = { dated: 80, total: 100 };

interface QueryCall {
  sql: string;
  args: unknown[];
}

// Route .all() by query shape so the seasonality (quarters) and movers (sectorYears) scans get their
// own fixtures rather than the period series.
function resultsFor<T>(sql: string): { results: T[] } {
  if (sql.includes('AS quarter')) return { results: QUARTERS as T[] };
  if (sql.includes('AS division')) return { results: SECTOR_YEARS as T[] };
  return { results: SERIES as T[] };
}

function fakeDb(capture?: string[], asOf: string | null = null): D1Database {
  return {
    prepare(sql: string) {
      capture?.push(sql);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return resultsFor<T>(sql);
        },
        async first<T>() {
          if (sql.includes('as_of')) return { as_of: asOf } as T;
          return COVERAGE as T;
        },
      };
    },
  } as unknown as D1Database;
}

const SCOPED_SERIES = {
  national: [
    { period: '2022', value_eur: 9000, contracts: 90 },
    { period: '2023', value_eur: 3000, contracts: 30 },
  ],
  authority: [
    { period: '2022', value_eur: 4000, contracts: 40 },
    { period: '2023', value_eur: 1000, contracts: 10 },
  ],
  bidder: [
    { period: '2022', value_eur: 2000, contracts: 20 },
    { period: '2023', value_eur: 500, contracts: 5 },
  ],
};

function scopedFakeDb(calls: QueryCall[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          calls.push({ sql, args });
          return this;
        },
        async all<T>() {
          if (sql.includes('FROM sector_totals')) return { results: [{ division: '45' }] as T[] };
          if (this.args.includes('auth:111')) return { results: SCOPED_SERIES.authority as T[] };
          if (this.args.includes('eik:222')) return { results: SCOPED_SERIES.bidder as T[] };
          return { results: SCOPED_SERIES.national as T[] };
        },
        async first<T>() {
          if (sql.includes('as_of')) return { as_of: null } as T;
          if (this.args.includes('auth:111')) return { dated: 50, total: 60 } as T;
          if (this.args.includes('eik:222')) return { dated: 25, total: 30 } as T;
          return { dated: 120, total: 140 } as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('getSpendingTrend', () => {
  it('zero-fills gaps so the monthly series is continuous', async () => {
    const { points } = await getSpendingTrend(fakeDb(), {});
    expect(points).toHaveLength(13); // 2022-01 .. 2023-01 inclusive
    expect(points[0]!.period).toBe('2022-01');
    expect(points.at(-1)!.period).toBe('2023-01');
    expect(points.find((p) => p.period === '2022-02')).toMatchObject({ valueEur: 0, contracts: 0 });
  });

  it('folds months into a per-year summary with year-over-year change', async () => {
    const { years } = await getSpendingTrend(fakeDb(), {});
    expect(years).toEqual([
      {
        year: '2022',
        valueEur: 4000,
        euValueEur: 400,
        contracts: 40,
        yoyPct: null,
        partial: false,
      },
      // (5000 - 4000) / 4000
      {
        year: '2023',
        valueEur: 5000,
        euValueEur: 2500,
        contracts: 50,
        yoyPct: 0.25,
        partial: false,
      },
    ]);
  });

  it('carries the EU-funded slice on each point and folds it into the year summary', async () => {
    const { points } = await getSpendingTrend(fakeDb(), {});
    expect(points.find((p) => p.period === '2022-01')).toMatchObject({
      valueEur: 1000,
      euValueEur: 400,
    });
    // The series SELECT computes the EU slice in the same scan (no extra query).
    const captured: string[] = [];
    await getSpendingTrend(fakeDb(captured), {});
    const series = captured.find((s) => s.includes('GROUP BY period'))!;
    expect(series).toContain('WHEN c.eu_funded = 1 THEN c.amount_eur');
  });

  it('marks the as_of period and year partial and suppresses the partial year YoY', async () => {
    const { points, years } = await getSpendingTrend(fakeDb(undefined, '2023-01-15'), {});
    expect(points.at(-1)).toMatchObject({ period: '2023-01', partial: true });
    expect(points.find((p) => p.period === '2022-03')).toMatchObject({ partial: false });
    const y2023 = years.find((y) => y.year === '2023')!;
    expect(y2023).toMatchObject({ partial: true, yoyPct: null });
    expect(years.find((y) => y.year === '2022')!.partial).toBe(false);
  });

  it('reports coverage of contracts with a usable signing date', async () => {
    const { coverage, totalValueEur } = await getSpendingTrend(fakeDb(), {});
    expect(coverage).toEqual({ dated: 80, total: 100, pct: 0.8 });
    expect(totalValueEur).toBe(9000); // 1000 + 3000 + 5000
  });

  it('uses month substr by default and year substr when asked', async () => {
    const month: string[] = [];
    await getSpendingTrend(fakeDb(month), {});
    expect(month.some((s) => s.includes('substr(c.signed_at, 1, 7)'))).toBe(true);

    const year: string[] = [];
    await getSpendingTrend(fakeDb(year), { granularity: 'year' });
    expect(year.some((s) => s.includes('substr(c.signed_at, 1, 4) AS period'))).toBe(true);
  });

  it('joins tenders on the series query only when a sector filter is set', async () => {
    const seriesOf = (sqls: string[]) => sqls.find((s) => s.includes('GROUP BY period'))!;

    const plain: string[] = [];
    await getSpendingTrend(fakeDb(plain), {});
    expect(seriesOf(plain).includes('JOIN tenders')).toBe(false);

    const filtered: string[] = [];
    await getSpendingTrend(fakeDb(filtered), { sector: '45' });
    expect(seriesOf(filtered).includes('JOIN tenders t')).toBe(true);
  });

  it('returns seasonality quarters and per-sector year rows for the /trends insights', async () => {
    const { quarters, sectorYears, partialYear } = await getSpendingTrend(
      fakeDb(undefined, '2023-01-15'),
      {},
    );
    expect(partialYear).toBe('2023');
    expect(quarters).toContainEqual({ year: '2022', quarter: 4, valueEur: 3000 });
    expect(sectorYears).toContainEqual({ division: '45', year: '2023', valueEur: 2000 });
  });

  it('does not run the seasonality / movers scans when includeSectors is false', async () => {
    const captured: string[] = [];
    const { quarters, sectorYears } = await getSpendingTrend(
      fakeDb(captured),
      {},
      { includeSectors: false },
    );
    expect(quarters).toEqual([]);
    expect(sectorYears).toEqual([]);
    expect(captured.some((s) => s.includes('AS quarter'))).toBe(false);
    expect(captured.some((s) => s.includes('AS division'))).toBe(false);
  });

  it('drops the sector filter on the movers scan so sectors can be ranked against each other', async () => {
    const captured: string[] = [];
    await getSpendingTrend(fakeDb(captured), { sector: '45' });
    const movers = captured.find((s) => s.includes('AS division'))!;
    expect(movers).toContain('JOIN tenders t ON t.id = c.tender_id');
    expect(movers).not.toContain('substr(t.cpv_code, 1, 2) = ?'); // no single-sector restriction
  });

  it('scopes the trend by authorityId through the tender authority', async () => {
    const national = await getSpendingTrend(scopedFakeDb([]), { granularity: 'year' });
    const calls: QueryCall[] = [];
    const scoped = await getSpendingTrend(scopedFakeDb(calls), {
      authorityId: 'auth:111',
      granularity: 'year',
    });

    expect(scoped.totalValueEur).toBe(5000);
    expect(scoped.totalValueEur).toBeLessThan(national.totalValueEur);
    expect(scoped.years).toMatchObject([
      { year: '2022', valueEur: 4000, contracts: 40 },
      { year: '2023', valueEur: 1000, contracts: 10 },
    ]);

    const series = calls.find((c) => c.sql.includes('GROUP BY period'))!;
    expect(series.sql).toContain('JOIN tenders t ON t.id = c.tender_id');
    expect(series.sql).toContain('t.authority_id = ?');
    expect(series.args).toEqual(['2020-01-01', 'auth:111']);
  });

  it('folds monthly rows into a continuous quarterly series (queried at month grain)', async () => {
    const sqls: string[] = [];
    const { points, granularity } = await getSpendingTrend(fakeDb(sqls), {
      granularity: 'quarter',
    });
    // Quarters come from the monthly substr, not a SQL quarter expression.
    expect(sqls.some((s) => s.includes('substr(c.signed_at, 1, 7)'))).toBe(true);
    expect(granularity).toBe('quarter');
    expect(points.map((p) => p.period)).toEqual([
      '2022-Q1',
      '2022-Q2',
      '2022-Q3',
      '2022-Q4',
      '2023-Q1',
    ]);
    // 2022-01 + 2022-03 land in the same quarter; the gap quarters are zero-filled.
    expect(points[0]).toMatchObject({ valueEur: 4000, contracts: 40 });
    expect(points[1]).toMatchObject({ valueEur: 0, contracts: 0 });
    expect(points.at(-1)).toMatchObject({ valueEur: 5000, contracts: 50 });
  });

  it('marks the as_of quarter partial', async () => {
    const { points, years } = await getSpendingTrend(fakeDb(undefined, '2023-01-15'), {
      granularity: 'quarter',
    });
    expect(points.at(-1)).toMatchObject({ period: '2023-Q1', partial: true });
    expect(points.find((p) => p.period === '2022-Q1')).toMatchObject({ partial: false });
    expect(years.find((y) => y.year === '2023')).toMatchObject({ partial: true, yoyPct: null });
  });

  it('scopes the trend by bidderId through the contract bidder', async () => {
    const national = await getSpendingTrend(scopedFakeDb([]), { granularity: 'year' });
    const calls: QueryCall[] = [];
    const scoped = await getSpendingTrend(scopedFakeDb(calls), {
      bidderId: 'eik:222',
      granularity: 'year',
    });

    expect(scoped.totalValueEur).toBe(2500);
    expect(scoped.totalValueEur).toBeLessThan(national.totalValueEur);
    expect(scoped.years).toMatchObject([
      { year: '2022', valueEur: 2000, contracts: 20 },
      { year: '2023', valueEur: 500, contracts: 5 },
    ]);

    const series = calls.find((c) => c.sql.includes('GROUP BY period'))!;
    expect(series.sql).toContain('c.bidder_id = ?');
    expect(series.sql).not.toContain('JOIN tenders t');
    expect(series.args).toEqual(['2020-01-01', 'eik:222']);
  });
});

// ── Contracts overview queries ───────────────────────────────────────────────────────────────────

// Fake D1 that routes each prepared statement by SQL shape and records { sql, args } for assertions.
function overviewDb(handlers: {
  all?: (sql: string, args: unknown[]) => unknown[];
  first?: (sql: string, args: unknown[]) => unknown;
  calls?: QueryCall[];
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          handlers.calls?.push({ sql, args });
          return this;
        },
        async all<T>() {
          return { results: (handlers.all?.(sql, this.args) ?? []) as T[] };
        },
        async first<T>() {
          return (handlers.first?.(sql, this.args) ?? null) as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('getCpvGroupStats', () => {
  // cnt=101 → floor-rank percentiles: p10 at rn 11, median at rn 51, p90 at rn 91 (matches the SQL's
  // integer division). The rows below stand in for the quantile ladder the query returns.
  const DIST_33600 = [
    { v: 100, name: 'Фармацевтични продукти', rn: 1, cnt: 101 },
    { v: 1000, name: 'Фармацевтични продукти', rn: 11, cnt: 101 },
    { v: 38000, name: 'Фармацевтични продукти', rn: 51, cnt: 101 },
    { v: 200000, name: 'Медицински консумативи', rn: 91, cnt: 101 },
    { v: 900000, name: null, rn: 101, cnt: 101 },
  ];
  const DIST_45000 = [{ v: 5000, name: 'Строителни работи', rn: 1, cnt: 1 }];

  function db(calls: QueryCall[]): D1Database {
    return overviewDb({
      calls,
      all(sql, args) {
        if (sql.includes('GROUP BY grp')) {
          return [
            { grp: '33600', contracts: 101 },
            { grp: '45000', contracts: 1 },
          ];
        }
        if (args[0] === '33600') return DIST_33600;
        if (args[0] === '45000') return DIST_45000;
        return [];
      },
      first(sql) {
        if (sql.includes('COUNT(DISTINCT')) return { n: 2045 };
        return null;
      },
    });
  }

  it('returns top groups with exact floor-rank percentiles from one bounded pass per group', async () => {
    const { groups, totalGroups } = await getCpvGroupStats(db([]), 2);
    expect(totalGroups).toBe(2045);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      group: '33600',
      contracts: 101,
      p10Eur: 1000,
      medianEur: 38000,
      p90Eur: 200000,
      maxEur: 900000,
      name: 'Фармацевтични продукти', // most common description among the sample
    });
    expect(groups[0]!.sampleEur).toEqual([100, 1000, 38000, 200000, 900000]);
    // A single-contract group degenerates to that one value everywhere.
    expect(groups[1]).toMatchObject({
      group: '45000',
      p10Eur: 5000,
      medianEur: 5000,
      p90Eur: 5000,
    });
  });

  it('scans each group through a half-open cpv_code prefix range (indexable)', async () => {
    const calls: QueryCall[] = [];
    await getCpvGroupStats(db(calls), 2);
    const dist = calls.filter((c) => c.sql.includes('ROW_NUMBER() OVER'));
    expect(dist.map((c) => c.args)).toEqual([
      ['33600', '33601'],
      ['45000', '45001'],
    ]);
    expect(dist[0]!.sql).toContain('t.cpv_code >= ? AND t.cpv_code < ?');
    // The distribution query never sorts by anything unindexed and returns only picked ranks.
    expect(dist[0]!.sql).toContain('rn = (cnt - 1) * 5 / 10 + 1');
  });
});

describe('getCpvGroupMedians', () => {
  it('returns the lower median per group, dedupes and drops malformed groups', async () => {
    const calls: QueryCall[] = [];
    const db = overviewDb({
      calls,
      first(sql, args) {
        if (!sql.includes('rn = (cnt - 1) * 5 / 10 + 1')) return null;
        if (args[0] === '22112') return { v: 6300, name: ' Училищни учебници ', cnt: 10 };
        if (args[0] === '99999') return { v: 100, name: null, cnt: 3 };
        return null;
      },
    });
    const medians = await getCpvGroupMedians(db, ['22112', '22112', 'bogus', '99999', '4500']);
    expect(medians).toEqual([
      { group: '22112', name: 'Училищни учебници', contracts: 10, medianEur: 6300 },
      { group: '99999', name: null, contracts: 3, medianEur: 100 },
    ]);
    // Two valid unique groups → exactly two median statements; '…9' prefix rolls to the next char.
    const medianCalls = calls.filter((c) => c.sql.includes('rn = (cnt - 1)'));
    expect(medianCalls).toHaveLength(2);
    expect(medianCalls[1]!.args).toEqual(['99999', '9999:']);
  });

  it('is a no-op for an empty group list', async () => {
    expect(await getCpvGroupMedians(overviewDb({}), [])).toEqual([]);
  });
});

describe('listOverviewContracts', () => {
  const ROWS = [
    {
      id: 'c:abc',
      signed_at: '2025-06-01',
      amount_eur: 125000,
      cpv_code: '33600000',
      authority_name: 'УМБАЛ Александровска ЕАД',
      bidder_name: 'Апекс Инженеринг ООД',
      bidder_kind: 'company',
    },
    {
      id: 'c:def',
      signed_at: '2025-05-01',
      amount_eur: 500,
      cpv_code: null,
      authority_name: 'Община Брегово',
      bidder_name: 'Фирма А; Фирма Б',
      bidder_kind: 'consortium',
    },
  ];

  it('maps rows to overview cards (slug, display names, 5-digit group)', async () => {
    const db = overviewDb({ all: () => ROWS });
    const items = await listOverviewContracts(db, {});
    expect(items).toEqual([
      {
        id: 'abc',
        signedAt: '2025-06-01',
        valueEur: 125000,
        authorityName: 'УМБАЛ Александровска ЕАД',
        bidderName: 'Апекс Инженеринг ООД',
        cpvGroup: '33600',
      },
      {
        id: 'def',
        signedAt: '2025-05-01',
        valueEur: 500,
        authorityName: 'Община Брегово',
        bidderName: 'Фирма А и др.', // consortium folded like the rest of the site
        cpvGroup: null,
      },
    ]);
  });

  it('applies year and CPV-group cuts and the value sort, all bounded by LIMIT', async () => {
    const calls: QueryCall[] = [];
    const db = overviewDb({ calls, all: () => [] });
    await listOverviewContracts(db, { year: '2024', cpvGroup: '45233', sort: 'value', limit: 12 });
    const call = calls[0]!;
    expect(call.sql).toContain('substr(c.signed_at, 1, 4) = ?');
    expect(call.sql).toContain('t.cpv_code >= ? AND t.cpv_code < ?');
    expect(call.sql).toContain('ORDER BY c.amount_eur DESC');
    expect(call.args).toEqual(['2020-01-01', '2024', '45233', '45234', 12]);
  });

  it('defaults to newest-first within the trend window on the same value basis', async () => {
    const calls: QueryCall[] = [];
    const db = overviewDb({ calls, all: () => [] });
    await listOverviewContracts(db, {});
    const call = calls[0]!;
    expect(call.sql).toContain('ORDER BY c.signed_at DESC');
    expect(call.sql).toContain('c.amount_eur > 0');
    expect(call.sql).toContain('substr(c.signed_at, 1, 4) GLOB');
    expect(call.args).toEqual(['2020-01-01', 24]);
  });
});
