// Pure, unit-tested formatters + derivations for the /analytics landing cards. Each card shows two
// real KPI figures sourced from the loader's rollup queries; these helpers turn the raw numbers the
// DB returns into the exact card strings (a growth multiple, a yearly-growth tag, an abbreviated peak
// month, a percentage-point swing). No DB, no rendering — just arithmetic + formatting, so they can
// be tested in isolation (repo convention: no render tests). Every helper is honest about thin data:
// a missing / non-finite input returns the em-dash, never a fabricated figure.

import { signedPct } from '@sigma/shared';

import { formatGrowthFactor } from './overruns-chart';

const EM_DASH = '—';

// Abbreviated Bulgarian month names for the trend „ПИК" stat (e.g. '2025-12' → „дек 2025").
const MONTHS_SHORT_BG = [
  'яну',
  'фев',
  'мар',
  'апр',
  'май',
  'юни',
  'юли',
  'авг',
  'сеп',
  'окт',
  'ное',
  'дек',
];

// Median post-annex growth as a multiple of the signing value: a median overrun of +210% (pct 2.1)
// reads „3,1×". Delegates to /overruns' formatGrowthFactor so /analytics and /overruns render the
// identical string (single source of truth for the „×" formatting); null/non-finite → em-dash.
export function growthMultiple(medianPct: number | null | undefined): string {
  if (medianPct == null || !Number.isFinite(medianPct)) return EM_DASH;
  return formatGrowthFactor(medianPct);
}

// „+18%/год" — yearly growth as a signed integer percentage with the per-year suffix. The input ratio
// is the canonical /trends growth estimate (3-year trailing median, clamped) so the landing card and
// the /trends header always read the same figure.
export function formatYearlyGrowth(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  return `${signedPct(ratio, 0)}/год`;
}

export interface PeakablePoint {
  period: string; // 'YYYY-MM'
  valueEur: number;
  partial?: boolean;
}

// The highest-value complete period in the series (the partial final period is skipped so a half-month
// dip never reads as the peak). Returns null for an empty / all-partial series.
export function peakPoint<T extends PeakablePoint>(points: T[]): T | null {
  let best: T | null = null;
  for (const p of points) {
    if (p.partial) continue;
    if (best == null || p.valueEur > best.valueEur) best = p;
  }
  return best;
}

// 'YYYY-MM' → „дек 2025" (abbreviated month + year).
export function formatPeakMonth(period: string | null | undefined): string {
  if (!period) return EM_DASH;
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const month = MONTHS_SHORT_BG[Number(m[2]) - 1] ?? m[2];
  return `${month} ${m[1]}`;
}

export interface OpaqueShareYear {
  year: string;
  valueEur: number;
  singleOfferValueEur: number;
}

export interface OpaqueHeadline {
  latestYear: string;
  latestShare: number; // ratio
  firstYear: string;
  firstShare: number; // ratio
  ppChange: number; // latestShare − firstShare, in ratio units (multiply by 100 for пр.п.)
}

// Single-offer value share for the latest and first years on record, plus the percentage-point swing
// between them. Years with no value are dropped (their share is undefined); null when nothing remains.
export function opaqueHeadline(rows: OpaqueShareYear[]): OpaqueHeadline | null {
  const usable = rows.filter((r) => r.valueEur > 0).sort((a, b) => a.year.localeCompare(b.year));
  if (usable.length === 0) return null;
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const firstShare = first.singleOfferValueEur / first.valueEur;
  const latestShare = last.singleOfferValueEur / last.valueEur;
  return {
    latestYear: last.year,
    latestShare,
    firstYear: first.year,
    firstShare,
    ppChange: latestShare - firstShare,
  };
}

// A percentage-point swing as „+7 пр.п." / „−3 пр.п." (rounded to a whole point). Input is a ratio
// difference (0.07 → „+7 пр.п."); a flat or non-finite delta drops the sign.
export function formatPpChange(deltaRatio: number | null | undefined): string {
  if (deltaRatio == null || !Number.isFinite(deltaRatio)) return EM_DASH;
  const points = Math.round(deltaRatio * 100);
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${Math.abs(points)} пр.п.`;
}
