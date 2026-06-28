import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { count, date, money, moneyBare, pct, signedPct } from '@sigma/shared';
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
import { FullscreenButton, useFullscreen } from '../components/FullscreenButton';
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
// Static layout/typography styles live in app.css (block „overruns-dashboard"). These constants are
// kept ONLY for the SVG scatter's presentation attributes (fill/stroke) and the JS-computed bar
// geometry — the few places where a value is data-driven and cannot be a static class.
const INK = 'var(--ink)';
const INK_SOFT = 'var(--ink-soft)';
const ACCENT = 'var(--accent)';
const RULE = 'var(--rule)';
const RULE_SOFT = 'var(--rule-soft)';
const PAPER = 'var(--paper)';

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

// ── inspector field helpers (REAL contract metadata, mock-faithful formatting) ────────
// „Финансиране": EU-funded → „Европейско [· programme]", national → „Национално", unknown → „—".
function financingText(row: OverrunRow): string {
  if (row.euFunded == null) return '—';
  if (!row.euFunded) return 'Национално';
  return row.euProgramme ? `Европейско · ${row.euProgramme}` : 'Европейско';
}

// „CPV код": „45233110 — Строеж на магистрали" when both present; code alone, or „—" when absent.
function cpvText(row: OverrunRow): string {
  if (!row.cpvCode) return '—';
  return row.cpvDescription ? `${row.cpvCode} — ${row.cpvDescription}` : row.cpvCode;
}

// The structured „ДЕТАЙЛИ ПО ДОГОВОРА" grid — every value is a real contracts/tenders column.
function inspectorFields(row: OverrunRow): { k: string; v: string }[] {
  return [
    { k: 'Сектор', v: row.sectorLabel },
    { k: 'Процедура', v: row.procedureType ?? '—' },
    { k: 'CPV код', v: cpvText(row) },
    { k: 'Финансиране', v: financingText(row) },
    { k: 'Сключен', v: date(row.signedAt) },
    { k: 'Възложител · ЕИК', v: `${row.authorityName} · ${row.authorityEik || '—'}` },
    { k: 'Изпълнител · ЕИК', v: `${row.bidderName} · ${row.bidderEik ?? 'непотвърден'}` },
  ];
}

// ── KPI band (the mock's 3 headline figures + the two context KPIs, mono numerics) ────
function KpiBand({ cells }: { cells: { num: string; label: string; accent?: boolean }[] }) {
  return (
    <dl aria-label="Обобщение на раздуването" className="ov-kpi">
      {cells.map((c) => (
        <div key={c.label} className="ov-kpi-cell">
          <dd className={c.accent ? 'ov-kpi-num accent' : 'ov-kpi-num'}>{c.num}</dd>
          <dt className="ov-kpi-label">{c.label}</dt>
        </div>
      ))}
    </dl>
  );
}

