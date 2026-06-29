// Spending over time — procurement value per period (month or year) for the /trends chart. Live
// aggregation over contracts on the site-wide value basis (amount_eur IS NOT NULL, matching the rollups), within the
// 2020 -> today window; missing periods are zero-filled so the line is continuous. Contracts without a
// usable signing date are excluded from the series and reported as coverage. Edge-cached at the route,
// like getFlows; precompute is a possible follow-up.

import type { TrendData, TrendPoint, TrendYear } from '@sigma/api-contract';
import { sectorOptions } from './sectors';

// /trends-only extras layered on top of TrendData: the EU-funded slice of each point/year (for the
// EU-vs-national split), the partial year (so the page can exclude it from derived stats), and the
// raw rows for the seasonality callout and the year-over-year sector "top movers". The pure
// derivations live in apps/web/app/lib/trends-insights.ts; this query only supplies the building
// blocks. The two extra aggregations are gated behind includeSectors, so entity/analytics embeds
// that pass includeSectors:false never pay for them.
export interface TrendPointPlus extends TrendPoint {
  euValueEur: number; // EU-funded value within the period; national = valueEur − euValueEur
}
export interface TrendYearPlus extends TrendYear {
  euValueEur: number;
}
export interface TrendQuarterValue {
  year: string; // 'YYYY'
  quarter: number; // 1..4
  valueEur: number;
}
export interface TrendSectorYearValue {
  division: string; // CPV division (first 2 digits of cpv_code)
  year: string; // 'YYYY'
  valueEur: number;
}
export interface TrendDataPlus extends Omit<TrendData, 'points' | 'years'> {
  points: TrendPointPlus[];
  years: TrendYearPlus[];
  partialYear: string | null;
  quarters: TrendQuarterValue[]; // per (year, quarter) value, for the seasonality callout
  sectorYears: TrendSectorYearValue[]; // per (division, year) value, for the top-movers list
}

export interface TrendParams {
  sector?: string | null;
  funding?: 'all' | 'eu' | 'national';
  granularity?: 'month' | 'year';
  authorityId?: string | null;
  bidderId?: string | null;
}

export interface TrendQueryOptions {
  includeSectors?: boolean;
  // The seasonality (quarters) + top-movers (sectorYears) scans. Defaults to includeSectors so existing
  // callers are unchanged; the /trends dashboard sets it false (it renders neither) to drop two scans.
  includeInsights?: boolean;
}

const START = '2020-01-01';
// A real signing year is YYYY at the head of signed_at; null/malformed dates are excluded from the
// series (and counted as undated for coverage). Mirrors the check in queries/contracts.ts.
const YEAR_KNOWN = "substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'";

interface PeriodRow {
  period: string;
  value_eur: number;
  eu_value_eur: number;
  contracts: number;
}

interface CoverageRow {
  dated: number;
  total: number;
}

interface QuarterRow {
  year: string;
  quarter: number;
  value_eur: number;
}

interface SectorYearRow {
  division: string;
  year: string;
  value_eur: number;
}

