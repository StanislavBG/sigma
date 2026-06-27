// Overruns („Раздуване") — the corpus-wide view of contracts that ballooned after signing via
// annexes. An overrun is a contract whose post-annex value (current_value_eur) exceeds its value at
// signing (signing_value_eur), with both figures present and at least one annex on record. The annex
// data is already promoted to the served DB (precompute fills *_eur; annex_suspect rows have a NULL
// current_value_eur and so are excluded honestly here). Read-only, edge-cached at the route; mirrors
// the live-aggregation style of flows.ts / competition.ts — no new rollup table.
//
// delta = current − signing; pct = delta / signing. signing_value_eur is required to be > 0 in the
// WHERE (data-quality guard + makes the pct division safe); the JS mapping double-guards so a stray
// non-positive signing can never produce an Infinity/NaN pct.
//
// The page issues exactly six bounded queries (see getOverrunsAnalytics): one leaderboard (LIMIT-ed),
// one corpus aggregate (single pass, conditional SUM/AVG — no duplicate COUNT), one median, and one
// each for the by-authority / by-sector / by-year breakdowns (each GROUP BY is bounded by its key
// cardinality and the two leaderboards carry a LIMIT). The shared OVERRUN_WHERE keeps every
// aggregate's definition of "ballooned" identical.

import { cleanName, entityName } from '@sigma/shared';
import { CPV_SECTORS } from '@sigma/config';
import { authoritySlug, companySlug, contractSlug } from './identity';

export interface OverrunRow {
  contractId: string;
  contractSlug: string;
  subject: string;
  authorityName: string;
  authoritySlug: string;
  bidderName: string;
  bidderSlug: string;
  signingEur: number;
  currentEur: number;
  deltaEur: number;
  pct: number;
  annexCount: number;
}

export interface OverrunsResult {
  rows: OverrunRow[];
  totalOverrunEur: number;
  count: number;
}

export interface OverrunsParams {
  by: 'absolute' | 'percent';
  limit?: number;
}

// Corpus headline figures for the whole overrun set. `shareOfSigning` puts the inflation in context:
// the total ballooning measured against every contract's signed value (the honest denominator — only
// rows with a usable signing value, suspect rows excluded).
export interface OverrunCorpus {
  totalOverrunEur: number;
  count: number;
  avgPct: number;
  medianPct: number;
  overrunSigningEur: number;
  corpusSigningEur: number;
  shareOfSigning: number;
}

export interface OverrunAuthorityRow {
  authorityName: string;
  authoritySlug: string;
  totalOverrunEur: number;
  avgPct: number;
  count: number;
}

export interface OverrunSectorRow {
  division: string;
  label: string;
  totalOverrunEur: number;
  avgPct: number;
  count: number;
}

export interface OverrunYearRow {
  year: string;
  totalOverrunEur: number;
  count: number;
}

export interface OverrunsAnalytics {
  corpus: OverrunCorpus;
  rows: OverrunRow[];
  byAuthority: OverrunAuthorityRow[];
  bySector: OverrunSectorRow[];
  byYear: OverrunYearRow[];
}

