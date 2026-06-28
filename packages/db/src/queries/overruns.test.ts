import { describe, expect, it } from 'vitest';
import { getOverrunsAnalytics, getTopOverruns } from './overruns';

// getTopOverruns runs two statements (see overruns.ts): a leaderboard SELECT (carries ORDER BY +
// LIMIT, read via .all) and a corpus-totals SELECT (COUNT(*)/SUM, read via .first). There's no real
// D1 here, so the fakes key off SQL markers — the leaderboard is the one with ORDER BY. Naming the
// markers keeps the assertions reading as intent and localises any future SQL change.
const isLeaderboard = (sql: string) => sql.includes('ORDER BY');
const ordersByAbsolute = (sql: string) =>
  sql.includes('(c.current_value_eur - c.signing_value_eur) DESC');
const ordersByPercent = (sql: string) =>
  sql.includes('(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC');

const rawRow = (over: Partial<Record<string, unknown>> = {}) => ({
  contract_id: 'c:123',
  subject: 'Доставка на услуги',
  authority_id: 'auth:000695089',
  authority_name: 'Министерство на финансите',
  bidder_id: 'eik:103267194',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company' as const,
  bidder_eik: '103267194',
  signing_eur: 1_000_000,
  current_eur: 1_500_000,
  annex_count: 2,
  cpv_code: '45233110',
  cpv_description: 'Строеж на магистрали',
  procedure_type: 'Открита процедура',
  eu_funded: 1,
  eu_programme: 'ОПТТИ',
  signed_at: '2022-03-12',
  ...over,
});

// Fake D1 keyed by SQL marker: leaderboard SELECT → `rows` via .all; totals SELECT → `totals` via
// .first. Also records every prepared statement so the ordering tests can pin which ORDER BY ran.
function fakeDb(
  rows: ReturnType<typeof rawRow>[] = [rawRow()],
  totals: { total_overrun_eur: number; count: number } = { total_overrun_eur: 500_000, count: 1 },
): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
        async first<T>() {
          return totals as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql };
}

describe('getTopOverruns', () => {
  it('orders by absolute delta for by="absolute"', async () => {
    const { db, sql } = fakeDb();

    await getTopOverruns(db, { by: 'absolute' });

    const board = sql.find(isLeaderboard)!;
    expect(ordersByAbsolute(board)).toBe(true);
    expect(ordersByPercent(board)).toBe(false);
  });

  it('orders by percentage blow-up for by="percent"', async () => {
    const { db, sql } = fakeDb();

    await getTopOverruns(db, { by: 'percent' });

    const board = sql.find(isLeaderboard)!;
    expect(ordersByPercent(board)).toBe(true);
  });

  it('maps a row to slugs, delta and pct', async () => {
    const { db } = fakeDb();

    const { rows } = await getTopOverruns(db, { by: 'absolute' });

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.contractSlug).toBe('123');
    expect(r.authoritySlug).toBe('000695089');
    expect(r.bidderSlug).toBe('103267194');
    expect(r.signingEur).toBe(1_000_000);
    expect(r.currentEur).toBe(1_500_000);
    expect(r.deltaEur).toBe(500_000);
    expect(r.pct).toBeCloseTo(0.5);
    expect(r.annexCount).toBe(2);
  });

  it('maps real contract metadata for the inspector „ДЕТАЙЛИ ПО ДОГОВОРА" grid', async () => {
    const { db } = fakeDb();

    const { rows } = await getTopOverruns(db, { by: 'absolute' });
    const r = rows[0]!;

    expect(r.cpvCode).toBe('45233110');
    expect(r.cpvDescription).toBe('Строеж на магистрали');
    expect(r.sectorLabel).not.toBe('45'); // resolved to the curated CPV-division label
    expect(r.procedureType).toBe('Открита процедура');
    expect(r.euFunded).toBe(true);
    expect(r.euProgramme).toBe('ОПТТИ');
    expect(r.signedAt).toBe('2022-03-12');
    expect(r.authorityEik).toBe('000695089');
    expect(r.bidderEik).toBe('103267194');
  });

  it('keeps inspector metadata honest when columns are NULL', async () => {
    const { db } = fakeDb([
      rawRow({
        cpv_code: null,
        cpv_description: null,
        procedure_type: null,
        eu_funded: null,
        eu_programme: null,
        signed_at: null,
        bidder_eik: null,
      }),
    ]);

    const { rows } = await getTopOverruns(db, { by: 'absolute' });
    const r = rows[0]!;

    expect(r.cpvCode).toBeNull();
    expect(r.sectorLabel).toBe('Без код');
    expect(r.euFunded).toBeNull();
    expect(r.bidderEik).toBeNull();
    expect(r.signedAt).toBeNull();
  });

  it('guards against divide-by-zero by skipping rows with non-positive signing', async () => {
    const { db } = fakeDb([
      rawRow({ contract_id: 'c:ok' }),
      rawRow({ contract_id: 'c:zero', signing_eur: 0, current_eur: 10_000 }),
      rawRow({ contract_id: 'c:neg', signing_eur: -5, current_eur: 10_000 }),
    ]);

    const { rows } = await getTopOverruns(db, { by: 'percent' });

    expect(rows.map((r) => r.contractSlug)).toEqual(['ok']);
    expect(rows.every((r) => Number.isFinite(r.pct))).toBe(true);
  });

  it('passes through corpus totals (sum of deltas + count)', async () => {
    const { db } = fakeDb([rawRow()], { total_overrun_eur: 12_345_678, count: 42 });

    const result = await getTopOverruns(db, { by: 'absolute' });

    expect(result.totalOverrunEur).toBe(12_345_678);
    expect(result.count).toBe(42);
  });

  it('returns an honest empty result with zero totals', async () => {
    const { db } = fakeDb([], { total_overrun_eur: 0, count: 0 });

    const result = await getTopOverruns(db, { by: 'absolute' });

    expect(result.rows).toHaveLength(0);
    expect(result.totalOverrunEur).toBe(0);
    expect(result.count).toBe(0);
  });
});

