// „Раздути спрямо сходни" (price-anomaly vs similar contracts) — the read layer over the precomputed
// CPV-cohort rollups (cpv_cohort_stats / cpv_cohort_sample / cpv_cohort_outlier; migrations 0003 + 0004,
// filled by scripts/precompute-price-anomaly.mjs). The dashboard flags contracts whose TOTAL value
// (amount_eur) is a high-tail log-MAD outlier vs SIMILAR-ERA contracts in the same 5-digit CPV cohort —
// the cohort is the contract's same-CPV peers signed within ±1 year (an inflation-adjusted window), so a
// flag reads as „expensive vs similar-era peers", not „expensive vs the whole history".
//
// HONESTY (must survive into any served text): this flags a contract for REVIEW against its CPV peers —
// it is NOT proof of overpayment. There are no quantities in the source, so a large total can be a
// legitimately large scope (e.g. a framework agreement whose total dwarfs the unit contracts in its
// cohort). The UI must say „за преглед", never assert waste. See docs/review-accuracy.md.
//
// PERF: every figure is read from the small rollup tables — no median/MAD is ever recomputed live. Each
// function issues a bounded, indexed query set (traced per function below); none duplicates a COUNT.

import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug, contractSlug } from './identity';

// ── Methodology constants (mirror scripts/cohort-stats.mjs; the corpus-KPI thresholds) ─────────────
/** Minimum cohort size: a contract's ±1-year same-CPV window needs ≥ 30 peers to call anything an outlier. */
export const MIN_COHORT_SIZE = 30;
/** Robust-z cutoff on log(value): flag a contract at z ≥ 3 on the high tail (v > window median). */
export const Z_THRESHOLD = 3;
/** Temporal window (days) for the inflation-adjusted cohort: peers signed within ±1 year of the contract. */
export const WINDOW_DAYS = 365;

const DEFAULT_COHORT_LIMIT = 50;
const MAX_COHORT_LIMIT = 200;
const DEFAULT_OUTLIER_LIMIT = 50;
const MAX_OUTLIER_LIMIT = 200;

export type CohortSort = 'inflatedShare' | 'outlierCount' | 'n';

export interface CohortStatRow {
  /** 5-digit CPV cohort code. */
  code: string;
  /** Human label — the cohort's modal cpv_description (no curated 5-digit taxonomy exists). */
  label: string;
  /** Number of priced peers in the cohort (≥ MIN_COHORT_SIZE). */
  n: number;
  /** The cohort's typical TOTAL contract value, exp(median(ln v)). */
  medianEur: number;
  /** Robust log-scale (MAD of ln v); always > 0 for a stored cohort. */
  logMad: number;
  /** Contracts flagged in this cohort (z ≥ 3, high tail). */
  outlierCount: number;
  /** Σ(outlier value) / Σ(cohort value) — the €-weighted share sitting in flagged contracts. */
  inflatedShare: number;
  /** Up to ~30 quantile-spaced cohort values (ascending) for the distribution strip. */
  sample: number[];
}

export interface CohortOutlierRow {
  contractId: string;
  contractSlug: string;
  /** Contract subject (falls back to the tender title); the headline of the flagged row. */
  subject: string | null;
  /** The cohort the contract was judged against. */
  code: string;
  valueEur: number;
  /** value / window median — the „× над типичното (±1 г.)" multiple. */
  mult: number;
  /** Rank of the value within its ±1-year window, 1..100. */
  percentile: number;
  /** The ±1-year same-CPV median the contract was judged against (exp(median(ln v)) of the window). */
  windowMedianEur: number;
  authorityName: string;
  authoritySlug: string;
  /** Authority ЕИК (the authority-route key). */
  authorityEik: string;
  bidderName: string;
  bidderSlug: string;
  /** Bidder ЕИК (digits-only; NULL for name-keyed bidders without a valid ЕИК). */
  bidderEik: string | null;
  cpvCode: string | null;
  cpvDescription: string | null;
  signedAt: string | null;
}

export interface PriceAnomalyKpis {
  /** Number of cohorts that qualified (n ≥ 30, MAD > 0) — the analysable CPV groups. */
  cohortCount: number;
  /** Total flagged contracts across all cohorts. */
  flaggedCount: number;
  /** The methodology thresholds, surfaced for the page's „метод" note. */
  minCohortSize: number;
  zThreshold: number;
}

