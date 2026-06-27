// Pure, unit-tested derivations for the /trends page. These take the raw aggregation rows that
// getSpendingTrend returns and turn them into the seasonality callout, the EU-vs-national split and
// the year-over-year sector "top movers" list. No DB, no rendering — just arithmetic, so the logic
// can be tested in isolation (repo convention: no render tests). Every output is honest about thin
// data: when there is not enough to say something true, the function returns null / empty.

export interface QuarterValue {
  year: string; // 'YYYY'
  quarter: number; // 1..4
  valueEur: number;
}

export interface SectorYearValue {
  division: string; // CPV division, e.g. '45'
  year: string; // 'YYYY'
  valueEur: number;
}

export interface FundingPoint {
  valueEur: number;
  euValueEur: number;
}

// ── Seasonality (Q4 budget-flush) ────────────────────────────────────────────────────────────────

export interface Seasonality {
  q4ShareRatio: number; // share of complete-year value signed in Q4 (Oct–Dec)
  q4ValueEur: number;
  totalValueEur: number;
  completeYears: number; // how many full years the share is averaged over
  excessOverEven: number; // q4ShareRatio − 0.25; a positive number means a real year-end spike
}

// Share of value signed in the final quarter, measured only over COMPLETE years: the running
// (partial) year is excluded so a mid-year as_of cannot understate Q4. Returns null when no complete
// year has any value — there is then nothing honest to say.
export function computeSeasonality(
  rows: QuarterValue[],
  opts: { partialYear: string | null },
): Seasonality | null {
  const completeYears = new Set<string>();
  let total = 0;
  let q4 = 0;
  for (const r of rows) {
    if (opts.partialYear && r.year >= opts.partialYear) continue;
    if (r.valueEur <= 0) continue;
    completeYears.add(r.year);
    total += r.valueEur;
    if (r.quarter === 4) q4 += r.valueEur;
  }
  if (total <= 0) return null;
  const q4ShareRatio = q4 / total;
  return {
    q4ShareRatio,
    q4ValueEur: q4,
    totalValueEur: total,
    completeYears: completeYears.size,
    excessOverEven: q4ShareRatio - 0.25,
  };
}

// ── EU vs national split ─────────────────────────────────────────────────────────────────────────

export interface FundingSplit {
  euEur: number;
  nationalEur: number;
  totalEur: number;
  euShareRatio: number; // EU-funded share of the total; 0 when total is 0
}

// Overall EU-vs-national split for the scope, summed across the period. National = total − EU
// (clamped at 0, so rounding never produces a negative bar).
export function computeFundingSplit(points: FundingPoint[]): FundingSplit {
  let total = 0;
  let eu = 0;
  for (const p of points) {
    total += p.valueEur;
    eu += p.euValueEur;
  }
  const national = Math.max(0, total - eu);
  return {
    euEur: eu,
    nationalEur: national,
    totalEur: total,
    euShareRatio: total > 0 ? eu / total : 0,
  };
}

// ── Top movers (year-over-year by sector) ────────────────────────────────────────────────────────

export interface SectorMover {
  division: string;
  label: string;
  prevEur: number;
  curEur: number;
  deltaEur: number; // curEur − prevEur
  yoyPct: number | null; // null when the previous year was zero (no honest ratio)
}

export interface TopMovers {
  prevYear: string;
  curYear: string;
  risers: SectorMover[];
  fallers: SectorMover[];
}

// Biggest year-over-year sector changes between the two most recent COMPLETE years. Ranked by
// absolute euro change (spend is what matters, not the percentage of a tiny base). Returns null when
// there are not two complete years to compare. `labels` maps a CPV division to a human label; the
// raw code is used as a fallback so nothing is dropped silently.
export function computeTopMovers(
  rows: SectorYearValue[],
  labels: Map<string, string>,
  opts: { partialYear: string | null; limit?: number },
): TopMovers | null {
  const limit = opts.limit ?? 5;
  const years = [...new Set(rows.map((r) => r.year))]
    .filter((y) => !(opts.partialYear && y >= opts.partialYear))
    .sort();
  if (years.length < 2) return null;
  const curYear = years[years.length - 1]!;
  const prevYear = years[years.length - 2]!;

  const byDivision = new Map<string, { prev: number; cur: number }>();
  for (const r of rows) {
    if (r.year !== curYear && r.year !== prevYear) continue;
    const acc = byDivision.get(r.division) ?? { prev: 0, cur: 0 };
    if (r.year === curYear) acc.cur += r.valueEur;
    else acc.prev += r.valueEur;
    byDivision.set(r.division, acc);
  }

  const movers: SectorMover[] = [...byDivision.entries()]
    .map(([division, v]) => ({
      division,
      label: labels.get(division) ?? division,
      prevEur: v.prev,
      curEur: v.cur,
      deltaEur: v.cur - v.prev,
      yoyPct: v.prev > 0 ? (v.cur - v.prev) / v.prev : null,
    }))
    // A flat division (no change either side) is noise.
    .filter((m) => m.deltaEur !== 0);

  const risers = movers
    .filter((m) => m.deltaEur > 0)
    .sort((a, b) => b.deltaEur - a.deltaEur)
    .slice(0, limit);
  const fallers = movers
    .filter((m) => m.deltaEur < 0)
    .sort((a, b) => a.deltaEur - b.deltaEur)
    .slice(0, limit);

  return { prevYear, curYear, risers, fallers };
}
