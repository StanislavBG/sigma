// Overruns („Раздуване") — a corpus-wide leaderboard of contracts that ballooned after signing via
// annexes. An overrun is a contract whose post-annex value (current_value_eur) exceeds its value at
// signing (signing_value_eur), with both figures present and at least one annex on record. The annex
// data is already promoted to the served DB (precompute fills *_eur; annex_suspect rows have a NULL
// current_value_eur and so are excluded honestly here). Read-only, edge-cached at the route; mirrors
// the live-aggregation style of flows.ts / competition.ts — no new rollup table.
//
// delta = current − signing; pct = delta / signing. signing_value_eur is required to be > 0 in the
// WHERE (data-quality guard + makes the pct division safe); the JS mapping double-guards so a stray
// non-positive signing can never produce an Infinity/NaN pct.

import { cleanName, entityName } from '@sigma/shared';
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// The overrun predicate, shared by the leaderboard and the corpus-totals queries so the two never
// disagree on what counts as a ballooned contract.
const OVERRUN_WHERE = `c.signing_value_eur IS NOT NULL
       AND c.current_value_eur IS NOT NULL
       AND c.annex_count > 0
       AND c.current_value_eur > c.signing_value_eur
       AND c.signing_value_eur > 0`;

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

export async function getTopOverruns(
  db: D1Database,
  { by, limit }: OverrunsParams,
): Promise<OverrunsResult> {
  const requested = Number.isInteger(limit) ? limit! : DEFAULT_LIMIT;
  const capped = requested >= 1 && requested <= MAX_LIMIT ? requested : DEFAULT_LIMIT;

  // Order by the absolute lev overrun, or by the percentage blow-up. Both are safe (signing > 0 in
  // WHERE); ties break on contract id for a stable order.
  const orderBy =
    by === 'percent'
      ? '(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC, c.id'
      : '(c.current_value_eur - c.signing_value_eur) DESC, c.id';

  const [rowsRes, totalsRow] = await Promise.all([
    db
      .prepare(
        `SELECT c.id AS contract_id,
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
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .bind(capped)
      .all<RawRow>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(c.current_value_eur - c.signing_value_eur), 0) AS total_overrun_eur,
                COUNT(*) AS count
         FROM contracts c
         WHERE ${OVERRUN_WHERE}`,
      )
      .first<{ total_overrun_eur: number; count: number }>(),
  ]);

  const rows: OverrunRow[] = rowsRes.results
    // Divide-by-zero guard: never trust the WHERE alone — drop any row whose signing is non-positive
    // so deltaEur/signing can't yield Infinity/NaN.
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

  return {
    rows,
    totalOverrunEur: totalsRow?.total_overrun_eur ?? 0,
    count: totalsRow?.count ?? 0,
  };
}