// ── getOverrunsAnalytics ───────────────────────────────────────────────────────────
// Six bounded statements; the fake keys each off a unique SQL marker (see overruns.ts) and serves the
// right shaped result via .all (lists) or .first (single-row aggregates). Marker presence is also the
// "no duplicate COUNT / each aggregate is one bounded query" guard.
const MARKERS = {
  leaderboard: 'JOIN bidders b', // the only statement that joins bidders → the per-contract board
  corpus: 'corpus_signing_eur', // single conditional-aggregate pass
  median: 'median_pct', // window-function median
  authority: 'GROUP BY t.authority_id',
  sector: 'GROUP BY division',
  year: 'GROUP BY year',
} as const;

type AnalyticsFakes = {
  leaderboard?: ReturnType<typeof rawRow>[];
  corpus?: Record<string, number>;
  median?: { median_pct: number };
  authority?: Record<string, unknown>[];
  sector?: Record<string, unknown>[];
  year?: Record<string, unknown>[];
};

function fakeAnalyticsDb(f: AnalyticsFakes = {}): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const corpus = f.corpus ?? {
    total_overrun_eur: 9_000_000,
    count: 3,
    avg_pct: 0.5,
    corpus_signing_eur: 90_000_000,
  };
  const median = f.median ?? { median_pct: 0.42 };
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (q.includes(MARKERS.leaderboard))
            return { results: (f.leaderboard ?? [rawRow()]) as T[] };
          if (q.includes(MARKERS.authority)) return { results: (f.authority ?? []) as T[] };
          if (q.includes(MARKERS.sector)) return { results: (f.sector ?? []) as T[] };
          if (q.includes(MARKERS.year)) return { results: (f.year ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (q.includes(MARKERS.median)) return median as T;
          if (q.includes(MARKERS.corpus)) return corpus as T;
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql };
}

