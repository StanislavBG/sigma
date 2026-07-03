import { useEffect, useMemo, useState } from 'react';
import { count as fmtCount, money } from '@sigma/shared';
import { buildChartModel } from '../lib/trends-chart';
import type { DisplayPoint } from '../lib/trends-series';

// Dual-axis combo chart for the /trends dashboard, server-rendered (no chart JS, like SankeyDiagram):
// contract-count bars on a right axis, a € area/line over the actuals (only real data — a dashed tail
// marks the opted-in partial current month), a bold moving-average trend line and a peak marker. The
// accessible figures live in the „По години" table beside it (role="img" + aria-label here); hover is
// pure client enhancement layered over per-point hit boxes. (The simpler sparkline used by the
// entity/analytics embeds stays in TrendChart.tsx — this is the full dashboard variant.)
//
// SVG presentation colours come through CSS custom properties (set on .trend-chart-wrap in app.css)
// so the SVG stays themeable. This matches the design's chart palette exactly: the contract-count
// measure is slate (--trend-count), the € line is tan (--trend-line), the trend is ink, and the
// peak/hover are accent. Colour is never the sole encoder — each series also differs by shape
// (bars vs solid vs dashed line), is named in the legend, and the figures live in the „По години"
// table + the hover tooltip.

const BAR_ACTUAL = 'rgb(var(--trend-count) / 0.52)';
const BAR_PARTIAL = 'rgb(var(--trend-count) / 0.26)'; // faded — the in-progress month, still filling
const BAR_HOVER = 'rgb(var(--trend-count) / 0.92)';
const COUNT_INK = 'var(--trend-count-ink)'; // darker slate — count axis labels
const EUR_LINE = 'var(--trend-line)'; // tan — € line
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

// Phone widths render the default 760-unit viewBox at ~0.42× scale, which shrinks the in-SVG text to
// ~3–4px (mobile audit). At ≤720px the chart re-renders on a narrower 420-unit canvas with taller
// plot and scaled-up font sizes so labels stay ≥10px on a 320px screen. SSR renders the desktop
// dims (no window); the client swaps after hydration — pure progressive enhancement, the visual
// re-layout is driven by real viewport width.
const COMPACT_DIMS = { width: 420, height: 300 };
const COMPACT_FONT_SCALE = 1.45;

function useCompactChart(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return compact;
}

