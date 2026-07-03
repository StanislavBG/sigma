/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createSqliteD1 } from './sqlite-d1';
import {
  NETWORK_GRAPH_DEFAULT,
  NETWORK_GRAPH_MAX,
  getEntityCounterparties,
  getEntityNetwork,
} from './queries/network';

// Integration test for the „Мрежа" graph-membership selection (options.neighbors — the profile
// pages' ?net param). The unit tests in queries/network.test.ts run against a fake D1; this runs
// the REAL SQL (the bound IN-list variant) against a real SQLite built from the production
// migration, and asserts the narrowing itself with exact edge counts: mutating the IN list, the
// LIMIT, or the ORDER BY breaks these numbers. Mirrors the sqlite3-CLI harness of
// competition-sql.test.ts, then drives the same better-sqlite3 adapter the fallback runtime uses.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');

// One authority hub with 10 company counterparties, won_eur strictly descending so the default
// top-NETWORK_GRAPH_DEFAULT cut and every selection are deterministic. A second authority gives
// eik:P07 a hop-2 ring (auth:X) to prove hop 2 follows the SELECTED hop-1 set.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:C', 'Институция Ц', '100000001', 'община'),
  ('auth:X', 'Институция Хикс', '100000002', 'община');
INSERT INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur) VALUES
  ('auth:C', 'Институция Ц', 55000, 10, 10, 5500),
  ('auth:X', 'Институция Хикс', 900, 1, 1, 900);
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts) VALUES
  ${Array.from({ length: 10 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `('auth:C', 'eik:P${n}', 'Институция Ц', 'Фирма П${n}', 'company', ${10000 - i * 1000}, ${i + 1})`;
  }).join(',\n  ')},
  ('auth:X', 'eik:P07', 'Институция Хикс', 'Фирма П07', 'company', 900, 1);
`;

function sqlite(dbPath: string, sql: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, stdio: 'pipe' });
}

const dir = mkdtempSync(join(tmpdir(), 'sigma-net-sel-'));
const dbPath = join(dir, 'net.sqlite');
sqlite(dbPath, `.read ${migration0}\n`);
sqlite(dbPath, FIXTURE);
const db = createSqliteD1(dbPath);
const CENTER = { kind: 'authority', id: 'auth:C' } as const;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('graph membership selection (real SQL)', () => {
  it('default (no selection) draws exactly the top-6 by value', async () => {
    const net = await getEntityNetwork(db, CENTER, { includeCenterOptions: false });
    const hop1 = net.edges.filter((e) => e.from === 'auth:C');
    expect(hop1).toHaveLength(NETWORK_GRAPH_DEFAULT);
    expect(hop1.map((e) => e.to)).toEqual([
      'eik:P01',
      'eik:P02',
      'eik:P03',
      'eik:P04',
      'eik:P05',
      'eik:P06',
    ]);
    expect(net.counterpartyTotal).toBe(10);
  });

  it('draws exactly an arbitrary selected set in ONE IN-list read — exact edges, exact values', async () => {
    const net = await getEntityNetwork(db, CENTER, {
      includeCenterOptions: false,
      neighbors: ['eik:P02', 'eik:P09', 'eik:P10'], // P09/P10 sit far below the default cut
    });
    const hop1 = net.edges.filter((e) => e.from === 'auth:C');
    expect(hop1).toHaveLength(3);
    // Ordered by won_eur DESC — the same ordering contract as the default read.
    expect(hop1.map((e) => e.to)).toEqual(['eik:P02', 'eik:P09', 'eik:P10']);
    expect(hop1.map((e) => e.valueEur)).toEqual([9000, 2000, 1000]);
    expect(net.nodes.find((n) => n.id === 'eik:P01')).toBeUndefined(); // top-1 excluded on purpose
    expect(net.counterpartyTotal).toBe(10); // degree unaffected by the drawn subset
  });

  it('hop 2 follows the SELECTED set, not the default one', async () => {
    // P07 (outside the default top-6) brings its other authority into hop 2 when selected…
    const withP07 = await getEntityNetwork(db, CENTER, {
      includeCenterOptions: false,
      neighbors: ['eik:P01', 'eik:P07'],
    });
    expect(withP07.edges).toHaveLength(3); // C→P01, C→P07, P07→X
    expect(withP07.edges.find((e) => e.from === 'eik:P07' && e.to === 'auth:X')).toBeTruthy();
    // …and the default view has no hop-2 ring at all (P07 is not drawn).
    const dflt = await getEntityNetwork(db, CENTER, { includeCenterOptions: false });
    expect(dflt.edges.some((e) => e.to === 'auth:X')).toBe(false);
  });

  it(`caps a hostile over-long selection at ${NETWORK_GRAPH_MAX} in SQL`, async () => {
    const all = Array.from({ length: 10 }, (_, i) => `eik:P${String(i + 1).padStart(2, '0')}`);
    const net = await getEntityNetwork(db, CENTER, {
      includeCenterOptions: false,
      neighbors: all,
    });
    expect(net.edges.filter((e) => e.from === 'auth:C')).toHaveLength(NETWORK_GRAPH_MAX);
  });

  it('ignores selected ids that are not counterparties of the centre', async () => {
    const net = await getEntityNetwork(db, CENTER, {
      includeCenterOptions: false,
      neighbors: ['eik:P03', 'eik:GHOST', 'auth:X'],
    });
    const hop1 = net.edges.filter((e) => e.from === 'auth:C');
    expect(hop1).toHaveLength(1);
    expect(hop1[0]?.to).toBe('eik:P03');
  });

  it('pages the full counterparty list with companyKind carried through', async () => {
    const page = await getEntityCounterparties(db, CENTER, { pageSize: 15 });
    expect(page.total).toBe(10);
    expect(page.rows).toHaveLength(10);
    expect(page.rows[0]).toMatchObject({
      companySlug: 'P01',
      companyKind: 'company',
      valueEur: 10000,
      contracts: 1,
    });
  });
});
