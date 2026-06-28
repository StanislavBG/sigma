// Pure, SSR-safe squarified treemap layout. No DOM, no React — just geometry, so it is unit-testable
// and the /overruns route stays a thin renderer. Ports the squarify algorithm (Bruls, Huizing & van
// Wijk, "Squarified Treemaps", 2000): greedily pack items into rows along the rectangle's shorter
// side, extending the current row only while doing so keeps the worst (largest) aspect ratio from
// getting worse — which yields cells as close to squares as possible. Each cell's AREA is exactly
// proportional to its weight, so the figure is data-honest: area = € at risk on the dashboard.

export interface TreemapItem {
  /** Stable key echoed back on the cell (e.g. CPV division code). */
  key: string;
  /** Non-negative weight; the cell area is proportional to it. Zero/negative items are dropped. */
  weight: number;
}

export interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapCell extends TreemapRect {
  key: string;
}

interface Tile {
  key: string;
  area: number;
}

// Worst (largest) aspect ratio in a row of tiles laid along a side of length `length`. Lower is more
// square. Infinity for an empty row so the first tile always joins.
function worstRatio(row: Tile[], length: number): number {
  if (row.length === 0 || length <= 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const t of row) {
    sum += t.area;
    if (t.area > max) max = t.area;
    if (t.area < min) min = t.area;
  }
  if (sum <= 0) return Infinity;
  const s2 = sum * sum;
  const l2 = length * length;
  return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

// Place a finished row of tiles along the shorter edge of `free`, returning the laid cells and the
// remaining free rectangle. The row is stacked along the shorter side so each row's strip spans the
// full short dimension (the squarify invariant).
function layoutRow(row: Tile[], free: TreemapRect): { cells: TreemapCell[]; free: TreemapRect } {
  const sum = row.reduce((s, t) => s + t.area, 0);
  const cells: TreemapCell[] = [];
  if (sum <= 0) return { cells, free };

  if (free.w >= free.h) {
    // Vertical strip down the left edge; strip width = area / column height.
    const stripW = sum / free.h;
    let y = free.y;
    for (const t of row) {
      const cellH = t.area / stripW;
      cells.push({ key: t.key, x: free.x, y, w: stripW, h: cellH });
      y += cellH;
    }
    return {
      cells,
      free: { x: free.x + stripW, y: free.y, w: free.w - stripW, h: free.h },
    };
  }
  // Horizontal strip along the top edge; strip height = area / row width.
  const stripH = sum / free.w;
  let x = free.x;
  for (const t of row) {
    const cellW = t.area / stripH;
    cells.push({ key: t.key, x, y: free.y, w: cellW, h: stripH });
    x += cellW;
  }
  return {
    cells,
    free: { x: free.x, y: free.y + stripH, w: free.w, h: free.h - stripH },
  };
}

// Squarified treemap layout. Items are scaled so the total cell area exactly fills `rect`; each cell's
// area is proportional to its weight. Returns [] for an empty/degenerate input (no positive weights or
// a zero-area rect) so the renderer draws an honest empty figure rather than NaN cells.
export function squarify(items: TreemapItem[], rect: TreemapRect): TreemapCell[] {
  const positive = items.filter((it) => Number.isFinite(it.weight) && it.weight > 0);
  if (positive.length === 0 || rect.w <= 0 || rect.h <= 0) return [];

  const totalWeight = positive.reduce((s, it) => s + it.weight, 0);
  const totalArea = rect.w * rect.h;
  // Largest first — the squarify ordering that keeps cells squarest.
  const tiles: Tile[] = positive
    .map((it) => ({ key: it.key, area: (it.weight / totalWeight) * totalArea }))
    .sort((a, b) => b.area - a.area);

  const cells: TreemapCell[] = [];
  let free: TreemapRect = { ...rect };
  let row: Tile[] = [];

  for (const tile of tiles) {
    const length = Math.min(free.w, free.h);
    const withTile = [...row, tile];
    if (row.length === 0 || worstRatio(withTile, length) <= worstRatio(row, length)) {
      row = withTile;
    } else {
      const placed = layoutRow(row, free);
      cells.push(...placed.cells);
      free = placed.free;
      row = [tile];
    }
  }
  if (row.length > 0) {
    const placed = layoutRow(row, free);
    cells.push(...placed.cells);
  }
  return cells;
}