export interface OverrunsAnalyticsParams {
  by: 'absolute' | 'percent';
  leaderboardLimit?: number;
  authorityLimit?: number;
  sectorLimit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const AUTHORITY_LIMIT = 20;
const SECTOR_LIMIT = 15;
const YEAR_UNKNOWN = 'Неизвестна';

// The overrun predicate, shared by every query so they never disagree on what counts as a ballooned
// contract. Uses only `contracts` columns (aliased `c`) so it works both as a WHERE and as a CASE
// condition in the single-pass corpus aggregate.
const OVERRUN_WHERE = `c.signing_value_eur IS NOT NULL
       AND c.current_value_eur IS NOT NULL
       AND c.annex_count > 0
       AND c.current_value_eur > c.signing_value_eur
       AND c.signing_value_eur > 0`;

// delta / pct expressions, reused across aggregates so the maths is defined once.
const DELTA = '(c.current_value_eur - c.signing_value_eur)';
const PCT = '(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur';

interface RawRow {
  contract_id: string;
  subject: string;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  signing_eur: number;
  current_eur: number;
  annex_count: number;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const requested = Number.isInteger(limit) ? limit! : fallback;
  return requested >= 1 && requested <= max ? requested : fallback;
}

// ORDER BY for the leaderboard: absolute lev overrun, or percentage blow-up. Both are safe (signing >
// 0 in WHERE); ties break on contract id for a stable order.
function leaderboardOrderBy(by: 'absolute' | 'percent'): string {
  return by === 'percent' ? `${PCT} DESC, c.id` : `${DELTA} DESC, c.id`;
}

function leaderboardSql(by: 'absolute' | 'percent'): string {
  return `SELECT c.id AS contract_id,
                COALESCE(NULLIF(TRIM(c.contract_subject), ''), t.title) AS subject,
                t.authority_id AS authority_id, a.name AS authority_name,
                c.bidder_id AS bidder_id, b.name AS bidder_name, b.kind AS bidder_kind,
                c.signing_value_eur AS signing_eur, c.current_value_eur AS current_eur,
                c.annex_count AS annex_count
         FROM contracts c
         JOIN tenders t ON t.id = c.tender_id
         JOIN authorities a ON a.id = t.authority_id
         JOIN bidders b ON b.id = c.bidder_id
         WHERE ${OVERRUN_WHERE}
         ORDER BY ${leaderboardOrderBy(by)}
         LIMIT ?`;
}

// Map raw leaderboard rows to the API shape. Divide-by-zero guard: never trust the WHERE alone — drop
// any row whose signing is non-positive so deltaEur/signing can't yield Infinity/NaN.
function mapOverrunRows(raw: RawRow[]): OverrunRow[] {
  return raw
    .filter((r) => r.signing_eur > 0 && r.current_eur > r.signing_eur)
    .map((r) => {
      const deltaEur = r.current_eur - r.signing_eur;
      const bidderName = cleanName(r.bidder_name);
      return {
        contractId: r.contract_id,
        contractSlug: contractSlug(r.contract_id),
        subject: r.subject,
        authorityName: cleanName(r.authority_name),
        authoritySlug: authoritySlug(r.authority_id),
        bidderName: entityName(bidderName, r.bidder_kind),
        bidderSlug: companySlug(r.bidder_id),
        signingEur: r.signing_eur,
        currentEur: r.current_eur,
        deltaEur,
        pct: deltaEur / r.signing_eur,
        annexCount: r.annex_count,
      };
    });
}

const SECTOR_LABELS = new Map(CPV_SECTORS.map((s) => [s.code, s.short ?? s.label]));

export async function getTopOverruns(
  db: D1Database,
  { by, limit }: OverrunsParams,
): Promise<OverrunsResult> {
  const capped = clampLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);