export function TrendComboChart({
  points,
  trendWindow,
  barRatio,
  ariaLabel,
}: {
  points: DisplayPoint[];
  trendWindow: number;
  barRatio: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const compact = useCompactChart();
  const model = useMemo(
    () =>
      buildChartModel(points, {
        trendWindow,
        barRatio,
        dims: compact ? COMPACT_DIMS : undefined,
      }),
    [points, trendWindow, barRatio, compact],
  );
  // Scale the in-SVG font sizes on the compact canvas so they stay legible at phone widths.
  const fs = (v: number): number => (compact ? Math.round(v * COMPACT_FONT_SCALE * 10) / 10 : v);
  if (points.length < 2) return null;

  const { dims, plotBottom } = model;
  const { width, height, plotTop } = dims;
  const hoverPt = hover != null ? model.points[hover] : null;
  const hoverData = hover != null ? points[hover] : null;

  return (
    <div className="trend-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="auto"
        role="img"
        aria-label={ariaLabel}
        className="trend-svg"
        onPointerLeave={() => setHover(null)}
      >
        <title>{ariaLabel}</title>
        <defs>
          <linearGradient
            id="trendArea"
            x1="0"
            y1={plotTop}
            x2="0"
            y2={plotBottom}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0.16 }} />
            <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
          </linearGradient>
        </defs>

        {/* left € axis gridlines */}
        {model.gridLines.map((g, i) => (
          <g key={`grid-${i}`}>
            <line
              x1={0}
              y1={g.y}
              x2={width}
              y2={g.y}
              style={{ stroke: 'var(--trend-grid)' }}
              strokeWidth={1}
            />
            <text
              x={2}
              y={g.y - 3}
              fontSize={fs(9)}
              style={{ fill: 'var(--ink-soft)', fontFamily: MONO }}
            >
              {g.label}
            </text>
          </g>
        ))}

        {/* contract-count bars (right axis) */}
        {model.bars.map((b, i) => (
          <rect
            key={`bar-${i}`}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            style={{ fill: hover === i ? BAR_HOVER : b.partial ? BAR_PARTIAL : BAR_ACTUAL }}
          />
        ))}

        {/* € area + line over the complete months; dashed tail to the opted-in partial month */}
        <path d={model.actualArea} fill="url(#trendArea)" />
        <path
          d={model.actualLine}
          fill="none"
          style={{ stroke: EUR_LINE }}
          strokeWidth={1.1}
          strokeLinejoin="round"
        />
        {model.partialLine && (
          <path
            d={model.partialLine}
            fill="none"
            style={{ stroke: EUR_LINE }}
            strokeWidth={1.1}
            strokeDasharray="4 3"
            strokeLinejoin="round"
          />
        )}

        {/* bold moving-average trend line */}
        <path
          d={model.trendPath}
          fill="none"
          style={{ stroke: 'var(--ink)' }}
          strokeWidth={2.3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* bold „ТРЕНД" tag on the moving-average line */}
        {model.trendTag && (
          <text
            x={model.trendTag.x}
            y={model.trendTag.y}
            textAnchor="end"
            fontSize={fs(8.5)}
            fontWeight={600}
            letterSpacing="0.12em"
            style={{ fill: 'var(--ink)', fontFamily: MONO }}
          >
            ТРЕНД
          </text>
        )}

        {/* right contract-count axis */}
        <text
          x={width}
          y={plotTop}
          textAnchor="end"
          fontSize={fs(8)}
          style={{ fill: COUNT_INK, fontFamily: MONO }}
        >
          договори ▸
        </text>
        {model.rightTicks.map((t, i) => (
          <text
            key={`rt-${i}`}
            x={width}
            y={t.y + 3}
            textAnchor="end"
            fontSize={fs(8.5)}
            style={{ fill: COUNT_INK, fontFamily: MONO }}
          >
            {t.label}
          </text>
        ))}

        {/* x-axis ticks */}
        {model.xTicks.map((t, i) => (
          <text
            key={`xt-${i}`}
            x={t.x}
            y={height - 5}
            textAnchor="middle"
            fontSize={fs(9)}
            style={{ fill: 'var(--ink-soft)', fontFamily: MONO }}
          >
            {t.label}
          </text>
        ))}

        {/* peak marker */}
        {model.peak && (
          <>
            <circle
              cx={model.peak.x}
              cy={model.peak.y}
              r={3.4}
              style={{ fill: 'var(--accent)', stroke: 'var(--paper-warm)' }}
              strokeWidth={1.4}
            />
            <text
              x={model.peak.labelX}
              y={model.peak.labelY}
              textAnchor={model.peak.anchor}
              fontSize={fs(9.5)}
              fontWeight={600}
              style={{ fill: 'var(--accent)', fontFamily: MONO }}
            >
              {peakValueLabel(points)}
            </text>
          </>
        )}

        {/* hover crosshair + dot */}
        {hoverPt && (
          <>
            <line
              x1={hoverPt.x}
              y1={plotTop}
              x2={hoverPt.x}
              y2={plotBottom}
              style={{ stroke: 'var(--accent)' }}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={hoverPt.x}
              cy={hoverPt.yValue}
              r={3.8}
              style={{ fill: 'var(--accent)', stroke: 'var(--paper-warm)' }}
              strokeWidth={1.6}
            />
          </>
        )}

        {/* per-point hover hit boxes (transparent) */}
        {model.hits.map((hit, i) => (
          <rect
            key={`hit-${i}`}
            x={hit.x}
            y={0}
            width={hit.w}
            height={height}
            fill="transparent"
            // pointerenter (not mouseenter) so a tap reveals the tooltip on touch screens too
            onPointerEnter={() => setHover(i)}
          />
        ))}
      </svg>

      {hoverPt && hoverData && (
        <div
          className="trend-tip"
          style={{
            // clamp so the centred tooltip never overflows the panel/viewport at the plot's edges
            left: `clamp(84px, ${hoverPt.leftPct}%, calc(100% - 84px))`,
            top: `${(Math.min(hoverPt.yValue, hoverPt.yCount) / height) * 100}%`,
          }}
        >
          <div className="trend-tip-head">
            {hoverData.label}
            {hoverData.partial && <span className="trend-tip-badge">ЧАСТИЧНО</span>}
          </div>
          <div className="trend-tip-row is-first">
            <span className="trend-tip-sw-line" />
            <span className="trend-tip-label">
              {hoverData.partial ? 'разходи до момента' : 'разходи'}
            </span>
            <span className="trend-tip-val">{money(hoverData.valueEur)}</span>
          </div>
          <div className="trend-tip-row">
            <span className="trend-tip-sw-box" />
            <span className="trend-tip-label">договори</span>
            <span className="trend-tip-val">{fmtCount(Math.round(hoverData.contracts))}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// The € value at the peak marker — the highest complete (non-partial) display point.
function peakValueLabel(points: DisplayPoint[]): string {
  let peak: DisplayPoint | null = null;
  for (const p of points) {
    if (!p.partial && (peak === null || p.valueEur > peak.valueEur)) peak = p;
  }
  return peak ? money(peak.valueEur) : '';
}
