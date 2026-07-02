import { describe, expect, it } from 'vitest';
import {
  getCohortLabel,
  getCohortMedians,
  getCohortOutliers,
  getCohortStats,
  getPriceAnomalyKpis,
  MIN_COHORT_SIZE,
  Z_THRESHOLD,
} from './price-anomaly';

// No real D1 here — the fakes key off SQL markers (repo convention). getCohortStats runs two
// statements: the cohort rows (FROM cpv_cohort_stats) and the samples (FROM cpv_cohort_sample).
const isStats = (sql: string) => sql.includes('FROM cpv_cohort_stats');
const isSamples = (sql: string) => sql.includes('FROM cpv_cohort_sample');
const isOutliers = (sql: string) => sql.includes('FROM cpv_cohort_outlier');

const statRaw = (over: Partial<Record<string, unknown>> = {}) => ({
  code: '45000',
  label: 'Строителни и монтажни работи',
  n: 1200,
  median_eur: 96185,
  log_mad: 1.4,
  outlier_count: 68,
  inflated_share: 0.42,
  ...over,
});

const outlierRaw = (over: Partial<Record<string, unknown>> = {}) => ({
  contract_id: 'c:123',
  subject: 'Строеж на магистрала',
  code: '45233',
  value_eur: 50_000_000,
  mult: 326.5,
  percentile: 100,
  window_median_eur: 153_139,
  authority_id: 'auth:000695089',
  authority_name: 'Министерство на финансите',
  bidder_id: 'eik:103267194',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company' as const,
  bidder_eik: '103267194',
  cpv_code: '45233110',
  cpv_description: 'Строеж на магистрали',
  signed_at: '2022-03-12',
  ...over,
});

// Fake D1 that records every prepared SQL + bound params and serves a shaped result by marker.
function fakeDb(opts: {
  stats?: ReturnType<typeof statRaw>[];
  samples?: { code: string; value_eur: number }[];
  outliers?: ReturnType<typeof outlierRaw>[];
  kpis?: { cohort_count: number; flagged_count: number } | null;
}): { db: D1Database; sql: string[]; bound: unknown[][] } {
  const sql: string[] = [];
  const bound: unknown[][] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind(...args: unknown[]) {
          bound.push(args);
          return this;
        },
        async all<T>() {
          if (isSamples(q)) return { results: (opts.samples ?? []) as T[] };
          if (isStats(q)) return { results: (opts.stats ?? []) as T[] };
          if (isOutliers(q)) return { results: (opts.outliers ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          return (opts.kpis ?? null) as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql, bound };
}

describe('getCohortStats', () => {
  it('reads cohort rows + attaches the per-cohort sample (two bounded queries)', async () => {
    const { db, sql, bound } = fakeDb({
      stats: [statRaw({ code: '45000' }), statRaw({ code: '15000', label: 'Храни' })],
      samples: [
        { code: '45000', value_eur: 10 },
        { code: '45000', value_eur: 20 },
        { code: '15000', value_eur: 5 },
      ],
    });

    const rows = await getCohortStats(db, {});

    expect(sql).toHaveLength(2); // cohort rows + samples, no third query, no recomputed median
    expect(rows).toHaveLength(2);
    expect(rows[0]!.code).toBe('45000');
    expect(rows[0]!.medianEur).toBe(96185);
    expect(rows[0]!.sample).toEqual([10, 20]);
    expect(rows[1]!.sample).toEqual([5]);
    // the sample query binds only the returned codes (IN-list bounded by the page LIMIT)
    expect(bound[1]).toEqual(['45000', '15000']);
  });

  it('runs only one query and skips the sample fetch when there are no cohorts', async () => {
    const { db, sql } = fakeDb({ stats: [] });
    const rows = await getCohortStats(db, {});
    expect(rows).toEqual([]);
    expect(sql).toHaveLength(1); // never issues the IN-list with an empty code set
  });

  it('whitelists the sort column — inflated share, outlier count or n', async () => {
    for (const [sort, frag] of [
      ['inflatedShare', 'inflated_share DESC, code'],
      ['outlierCount', 'outlier_count DESC, code'],
      ['n', 'n DESC, code'],
    ] as const) {
      const { db, sql } = fakeDb({ stats: [statRaw()], samples: [] });
      await getCohortStats(db, { sort });
      expect(sql.find(isStats)!).toContain(frag);
    }
  });

  it('caps the limit and binds it (page 1 ⇒ offset 0)', async () => {
    const { db, bound } = fakeDb({ stats: [statRaw()], samples: [] });
    await getCohortStats(db, { limit: 99999 }); // over MAX → falls back to the default
    expect(bound[0]).toEqual([50, 0]); // capped LIMIT, then OFFSET 0
  });

  it('derives the OFFSET from page × limit and binds LIMIT then OFFSET', async () => {
    const { db, sql, bound } = fakeDb({ stats: [statRaw()], samples: [] });
    await getCohortStats(db, { page: 3, limit: 10 });
    expect(sql.find(isStats)!).toContain('LIMIT ? OFFSET ?');
    expect(bound[0]).toEqual([10, 20]); // page 3 of 10 ⇒ offset 20
  });

  it('accepts an explicit offset and clamps a stray negative to 0', async () => {
    const a = fakeDb({ stats: [statRaw()], samples: [] });
    await getCohortStats(a.db, { offset: 30, limit: 10 });
    expect(a.bound[0]).toEqual([10, 30]);

    const b = fakeDb({ stats: [statRaw()], samples: [] });
    await getCohortStats(b.db, { offset: -5, page: -2, limit: 10 });
    expect(b.bound[0]).toEqual([10, 0]);
  });

  it('filters to the selected codes via an IN-list and bypasses the pager (no LIMIT/OFFSET)', async () => {
    const { db, sql, bound } = fakeDb({
      stats: [statRaw({ code: '63712', label: 'Услуги, свързани с пътен транспорт' })],
      samples: [{ code: '63712', value_eur: 7 }],
    });

    const rows = await getCohortStats(db, { codes: ['63712', '45000'] });

    const statsSql = sql.find(isStats)!;
    expect(statsSql).toContain('WHERE code IN (?, ?)');
    expect(statsSql).not.toContain('LIMIT'); // the IN-list bounds the read; no pager
    expect(bound[0]).toEqual(['63712', '45000']); // just the codes, no LIMIT/OFFSET
    expect(rows[0]!.code).toBe('63712');
    expect(rows[0]!.n).toBe(1200);
    expect(rows[0]!.sample).toEqual([7]);
  });
});

describe('getCohortLabel', () => {
  it('returns the cohort label for a known 5-digit CPV', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind() {
            return this;
          },
          async first<T>() {
            return { label: 'Услуги, свързани с пътен транспорт' } as T;
          },
        };
      },
    } as unknown as D1Database;
    expect(await getCohortLabel(db, '63712')).toBe('Услуги, свързани с пътен транспорт');
  });

  it('returns null for a CPV with no cohort', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first<T>() {
            return null as T;
          },
        };
      },
    } as unknown as D1Database;
    expect(await getCohortLabel(db, '00000')).toBeNull();
  });
});

