// Pure comparison logic for the /compare side-by-side scorecard. Kept DB-free and framework-free so
// it unit-tests in isolation: given two already-loaded detail DTOs it normalises each entity to a
// shared numeric shape and emits the comparison rows the route renders. No fabricated values — a
// missing entity stays `null` all the way through and the row simply has no value on that side.

import type { AuthorityDetail, CompanyDetail } from '@sigma/api-contract';

export type CompareKind = 'authority' | 'company';

/** One sector slice for the side-by-side „топ сектори" lists (display only, never judged). */
export interface CompareSector {
  short: string;
  sharePct: number; // 0–1 share of the entity's value
}

/** The shared numeric profile both an authority and a company are projected onto. */
export interface CompareEntity {
  kind: CompareKind;
  slug: string; // /authorities/:slug | /companies/:slug
  name: string;
  totalEur: number; // authority: spent · company: won
  contracts: number;
  counterparties: number; // authority: distinct suppliers · company: distinct authorities
  counterpartyLabel: string;
  avgEur: number; // mean contract value
  avgBids: number | null; // mean offers per tender (null when unknown)
  euSharePct: number; // 0–1 share of value on EU-funded contracts
  sectors: CompareSector[]; // top sectors (≤3), already sorted by share desc
}

export type MetricFormat = 'money' | 'count' | 'pct' | 'bids';

/** Where a metric's „better" value lies, when the metric carries a meaningful civic judgement.
 *  `null` = neutral (more/less is neither good nor bad — e.g. total € spent). */
export type MetricDirection = 'higher' | null;

/** Which column wins the row: 'a'/'b', 'equal', or null (neutral metric or a side missing). */
export type BetterSide = 'a' | 'b' | 'equal' | null;

export interface ComparisonRow {
  key: string;
  label: string;
  format: MetricFormat;
  direction: MetricDirection;
  a: number | null;
  b: number | null;
  betterSide: BetterSide;
}

export function normalizeAuthority(a: AuthorityDetail): CompareEntity {
  return {
    kind: 'authority',
    slug: a.slug,
    name: a.name,
    totalEur: a.spentEur,
    contracts: a.contracts,
    counterparties: a.suppliers,
    counterpartyLabel: 'Различни изпълнители',
    avgEur: a.avgEur,
    avgBids: a.avgBids,
    euSharePct: a.euSharePct,
    sectors: a.sectors.slice(0, 3).map((s) => ({ short: s.short, sharePct: s.sharePct })),
  };
}

export function normalizeCompany(c: CompanyDetail): CompareEntity {
  return {
    kind: 'company',
    slug: c.slug,
    name: c.displayName,
    totalEur: c.wonEur,
    contracts: c.contracts,
    counterparties: c.authorities,
    counterpartyLabel: 'Възложители',
    // CompanyDetail carries no precomputed average; derive it the same way the authority rollup does.
    avgEur: c.contracts > 0 ? c.wonEur / c.contracts : 0,
    avgBids: c.avgBids,
    euSharePct: c.euSharePct,
    sectors: c.sector ? [{ short: c.sector.short, sharePct: c.sectorSharePct ?? 0 }] : [],
  };
}

/** Decide the winning side for one metric. Neutral metrics and any row missing a side return a
 *  judgement-free result so the UI never paints a green/red verdict on absent or meaningless data. */
function pickBetter(a: number | null, b: number | null, direction: MetricDirection): BetterSide {
  if (direction == null || a == null || b == null) return null;
  if (a === b) return 'equal';
  // `direction` is only ever 'higher' today; kept as a switch so 'lower' metrics can be added.
  const aWins = direction === 'higher' ? a > b : a < b;
  return aWins ? 'a' : 'b';
}

interface MetricDef {
  key: string;
  label: string;
  format: MetricFormat;
  direction: MetricDirection;
  get: (e: CompareEntity) => number | null;
}

/**
 * Build the comparison-table rows from two normalised entities (either may be `null` when its slug
 * was missing or invalid). The shared numeric metrics are: total €, contracts, suppliers/authorities,
 * average €, average bids, and EU-funded share. Only the competition-flavoured metrics
 * (counterparty diversity, average bids) carry a better/worse judgement; the rest are neutral.
 */
export function buildComparisonRows(
  a: CompareEntity | null,
  b: CompareEntity | null,
): ComparisonRow[] {
  const counterpartyLabel = a?.counterpartyLabel ?? b?.counterpartyLabel ?? 'Контрагенти';
  const defs: MetricDef[] = [
    {
      key: 'total',
      label: 'Обща стойност',
      format: 'money',
      direction: null,
      get: (e) => e.totalEur,
    },
    {
      key: 'contracts',
      label: 'Брой договори',
      format: 'count',
      direction: null,
      get: (e) => e.contracts,
    },
    {
      key: 'counterparties',
      label: counterpartyLabel,
      format: 'count',
      direction: 'higher',
      get: (e) => e.counterparties,
    },
    {
      key: 'avg',
      label: 'Средна стойност на договор',
      format: 'money',
      direction: null,
      get: (e) => e.avgEur,
    },
    {
      key: 'avgBids',
      label: 'Средно оферти на търг',
      format: 'bids',
      direction: 'higher',
      get: (e) => e.avgBids,
    },
    {
      key: 'eu',
      label: 'Дял с финансиране от ЕС',
      format: 'pct',
      direction: null,
      get: (e) => e.euSharePct,
    },
  ];
  return defs.map((d) => {
    const av = a ? d.get(a) : null;
    const bv = b ? d.get(b) : null;
    return {
      key: d.key,
      label: d.label,
      format: d.format,
      direction: d.direction,
      a: av,
      b: bv,
      betterSide: pickBetter(av, bv, d.direction),
    };
  });
}
