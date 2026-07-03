// Pure geometry for the dual-axis combo chart. Given the display points (already rolled up to the
// active step) and a fixed user-space canvas, it lays out: contract-count bars on the right axis, the
// € area/line (with a dashed tail to the opted-in partial current period), the bold moving-average
// trend line, the peak marker, both value axes and the x-axis ticks, plus per-point hit boxes for
// hover. The SVG is
// drawn in this fixed user space and scaled to the container via viewBox, so nothing here needs the
// DOM — it renders identically on the server and the client.

import { count as fmtCount, moneyBare } from '@sigma/shared';
import { movingAverage, type DisplayPoint } from './trends-series';

export interface ChartDims {
  width: number;
  height: number;
  plotTop: number;
  axisH: number; // band at the bottom reserved for x-axis labels
  padL: number;
  padR: number;
}

export const DEFAULT_DIMS: ChartDims = {
  width: 760,
  height: 230,
  plotTop: 16,
  axisH: 22,
  padL: 2,
  padR: 2,
};

export interface ChartBar {
  x: number;
  y: number;
  w: number;
  h: number;
  partial: boolean;
}

export interface ChartPointXY {
  index: number;
  x: number;
  yValue: number; // y of the € line
  yCount: number; // top y of the count bar
  leftPct: number; // x as a percent of width (for absolutely-positioned hover tooltip)
}

export interface ChartHit {
  index: number;
  x: number;
  w: number;
}

export interface ChartModel {
  dims: ChartDims;
  plotBottom: number;
  n: number;
  firstPartialIndex: number; // n when no partial (opted-in current) point is shown
  bars: ChartBar[];
  actualLine: string;
  actualArea: string;
  // Dashed € tail from the last complete point to the opted-in partial current period ('' when the
  // partial period is not shown — the default).
  partialLine: string;
  trendPath: string;
  gridLines: { y: number; label: string }[]; // left € axis
  rightTicks: { y: number; label: string }[]; // right contract-count axis
  xTicks: { x: number; label: string }[];
  peak: { x: number; y: number; labelX: number; labelY: number; anchor: 'middle' | 'end' } | null;
  trendTag: { x: number; y: number } | null;
  points: ChartPointXY[];
  hits: ChartHit[];
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

// Catmull-Rom → cubic Bézier, matching the design mock's smoothing for the trend line.
function smoothPath(p: { x: number; y: number }[]): string {
  if (p.length < 2) return p.length === 1 ? `M${r1(p[0]!.x)} ${r1(p[0]!.y)}` : '';
  let d = `M${r1(p[0]!.x)} ${r1(p[0]!.y)}`;
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p[i + 1]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${r1(c1x)} ${r1(c1y)} ${r1(c2x)} ${r1(c2y)} ${r1(p2.x)} ${r1(p2.y)}`;
  }
  return d;
}

const linePath = (pts: { x: number; y: number }[]): string =>
  pts.length < 2 ? '' : pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.y)}`).join(' ');

const areaPath = (pts: { x: number; y: number }[], baseY: number): string =>
  pts.length < 2
    ? ''
    : `${linePath(pts)} L${r1(pts[pts.length - 1]!.x)} ${r1(baseY)} L${r1(pts[0]!.x)} ${r1(baseY)} Z`;

// A "nice" round ceiling for the right-axis (contract count) ticks.
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / mag) * mag;
}

/**
 * Lay out the whole chart. `trendWindow` is the moving-average window for the bold trend line and
 * `barRatio` the fraction of the slot each count bar fills (both vary by step, set by the caller).
 */
