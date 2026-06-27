import { listContracts } from '@sigma/db';
import type { Route } from './+types/trends.rss';
import { CPV_SECTORS } from '@sigma/config';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { buildContractsRss, rfc822 } from '../lib/rss';

const FEED_SIZE = 50;

// Resource route (no default export): a valid RSS 2.0 feed of the newest signed contracts — the
// subscribe-without-an-account companion to the /trends "Най-нови договори" section. Honours the same
// sector/funding filters as /trends, so `?sector=45` subscribes to just that slice. Links are absolute
// against the canonical origin (see FEED_BASE) so subscriptions survive across hosts.
export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sector = sp.get('sector');
  const validSector = sector && CPV_SECTORS.some((s) => s.code === sector) ? sector : null;
  const funding =
    sp.get('funding') === 'eu' ? 'eu' : sp.get('funding') === 'national' ? 'national' : null;

  const { env } = context.cloudflare;
  const result = await withDbRetry(() =>
    listContracts(env.DB, {
      sort: 'date-desc',
      sectors: validSector ? [validSector] : [],
      eu: funding,
      pageSize: FEED_SIZE,
    }),
  );
  const lastBuildDate = rfc822(result.items[0]?.signedAt) ?? new Date().toUTCString();
  const body = buildContractsRss(result.items, { lastBuildDate });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': publicCache(1800),
    },
  });
}
