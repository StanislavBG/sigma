import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './sqlite-d1';
import { getEntityNetwork } from './queries/network';
import { getHomeData } from './queries/home';

// Gated smoke against the REAL ~1.7 GB corpus, run on Node via the better-sqlite3 adapter. Proves the
// fallback runtime serves the full dataset (directly answers the "can workerd open 1.7 GB" caveat).
// Skipped unless SIGMA_SMOKE_DB points at an existing served SQLite file, e.g.:
//   SIGMA_SMOKE_DB=apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite \
//     pnpm --filter @sigma/db exec vitest run src/sqlite-d1.corpus.test.ts
const SMOKE = process.env.SIGMA_SMOKE_DB;
const ready = Boolean(SMOKE && existsSync(SMOKE));

describe.skipIf(!ready)('corpus smoke (better-sqlite3 on Node)', () => {
  it('runs the real query layer against the full corpus', async () => {
    const db = createSqliteD1(SMOKE!);

    const home = await getHomeData(db);
    expect(home.totals.contracts).toBeGreaterThan(0);
    expect(home.topCompanies.length).toBeGreaterThan(0);

    const net = await getEntityNetwork(db, null);
    expect(net.center).not.toBeNull();
    expect(net.nodes.length).toBeGreaterThan(1);
    expect(net.edges.length).toBeGreaterThan(0);
  });
});