export function buildChartModel(
  pts: DisplayPoint[],
  opts: {
    dims?: Partial<ChartDims>;
    trendWindow?: number;
    barRatio?: number;
  } = {},
): ChartModel {
  const dims: ChartDims = { ...DEFAULT_DIMS, ...opts.dims };
  const { width, height, plotTop, axisH, padL, padR } = dims;
  const plotBottom = height - axisH;
  const n = pts.length;
  const step = n > 1 ? (width - padL - padR) / (n - 1) : 0;
  const xOf = (i: number): number => (n > 1 ? padL + i * step : width / 2);

  const vMaxL = Math.max(1, ...pts.map((p) => p.valueEur)) * 1.14;
  const cMax = Math.max(1, ...pts.map((p) => p.contracts));
  const barFrac = 0.66; // count bars occupy the lower 66% of the plot height
  const yL = (v: number): number => plotBottom - (v / vMaxL) * (plotBottom - plotTop);
  const yR = (c: number): number => plotBottom - (c / cMax) * (plotBottom - plotTop) * barFrac;

  // The opted-in partial current period only ever trails the series (combineSeries keeps order).
  let firstPartialIndex = n;
  for (let i = 0; i < n; i += 1) {
    if (pts[i]!.partial) {
      firstPartialIndex = i;
      break;
    }
  }

  const geom = pts.map((p, i) => ({ x: xOf(i), y: yL(p.valueEur) }));

  // Count bars (right axis).
  const barRatio = opts.barRatio ?? 0.6;
  const bw = n > 1 ? Math.max(2, Math.min(step * barRatio, 46)) : Math.min(width * 0.5, 60);
  const bars: ChartBar[] = pts.map((p, i) => {
    const top = yR(p.contracts);
    return {
      x: r1(geom[i]!.x - bw / 2),
      y: r1(top),
      w: r1(bw),
      h: r1(Math.max(0, plotBottom - top)),
      partial: p.partial,
    };
  });

  // € line + area over the complete points; a dashed tail joins the opted-in partial current period
  // (overlap one point so the join is seamless).
  const actualGeom = geom.slice(0, firstPartialIndex);
  const partialGeom = firstPartialIndex < n ? geom.slice(Math.max(0, firstPartialIndex - 1)) : [];
  const actualLine = linePath(actualGeom);
  const actualArea = areaPath(actualGeom, plotBottom);
  const partialLine = linePath(partialGeom);

  // Bold moving-average trend line, smoothed across every rendered point.
  const window = Math.max(1, opts.trendWindow ?? 7);
  const ma = movingAverage(
    pts.map((p) => p.valueEur),
    window,
  );
  const maGeom = ma.map((v, i) => ({ x: geom[i]!.x, y: yL(v) }));
  const trendPath = smoothPath(maGeom);
  const tIdx = firstPartialIndex > 0 ? firstPartialIndex - 1 : 0;
  const trendTag = n ? { x: r1(maGeom[tIdx]!.x - 5), y: r1(maGeom[tIdx]!.y - 7) } : null;

  // Peak among COMPLETE points (never the partial current period).
  const lim = n;
  let peakIdx = -1;
  for (let i = 0; i < lim; i += 1) {
    if (!pts[i]!.partial && (peakIdx < 0 || pts[i]!.valueEur > pts[peakIdx]!.valueEur)) peakIdx = i;
  }
  const nearRight = peakIdx >= 0 && peakIdx > n * 0.66;
  const peak =
    peakIdx >= 0
      ? {
          x: r1(geom[peakIdx]!.x),
          y: r1(geom[peakIdx]!.y),
          labelX: r1(geom[peakIdx]!.x + (nearRight ? -6 : 0)),
          labelY: r1(geom[peakIdx]!.y - 9),
          anchor: (nearRight ? 'end' : 'middle') as 'middle' | 'end',
        }
      : null;

  // Left € axis (4 gridlines) and right contract-count axis (2 ticks).
  const gridLines = [0, 1 / 3, 2 / 3, 1].map((f) => {
    const v = vMaxL * f;
    return { y: r1(yL(v)), label: f === 0 ? '0' : moneyBare(v) };
  });
  const niceC = niceCeil(cMax);
  const rightTicks = [0.5, 1].map((f) => ({ y: r1(yR(niceC * f)), label: fmtCount(niceC * f) }));

  const xTicks = pts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.tick != null)
    .map(({ p, i }) => ({ x: r1(geom[i]!.x), label: p.tick! }));

  const points: ChartPointXY[] = pts.map((p, i) => ({
    index: i,
    x: r1(geom[i]!.x),
    yValue: r1(geom[i]!.y),
    yCount: r1(yR(p.contracts)),
    leftPct: width > 0 ? r1((geom[i]!.x / width) * 100) : 0,
  }));

  // Per-point hover hit boxes spanning the midpoints to the neighbours.
  const hits: ChartHit[] = pts.map((_, i) => {
    const left = i === 0 ? 0 : (geom[i - 1]!.x + geom[i]!.x) / 2;
    const right = i === n - 1 ? width : (geom[i]!.x + geom[i + 1]!.x) / 2;
    return { index: i, x: r1(left), w: r1(Math.max(0, right - left)) };
  });

  return {
    dims,
    plotBottom: r1(plotBottom),
    n,
    firstPartialIndex,
    bars,
    actualLine,
    actualArea,
    partialLine,
    trendPath,
    gridLines,
    rightTicks,
    xTicks,
    peak,
    trendTag,
    points,
    hits,
  };
}
