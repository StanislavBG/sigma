import { describe, expect, it } from 'vitest';
import { getCompareLeaderboard, normalizeLeaderboardMetric } from './compare';

// Top rows the ranked query returns (already ordered by the metric desc).
const TOP = [
  { id: 'auth:A', name: 'Алфа', total_eur: 1000, contracts: 10, metric: 1000 },
  { id: 'auth:B', name: 'Бета', total_eur: 500, contracts: 8, metric: 500 },
];

function fakeDb(capture?: string[]): D1Database {
  return {
    prepare(sql: string) {
      if (capture) capture.push(sql);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('ORDER BY metric DESC')) return { results: TOP as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('COUNT(*)') && sql.includes('> ?')) return { n: 4 } as T; // rank count → 5
          if (sql.includes('COUNT(*)')) return { n: 200 } as T; // qualifying
          if (sql.includes('WHERE authority_id = ?'))
            return { id: 'auth:Z', name: 'Зета', total_eur: 50, contracts: 7, metric: 60 } as T;
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('normalizeLeaderboardMetric', () => {
  it('defaults unknown to total, accepts the four', () => {
    expect(normalizeLeaderboardMetric(null)).toBe('total');
    expect(normalizeLeaderboardMetric('bogus')).toBe('total');
    expect(normalizeLeaderboardMetric('avg')).toBe('avg');
    expect(normalizeLeaderboardMetric('eu')).toBe('eu');
  });
});

describe('getCompareLeaderboard', () => {
  it('ranks the field, flags highlights, and pins compared entities with their true rank', async () => {
    const board = await getCompareLeaderboard(fakeDb(), {
      kind: 'authority',
      metric: 'total',
      highlightIds: ['auth:A', 'auth:Z'],
    });
    expect(board.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(board.rows[0]).toMatchObject({ slug: 'A', name: 'Алфа', rank: 1, highlighted: true });
    expect(board.rows[1]?.highlighted).toBe(false); // auth:B not compared
    expect(board.maxValue).toBe(1000);
    expect(board.qualifying).toBe(200);
    // auth:A is in the top list → rank reused (1). auth:Z is outside → lookup + count → rank 5.
    expect(board.pinned.map((p) => [p.name, p.rank])).toEqual([
      ['Алфа', 1],
      ['Зета', 5],
    ]);
  });

  it('ranks a pinned entity outside the top with a tie-break matching the list order', async () => {
    const sql: string[] = [];
    const board = await getCompareLeaderboard(fakeDb(sql), {
      kind: 'authority',
      metric: 'total',
      highlightIds: ['auth:Z'],
    });
    const rankSql = sql.find((s) => s.includes('COUNT(*)') && s.includes('> ?'));
    expect(rankSql).toBeDefined();
    // mirrors `ORDER BY metric DESC, id`: equal-metric + smaller-id entities count as ahead, so the
    // reported rank lines up with where the entity would sit in the list.
    expect(rankSql).toMatch(/> \? OR \(.*= \? AND .*< \?\)/);
    expect(board.pinned[0]?.rank).toBe(5);
  });

  it('guards ratio metrics with a min-contracts WHERE and marks EU as a percentage', async () => {
    const sql: string[] = [];
    const board = await getCompareLeaderboard(fakeDb(sql), { kind: 'authority', metric: 'eu' });
    expect(board.isRatio).toBe(true);
    expect(board.isPct).toBe(true);
    expect(sql.some((s) => s.includes('contracts >= 5'))).toBe(true);
    expect(sql.some((s) => s.includes('eu_eur'))).toBe(true);
  });

  it('uses won_eur and the authorities reach column for companies', async () => {
    const sql: string[] = [];
    await getCompareLeaderboard(fakeDb(sql), { kind: 'company', metric: 'reach' });
    expect(sql.some((s) => s.includes('FROM company_totals'))).toBe(true);
    expect(sql.some((s) => s.includes('authorities AS metric') || s.includes('authorities,'))).toBe(
      true,
    );
  });
});