// ── before→now stacked bar (decorative; the figures sit beside it as text) ────────────
// Only the geometry (segment widths, overall length) is inline — it is data-driven. Colours and the
// dashed track live in app.css.
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
    <div className="ov-bar" aria-hidden="true">
      <div className="ov-bar-track" />
      <div className="ov-bar-fill" style={{ width: `${Math.max(g.nowScalePct, 0.8)}%` }}>
        <div className="ov-bar-sign" style={{ width: `${g.signPct}%` }} />
        <div className="ov-bar-inc" style={{ width: `${g.incPct}%` }} />
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
  // Bulgarian decimal comma for the „к%" (thousands) tick labels — e.g. +2,5к%, +10к%.
  const xtickLabel = (pctPercent: number) =>
    pctPercent >= 1000
      ? `+${(Math.round(pctPercent / 100) / 10).toString().replace('.', ',')}к%`
      : `+${pctPercent}%`;

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${geo.width} ${geo.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Облак на раздуването: всеки договор по процентно нарастване (хоризонтално, логаритмично) спрямо абсолютно раздуване в евро (вертикално); размерът на кръга расте с броя анекси. Конкретните стойности са в класацията вляво."
      className="ov-scatter-svg"
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
  const boardFs = useFullscreen<HTMLDivElement>();
  const scatterFs = useFullscreen<HTMLDivElement>();

  return (
    <div className="overruns-grid">
      {/* LEFT — leaderboard bars (buttons select the inspector; figures are text) */}
      <div className="ov-panel ov-board" ref={boardFs.ref}>
        <div className="ov-board-head">
          <div className="ov-board-title">
            Най-голямо <em>раздуване</em>
          </div>
          <div className="ov-board-scale">
            <span>скала 0 — {moneyBare(scaleMax)}</span>
            <FullscreenButton active={boardFs.isFullscreen} onToggle={boardFs.toggle} />
          </div>
        </div>
        <ol className="scrolly ov-board-list">
          {rows.map((r, i) => {
            const active = i === selected;
            return (
              <li key={r.contractId}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-pressed={active}
                  className="ov-row"
                >
                  <span className="ov-row-rank">{i + 1}</span>
                  <span className="ov-row-body">
                    <span className="ov-row-head">
                      <span className="clamp1 ov-row-subject">{r.subject}</span>
                      <span className="ov-row-value">
                        {money(r.currentEur)} <span className="ov-accent">{signedPct(r.pct)}</span>
                      </span>
                    </span>
                    <OverrunBar
                      signingEur={r.signingEur}
                      currentEur={r.currentEur}
                      scaleMaxEur={scaleMax}
                    />
                    <span className="clamp1 ov-row-meta">
                      {r.authorityName} <span className="ov-accent">→</span> {r.bidderName} · от{' '}
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
      <div className="ov-right">
        <div className="ov-panel ov-scatter-panel" ref={scatterFs.ref}>
          <div className="ov-scatter-head">
            <div className="ov-panel-title">Облак на раздуването</div>
            <div className="ov-panel-note">
              <span>размер = брой анекси</span>
              <FullscreenButton active={scatterFs.isFullscreen} onToggle={scatterFs.toggle} />
            </div>
          </div>
          <div className="ov-scatter-body">
            <OverrunScatter rows={rows} selected={selected} />
          </div>
        </div>

        {/* inspector */}
        <div className="ov-panel ov-inspector">
          <div className="ov-insp-head">
            <div className="ov-mono-label ov-accent">Избран договор · #{selected + 1}</div>
            <div className="ov-insp-title">
              <Link to={`/contracts/${sel.contractSlug}`}>{sel.subject}</Link>
            </div>
            <div className="ov-insp-parties">
              <Link to={`/authorities/${sel.authoritySlug}`}>{sel.authorityName}</Link>{' '}
              <span className="ov-accent">→</span>{' '}
              <Link to={`/companies/${sel.bidderSlug}`}>{sel.bidderName}</Link>
            </div>
            <div className="ov-insp-figures">
              <div>
                <div className="ov-insp-fig-label">При сключване</div>
                <div className="ov-insp-fig-val">{money(sel.signingEur)}</div>
              </div>
              <div className="ov-insp-arrow">→</div>
              <div>
                <div className="ov-insp-fig-label">Сега</div>
                <div className="ov-insp-fig-val now">{money(sel.currentEur)}</div>
              </div>
              <div className="ov-insp-delta-wrap">
                <div className="ov-insp-delta">+{money(sel.deltaEur)}</div>
                <div className="ov-insp-delta-meta">
                  {signedPct(sel.pct)} · {count(sel.annexCount)} анекса
                </div>
              </div>
            </div>
          </div>
          <div className="ov-insp-grid-wrap">
            <div className="ov-mono-label ov-insp-grid-heading">Детайли по договора</div>
            <dl className="ov-insp-grid">
              {inspectorFields(sel).map((f) => (
                <div className="ov-insp-grid-row" key={f.k}>
                  <dt className="ov-insp-grid-key">{f.k}</dt>
                  <dd className="ov-insp-grid-val">{f.v}</dd>
                </div>
              ))}
            </dl>
            <p className="ov-insp-foot">
              Пълната история на анексите и документите по договора са в{' '}
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
          <div className="ov-sortbar" role="group" aria-label="Подреждане">
            <span className="ov-sortbar-label">Подреди по</span>
            <div className="ov-seg">
              <Link
                to={sortHref('absolute')}
                aria-current={by === 'absolute' ? 'true' : undefined}
                rel="nofollow"
              >
                абсолютно (€)
              </Link>
              <Link
                to={sortHref('percent')}
                aria-current={by === 'percent' ? 'true' : undefined}
                rel="nofollow"
              >
                процентно (%)
              </Link>
            </div>
            <span className="ov-legend">
              <span className="ov-legend-item">
                <span aria-hidden="true" className="ov-swatch ink" />
                при сключване
              </span>
              <span className="ov-legend-item">
                <span aria-hidden="true" className="ov-swatch accent" />
                раздуване
              </span>
            </span>
          </div>

          {rows.length ? (
            <>
              <OverrunsDashboard key={by} rows={rows} />
              <details className="ov-table-details">
                <summary className="ov-table-summary">
                  Виж класацията като таблица ({count(rows.length)} договора)
                </summary>
                <div className="ov-table-body">
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

        <p className="small muted ov-methodology">
          Раздуването е разликата между сегашната стойност и стойността при сключване, само за
          договори с поне един анекс и потвърдени стойности. Виж{' '}
          <Link to="/methodology#glossary">методологията</Link> за дефинициите.
        </p>
      </main>
    </>
  );
}