export interface CohortStatsParams {
  sort?: CohortSort;
  limit?: number;
  /** Row offset (0-based). Takes precedence over `page` when both are given. */
  offset?: number;
  /** 1-based page index — converted to an offset of (page − 1) × limit. */
  page?: number;
  /**
   * Restrict to these cohort codes (the selected CPV cohorts). When given, pagination is bypassed —
   * the IN-list already bounds the result to the (few) selected codes, so the summary header can read
   * a cohort's full stats even when it isn't on the current browse page.
   */
  codes?: string[];
}

export interface CohortOutliersParams {
  /** Restrict to these cohort codes (the selected cohorts); omitted ⇒ corpus-wide. */
  codes?: string[];
  limit?: number;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const requested = Number.isInteger(limit) ? limit! : fallback;
  return requested >= 1 && requested <= max ? requested : fallback;
}

// Resolve the page's row offset: an explicit `offset` wins, else derive it from a 1-based `page`.
// Clamped to ≥ 0 so a stray negative/non-integer can't produce a malformed OFFSET.
function clampOffset(offset: number | undefined, page: number | undefined, limit: number): number {
  if (Number.isInteger(offset) && offset! >= 0) return offset!;
  if (Number.isInteger(page) && page! >= 1) return (page! - 1) * limit;
  return 0;
}

// ORDER BY column for the cohort browse. Whitelisted (never interpolate caller text) so the sort toggle
// can't inject SQL; every option tiebreaks on code for a deterministic, stable page.
function cohortOrderBy(sort: CohortSort | undefined): string {
  switch (sort) {
    case 'outlierCount':
      return 'outlier_count DESC, code';
    case 'n':
      return 'n DESC, code';
    case 'inflatedShare':
    default:
      return 'inflated_share DESC, code';
  }
}

interface StatRaw {
  code: string;
  label: string;
  n: number;
  median_eur: number;
  log_mad: number;
  outlier_count: number;
  inflated_share: number;
}

interface SampleRaw {
  code: string;
  value_eur: number;
}

/**
 * The cohort-browse rows + the per-cohort distribution sample for the strips. TWO bounded queries:
 *   1) the cohort rows — read straight from cpv_cohort_stats, ORDER BY the (whitelisted) sort, with a
 *      LIMIT + OFFSET for the requested page (total page count comes from getPriceAnomalyKpis.cohortCount).
 *   2) the samples for ONLY the returned codes — one IN-list query (bounded by the page LIMIT), riding
 *      idx_cpv_cohort_sample_code. No median is recomputed; no duplicate COUNT.
 */
export async function getCohortStats(
  db: D1Database,
  { sort, limit, offset, page, codes }: CohortStatsParams = {},
): Promise<CohortStatRow[]> {
  const capped = clampLimit(limit, DEFAULT_COHORT_LIMIT, MAX_COHORT_LIMIT);
  // A `codes` filter (the selected cohorts) bypasses the LIMIT/OFFSET pager: the IN-list already bounds
  // the read to the few selected codes, so a selected cohort that isn't on the current browse page still
  // resolves to its full stats for the summary header. Otherwise it's the paginated browse read.
  const filter = codes && codes.length > 0;
  const off = clampOffset(offset, page, capped);
  const statsRes = filter
    ? await db
        .prepare(
          `SELECT code, label, n, median_eur, log_mad, outlier_count, inflated_share
           FROM cpv_cohort_stats
           WHERE code IN (${codes!.map(() => '?').join(', ')})
           ORDER BY ${cohortOrderBy(sort)}`,
        )
        .bind(...codes!)
        .all<StatRaw>()
    : await db
        .prepare(
          `SELECT code, label, n, median_eur, log_mad, outlier_count, inflated_share
           FROM cpv_cohort_stats
           ORDER BY ${cohortOrderBy(sort)}
           LIMIT ? OFFSET ?`,
        )
        .bind(capped, off)
        .all<StatRaw>();

  const pageCodes = statsRes.results.map((r) => r.code);
  const samplesByCode = new Map<string, number[]>();
  if (pageCodes.length > 0) {
    const placeholders = pageCodes.map(() => '?').join(', ');
    const sampleRes = await db
      .prepare(
        `SELECT code, value_eur
         FROM cpv_cohort_sample
         WHERE code IN (${placeholders})
         ORDER BY code, value_eur`,
      )
      .bind(...pageCodes)
      .all<SampleRaw>();
    for (const s of sampleRes.results) {
      const arr = samplesByCode.get(s.code);
      if (arr) arr.push(s.value_eur);
      else samplesByCode.set(s.code, [s.value_eur]);
    }
  }

  return statsRes.results.map((r) => ({
    code: r.code,
    label: r.label,
    n: r.n,
    medianEur: r.median_eur,
    logMad: r.log_mad,
    outlierCount: r.outlier_count,
    inflatedShare: r.inflated_share,
    sample: samplesByCode.get(r.code) ?? [],
  }));
}

