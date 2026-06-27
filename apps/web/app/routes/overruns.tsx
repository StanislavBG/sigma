import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { count, money, moneyBare, pct, signedPct } from '@sigma/shared';
import {
  getOverrunsAnalytics,
  type OverrunAuthorityRow,
  type OverrunRow,
  type OverrunSectorRow,
  type OverrunYearRow,
} from '@sigma/db';
import type { Route } from './+types/overruns';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import {
  formatGrowthFactor,
  overrunBarGeometry,
  scatterGeometry,
  type ScatterDatum,
} from '../lib/overruns-chart';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/overruns',
    title: 'Раздуване — СИГМА',
    description:
      'Кои договори се раздуха най-много след подписването чрез анекси. Класация по абсолютно и процентно нарастване, по институции, по сектори и по години — всеки лев проследим до конкретния договор.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const by = new URL(request.url).searchParams.get('by') === 'percent' ? 'percent' : 'absolute';
  const { env } = context.cloudflare;
  return withDbRetry(async () => {
    const data = await getOverrunsAnalytics(env.DB, { by });
    return { data, by };
  });
}

// ── design tokens (mock hexes → app CSS variables) ───────────────────────────────────
const INK = 'var(--ink)';
const INK_MID = 'var(--ink-mid)';
const INK_SOFT = 'var(--ink-soft)';
const ACCENT = 'var(--accent)';
const RULE = 'var(--rule)';
const RULE_SOFT = 'var(--rule-soft)';
const PAPER = 'var(--paper)';
const PAPER_WARM = 'var(--paper-warm)';
const MONO = 'var(--font-mono)';
const SERIF = 'var(--font-serif)';

const monoLabel: React.CSSProperties = {
  font: `500 9px/1 ${MONO}`,
  letterSpacing: '.12em',
  color: INK_SOFT,
  textTransform: 'uppercase',
};

const panel: React.CSSProperties = {
  background: PAPER_WARM,
  border: `1px solid ${RULE}`,
  borderRadius: 4,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

// ── leaderboard table (the accessible figures, every row linked) ──────────────────────
const contractColumns: Column<OverrunRow>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  {
    key: 'subject',
    header: 'Договор',
    isTitle: true,
    cell: (r) => <Link to={`/contracts/${r.contractSlug}`}>{r.subject}</Link>,
  },
  {
    key: 'parties',
    header: 'Възложител · Изпълнител',
    secondary: true,
    cell: (r) => (
      <>
        <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>
        {' → '}
        <Link to={`/companies/${r.bidderSlug}`}>{r.bidderName}</Link>
      </>
    ),
  },
  { key: 'signing', header: 'При сключване', align: 'money', cell: (r) => money(r.signingEur) },
  { key: 'current', header: 'Сега', align: 'money', cell: (r) => money(r.currentEur) },
  {
    key: 'delta',
    header: 'Нарастване',
    align: 'money',
    cell: (r) => (
      <>
        +{money(r.deltaEur)} <span className="muted">({signedPct(r.pct)})</span>
      </>
    ),
  },
  {
    key: 'annex',
    header: 'Анекси',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.annexCount),
  },
];

const authorityColumns: Column<OverrunAuthorityRow>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  {
    key: 'authority',
    header: 'Възложител',
    isTitle: true,
    cell: (r) => <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>,
  },
  {
    key: 'total',
    header: 'Общо раздуване (€)',
    align: 'money',
    cell: (r) => moneyBare(r.totalOverrunEur),
  },
  { key: 'avg', header: 'Средно раздуване', align: 'num', cell: (r) => signedPct(r.avgPct) },
  { key: 'count', header: 'Договори', align: 'num', secondary: true, cell: (r) => count(r.count) },
];

const sectorColumns: Column<OverrunSectorRow>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  { key: 'sector', header: 'Сектор (CPV)', isTitle: true, cell: (r) => r.label },
  {
    key: 'total',
    header: 'Общо раздуване (€)',
    align: 'money',
    cell: (r) => moneyBare(r.totalOverrunEur),
  },
  { key: 'avg', header: 'Средно раздуване', align: 'num', cell: (r) => signedPct(r.avgPct) },
  { key: 'count', header: 'Договори', align: 'num', secondary: true, cell: (r) => count(r.count) },
];

const yearColumns: Column<OverrunYearRow>[] = [
  { key: 'year', header: 'Година на сключване', isTitle: true, cell: (r) => r.year },
  {
    key: 'total',
    header: 'Общо раздуване (€)',
    align: 'money',
    cell: (r) => moneyBare(r.totalOverrunEur),
  },
  { key: 'count', header: 'Договори', align: 'num', cell: (r) => count(r.count) },
];

