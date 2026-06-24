import type { NetworkData, NetworkNode } from '@sigma/api-contract';
import { count, money, moneyBare } from '@sigma/shared';

// Server-rendered ego graph (no chart JS, like SankeyDiagram). 1..3 focus entities; each focus's direct
// counterparties (hop 1) and their top other counterparty (hop 2). With one focus it is a radial graph
// (focus centred, neighbours on rings). With several foci each gets its own cluster and shared
// counterparties sit between the foci they bridge. Node size = incident-edge sum; edge thickness = flow
// value. Every node is an SVG anchor that adds/removes itself as a focus (lightweight SSR navigation —
// URL stays shareable/cacheable). Each edge carries a value label rotated to lie along the edge, toggled
// by a pure-CSS checkbox. The connections table beside it is the accessible fallback (role="img").
const W = 760;
const H = 540;
const CX = W / 2;
const CY = H / 2;
const R1 = 150; // single-focus hop-1 ring
const R2 = 250; // single-focus hop-2 ring
const RC = 104; // multi-focus: radius the foci sit on around the canvas centre
const RNEI = 122; // multi-focus: a focus's exclusive neighbours fan at this radius around it
const RH2 = 80; // multi-focus: hop-2 nodes sit this far beyond their hop-1 parent
const CENTER_FILL = 'var(--accent)'; // focus
const AUTH_FILL = 'var(--ink)'; // authorities
const COMP_FILL = 'var(--ink-mid)'; // companies