// Shared value + sector/funding scope (the date window lives only on the series query).
function scope(p: TrendParams): { join: string; where: string[]; params: unknown[] } {
  // One value basis for the whole site: the rollups (authority_totals / home_totals / flow_pairs) sum
  // amount_eur IS NOT NULL, so the trend must too, or the same total differs between pages.
  const where = ['c.amount_eur IS NOT NULL'];
  const params: unknown[] = [];
  const join = p.sector || p.authorityId ? 'JOIN tenders t ON t.id = c.tender_id' : '';
  if (p.sector) {
    where.push('substr(t.cpv_code, 1, 2) = ?');
    params.push(p.sector);
  }
  if (p.authorityId) {
    where.push('t.authority_id = ?');
    params.push(p.authorityId);
  }
  if (p.bidderId) {
    where.push('c.bidder_id = ?');
    params.push(p.bidderId);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  return { join, where, params };
}

// Top-movers compares sectors against each other, so it deliberately drops the sector filter (a
// single-sector scope has nothing to rank) but keeps funding/authority/bidder and always joins
// tenders for the CPV division. Mirrors scope() minus the sector clause.
function crossSectorScope(p: TrendParams): { where: string[]; params: unknown[] } {
  const where = ['c.amount_eur IS NOT NULL'];
  const params: unknown[] = [];
  if (p.authorityId) {
    where.push('t.authority_id = ?');
    params.push(p.authorityId);
  }
  if (p.bidderId) {
    where.push('c.bidder_id = ?');
    params.push(p.bidderId);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  return { where, params };
}

// month → quarter (1..4) on the signing date: (m + 2) / 3 in integer arithmetic.
const QUARTER_EXPR = '((CAST(substr(c.signed_at, 6, 2) AS INTEGER) + 2) / 3)';

// A full year+month signing date ('YYYY-MM…'). Year-only dates (e.g. '2024') pass YEAR_KNOWN but have
// no month, so QUARTER_EXPR's substr is '' → CAST 0 → a bogus "quarter 0" that dilutes the Q4
// seasonality share. The seasonality query requires the month delimiter (position 5 = '-') to drop them.
const MONTH_KNOWN = "substr(c.signed_at, 5, 1) = '-'";

// Continuous period keys (inclusive) for zero-filling gaps, so the chart has no holes.
function fillPeriods(first: string, last: string, granularity: 'month' | 'year'): string[] {
  if (granularity === 'year') {
    const out: string[] = [];
    for (let y = Number(first); y <= Number(last); y += 1) out.push(String(y));
    return out;
  }
  const [fy, fm] = first.split('-').map(Number) as [number, number];
  const [ly, lm] = last.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let m = fy * 12 + (fm - 1); m <= ly * 12 + (lm - 1); m += 1) {
    out.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export async function getSpendingTrend(
  db: D1Database,
  p: TrendParams,
  options: TrendQueryOptions = {},
): Promise<TrendDataPlus> {
  const includeSectors = options.includeSectors ?? true;
  const includeInsights = options.includeInsights ?? includeSectors;
  const granularity = p.granularity === 'year' ? 'year' : 'month';
  const periodLen = granularity === 'year' ? 4 : 7; // substr length: 'YYYY' vs 'YYYY-MM'
  const s = scope(p);

  const seriesWhere = [YEAR_KNOWN, 'c.signed_at >= ?', "c.signed_at <= date('now')", ...s.where];
  // The /trends-only insights (seasonality, top movers). Gated behind includeSectors so the
  // entity/analytics embeds never run these extra scans.
  const cs = crossSectorScope(p);
  const quartersWhere = [
    YEAR_KNOWN,
    MONTH_KNOWN,
    'c.signed_at >= ?',
    "c.signed_at <= date('now')",
    ...s.where,
  ];
  const moversWhere = [
    YEAR_KNOWN,
    'c.signed_at >= ?',
    "c.signed_at <= date('now')",
    't.cpv_code IS NOT NULL',
    ...cs.where,
  ];
  const [series, coverageRow, sectors, asOfRow, quarterRows, sectorYearRows] = await Promise.all([
    db
      .prepare(
        `SELECT substr(c.signed_at, 1, ${periodLen}) AS period,
                COALESCE(SUM(c.amount_eur), 0) AS value_eur,
                COALESCE(SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), 0) AS eu_value_eur,
                COUNT(*) AS contracts
         FROM contracts c ${s.join}
         WHERE ${seriesWhere.join(' AND ')}
         GROUP BY period ORDER BY period`,
      )
      .bind(START, ...s.params)
      .all<PeriodRow>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN ${YEAR_KNOWN} THEN 1 ELSE 0 END), 0) AS dated,
           COUNT(*) AS total
         FROM contracts c ${s.join} WHERE ${s.where.join(' AND ')}`,
      )
      .bind(...s.params)
      .first<CoverageRow>(),
    includeSectors ? sectorOptions(db) : Promise.resolve([]),
    db.prepare('SELECT as_of FROM home_totals WHERE id = 1').first<{ as_of: string | null }>(),
    includeInsights
      ? db
          .prepare(
            `SELECT substr(c.signed_at, 1, 4) AS year, ${QUARTER_EXPR} AS quarter,
                    COALESCE(SUM(c.amount_eur), 0) AS value_eur
             FROM contracts c ${s.join}
             WHERE ${quartersWhere.join(' AND ')}
             GROUP BY year, quarter`,
          )
          .bind(START, ...s.params)
          .all<QuarterRow>()
      : Promise.resolve({ results: [] as QuarterRow[] }),
    includeInsights
      ? db
          .prepare(
            `SELECT substr(t.cpv_code, 1, 2) AS division, substr(c.signed_at, 1, 4) AS year,
                    COALESCE(SUM(c.amount_eur), 0) AS value_eur
             FROM contracts c JOIN tenders t ON t.id = c.tender_id
             WHERE ${moversWhere.join(' AND ')}
             GROUP BY division, year`,
          )
          .bind(START, ...cs.params)
          .all<SectorYearRow>()
      : Promise.resolve({ results: [] as SectorYearRow[] }),
  ]);
  // The final period (the as_of period) is still being filled; mark it so the chart and table do not
  // read its dip as a real decline, and so YoY is not computed against a partial year.
  const asOf = asOfRow?.as_of ?? null;
  const partialPeriod = asOf ? asOf.slice(0, periodLen) : null;
  const partialYear = asOf ? asOf.slice(0, 4) : null;

  const rows = series.results;
  let points: TrendPointPlus[] = [];
  if (rows.length) {
    const byPeriod = new Map(rows.map((r) => [r.period, r]));
    points = fillPeriods(rows[0]!.period, rows[rows.length - 1]!.period, granularity).map(
      (period) => {
        const r = byPeriod.get(period);
        return {
          period,
          valueEur: r?.value_eur ?? 0,
          euValueEur: r?.eu_value_eur ?? 0,
          contracts: r?.contracts ?? 0,
          partial: period === partialPeriod,
        };
      },
    );
  }

  // Per-year summary with year-over-year change (fold months into years for month granularity).
  const yearMap = new Map<string, { valueEur: number; euValueEur: number; contracts: number }>();
  for (const pt of points) {
    const y = pt.period.slice(0, 4);
    const acc = yearMap.get(y) ?? { valueEur: 0, euValueEur: 0, contracts: 0 };
    acc.valueEur += pt.valueEur;
    acc.euValueEur += pt.euValueEur;
    acc.contracts += pt.contracts;
    yearMap.set(y, acc);
  }
  const sortedYears = [...yearMap.keys()].sort();
  const years: TrendYearPlus[] = sortedYears.map((year, i) => {
    const cur = yearMap.get(year)!;
    const prev = i > 0 ? yearMap.get(sortedYears[i - 1]!)! : null;
    const partial = year === partialYear;
    return {
      year,
      valueEur: cur.valueEur,
      euValueEur: cur.euValueEur,
      contracts: cur.contracts,
      // No YoY for the partial final year: a partial year against a full one reads as a false collapse.
      yoyPct:
        partial || !prev || prev.valueEur <= 0
          ? null
          : (cur.valueEur - prev.valueEur) / prev.valueEur,
      partial,
    };
  });

  const quarters: TrendQuarterValue[] = quarterRows.results.map((r) => ({
    year: r.year,
    quarter: Number(r.quarter),
    valueEur: r.value_eur,
  }));
  const sectorYears: TrendSectorYearValue[] = sectorYearRows.results.map((r) => ({
    division: r.division,
    year: r.year,
    valueEur: r.value_eur,
  }));

  const dated = coverageRow?.dated ?? 0;
  const total = coverageRow?.total ?? 0;
  return {
    granularity,
    points,
    years,
    sectors,
    partialYear,
    quarters,
    sectorYears,
    totalValueEur: points.reduce((sum, pt) => sum + pt.valueEur, 0),
    coverage: { dated, total, pct: total > 0 ? dated / total : 0 },
    scope: { sector: p.sector ?? null, funding: p.funding ?? 'all', granularity },
  };
}