// ── KPI band (the mock's 3 headline figures + the two context KPIs, mono numerics) ────
function KpiBand({ cells }: { cells: { num: string; label: string; accent?: boolean }[] }) {
  return (
    <dl
      aria-label="Обобщение на раздуването"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 0,
        margin: 'var(--s-4) 0',
        padding: '14px 0',
        borderTop: `1px solid ${INK}`,
        borderBottom: `1px solid ${RULE}`,
      }}
    >
      {cells.map((c, i) => (
        <div
          key={c.label}
          style={{
            padding: i === 0 ? '0 22px 0 0' : '0 22px',
            borderLeft: i === 0 ? undefined : `1px solid ${RULE}`,
          }}
        >
          <dd
            style={{
              margin: 0,
              font: `600 24px/1 ${MONO}`,
              fontVariantNumeric: 'tabular-nums',
              color: c.accent ? ACCENT : INK,
            }}
          >
            {c.num}
          </dd>
          <dt style={{ ...monoLabel, marginTop: 6, letterSpacing: '.14em' }}>{c.label}</dt>
        </div>
      ))}
    </dl>
  );
}

// ── before→now stacked bar (decorative; the figures sit beside it as text) ────────────
function OverrunBar({
  signingEur,
  currentEur,
  scaleMaxEur,
}: {
  signingEur: number;
  currentEur: number;
  scaleMaxEur: number;
}) {
  const g = overrunBarGeometry(signingEur, currentEur, scaleMaxEur);
  return (
    <div style={{ position: 'relative', height: 13, marginTop: 5 }} aria-hidden="true">
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 2,
          background: `repeating-linear-gradient(90deg, transparent, transparent 48px, ${RULE_SOFT} 48px, ${RULE_SOFT} 49px)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          display: 'flex',
          height: 13,
          width: `${Math.max(g.nowScalePct, 0.8)}%`,
          minWidth: 3,
          borderRadius: '0 2px 2px 0',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: '100%', background: INK, width: `${g.signPct}%` }} />
        <div style={{ height: '100%', background: ACCENT, width: `${g.incPct}%` }} />
      </div>
    </div>
  );
}

// ── the „Облак на раздуването" scatter (visual summary; role=img + the list carries the data) ──
function OverrunScatter({ rows, selected }: { rows: OverrunRow[]; selected: number }) {
  const data: ScatterDatum[] = rows.map((r, i) => ({
    id: r.contractId,
    pct: r.pct,
    deltaEur: r.deltaEur,
    annexCount: r.annexCount,
    rank: i + 1,
  }));
  const geo = scatterGeometry(data);
  const { axis } = geo;
  const selectedId = rows[selected]?.contractId;
  const xtickLabel = (pctPercent: number) =>
    pctPercent >= 1000 ? `+${pctPercent / 1000}к%` : `+${pctPercent}%`;

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${geo.width} ${geo.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Облак на раздуването: всеки договор по процентно нарастване (хоризонтално, логаритмично) спрямо абсолютно раздуване в евро (вертикално); размерът на кръга расте с броя анекси. Конкретните стойности са в класацията вляво."
      style={{ display: 'block', overflow: 'visible' }}
    >
      <line
        x1={axis.left}
        y1={axis.top}
        x2={axis.left}
        y2={axis.bottom}
        stroke={RULE}
        strokeWidth={1}
      />
      <line
        x1={axis.left}
        y1={axis.bottom}
        x2={axis.right}
        y2={axis.bottom}
        stroke={RULE}
        strokeWidth={1}
      />
      {geo.grid.map((g) => (
        <g key={`g${g.y}`}>
          <line
            x1={axis.left}
            y1={g.y}
            x2={axis.right}
            y2={g.y}
            stroke={RULE_SOFT}
            strokeWidth={1}
          />
          <text
            x={axis.left - 5}
            y={g.y + 3}
            textAnchor="end"
            fontFamily="var(--font-mono)"
            fontSize={8.5}
            fill={INK_SOFT}
          >
            {moneyBare(g.value)}
          </text>
        </g>
      ))}
      {geo.xticks.map((t) => (
        <text
          key={`x${t.pctPercent}`}
          x={t.x}
          y={geo.height - 24}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={8.5}
          fill={INK_SOFT}
        >
          {xtickLabel(t.pctPercent)}
        </text>
      ))}
      <text x={6} y={14} fontFamily="var(--font-mono)" fontSize={8.5} fill={INK_SOFT}>
        € раздуване
      </text>
      <text
        x={axis.right}
        y={geo.height - 2}
        textAnchor="end"
        fontFamily="var(--font-mono)"
        fontSize={8.5}
        fill={INK_SOFT}
      >
        % нарастване (лог) →
      </text>
      {geo.points.map((p) => {
        const isSel = p.id === selectedId;
        return (
          <g key={p.id}>
            {isSel && (
              <circle cx={p.x} cy={p.y} r={p.r + 4} fill="none" stroke={ACCENT} strokeWidth={1.5} />
            )}
            <circle
              cx={p.x}
              cy={p.y}
              r={isSel ? p.r * 1.18 : p.r}
              fill={isSel || p.big ? ACCENT : INK}
              fillOpacity={isSel ? 1 : p.big ? 0.78 : 0.5}
              stroke={PAPER}
              strokeWidth={1}
            />
            {(p.big || isSel) && (
              <text
                x={p.x + p.r + 3}
                y={p.y + 3}
                fontFamily="var(--font-mono)"
                fontSize={8.5}
                fontWeight={600}
                fill={isSel ? ACCENT : INK}
              >
                #{p.rank}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── the interactive dashboard: leaderboard selector ↔ scatter ↔ inspector ─────────────
function OverrunsDashboard({ rows }: { rows: OverrunRow[] }) {
  const [selected, setSelected] = useState(0);
  const scaleMax = Math.max(1, ...rows.map((r) => r.currentEur));
  const sel = rows[selected] ?? rows[0]!;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.5fr) minmax(320px, 1fr)',
        gap: 14,
        alignItems: 'stretch',
      }}
      className="overruns-grid"
    >
      <style>
        {'@media (max-width: 860px){.overruns-grid{grid-template-columns:1fr !important}}'}
      </style>
      {/* LEFT — leaderboard bars (buttons select the inspector; figures are text) */}
      <div style={{ ...panel }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            padding: '13px 16px 8px',
          }}
        >
          <div style={{ font: `600 16px/1.2 ${SERIF}`, color: INK }}>
            Най-голямо <em style={{ color: ACCENT }}>раздуване</em>
          </div>
          <div style={{ font: `400 10px/1 ${MONO}`, color: INK_SOFT }}>
            скала 0 — {moneyBare(scaleMax)}
          </div>
        </div>
        <ol
          className="scrolly"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: '0 8px 8px',
            overflow: 'auto',
            maxHeight: 520,
          }}
        >
          {rows.map((r, i) => {
            const active = i === selected;
            return (
              <li key={r.contractId}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-pressed={active}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '22px 1fr',
                    gap: 11,
                    alignItems: 'center',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 8px',
                    border: 'none',
                    borderBottom: `1px solid ${RULE_SOFT}`,
                    borderLeft: `2px solid ${active ? ACCENT : 'transparent'}`,
                    background: active
                      ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                      : 'transparent',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  <span style={{ font: `600 15px/1 ${SERIF}`, color: ACCENT, textAlign: 'center' }}>
                    {i + 1}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 10,
                      }}
                    >
                      <span
                        className="clamp1"
                        style={{ fontSize: 12, fontWeight: 500, color: INK }}
                      >
                        {r.subject}
                      </span>
                      <span
                        style={{ whiteSpace: 'nowrap', font: `600 10.5px/1 ${MONO}`, color: INK }}
                      >
                        {money(r.currentEur)}{' '}
                        <span style={{ color: ACCENT }}>{signedPct(r.pct)}</span>
                      </span>
                    </span>
                    <OverrunBar
                      signingEur={r.signingEur}
                      currentEur={r.currentEur}
                      scaleMaxEur={scaleMax}
                    />
                    <span
                      className="clamp1"
                      style={{
                        display: 'block',
                        marginTop: 4,
                        font: `400 9px/1.2 ${MONO}`,
                        color: INK_SOFT,
                      }}
                    >
                      {r.authorityName} <span style={{ color: ACCENT }}>→</span> {r.bidderName} · от{' '}
                      {money(r.signingEur)} · {count(r.annexCount)} анекса
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* RIGHT — scatter cloud + inspector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
        <div style={{ ...panel, padding: '13px 16px 8px', minHeight: 230 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ font: `600 16px/1.2 ${SERIF}`, color: INK }}>Облак на раздуването</div>
            <div style={{ font: `400 9.5px/1 ${MONO}`, color: INK_SOFT }}>размер = брой анекси</div>
          </div>
          <div style={{ flex: 1, minHeight: 200, marginTop: 6 }}>
            <OverrunScatter rows={rows} selected={selected} />
          </div>
        </div>

        {/* inspector */}
        <div style={{ ...panel }}>
          <div style={{ padding: '13px 16px 12px', borderBottom: `1px solid ${RULE}` }}>
            <div style={{ ...monoLabel, color: ACCENT }}>Избран договор · #{selected + 1}</div>
            <div
              style={{
                marginTop: 8,
                fontSize: 12.5,
                fontWeight: 600,
                lineHeight: 1.32,
                color: INK,
              }}
            >
              <Link to={`/contracts/${sel.contractSlug}`}>{sel.subject}</Link>
            </div>
            <div style={{ marginTop: 6, font: `400 9.5px/1.3 ${MONO}`, color: INK_SOFT }}>
              <Link to={`/authorities/${sel.authoritySlug}`}>{sel.authorityName}</Link>{' '}
              <span style={{ color: ACCENT }}>→</span>{' '}
              <Link to={`/companies/${sel.bidderSlug}`}>{sel.bidderName}</Link>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 16,
                marginTop: 12,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div
                  style={{ ...monoLabel, fontWeight: 400, letterSpacing: '.1em', fontSize: 8.5 }}
                >
                  При сключване
                </div>
                <div style={{ marginTop: 3, font: `400 15px/1 ${MONO}`, color: INK_MID }}>
                  {money(sel.signingEur)}
                </div>
              </div>
              <div style={{ color: ACCENT, fontSize: 14, paddingBottom: 1 }}>→</div>
              <div>
                <div
                  style={{ ...monoLabel, fontWeight: 400, letterSpacing: '.1em', fontSize: 8.5 }}
                >
                  Сега
                </div>
                <div style={{ marginTop: 3, font: `600 15px/1 ${MONO}`, color: INK }}>
                  {money(sel.currentEur)}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ font: `600 16px/1 ${MONO}`, color: ACCENT }}>
                  +{money(sel.deltaEur)}
                </div>
                <div style={{ font: `400 9px/1 ${MONO}`, color: INK_SOFT, marginTop: 2 }}>
                  {signedPct(sel.pct)} · {count(sel.annexCount)} анекса
                </div>
              </div>
            </div>
          </div>
          <div style={{ padding: '12px 16px 14px' }}>
            <div style={{ ...monoLabel, marginBottom: 6 }}>Детайли по договора</div>
            <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: INK_MID }}>
              Стойността при сключване{' '}
              <strong style={{ color: INK }}>{money(sel.signingEur)}</strong> е нараснала до{' '}
              <strong style={{ color: INK }}>{money(sel.currentEur)}</strong> чрез{' '}
              {count(sel.annexCount)} анекса —{' '}
              <span style={{ color: ACCENT }}>+{money(sel.deltaEur)}</span> ({signedPct(sel.pct)}).
            </p>
            <p style={{ marginTop: 12, font: `400 9.5px/1.5 ${MONO}`, color: INK_SOFT }}>
              Историята на анексите и пълните детайли (процедура, CPV, срокове, ЕИК) са в{' '}
              <Link to={`/contracts/${sel.contractSlug}`}>страницата на договора →</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Overruns({ loaderData }: Route.ComponentProps) {
  const { data, by } = loaderData;
  const { corpus, rows, byAuthority, bySector, byYear } = data;
  const [sp] = useSearchParams();

  const kpis = [
    { num: money(corpus.totalOverrunEur), label: 'Общо раздуване' },
    { num: count(corpus.count), label: 'Договора' },
    {
      num: corpus.count ? formatGrowthFactor(corpus.medianPct) : '—',
      label: 'Медиана растеж',
      accent: true,
    },
    { num: corpus.count ? signedPct(corpus.avgPct) : '—', label: 'Средно раздуване' },
    {
      num: corpus.corpusSigningEur > 0 ? pct(corpus.shareOfSigning) : '—',
      label: 'Дял от стойността при сключване',
    },
  ];

  const sortHref = (next: 'absolute' | 'percent') => {
    const params = new URLSearchParams(sp);
    if (next === 'absolute') params.delete('by');
    else params.set('by', 'percent');
    const qs = params.toString();
    return qs ? `/overruns?${qs}` : '/overruns';
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Раздуване' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ · Раздуване"
          title={
            <>
              Раздуване на <em>договорите</em>
            </>
          }
          lede="Договори по обществени поръчки, чиято стойност след анекси надхвърля стойността при сключване. Сравняваме стойността при сключване със сегашната и подреждаме по най-голямото нарастване — по договори, по институции, по сектори и по години. Това е описателен показател, не присъда: зад всеки лев стои конкретният договор."
        />

        <KpiBand cells={kpis} />

        <Section
          id="leaderboard"
          title={
            <>
              Най-голямо <em>раздуване</em> на стойността
            </>
          }
          hint="Дължината на лентата е сегашната стойност; тъмното е платеното при сключване, оранжевото — раздуването. Избери договор, за да го разгледаш в инспектора и в облака вдясно."
        >
          <div className="flow-controls" role="group" aria-label="Подреждане">
            <span className="muted">Подреди по:</span>{' '}
            <Link
              to={sortHref('absolute')}
              aria-current={by === 'absolute' ? 'true' : undefined}
              rel="nofollow"
            >
              абсолютно (€)
            </Link>{' '}
            ·{' '}
            <Link
              to={sortHref('percent')}
              aria-current={by === 'percent' ? 'true' : undefined}
              rel="nofollow"
            >
              процентно (%)
            </Link>
            <span
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                gap: 16,
                font: `400 10px/1 ${MONO}`,
                color: INK_MID,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 10, height: 10, background: INK, borderRadius: 1 }}
                />
                при сключване
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 10, height: 10, background: ACCENT, borderRadius: 1 }}
                />
                раздуване
              </span>
            </span>
          </div>

          {rows.length ? (
            <>
              <OverrunsDashboard key={by} rows={rows} />
              <details style={{ marginTop: 'var(--s-4)' }}>
                <summary
                  style={{ cursor: 'pointer', font: `500 12px/1.4 ${MONO}`, color: INK_MID }}
                >
                  Виж класацията като таблица ({count(rows.length)} договора)
                </summary>
                <div style={{ marginTop: 'var(--s-3)' }}>
                  <DataTable
                    columns={contractColumns}
                    rows={rows}
                    getKey={(r) => r.contractId}
                    caption="Договори, подредени по нарастване на стойността след подписване"
                  />
                </div>
              </details>
            </>
          ) : (
            <Callout title="Няма раздути договори">
              <p className="m-0">
                В обхванатите данни няма договори с потвърдено нарастване на стойността след
                подписване. Щом анекс увеличи стойност, договорът ще се появи тук.
              </p>
            </Callout>
          )}
        </Section>

        <Section
          id="by-authority"
          title={
            <>
              Кои <em>институции</em> раздуват най-много
            </>
          }
          hint="Възложители, подредени по общата сума на раздуването. Високо общо при ниско средно говори за обем; високо средно — за систематично подписване ниско и последващо нарастване."
        >
          {byAuthority.length ? (
            <DataTable
              columns={authorityColumns}
              rows={byAuthority}
              getKey={(r) => r.authoritySlug}
              caption="Институции, подредени по обща сума на раздуването"
            />
          ) : (
            <Callout title="Няма данни по институции">
              <p className="m-0">Все още няма институции с раздути договори в обхванатите данни.</p>
            </Callout>
          )}
        </Section>

        <Section
          id="by-sector"
          title={
            <>
              Кои <em>сектори</em> се раздуват най-много
            </>
          }
          hint="Раздуване по CPV-раздел (първите две цифри на кода). Показва къде нарастването след подписване е концентрирано."
        >
          {bySector.length ? (
            <DataTable
              columns={sectorColumns}
              rows={bySector}
              getKey={(r) => r.division || r.label}
              caption="Сектори (CPV-раздели), подредени по обща сума на раздуването"
            />
          ) : (
            <Callout title="Няма данни по сектори">
              <p className="m-0">Все още няма сектори с раздути договори в обхванатите данни.</p>
            </Callout>
          )}
        </Section>

        <Section
          id="by-year"
          title={
            <>
              Раздуване <em>във времето</em>
            </>
          }
          hint="Обща сума на раздуването по година на сключване на договора. Договори без разпозната дата на сключване попадат в „Неизвестна“."
        >
          {byYear.length ? (
            <DataTable
              columns={yearColumns}
              rows={byYear}
              getKey={(r) => r.year}
              caption="Раздуване по година на сключване на договора"
            />
          ) : (
            <Callout title="Няма данни по години">
              <p className="m-0">Все още няма раздути договори с разпозната година в данните.</p>
            </Callout>
          )}
        </Section>

        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          Раздуването е разликата между сегашната стойност и стойността при сключване, само за
          договори с поне един анекс и потвърдени стойности. Виж{' '}
          <Link to="/methodology#glossary">методологията</Link> за дефинициите.
        </p>
      </main>
    </>
  );
}