interface OutlierRaw {
  contract_id: string;
  subject: string | null;
  code: string;
  value_eur: number;
  mult: number;
  percentile: number;
  window_median_eur: number;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  bidder_eik: string | null;
  cpv_code: string | null;
  cpv_description: string | null;
  signed_at: string | null;
}

/**
 * The flagged contracts, joined to contracts/tenders/authorities/bidders for title + buyer, ordered by
 * mult desc. ONE bounded query: it reads cpv_cohort_outlier (the small flagged set), optionally filtered
 * to `codes` (IN-list, riding idx_cpv_cohort_outlier_code), and the ORDER BY rides
 * idx_cpv_cohort_outlier_mult. LIMIT-ed. No COUNT, no per-row round trip.
 */
export async function getCohortOutliers(
  db: D1Database,
  { codes, limit }: CohortOutliersParams = {},
): Promise<CohortOutlierRow[]> {
  const capped = clampLimit(limit, DEFAULT_OUTLIER_LIMIT, MAX_OUTLIER_LIMIT);
  const filter = codes && codes.length > 0;
  const placeholders = filter ? codes!.map(() => '?').join(', ') : '';
  const res = await db
    .prepare(
      `SELECT o.contract_id AS contract_id,
              COALESCE(NULLIF(TRIM(c.contract_subject), ''), t.title) AS subject,
              o.code AS code, o.value_eur AS value_eur, o.mult AS mult, o.percentile AS percentile,
              o.window_median_eur AS window_median_eur,
              t.authority_id AS authority_id, a.name AS authority_name,
              c.bidder_id AS bidder_id, b.name AS bidder_name, b.kind AS bidder_kind,
              b.eik_normalized AS bidder_eik,
              t.cpv_code AS cpv_code, t.cpv_description AS cpv_description,
              c.signed_at AS signed_at
       FROM cpv_cohort_outlier o
       JOIN contracts c ON c.id = o.contract_id
       JOIN tenders t ON t.id = c.tender_id
       JOIN authorities a ON a.id = t.authority_id
       JOIN bidders b ON b.id = c.bidder_id
       ${filter ? `WHERE o.code IN (${placeholders})` : ''}
       ORDER BY o.mult DESC, o.contract_id
       LIMIT ?`,
    )
    .bind(...(filter ? codes! : []), capped)
    .all<OutlierRaw>();

  return res.results.map((r) => ({
    contractId: r.contract_id,
    contractSlug: contractSlug(r.contract_id),
    subject: r.subject ?? null,
    code: r.code,
    valueEur: r.value_eur,
    mult: r.mult,
    percentile: r.percentile,
    windowMedianEur: r.window_median_eur,
    authorityName: cleanName(r.authority_name),
    authoritySlug: authoritySlug(r.authority_id),
    authorityEik: authoritySlug(r.authority_id),
    bidderName: entityName(cleanName(r.bidder_name), r.bidder_kind),
    bidderSlug: companySlug(r.bidder_id),
    bidderEik: r.bidder_eik ?? null,
    cpvCode: r.cpv_code ?? null,
    cpvDescription: r.cpv_description ?? null,
    signedAt: r.signed_at ?? null,
  }));
}

/**
 * The human label for a 5-digit CPV cohort — its modal cpv_description from the rollup. One indexed
 * PK lookup, used to caption the /contracts ?cpv= drill-in. Returns null for a CPV that has no cohort
 * (fewer than MIN_COHORT_SIZE priced contracts), so the caller falls back to showing the bare code.
 */
export async function getCohortLabel(db: D1Database, code: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT label FROM cpv_cohort_stats WHERE code = ?`)
    .bind(code)
    .first<{ label: string }>();
  return row?.label ?? null;
}

/**
 * Corpus KPIs for the page header: the analysable-cohort count + the total flagged contracts, plus the
 * methodology thresholds. ONE query, two scalar subqueries over the small rollups → one round trip.
 */
export async function getPriceAnomalyKpis(db: D1Database): Promise<PriceAnomalyKpis> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cpv_cohort_stats) AS cohort_count,
              (SELECT COUNT(*) FROM cpv_cohort_outlier) AS flagged_count`,
    )
    .first<{ cohort_count: number; flagged_count: number }>();
  return {
    cohortCount: row?.cohort_count ?? 0,
    flaggedCount: row?.flagged_count ?? 0,
    minCohortSize: MIN_COHORT_SIZE,
    zThreshold: Z_THRESHOLD,
  };
}
