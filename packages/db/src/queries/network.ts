// Relationship graph — the ego network around one entity (authority or company) for the /network page.
// Centre + its top direct counterparties (hop 1) + each counterparty's single top other counterparty
// (hop 2), which surfaces clusters (suppliers shared across authorities, authorities sharing suppliers)
// that the global /flows Sankey does not. Reads the flow_pairs rollup (cheap); no new precompute table.

import type {
  NetworkCenterOption,
  NetworkData,
  NetworkEdge,
  NetworkNode,
} from '@sigma/api-contract';
import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug } from './identity';

export type NetworkCenterKind = 'authority' | 'company';
export interface NetworkParams {
  kind: NetworkCenterKind;
  id: string;
}

const HOP1 = 6; // direct counterparties shown
const HOP2_SCAN = HOP1 * 10; // rows scanned for hop 2 before the top-1-per-neighbour reduction
const PICKER_LIMIT = 12; // entities offered in the centre picker

interface PairRow {
  authority_id: string;
  bidder_id: string;
  authority_name: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  won_eur: number;
  contracts: number;
}

type Center = NonNullable<NetworkData['center']>;

function authorityNodeOf(r: PairRow, hop: number): NetworkNode {
  return {
    id: r.authority_id,
    kind: 'authority',
    label: cleanName(r.authority_name),
    slug: authoritySlug(r.authority_id),
    valueEur: 0, // node size is the incident-edge sum, set in getEntityNetwork below
    hop,
  };
}

function companyNodeOf(r: PairRow, hop: number): NetworkNode {
  const name = cleanName(r.bidder_name);
  return {
    id: r.bidder_id,
    kind: 'company',
    label: entityName(name, r.bidder_kind),
    slug: companySlug(r.bidder_id),
    valueEur: 0, // node size is the incident-edge sum, set in getEntityNetwork below
    hop,
  };
}

async function loadCenterOptions(
  db: D1Database,
): Promise<{ authorities: NetworkCenterOption[]; companies: NetworkCenterOption[] }> {
  const [a, c] = await Promise.all([
    db
      .prepare(
        `SELECT authority_id, name FROM authority_totals
         WHERE EXISTS (SELECT 1 FROM flow_pairs f WHERE f.authority_id = authority_totals.authority_id)
         ORDER BY spent_eur DESC, authority_id LIMIT ?`,
      )
      .bind(PICKER_LIMIT)
      .all<{ authority_id: string; name: string }>(),
    db
      .prepare(
        `SELECT bidder_id, name, kind FROM company_totals
         WHERE EXISTS (SELECT 1 FROM flow_pairs f WHERE f.bidder_id = company_totals.bidder_id)
         ORDER BY won_eur DESC, bidder_id LIMIT ?`,
      )
      .bind(PICKER_LIMIT)
      .all<{ bidder_id: string; name: string; kind: 'company' | 'consortium' }>(),
  ]);
  return {
    authorities: a.results.map((r) => ({
      kind: 'authority',
      label: cleanName(r.name),
      value: `a:${authoritySlug(r.authority_id)}`,
    })),
    companies: c.results.map((r) => ({
      kind: 'company',
      label: entityName(cleanName(r.name), r.kind),
      value: `c:${companySlug(r.bidder_id)}`,
    })),
  };
}

async function loadCenter(
  db: D1Database,
  p: NetworkParams,
  sample?: PairRow,
): Promise<Center | null> {
  if (p.kind === 'authority') {
    const row = await db
      .prepare(`SELECT name, spent_eur FROM authority_totals WHERE authority_id = ?`)
      .bind(p.id)
      .first<{ name: string; spent_eur: number }>();
    const name = row?.name ?? sample?.authority_name;
    if (name == null) return null;
    return {
      id: p.id,
      kind: 'authority',
      label: cleanName(name),
      slug: authoritySlug(p.id),
      valueEur: row?.spent_eur ?? 0,
    };
  }
  const row = await db
    .prepare(`SELECT name, kind, won_eur FROM company_totals WHERE bidder_id = ?`)
    .bind(p.id)
    .first<{ name: string; kind: 'company' | 'consortium'; won_eur: number }>();
  const name = row?.name ?? sample?.bidder_name;
  if (name == null) return null;
  return {
    id: p.id,
    kind: 'company',
    label: entityName(cleanName(name), row?.kind ?? sample?.bidder_kind ?? 'company'),
    slug: companySlug(p.id),
    valueEur: row?.won_eur ?? 0,
  };
}

// Up to this many focus entities can be on the graph at once. The page accumulates clicks into the
// `?center=` list; beyond this the oldest focus is dropped (see routes/network.tsx). Kept small so the
// merged ego network stays legible — more is allowed but readability degrades.
export const MAX_CENTERS = 3;

