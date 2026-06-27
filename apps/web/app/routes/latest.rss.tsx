import { listContracts } from '@sigma/db';
import type { Route } from './+types/latest.rss';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { buildContractsRss, rfc822 } from '../lib/rss';

const FEED_SIZE = 50;

// Resource route (no default export): a valid RSS 2.0 feed of the newest signed contracts. Links are
// absolute against the canonical origin (see FEED_BASE) so subscriptions survive across hosts.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  const result = await withDbRetry(() =>
    listContracts(env.DB, { sort: 'date-desc', pageSize: FEED_SIZE }),
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