describe('getOverrunsAnalytics', () => {
  it('issues exactly six bounded queries, one per section', async () => {
    const { db, sql } = fakeAnalyticsDb();

    await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(sql).toHaveLength(6);
    for (const marker of Object.values(MARKERS)) {
      expect(sql.some((q) => q.includes(marker))).toBe(true);
    }
    // The corpus totals come from one conditional-aggregate pass — the count is a SUM(CASE…), not a
    // duplicate COUNT(*) over the contracts table (the perf-review trap).
    const corpusSql = sql.find((q) => q.includes(MARKERS.corpus))!;
    expect(corpusSql.includes('COUNT(*)')).toBe(false);
    expect(corpusSql.includes('SUM(CASE WHEN')).toBe(true);
  });

  it('honours the leaderboard sort toggle', async () => {
    const abs = fakeAnalyticsDb();
    await getOverrunsAnalytics(abs.db, { by: 'absolute' });
    const absBoard = abs.sql.find((q) => q.includes(MARKERS.leaderboard))!;
    expect(
      absBoard.includes('(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC'),
    ).toBe(false);

    const pctRun = fakeAnalyticsDb();
    await getOverrunsAnalytics(pctRun.db, { by: 'percent' });
    const pctBoard = pctRun.sql.find((q) => q.includes(MARKERS.leaderboard))!;
    expect(
      pctBoard.includes('(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC'),
    ).toBe(true);
  });

  it('derives share-of-signing from the corpus aggregate', async () => {
    const { db } = fakeAnalyticsDb({
      corpus: {
        total_overrun_eur: 9_000_000,
        count: 3,
        avg_pct: 0.5,
        corpus_signing_eur: 90_000_000,
      },
      median: { median_pct: 0.42 },
    });

    const { corpus } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(corpus.totalOverrunEur).toBe(9_000_000);
    expect(corpus.count).toBe(3);
    expect(corpus.avgPct).toBeCloseTo(0.5);
    expect(corpus.medianPct).toBeCloseTo(0.42);
    expect(corpus.shareOfSigning).toBeCloseTo(0.1); // 9M / 90M
  });

  it('guards share-of-signing against a zero denominator', async () => {
    const { db } = fakeAnalyticsDb({
      corpus: {
        total_overrun_eur: 0,
        count: 0,
        avg_pct: 0,
        corpus_signing_eur: 0,
      },
      median: { median_pct: 0 },
    });

    const { corpus } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(corpus.shareOfSigning).toBe(0);
    expect(Number.isFinite(corpus.shareOfSigning)).toBe(true);
  });

  it('maps authority rows to slugs and clean names', async () => {
    const { db } = fakeAnalyticsDb({
      authority: [
        {
          authority_id: 'auth:000695089',
          authority_name: 'Министерство на финансите',
          total_overrun_eur: 5_000_000,
          avg_pct: 0.3,
          count: 7,
        },
      ],
    });

    const { byAuthority } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(byAuthority).toHaveLength(1);
    expect(byAuthority[0]!.authoritySlug).toBe('000695089');
    expect(byAuthority[0]!.totalOverrunEur).toBe(5_000_000);
    expect(byAuthority[0]!.count).toBe(7);
  });

  it('labels CPV divisions and falls back for unknown / missing codes', async () => {
    const { db } = fakeAnalyticsDb({
      sector: [
        { division: '45', total_overrun_eur: 8_000_000, avg_pct: 0.4, count: 12 },
        { division: '99', total_overrun_eur: 2_000_000, avg_pct: 0.2, count: 3 },
        { division: null, total_overrun_eur: 1_000_000, avg_pct: 0.1, count: 1 },
      ],
    });

    const { bySector } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(bySector[0]!.label).not.toBe('45'); // resolved to the curated/official CPV label
    expect(bySector[1]!.label).toBe('Сектор 99'); // present in corpus but not in the taxonomy
    expect(bySector[2]!.label).toBe('Без код'); // NULL cpv_code
  });

  it('passes through the by-year trend buckets', async () => {
    const { db } = fakeAnalyticsDb({
      year: [
        { year: '2021', total_overrun_eur: 3_000_000, count: 4 },
        { year: 'Неизвестна', total_overrun_eur: 500_000, count: 2 },
      ],
    });

    const { byYear } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(byYear.map((r) => r.year)).toEqual(['2021', 'Неизвестна']);
    expect(byYear[0]!.totalOverrunEur).toBe(3_000_000);
  });

  it('returns honest empty breakdowns when there are no overruns', async () => {
    const { db } = fakeAnalyticsDb({
      leaderboard: [],
      corpus: {
        total_overrun_eur: 0,
        count: 0,
        avg_pct: 0,
        corpus_signing_eur: 0,
      },
      median: { median_pct: 0 },
      authority: [],
      sector: [],
      year: [],
    });

    const { rows, byAuthority, bySector, byYear, corpus } = await getOverrunsAnalytics(db, {
      by: 'absolute',
    });

    expect(rows).toHaveLength(0);
    expect(byAuthority).toHaveLength(0);
    expect(bySector).toHaveLength(0);
    expect(byYear).toHaveLength(0);
    expect(corpus.count).toBe(0);
  });
});