describe('getCohortOutliers', () => {
  it('maps a flagged contract to slugs, mult and percentile (one query, no filter)', async () => {
    const { db, sql, bound } = fakeDb({ outliers: [outlierRaw()] });

    const rows = await getCohortOutliers(db, {});

    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toContain('WHERE o.code IN'); // corpus-wide when no codes given
    expect(bound[0]).toEqual([50]); // just the LIMIT
    const r = rows[0]!;
    expect(r.contractSlug).toBe('123');
    expect(r.authoritySlug).toBe('000695089');
    expect(r.bidderSlug).toBe('103267194');
    expect(r.mult).toBe(326.5);
    expect(r.percentile).toBe(100);
    expect(r.windowMedianEur).toBe(153_139);
    expect(r.subject).toBe('Строеж на магистрала');
    expect(r.cpvCode).toBe('45233110');
    expect(r.bidderEik).toBe('103267194');
  });

  it('filters to the selected cohort codes via a bounded IN-list', async () => {
    const { db, sql, bound } = fakeDb({ outliers: [] });

    await getCohortOutliers(db, { codes: ['45000', '45233'], limit: 25 });

    expect(sql[0]).toContain('WHERE o.code IN (?, ?)');
    expect(bound[0]).toEqual(['45000', '45233', 25]); // codes then LIMIT
  });

  it('keeps honest NULLs (no subject / unknown bidder ЕИК)', async () => {
    const { db } = fakeDb({
      outliers: [outlierRaw({ subject: null, bidder_eik: null, cpv_code: null, signed_at: null })],
    });
    const [r] = await getCohortOutliers(db, {});
    expect(r!.subject).toBeNull();
    expect(r!.bidderEik).toBeNull();
    expect(r!.cpvCode).toBeNull();
    expect(r!.signedAt).toBeNull();
  });
});

describe('getPriceAnomalyKpis', () => {
  it('returns cohort + flagged counts with the methodology thresholds', async () => {
    const { db } = fakeDb({ kpis: { cohort_count: 583, flagged_count: 1333 } });
    const kpis = await getPriceAnomalyKpis(db);
    expect(kpis).toEqual({
      cohortCount: 583,
      flaggedCount: 1333,
      minCohortSize: MIN_COHORT_SIZE,
      zThreshold: Z_THRESHOLD,
    });
  });

  it('defaults to zero counts when the rollups are empty', async () => {
    const { db } = fakeDb({ kpis: null });
    const kpis = await getPriceAnomalyKpis(db);
    expect(kpis.cohortCount).toBe(0);
    expect(kpis.flaggedCount).toBe(0);
  });
});

describe('getCohortMedians', () => {
  it('reads the badge baselines from the rollup via ONE IN-list query (no live median)', async () => {
    const { db, sql, bound } = fakeDb({
      stats: [
        statRaw({ code: '15000', label: 'Храни', n: 210, median_eur: 4200 }),
        statRaw({ code: '45000' }),
      ],
    });
    const rows = await getCohortMedians(db, ['45000', '15000', '45000']); // duplicate collapses
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('FROM cpv_cohort_stats');
    expect(sql[0]).not.toMatch(/contracts|tenders|ROW_NUMBER/); // rollup-sourced, never a corpus scan
    expect(bound[0]).toEqual(['45000', '15000']);
    expect(rows).toEqual([
      { code: '15000', label: 'Храни', n: 210, medianEur: 4200 },
      { code: '45000', label: 'Строителни и монтажни работи', n: 1200, medianEur: 96185 },
    ]);
  });

  it('drops malformed codes and issues no query when nothing valid remains', async () => {
    const { db, sql } = fakeDb({ stats: [] });
    const rows = await getCohortMedians(db, ['4500', 'abcde', "45000' OR 1=1 --", '']);
    expect(rows).toEqual([]);
    expect(sql).toHaveLength(0); // nothing valid ⇒ no round trip
  });

  it('omits codes without a stored cohort instead of fabricating a baseline', async () => {
    const { db } = fakeDb({ stats: [statRaw({ code: '45000' })] });
    const rows = await getCohortMedians(db, ['45000', '99999']);
    expect(rows.map((r) => r.code)).toEqual(['45000']); // 99999 absent — honest, not invented
  });
});