function truncate(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

type Pt = { x: number; y: number };

// Lay out every node. Single focus → the proven radial layout. Multiple foci → per-focus clusters with
// shared counterparties bridged between them. Returns a position per node id.
function layout(data: NetworkData): Map<string, Pt> {
  const { nodes, edges } = data;
  const centers = nodes.filter((n) => n.hop === 0);
  const hop1 = nodes.filter((n) => n.hop === 1);
  const hop2 = nodes.filter((n) => n.hop === 2);
  const pos = new Map<string, Pt>();
  const angleOf = new Map<string, number>();

  // Adjacency over the merged edge set (undirected) — used to find which foci a node touches and the
  // hop-1 parent of a hop-2 node.
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const centerIds = new Set(centers.map((c) => c.id));
  const touchedCenters = (id: string) => (adj.get(id) ?? []).filter((x) => centerIds.has(x));

  // ── Single focus: original radial layout ──────────────────────────────────────────────────────
  if (centers.length <= 1) {
    const c = centers[0];
    if (c) pos.set(c.id, { x: CX, y: CY });
    hop1.forEach((n, i) => {
      const a = (i / Math.max(1, hop1.length)) * Math.PI * 2 - Math.PI / 2;
      angleOf.set(n.id, a);
      pos.set(n.id, { x: CX + Math.cos(a) * R1, y: CY + Math.sin(a) * R1 });
    });
    hop2.forEach((n, i) => {
      const e = edges.find(
        (x) => (x.to === n.id && angleOf.has(x.from)) || (x.from === n.id && angleOf.has(x.to)),
      );
      const parent = e ? (angleOf.has(e.from) ? e.from : e.to) : null;
      const base =
        parent != null ? (angleOf.get(parent) ?? 0) : (i / Math.max(1, hop2.length)) * Math.PI * 2;
      const a = base + (i % 2 === 0 ? 1 : -1) * 0.14 * Math.ceil(i / 2);
      pos.set(n.id, { x: CX + Math.cos(a) * R2, y: CY + Math.sin(a) * R2 });
    });
    return pos;
  }

  // ── Multiple foci: cluster per focus + bridge shared counterparties ───────────────────────────
  const k = centers.length;
  const centerPos = new Map<string, Pt & { a: number }>();
  centers.forEach((c, i) => {
    const a = -Math.PI / 2 + (i / k) * Math.PI * 2;
    const p = { x: CX + Math.cos(a) * RC, y: CY + Math.sin(a) * RC, a };
    centerPos.set(c.id, p);
    pos.set(c.id, { x: p.x, y: p.y });
  });

  // hop 1: exclusive neighbours fan around their focus; nodes shared by ≥2 foci go between them.
  const exclusive = new Map<string, string[]>();
  const shared: { id: string; cc: string[] }[] = [];
  for (const n of hop1) {
    const cc = touchedCenters(n.id);
    if (cc.length === 1) (exclusive.get(cc[0]) ?? exclusive.set(cc[0], []).get(cc[0])!).push(n.id);
    else shared.push({ id: n.id, cc: cc.length ? cc : centers.map((c) => c.id) });
  }
  const ARC = (Math.PI * 2 * 0.8) / k; // each focus's neighbours stay within its own slice
  for (const [cid, ids] of exclusive) {
    const c = centerPos.get(cid)!;
    const m = ids.length;
    ids.forEach((id, j) => {
      const a = c.a + (j - (m - 1) / 2) * (ARC / Math.max(1, m));
      const p = { x: c.x + Math.cos(a) * RNEI, y: c.y + Math.sin(a) * RNEI };
      pos.set(id, p);
      angleOf.set(id, Math.atan2(p.y - CY, p.x - CX));
    });
  }
  shared.forEach((s, idx) => {
    const ps = s.cc
      .map((id) => centerPos.get(id))
      .filter((p): p is Pt & { a: number } => p != null);
    const cx = ps.reduce((t, p) => t + p.x, 0) / ps.length;
    const cy = ps.reduce((t, p) => t + p.y, 0) / ps.length;
    // Spread several bridges perpendicular to the line between the first two foci so they don't stack.
    let ox = 0;
    let oy = 0;
    if (ps.length >= 2) {
      const dx = ps[1].x - ps[0].x;
      const dy = ps[1].y - ps[0].y;
      const L = Math.hypot(dx, dy) || 1;
      const off = (idx - (shared.length - 1) / 2) * 28;
      ox = (-dy / L) * off;
      oy = (dx / L) * off;
    }
    const p = { x: cx + ox, y: cy + oy };
    pos.set(s.id, p);
    angleOf.set(s.id, Math.atan2(p.y - CY, p.x - CX));
  });

  // hop 2: just beyond their hop-1 parent, radially outward from the canvas centre.
  hop2.forEach((n, i) => {
    const parent = (adj.get(n.id) ?? []).find((x) => pos.has(x) && !centerIds.has(x));
    const pp = parent ? pos.get(parent)! : null;
    if (pp) {
      const baseA =
        Math.atan2(pp.y - CY, pp.x - CX) + (i % 2 === 0 ? 1 : -1) * 0.12 * Math.ceil(i / 2);
      pos.set(n.id, { x: pp.x + Math.cos(baseA) * RH2, y: pp.y + Math.sin(baseA) * RH2 });
    } else {
      const a = (i / Math.max(1, hop2.length)) * Math.PI * 2 - Math.PI / 2;
      pos.set(n.id, { x: CX + Math.cos(a) * (R2 + 20), y: CY + Math.sin(a) * (R2 + 20) });
    }
  });
  return pos;
}

export function NetworkGraph({
  data,
  centerTokens,
  maxCenters,
}: {
  data: NetworkData;
  centerTokens: string[];
  maxCenters: number;
}) {
  const { nodes, edges, centers } = data;
  // Defensive guard so the component is safe on its own; network.tsx also gates on the same condition.
  if (!centers.length || nodes.length < 2) return null;

  const pos = layout(data);
  const maxVal = Math.max(1, ...nodes.map((n) => n.valueEur));
  const radius = (n: NetworkNode) => 6 + Math.sqrt(n.valueEur / maxVal) * 22;
  const maxEdge = Math.max(1, ...edges.map((e) => e.valueEur));
  const strokeW = (v: number) => 1 + (v / maxEdge) * 5;
  const fill = (n: NetworkNode) =>
    n.hop === 0 ? CENTER_FILL : n.kind === 'authority' ? AUTH_FILL : COMP_FILL;

  // Clicking a node toggles it in the focus list: a focus removes itself; any other node is appended
  // (dropping the oldest focus once at the cap). Same ?center grammar the loader parses.
  const tokenOf = (n: NetworkNode) => `${n.kind === 'authority' ? 'a' : 'c'}:${n.slug}`;
  const hrefFor = (n: NetworkNode) => {
    const tok = tokenOf(n);
    const next = centerTokens.includes(tok)
      ? centerTokens.filter((t) => t !== tok)
      : [...centerTokens, tok].slice(-maxCenters);
    return next.length ? `/network?center=${next.join(',')}` : '/network';
  };
  const focusName = centers.map((c) => c.label).join(', ');

  return (
    <div className="net-graph">
      {/* Pure-CSS toggle: when unchecked, `.net-graph:has(input:not(:checked)) .edge-label` hides the
          edge value labels — no client JS, so the graph stays server-rendered. Default on. */}
      <label className="net-toggle">
        <input type="checkbox" defaultChecked />
        Стойности по връзките
      </label>
      {/* Sankey-style horizontal scroll so the fixed-width graph does not squash on phones; the
          connections table below is the accessible fallback. */}
      <div className="flow-scroll">
        <svg
          viewBox={`-100 -10 ${W + 200} ${H + 20}`}
          role="img"
          aria-label={`Граф на връзките около ${focusName}`}
          className="network-svg"
        >
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const L = Math.hypot(dx, dy) || 1;
            // Rotate the label to lie along the edge, kept upright (never upside-down), and nudged off
            // the line along its perpendicular so the number does not sit on top of the stroke.
            let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
            if (deg > 90) deg -= 180;
            else if (deg < -90) deg += 180;
            const off = 8;
            const lx = (a.x + b.x) / 2 + (-dy / L) * off;
            const ly = (a.y + b.y) / 2 + (dx / L) * off;
            return (
              <g key={`e${i}`}>
                <line
                  className="edge"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  style={{ strokeWidth: strokeW(e.valueEur) }}
                >
                  <title>{`${money(e.valueEur)} · ${count(e.contracts)} ${
                    e.contracts === 1 ? 'договор' : 'договора'
                  }`}</title>
                </line>
                <text
                  className="edge-label"
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="central"
                  transform={`rotate(${deg} ${lx} ${ly})`}
                >
                  {moneyBare(e.valueEur)}
                </text>
              </g>
            );
          })}
          {nodes.map((n) => {
            const pt = pos.get(n.id);
            if (!pt) return null;
            const r = radius(n);
            const right = pt.x >= CX;
            const isFocus = n.hop === 0;
            const title = `${n.label}: ${money(n.valueEur)}`;
            const shape =
              n.kind === 'company' ? (
                <rect
                  className="node"
                  x={pt.x - r}
                  y={pt.y - r}
                  width={r * 2}
                  height={r * 2}
                  rx={3}
                  style={{ fill: fill(n) }}
                >
                  <title>{title}</title>
                </rect>
              ) : (
                <circle className="node" cx={pt.x} cy={pt.y} r={r} style={{ fill: fill(n) }}>
                  <title>{title}</title>
                </circle>
              );
            const text = (
              <text
                className="node-label"
                x={right ? pt.x + r + 4 : pt.x - r - 4}
                y={pt.y + 3}
                textAnchor={right ? 'start' : 'end'}
              >
                {truncate(n.label)}
              </text>
            );
            // Every node is an anchor (native <a href> = accessible + keyboard-navigable): a focus
            // removes itself, any other node is added as a focus.
            return (
              <a
                key={n.id}
                href={hrefFor(n)}
                className={isFocus ? 'is-focus' : undefined}
                aria-label={`${isFocus ? 'Премахни фокус' : 'Добави фокус'}: ${n.label}`}
              >
                {shape}
                {text}
              </a>
            );
          })}
        </svg>
      </div>
      <ul className="net-legend" aria-hidden="true">
        <li>
          <span className="key center" /> Фокус
        </li>
        <li>
          <span className="key authority" /> Институция
        </li>
        <li>
          <span className="key company" /> Фирма
        </li>
      </ul>
    </div>
  );
}
