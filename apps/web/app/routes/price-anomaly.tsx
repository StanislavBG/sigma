import { redirect } from 'react-router';
import type { Route } from './+types/price-anomaly';

// /price-anomaly („Раздути спрямо сходни") merged into the /trends обзор's CPV lens (#170 follow-up):
// the same cpv_cohort_stats / cpv_cohort_sample / cpv_cohort_outlier rollups now power
// /trends?angle=cpv — distribution table, „спрямо типичното" badges and the method ⓘ. This route
// remains only as a permanent redirect so old links, bookmarks and search results keep resolving.
//
// Param mapping (only where a meaningful equivalent exists):
//   • cohort=CODE (repeatable, the selected CPV cohorts) → cpv=CODE (the lens' CPV multi-select)
//   • sort / page (cohort-browse ordering + pager) → dropped — the lens has its own cpvSort semantics
//     and no cohort pager.
export function priceAnomalyRedirectTarget(url: URL): string {
  const next = new URLSearchParams();
  next.set('angle', 'cpv');
  // De-duplicated + shape-validated (5 digits), written sorted so equal selections share one
  // canonical target URL — the same convention the lens itself uses for its cache keys.
  const cohorts = [...new Set(url.searchParams.getAll('cohort'))]
    .filter((c) => /^\d{5}$/.test(c))
    .sort();
  for (const c of cohorts) next.append('cpv', c);
  return `/trends?${next.toString()}`;
}

export function loader({ request }: Route.LoaderArgs) {
  return redirect(priceAnomalyRedirectTarget(new URL(request.url)), 301);
}