// The ego network of ONE centre: centre (hop 0) + its top direct counterparties (hop 1) + each of
// those neighbours' single top other counterparty (hop 2). Returned without node weights — the caller
// merges several egos and computes incident-edge weights over the union.
async function loadEgo(
  db: D1Database,
  p: NetworkParams,
): Promise<{ center: Center; nodes: NetworkNode[]; edges: NetworkEdge[] } | null> {
  const isAuth = p.kind === 'authority';
  const centerCol = isAuth ? 'authority_id' : 'bidder_id';
  const neighborCol = isAuth ? 'bidder_id' : 'authority_id';

  const hop1 = (
    await db
      .prepare(
        `SELECT authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts
         FROM flow_pairs WHERE ${centerCol} = ? ORDER BY won_eur DESC LIMIT ?`,
      )
      .bind(p.id, HOP1)
      .all<PairRow>()
  ).results;

  const center = await loadCenter(db, p, hop1[0]);
  if (!center) return null;

  const nodes = new Map<string, NetworkNode>([[center.id, { ...center, hop: 0 }]]);
  const edges: NetworkEdge[] = [];
  const neighborIds: string[] = [];
  for (const r of hop1) {
    const node = isAuth ? companyNodeOf(r, 1) : authorityNodeOf(r, 1);
    if (node.id === center.id) continue;
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    edges.push({ from: center.id, to: node.id, valueEur: r.won_eur, contracts: r.contracts });
    neighborIds.push(node.id);
  }

  // hop 2: each direct neighbour's single top OTHER counterparty (same kind as the centre). LIMIT caps
  // the scan so a high-degree neighbour cannot pull hundreds of rows; the top-1-per-neighbour reduction
  // then runs in JS over that bounded set.
  if (neighborIds.length) {
    const placeholders = neighborIds.map(() => '?').join(', ');
    const hop2 = (
      await db
        .prepare(
          `SELECT authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts
           FROM flow_pairs WHERE ${neighborCol} IN (${placeholders}) AND ${centerCol} != ?
           ORDER BY won_eur DESC LIMIT ?`,
        )
        .bind(...neighborIds, p.id, HOP2_SCAN)
        .all<PairRow>()
    ).results;
    const seenNeighbor = new Set<string>();
    for (const r of hop2) {
      const neighborId = isAuth ? r.bidder_id : r.authority_id;
      if (seenNeighbor.has(neighborId)) continue; // top-1 per neighbour
      seenNeighbor.add(neighborId);
      const node = isAuth ? authorityNodeOf(r, 2) : companyNodeOf(r, 2);
      if (node.id === center.id) continue;
      if (!nodes.has(node.id)) nodes.set(node.id, { ...node, hop: 2 });
      edges.push({ from: neighborId, to: node.id, valueEur: r.won_eur, contracts: r.contracts });
    }
  }

  return { center, nodes: [...nodes.values()], edges };
}

export async function getEntityNetwork(
  db: D1Database,
  params: NetworkParams[] | null,
): Promise<NetworkData> {
  const centerOptions = await loadCenterOptions(db);
  const empty = { center: null, centers: [], nodes: [], edges: [], centerOptions } as NetworkData;

  const seen = new Set<string>();
  const deduped = (params ?? []).filter((p) => {
    const k = `${p.kind}:${p.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let list = deduped.length ? deduped.slice(0, MAX_CENTERS) : null;
  if (!list) {
    // Default centre: the biggest authority by spend, so the page shows something on first load.
    const top = await db
      .prepare(
        `SELECT authority_id FROM authority_totals
         WHERE EXISTS (SELECT 1 FROM flow_pairs f WHERE f.authority_id = authority_totals.authority_id)
         ORDER BY spent_eur DESC, authority_id LIMIT 1`,
      )
      .first<{ authority_id: string }>();
    if (!top) return empty;
    list = [{ kind: 'authority', id: top.authority_id }];
  }

  const egos = (await Promise.all(list.map((p) => loadEgo(db, p)))).filter(
    (e): e is NonNullable<typeof e> => e != null,
  );
  if (!egos.length) return empty;

  const centers = egos.map((e) => e.center);
  const centerIds = new Set(centers.map((c) => c.id));

  // Merge the egos. Centres are authoritative (hop 0) even where they also appear as another centre's
  // neighbour; every other node keeps its smallest hop across the egos it appears in.
  const nodes = new Map<string, NetworkNode>();
  for (const c of centers) nodes.set(c.id, { ...c, hop: 0 });
  for (const ego of egos) {
    for (const nd of ego.nodes) {
      if (centerIds.has(nd.id)) continue;
      const existing = nodes.get(nd.id);
      if (!existing) nodes.set(nd.id, nd);
      else if (nd.hop < existing.hop) nodes.set(nd.id, { ...existing, hop: nd.hop });
    }
  }

  // Edges deduped by unordered endpoint pair — a shared counterparty between two foci yields the same
  // authority↔company pair from both egos; the flow_pairs value is identical, so keep one.
  const edges: NetworkEdge[] = [];
  const seenEdge = new Set<string>();
  for (const ego of egos) {
    for (const e of ego.edges) {
      const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push(e);
    }
  }

  // Node weight = sum of incident edge values (drives the circle size in the graph).
  const weight = new Map<string, number>();
  for (const e of edges) {
    weight.set(e.from, (weight.get(e.from) ?? 0) + e.valueEur);
    weight.set(e.to, (weight.get(e.to) ?? 0) + e.valueEur);
  }
  const nodeList = [...nodes.values()].map((nd) => ({
    ...nd,
    valueEur: weight.get(nd.id) ?? nd.valueEur,
  }));

  return { center: centers[0] ?? null, centers, nodes: nodeList, edges, centerOptions };
}
