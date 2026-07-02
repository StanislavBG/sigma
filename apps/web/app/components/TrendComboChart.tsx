import { useEffect, useMemo, useState } from 'react';
import { count as fmtCount, money } from '@sigma/shared';
import { buildChartModel } from '../lib/trends-chart';
import type { DisplayPoint } from '../lib/trends-series';

// Dual-axis combo chart for the /trends dashboard, server-rendered (no chart JS, like SankeyDiagram):
// contract-count bars on a right axis, a € area/line split into actual vs forecast, a bold moving-
// average trend line, a peak marker and a dashed „ПРОГНОЗА" band. The accessible figures live in the
// „По години" table beside it (role="img" + aria-label here); hover is pure client enhancement layered
// over per-point hit boxes. (The simpler sparkline used by the entity/analytics embeds stays in
// TrendChart.tsx — this is the full dashboard variant.)
//
// SVG presentation colours come through CSS custom properties (set on .trend-chart-wrap in app.css)
// so the SVG stays themeable. This matches the design's chart palette exactly: the contract-count
// measure is slate (--trend-count), the € line is tan (--trend-line), the trend is ink, and the
// forecast/peak/hover are accent. Colour is never the sole encoder — each series also differs by shape
// (bars vs solid vs dashed line), is named in the legend, and the figures live in the „По години"
// table + the hover tooltip.

const BAR_ACTUAL = 'rgb(var(--trend-count) / 0.52)';
const BAR_FORECAST = 'rgb(var(--trend-count) / 0.26)';
const BAR_HOVER = 'rgb(var(--trend-count) / 0.92)';
const BAND_FILL = 'rgb(var(--trend-count) / 0.06)';
const COUNT_INK = 'var(--trend-count-ink)'; // darker slate — count axis + ПРОГНОЗА label
const EUR_LINE = 'var(--trend-line)'; // tan — actual/forecast € line
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
  partial = null,
}: {
  points: DisplayPoint[];
  trendWindow: number;
  barRatio: number;
  ariaLabel: string;
  // The current in-progress period's REAL partial value — plotted as a „до момента" hollow marker
  // beside the projection (month view only). Null = don't show it.
  partial?: { valueEur: number; contracts: number } | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const compact = useCompactChart();
  const model = useMemo(
    () =>
      buildChartModel(points, {
        trendWindow,
        barRatio,
        partial,
        dims: compact ? COMPACT_DIMS : undefined,
      }),
    [points, trendWindow, barRatio, partial, compact],
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

        {/* forecast band + "today" divider */}
        {model.band && (
          <>
            <rect
              x={model.band.x}
              y={plotTop}
              width={model.band.w}
              height={plotBottom - plotTop}
              style={{ fill: BAND_FILL }}
            />
            <line
              x1={model.todayX!}
              y1={plotTop}
              x2={model.todayX!}
              y2={plotBottom}
              style={{ stroke: 'var(--accent)' }}
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <text
              x={model.band.labelX}
              y={model.band.labelY}
              textAnchor="middle"
              fontSize={fs(8.5)}
              fontWeight={600}
              letterSpacing="0.14em"
              style={{ fill: COUNT_INK, fontFamily: MONO }}
            >
              ПРОГНОЗА
            </text>
          </>
        )}

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
            style={{ fill: hover === i ? BAR_HOVER : b.forecast ? BAR_FORECAST : BAR_ACTUAL }}
          />
        ))}

        {/* € area + line, split actual / forecast */}
        <path d={model.actualArea} fill="url(#trendArea)" />
        {model.forecastArea && (
          <path d={model.forecastArea} fill="url(#trendArea)" opacity={0.45} />
        )}
        <path
          d={model.actualLine}
          fill="none"
          style={{ stroke: EUR_LINE }}
          strokeWidth={1.1}
          strokeLinejoin="round"
        />
        {model.forecastLine && (
          <path
            d={model.forecastLine}
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

        {/* x-axis ticks (forecast ticks read in a cooler muted slate) */}
        {model.xTicks.map((t, i) => (
          <text
            key={`xt-${i}`}
            x={t.x}
            y={height - 5}
            textAnchor="middle"
            fontSize={fs(9)}
            style={{
              fill: t.forecast ? 'var(--trend-xtick-fc)' : 'var(--ink-soft)',
              fontFamily: MONO,
            }}
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
              {peakValueLabel(points, model.firstForecastIndex)}
            </text>
          </>
        )}

        {/* „до момента" marker: the current period's real partial value beside the projection */}
        {model.partialMarker && (
          <circle
            cx={model.partialMarker.x}
            cy={model.partialMarker.yValue}
            r={3.4}
            fill="none"
            style={{ stroke: 'var(--accent)' }}
            strokeWidth={1.5}
          >
            <title>до момента (текущ период)</title>
          </circle>
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
            {hoverData.forecast && <span className="trend-tip-badge">ПРОГНОЗА</span>}
          </div>
          <div className="trend-tip-row is-first">
            <span className="trend-tip-sw-line" />
            <span className="trend-tip-label">{hoverData.forecast ? 'прогноза' : 'разходи'}</span>
            <span className="trend-tip-val">{money(hoverData.valueEur)}</span>
          </div>
          {partial && hover === model.firstForecastIndex && (
            <div className="trend-tip-row">
              <span className="trend-tip-sw-hollow" />
              <span className="trend-tip-label">до момента</span>
              <span className="trend-tip-val">{money(partial.valueEur)}</span>
            </div>
          )}
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

// The € value at the peak marker — the highest complete (non-forecast) display point.
function peakValueLabel(points: DisplayPoint[], firstForecastIndex: number): string {
  const lim = firstForecastIndex || points.length;
  let peak: DisplayPoint | null = null;
  for (let i = 0; i < lim; i += 1) {
    const p = points[i]!;
    if (!p.partial && (peak === null || p.valueEur > peak.valueEur)) peak = p;
  }
  return peak ? money(peak.valueEur) : '';
}
