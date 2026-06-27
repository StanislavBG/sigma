import { describe, expect, it } from 'vitest';
import { getTopOverruns } from './overruns';

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
  signing_eur: 1_000_000,
  current_eur: 1_500_000,
  annex_count: 2,
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
