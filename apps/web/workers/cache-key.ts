// Keep this allow-list in sync with query params consumed by apps/web/app/routes loaders.
export const CACHE_QUERY_PARAMS = new Set([
  'a', // /compare — entity A slug
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'b', // /compare — entity B slug
  'band', // /quality: histogram score-band filter on the contracts list — changes rows + totals (CWE-349)
  'bidder',
  'bids', // /contracts: c.bids_received = 1 — changes the result set and headline totals (CWE-349, #56)
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'cohort', // /price-anomaly (301 → /trends?angle=cpv) — legacy selected cohorts (repeatable); mapped into ?cpv, so the redirect target varies by it
  'conf', // /quality: confidence-tier facet on the contracts list — changes rows + totals (CWE-349)
  'contract', // /quality: scorecard subject
  'count',
  'cpv', // /contracts — exact 5-digit CPV filter; ALSO /trends: repeatable CPV group multi-select faceting the обзор chart + list (CWE-349)
  'cpvSort', // /trends: CPV list ordering
  'csort', // /quality: contract list ordering
  'cursor',
  'eu',
  'funding',
  'g', // /network: graph-only re-centre loader reads ?g=1 — do NOT drop even though /trends moved to `step`
  'grain', // /quality: rollup grain (authority|supplier|sector|region|year|funding)
  'kind',
  'metric', // /compare leaderboard dimension
  'p',
  'page', // pagination offset — distinct pages must not share a cache entry
  'procedure',
  'q',
  'rdir', // /quality: „Разбивка" ranking direction (asc|desc) — flips the rendered row order (CWE-349)
  'rfrom', // /quality: „Разбивка" avg-index range lower bound — changes rows + totals (CWE-349)
  'rpage', // /quality: „Разбивка" ranking OFFSET page — distinct pages must not share a cache entry
  'rto', // /quality: „Разбивка" avg-index range upper bound — changes rows + totals (CWE-349)
  'sector',
  'sel', // /quality: selected ranking row scoping the contract list
  'sort',
  'step', // reserved for /trends server-side series granularity (m|q|y); the dashboard's step toggle is client-side today

  'top', // singleSelectFilters: top-20 vs top-50 on /flows and /competition
  'type',
  'value',
  'year',
]);

// Params a loader reads but that intentionally do NOT change the response (so they're safe to omit
// from the cache key). None exist today — every consumed param affects output. This constant is not
// dead: the drift guard in cache-key.test.ts treats `consumed ⊆ CACHE_QUERY_PARAMS ∪
// INTENTIONALLY_UNKEYED` as the invariant, so any future read-but-ignored param must be listed here
// with a justification rather than silently absent (CWE-349, #56).
export const INTENTIONALLY_UNKEYED = new Set<string>([]);

export function cacheKey(request: Request, deployTag: string): Request {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  try {
    url.pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding should not break cache lookup; keep the raw path as the fallback.
  }

  for (const [key, value] of url.searchParams) {
    if (CACHE_QUERY_PARAMS.has(key)) params.append(key, value);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
