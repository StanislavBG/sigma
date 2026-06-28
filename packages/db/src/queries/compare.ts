// Leaderboard for /compare — ranks EVERY authority (or company) on one chosen dimension, so a
// comparison isn't two numbers in a vacuum: you see the whole field and where your picks land. Reads
// only the *_totals rollups (one scan), with derived ratio dimensions (avg contract €, EU share)
// guarded by a minimum contract count so a single-contract entity can't top the table on noise.

import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug } from './identity';

export type LeaderboardKind = 'authority' | 'company';
// total: spent/won € · avg: € per contract · reach: distinct counterparties · eu: EU-funded share
export type LeaderboardMetric = 'total' | 'avg' | 'reach' | 'eu';

export interface LeaderboardRow {
  slug: string;
  name: string;
  rank: number; // 1-based; 0 = doesn't qualify (ratio metric, too few contracts)
  metricValue: number;
  totalEur: number; // spent/won, for context next to the ranked metric
  contracts: number;
  highlighted: boolean; // one of the compared entities
}

export interface CompareLeaderboard {
  metric: LeaderboardMetric;
  isRatio: boolean;
  isPct: boolean;
  rows: LeaderboardRow[]; // top N by the metric
  pinned: LeaderboardRow[]; // the compared entities with their true rank (may be outside top N)
  qualifying: number; // entities that qualify for this metric (denominator for percentile)
  maxValue: number; // top metric value, for bar scaling
}

export const LEADERBOARD_MIN_CONTRACTS = 5; // ratio dimensions ignore entities below this (noise guard)

interface Bits {
  table: string;
  id: string;
  total: string;
  metricExpr: string;
  isRatio: boolean;
  where: string;
}

function bits(kind: LeaderboardKind, metric: LeaderboardMetric): Bits {
  const t =
    kind === 'authority'
      ? { table: 'authority_totals', id: 'authority_id', total: 'spent_eur', reach: 'suppliers' }
      : { table: 'company_totals', id: 'bidder_id', total: 'won_eur', reach: 'authorities' };
  const avg = kind === 'authority' ? 'avg_eur' : `(${t.total} * 1.0 / contracts)`;
  const metricExpr =
    metric === 'total'
      ? t.total
      : metric === 'reach'
        ? t.reach
        : metric === 'avg'
          ? avg
          : `(eu_eur * 1.0 / NULLIF(${t.total}, 0))`; // eu share, 0..1
  const isRatio = metric === 'avg' || metric === 'eu';
  // Ratio metrics: require a real sample so one-contract outliers don't dominate. Count/sum metrics
  // rank the whole field.
  const where = isRatio ? `WHERE contracts >= ${LEADERBOARD_MIN_CONTRACTS} AND ${t.total} > 0` : '';
  return { table: t.table, id: t.id, total: t.total, metricExpr, isRatio, where };
}

interface Raw {
  id: string;
  name: string;
  kind?: string;
  total_eur: number;
  contracts: number;
  metric: number;
}

export function normalizeLeaderboardMetric(v: string | null | undefined): LeaderboardMetric {
  return v === 'avg' || v === 'reach' || v === 'eu' ? v : 'total';
}

export async function getCompareLeaderboard(
  db: D1Database,
  opts: {
    kind: LeaderboardKind;
    metric: LeaderboardMetric;
    limit?: number;
    highlightIds?: string[];
  },
): Promise<CompareLeaderboard> {
  const { kind, metric } = opts;
  const limit = opts.limit ?? 25;
  const highlightIds = opts.highlightIds ?? [];
  const b = bits(kind, metric);
  const toSlug = kind === 'authority' ? authoritySlug : companySlug;
  const kindCol = kind === 'company' ? ', kind' : '';
  const select = `SELECT ${b.id} AS id, name${kindCol}, ${b.total} AS total_eur, contracts, ${b.metricExpr} AS metric FROM ${b.table}`;

  const display = (r: Raw): string =>
    kind === 'company'
      ? entityName(cleanName(r.name), (r.kind as 'company' | 'consortium') ?? 'company')
      : cleanName(r.name);

  const [topRes, qRow] = await Promise.all([
    db.prepare(`${select} ${b.where} ORDER BY metric DESC, ${b.id} LIMIT ?`).bind(limit).all<Raw>(),
    db.prepare(`SELECT COUNT(*) AS n FROM ${b.table} ${b.where}`).first<{ n: number }>(),
  ]);
  const top = topRes.results;
  const qualifying = Number(qRow?.n ?? 0);
  const maxValue = top[0]?.metric ?? 0;

  const toRow = (r: Raw, rank: number): LeaderboardRow => ({
    slug: toSlug(r.id),
    name: display(r),
    rank,
    metricValue: r.metric,
    totalEur: r.total_eur,
    contracts: r.contracts,
    highlighted: highlightIds.includes(r.id),
  });

  const topById = new Map(top.map((r, i) => [r.id, { raw: r, rank: i + 1 }]));
  const rows: LeaderboardRow[] = top.map((r, i) => toRow(r, i + 1));

  // The compared entities, with their TRUE rank — even when outside the top N (the „where do I stand"
  // payoff). A highlight already in the top list reuses that row + rank (no query); otherwise a single
  // by-PK lookup, plus one „how many beat me" count when it qualifies. Each pinned entity is resolved
  // independently, so the whole batch runs in parallel (Promise.all) rather than awaiting in series.
  // The rank count mirrors the list's `metric DESC, id` ordering: an entity is preceded by anything
  // with a strictly greater metric OR an equal metric and a smaller id, so its rank matches its row.
  const pinned: LeaderboardRow[] = (
    await Promise.all(
      highlightIds.map(async (hid): Promise<LeaderboardRow | null> => {
        const inTop = topById.get(hid);
        if (inTop) return toRow(inTop.raw, inTop.rank);
        const lr = await db.prepare(`${select} WHERE ${b.id} = ?`).bind(hid).first<Raw>();
        if (!lr) return null;
        const qualifies =
          !b.isRatio || (lr.contracts >= LEADERBOARD_MIN_CONTRACTS && lr.total_eur > 0);
        let rank = 0;
        if (qualifies) {
          const c = await db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${b.table} ${b.where ? b.where + ' AND' : 'WHERE'} (${b.metricExpr} > ? OR (${b.metricExpr} = ? AND ${b.id} < ?))`,
            )
            .bind(lr.metric, lr.metric, lr.id)
            .first<{ n: number }>();
          rank = Number(c?.n ?? 0) + 1;
        }
        return { ...toRow(lr, rank), highlighted: true };
      }),
    )
  ).filter((r): r is LeaderboardRow => r !== null);

  return { metric, isRatio: b.isRatio, isPct: metric === 'eu', rows, pinned, qualifying, maxValue };
}