  const [rowsRes, totalsRow] = await Promise.all([
    db.prepare(leaderboardSql(by)).bind(capped).all<RawRow>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(c.current_value_eur - c.signing_value_eur), 0) AS total_overrun_eur,
                COUNT(*) AS count
         FROM contracts c
         WHERE ${OVERRUN_WHERE}`,
      )
      .first<{ total_overrun_eur: number; count: number }>(),
  ]);

  return {
    rows: mapOverrunRows(rowsRes.results),
    totalOverrunEur: totalsRow?.total_overrun_eur ?? 0,
    count: totalsRow?.count ?? 0,
  };
}

interface CorpusRaw {
  total_overrun_eur: number;
  count: number;
  avg_pct: number;
  overrun_signing_eur: number;
  corpus_signing_eur: number;
}

interface AuthorityRaw {
  authority_id: string;
  authority_name: string;
  total_overrun_eur: number;
  avg_pct: number;
  count: number;
}

interface SectorRaw {
  division: string | null;
  total_overrun_eur: number;
  avg_pct: number;
  count: number;
}

interface YearRaw {
  year: string;
  total_overrun_eur: number;
  count: number;
}

// The full analytical page in six bounded queries. None duplicates another's COUNT/SUM: the corpus
// totals come from the single conditional-aggregate pass, the leaderboard carries a LIMIT, and every
// GROUP BY is bounded by its key (authorities/sectors LIMIT-ed, years are a tiny fixed set).
export async function getOverrunsAnalytics(
  db: D1Database,
  { by, leaderboardLimit, authorityLimit, sectorLimit }: OverrunsAnalyticsParams,
): Promise<OverrunsAnalytics> {
  const boardLimit = clampLimit(leaderboardLimit, DEFAULT_LIMIT, MAX_LIMIT);
  const authLimit = clampLimit(authorityLimit, AUTHORITY_LIMIT, MAX_LIMIT);
  const secLimit = clampLimit(sectorLimit, SECTOR_LIMIT, MAX_LIMIT);

  const [rowsRes, corpusRow, medianRow, authRes, sectorRes, yearRes] = await Promise.all([
    db.prepare(leaderboardSql(by)).bind(boardLimit).all<RawRow>(),
    // Single pass over contracts: conditional SUM/AVG so the overrun totals and the corpus signing
    // denominator come from ONE scan, never a duplicate COUNT.
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN ${OVERRUN_WHERE} THEN ${DELTA} END), 0) AS total_overrun_eur,
           COALESCE(SUM(CASE WHEN ${OVERRUN_WHERE} THEN 1 ELSE 0 END), 0) AS count,
           COALESCE(AVG(CASE WHEN ${OVERRUN_WHERE} THEN ${PCT} END), 0) AS avg_pct,
           COALESCE(SUM(CASE WHEN ${OVERRUN_WHERE} THEN c.signing_value_eur END), 0) AS overrun_signing_eur,
           COALESCE(SUM(CASE WHEN c.signing_value_eur IS NOT NULL AND c.signing_value_eur > 0
                            THEN c.signing_value_eur END), 0) AS corpus_signing_eur
         FROM contracts c`,
      )
      .first<CorpusRaw>(),
    // Median overrun pct via a window-function pass over the overrun subset; returns the one (odd n)
    // or two (even n) middle rows and averages them. One row out — bounded.
    db
      .prepare(
        `SELECT COALESCE(AVG(pct), 0) AS median_pct
         FROM (
           SELECT pct,
                  ROW_NUMBER() OVER (ORDER BY pct) AS rn,
                  COUNT(*) OVER () AS n
           FROM (
             SELECT ${PCT} AS pct
             FROM contracts c
             WHERE ${OVERRUN_WHERE}
           )
         )
         WHERE rn IN ((n + 1) / 2, (n + 2) / 2)`,
      )
      .first<{ median_pct: number }>(),
    db
      .prepare(
        `SELECT t.authority_id AS authority_id, a.name AS authority_name,
                SUM(${DELTA}) AS total_overrun_eur,
                AVG(${PCT}) AS avg_pct,
                COUNT(*) AS count
         FROM contracts c
         JOIN tenders t ON t.id = c.tender_id
         JOIN authorities a ON a.id = t.authority_id
         WHERE ${OVERRUN_WHERE}
         GROUP BY t.authority_id, a.name
         ORDER BY total_overrun_eur DESC, t.authority_id
         LIMIT ?`,
      )
      .bind(authLimit)
      .all<AuthorityRaw>(),
    db
      .prepare(
        `SELECT substr(t.cpv_code, 1, 2) AS division,
                SUM(${DELTA}) AS total_overrun_eur,
                AVG(${PCT}) AS avg_pct,
                COUNT(*) AS count
         FROM contracts c
         JOIN tenders t ON t.id = c.tender_id
         WHERE ${OVERRUN_WHERE}
         GROUP BY division
         ORDER BY total_overrun_eur DESC
         LIMIT ?`,
      )
      .bind(secLimit)
      .all<SectorRaw>(),
    db
      .prepare(
        `SELECT CASE WHEN substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
                     THEN substr(c.signed_at, 1, 4) ELSE '${YEAR_UNKNOWN}' END AS year,
                SUM(${DELTA}) AS total_overrun_eur,
                COUNT(*) AS count
         FROM contracts c
         WHERE ${OVERRUN_WHERE}
         GROUP BY year
         ORDER BY year`,
      )
      .all<YearRaw>(),
  ]);

  const totalOverrunEur = corpusRow?.total_overrun_eur ?? 0;
  const corpusSigningEur = corpusRow?.corpus_signing_eur ?? 0;
  const corpus: OverrunCorpus = {
    totalOverrunEur,
    count: corpusRow?.count ?? 0,
    avgPct: corpusRow?.avg_pct ?? 0,
    medianPct: medianRow?.median_pct ?? 0,
    overrunSigningEur: corpusRow?.overrun_signing_eur ?? 0,
    corpusSigningEur,
    shareOfSigning: corpusSigningEur > 0 ? totalOverrunEur / corpusSigningEur : 0,
  };

  const byAuthority: OverrunAuthorityRow[] = authRes.results.map((r) => ({
    authorityName: cleanName(r.authority_name),
    authoritySlug: authoritySlug(r.authority_id),
    totalOverrunEur: r.total_overrun_eur,
    avgPct: r.avg_pct,
    count: r.count,
  }));

  const bySector: OverrunSectorRow[] = sectorRes.results.map((r) => {
    const division = (r.division ?? '').trim();
    return {
      division,
      label: SECTOR_LABELS.get(division) ?? (division ? `Сектор ${division}` : 'Без код'),
      totalOverrunEur: r.total_overrun_eur,
      avgPct: r.avg_pct,
      count: r.count,
    };
  });

  const byYear: OverrunYearRow[] = yearRes.results.map((r) => ({
    year: r.year,
    totalOverrunEur: r.total_overrun_eur,
    count: r.count,
  }));

  return { corpus, rows: mapOverrunRows(rowsRes.results), byAuthority, bySector, byYear };
}
