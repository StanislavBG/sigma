import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { count, date, money, pct, plural, signedPct } from '@sigma/shared';
import { CPV_SECTORS } from '@sigma/config';
import {
  getCohortMedians,
  getCohortStats,
  getPriceAnomalyKpis,
  getSpendingTrend,
  listContracts,
  listOverviewContracts,
} from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { ComboTrendChart } from '../components/ComboTrendChart';
import { TrendComboChart } from '../components/TrendComboChart';
import { MetricInfo } from '../components/MetricInfo';
import { Callout } from '../components/ui';
import { publicCache } from '../lib/cache';
import { cpvGroupSelection } from '../lib/filters';
import { estimateYoyGrowth } from '../lib/analytics-stats';
import {
  aggregate,
  combineSeries,
  computeKpis,
  shortMonthLabel,
  type Step,
} from '../lib/trends-series';
import {
  axisLabel,
  type CpvLensGroup,
  jitter,
  LOG_MIN,
  logMax,
  makeLx,
  relLabel,
  toLensGroup,
} from '../lib/obzor-cpv';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Тренд във времето — СИГМА' },
    {
      name: 'description',
      content:
        'Как се движат разходите за обществени поръчки във времето — месечен обем, брой договори, сезонните пикове в края на годината — само по реални данни.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

// ?angle= switches the page between the trend dashboard (time, default) and the „обзор" lenses:
// per-CPV-group price distributions (cpv) or the year × CPV cross cut (cross). The lenses re-apply
// the sigma-plus „Договори — обзор" feature on top of the reviewed trend dashboard (#170).
type Angle = 'time' | 'cpv' | 'cross';

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const db = context.cloudflare.env.DB;

  const angle = pick<Angle>(sp.get('angle'), ['time', 'cpv', 'cross'], 'time');
  if (angle !== 'time') {
    const sort = pick(sp.get('sort'), ['date', 'value'] as const, 'date');
    const cpvSort = pick(sp.get('cpvSort'), ['n', 'med', 'code'] as const, 'n');
    const yearRaw = sp.get('year');
    const year = yearRaw && /^20\d\d$/.test(yearRaw) ? yearRaw : null;
    // Repeatable ?cpv — the multi-select CPV facet. Validated + bounded by cpvGroupSelection so
    // hostile input can neither poison the SQL scope nor mint unbounded cache-key variants (CWE-349).
    const cpvSel = cpvGroupSelection(sp);

    const [trend, cohorts, contracts, kpis] = await Promise.all([
      // Compact quarterly picker for the cross lens / year cards; the lenses render no dashboard, so
      // sectors and the seasonality/movers insights are skipped.
      // Faceted by the selected CPV groups (one aggregate scan; all groups when nothing is
      // selected), so the year chart, year cards and totals all re-run server-side on real data.
      getSpendingTrend(
        db,
        { granularity: 'quarter', cpvGroups: cpvSel },
        { includeSectors: false, includeInsights: false },
      ),
      // The lens table is the merged home of /price-anomaly: rows come from the SAME precomputed
      // CPV-cohort rollups (cpv_cohort_stats + cpv_cohort_sample) — median, sample points and outlier
      // counts are read, never recomputed live (D1-cheap; 2 bounded statements).
      getCohortStats(db, { sort: 'n', limit: 10 }),
      listOverviewContracts(db, { year, cpvGroups: cpvSel, sort, limit: 24 }),
      // Corpus totals + methodology thresholds (log-MAD z ≥ 3, min cohort 30) for the header ⓘ.
      getPriceAnomalyKpis(db),
    ]);
    const groups = cohorts.map(toLensGroup);

    // „Спрямо типичното" baselines for card groups outside the top-N rows (bounded IN-list over the
    // rollup: distinct groups on one card page, plus the selected groups so their filter chips can
    // carry a name). Groups without a stored cohort (< 30 priced peers) get no badge — honest absence.
    const known = new Set(groups.map((g) => g.group));
    const missing = contracts
      .map((c) => c.cpvGroup)
      .filter((g): g is string => g != null && !known.has(g));
    for (const g of cpvSel) if (!known.has(g)) missing.push(g);
    const medians = await getCohortMedians(db, missing);

    return {
      angle: angle as 'cpv' | 'cross',
      sort,
      cpvSort,
      year,
      cpvSel,
      trend,
      stats: { groups, totalGroups: kpis.cohortCount },
      method: {
        flaggedCount: kpis.flaggedCount,
        minCohortSize: kpis.minCohortSize,
        zThreshold: kpis.zThreshold,
      },
      contracts,
      medians,
    };
  }

  const sector = sp.get('sector');
  // A bogus ?sector would silently empty the chart; flag it and ignore it instead.
  const unknownSector = Boolean(sector) && !CPV_SECTORS.some((s) => s.code === sector);
  const validSector = unknownSector ? null : sector;
  const funding = (sp.get('funding') as 'eu' | 'national' | null) || 'all';

  const [data, latest] = await Promise.all([
    // Always monthly: the step toggle (МЕСЕЧНО/ТРИМЕСЕЧНО/ГОДИШНО) and the year drill-down are pure
    // client re-shaping of this one series. includeInsights:false drops the seasonality + movers scans
    // the new dashboard no longer renders.
    getSpendingTrend(
      db,
      { sector: validSector, funding, granularity: 'month' },
      {
        includeInsights: false,
      },
    ),
    // The newest contracts behind the curve — the "what just landed" rail. Respects the page's
    // sector/funding filters so it stays coherent with the chart. The dummy summary override skips
    // listContracts' COUNT/SUM scan: this rail never shows totals.
    listContracts(
      db,
      {
        sort: 'date-desc',
        sectors: validSector ? [validSector] : [],
        eu: funding === 'all' ? null : funding,
        pageSize: 12,
      },
      { total: 0, valueEur: 0, suspect: 0 },
    ),
  ]);

  return { angle: 'time' as const, data, unknownSector, latest: latest.items, funding };
}

type LoaderData = Route.ComponentProps['loaderData'];
type DashboardData = Extract<LoaderData, { angle: 'time' }>;
type OverviewData = Extract<LoaderData, { angle: 'cpv' | 'cross' }>;

// The angle switcher shared by both views. On the dashboard the lens params are absent, so plain
// hrefs suffice; the overview passes hrefs that preserve its own filters.
const ANGLES: { key: Angle; label: string }[] = [
  { key: 'time', label: 'Във времето' },
  { key: 'cpv', label: 'По CPV код' },
  { key: 'cross', label: 'Време × CPV' },
];

function AngleSwitch({ angle, hrefFor }: { angle: Angle; hrefFor: (a: Angle) => string }) {
  return (
    <div className="ov-seg ov-switch" role="group" aria-label="Ъгъл на гледане">
      {ANGLES.map((a) => (
        <Link
          key={a.key}
          to={hrefFor(a.key)}
          preventScrollReset
          aria-current={angle === a.key || undefined}
        >
          {a.label}
        </Link>
      ))}
    </div>
  );
}

// Default chart window: the most recent N years of actuals.
const CHART_TRAILING_YEARS = 5;

const STEP_DEFS: { key: Step; label: string }[] = [
  { key: 'month', label: 'МЕСЕЧНО' },
  { key: 'quarter', label: 'ТРИМЕСЕЧНО' },
  { key: 'year', label: 'ГОДИШНО' },
];

export default function Trends({ loaderData }: Route.ComponentProps) {
  return loaderData.angle === 'time' ? (
    <TrendsDashboard loaderData={loaderData} />
  ) : (
    <TrendsOverview loaderData={loaderData} />
  );
}

function TrendsDashboard({ loaderData }: { loaderData: DashboardData }) {
  const { data, unknownSector, latest } = loaderData;
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  // Step + year drill-down are client state over the one monthly series the loader returned.
  const [step, setStep] = useState<Step>('month');
  const [activeYear, setActiveYear] = useState<number | null>(null);

  // „Вкл. текущия месец": the current in-progress month is EXCLUDED from the chart by default (its
  // half-filled value reads as a false dip); ?cur=1 opts back in. Strictly '1' so the edge-cache key
  // space stays two-valued — the toggle changes the SSR-rendered chart, so `cur` is keyed (CWE-349).
  const cur = sp.get('cur') === '1';
  const curToggleHref = useMemo(() => {
    const next = new URLSearchParams(sp);
    if (cur) next.delete('cur');
    else next.set('cur', '1');
    const qs = next.toString();
    return qs ? `?${qs}` : '/trends';
  }, [sp, cur]);

  // KPIs + coverage use the UNFILTERED actuals; the rendered series applies the partial-month filter.
  const kpis = useMemo(() => computeKpis(data.points), [data.points]);
  const growth = useMemo(() => estimateYoyGrowth(data.points), [data.points]);
  const combined = useMemo(() => combineSeries(data.points, cur), [data.points, cur]);
  const hasPartial = useMemo(() => combined.some((p) => p.partial), [combined]);

  // Default chart view is the last CHART_TRAILING_YEARS of actuals — the early ramp-up years (and any
  // stray junk year) are trimmed so the curve reads cleanly. A year drill-down shows that single year
  // in full.
  const windowed = useMemo(() => {
    if (activeYear) return combined;
    const actualYears = combined.map((p) => Number(p.period.slice(0, 4)));
    if (!actualYears.length) return combined;
    const minYear = Math.max(...actualYears) - (CHART_TRAILING_YEARS - 1);
    return combined.filter((p) => Number(p.period.slice(0, 4)) >= minYear);
  }, [combined, activeYear]);

  const display = useMemo(
    () => aggregate(windowed, step, activeYear),
    [windowed, step, activeYear],
  );

  const hasChart = display.length >= 2;
  const trendWindow = activeYear ? 3 : step === 'month' ? 7 : step === 'quarter' ? 4 : 3;
  const barRatio = step === 'year' ? 0.5 : step === 'quarter' ? 0.6 : 0.62;
  const axisWord =
    activeYear || step === 'month' ? 'месеци' : step === 'quarter' ? 'тримесечия' : 'години';

  const growthTxt = `${growth.value >= 1 ? '+' : ''}${Math.round((growth.value - 1) * 100)}%`;
  const firstYear = windowed.length ? windowed[0]!.period.slice(0, 4) : '';
  const lastYear = windowed.length ? windowed.at(-1)!.period.slice(0, 4) : '';
  const chartMeta = activeYear
    ? String(activeYear)
    : `${firstYear}–${lastYear} · ръст ${growthTxt}/год`;
  const chartTitle = activeYear ? `Разходи по месеци · ${activeYear}` : `Разходи по ${axisWord}`;

  // Chart fullscreen: a modal overlay (per the design), not the native Fullscreen API.
  const [chartFull, setChartFull] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null); // the role="dialog" panel (focus trap scope)
  const closeBtnRef = useRef<HTMLButtonElement>(null); // „✕ ЗАТВОРИ" — receives focus on open
  const fsTriggerRef = useRef<HTMLButtonElement>(null); // „⤢ ЦЯЛ ЕКРАН" — focus returns here on close
  // WCAG 2.4.3 / 2.1.2: move focus into the dialog on open, trap Tab within it while open, and restore
  // focus to the trigger on close — Esc still closes. (The backdrop click also closes; React's effect
  // cleanup runs on the chartFull→false transition and returns focus regardless of how it closed.)
  useEffect(() => {
    if (!chartFull) return;
    // Lock the page behind the modal so wheel/touch scrolling moves the dialog, not the document.
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setChartFull(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevBodyOverflow;
      fsTriggerRef.current?.focus();
    };
  }, [chartFull]);
  const ariaLabel = `Разходи за обществени поръчки и брой договори по ${axisWord}${
    activeYear ? `, ${activeYear} г.` : ''
  }. Колоните са броят договори, плътната линия е трендът на стойността${
    hasPartial ? ', а пунктираната опашка е текущият незавършен период' : ''
  }. Точните стойности са в таблицата „По години" по-долу.`;

  // Sub-meta for the "newest contracts" rail: the active sector scope, or all sectors.
  const sectorMeta = data.scope.sector
    ? (data.sectors.find((s) => s.code === data.scope.sector)?.short ?? data.scope.sector)
    : 'всички сектори';

  // CPV division → short label, for the per-contract sector tag in the rail (compact scorecard).
  const sectorShortByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of CPV_SECTORS) m.set(s.code, s.short ?? s.label);
    for (const s of data.sectors) m.set(s.code, s.short); // prefer the corpus' own short names
    return m;
  }, [data.sectors]);

  // Year table figures (share + average + YoY bar), all derived from the loader's per-year rows.
  const grandTotal = data.years.reduce((a, y) => a + y.valueEur, 0);
  const YOY_BAR_MAX = 2.8; // a +280% YoY fills the bar

  // Analytical readouts for the KPI info popovers (all from the already-loaded figures). The „на
  // година" / „типичен месец" baselines are computed over COMPLETE periods only — the partial current
  // year (and its half-filled months) would otherwise drag the per-year average and the peak ratio
  // down. partial flags come straight from the loader (getSpendingTrend marks the as_of period).
  const completeYears = data.years.filter((y) => !y.partial);
  const completeMonths = data.points.filter((p) => !p.partial);
  const completeYearValue = completeYears.reduce((a, y) => a + y.valueEur, 0);
  const completeYearContracts = completeYears.reduce((a, y) => a + y.contracts, 0);
  const completeMonthValue = completeMonths.reduce((a, p) => a + p.valueEur, 0);
  const perYearValue = completeYearValue / (completeYears.length || 1);
  const perYearContracts = completeYearContracts / (completeYears.length || 1);
  const typicalMonthValue = completeMonthValue / (completeMonths.length || 1);
  const peakRatio =
    kpis.peak && typicalMonthValue > 0 ? kpis.peak.valueEur / typicalMonthValue : null;
  // The peak readout only asserts the year-end seasonality clause when the peak month really is Nov/Dec.
  const peakMonth = kpis.peak ? Number(kpis.peak.period.slice(5, 7)) : null;
  const peakIsYearEnd = peakMonth === 11 || peakMonth === 12;

  // Step toggle (МЕСЕЧНО/ТРИМЕСЕЧНО/ГОДИШНО) — rendered both in the filter bar and the fullscreen header.
  const stepToggle = (
    <div role="group" aria-label="Стъпка на графиката" className="trend-steps">
      {STEP_DEFS.map((s, i) => {
        const on = step === s.key;
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={on}
            onClick={() => {
              setStep(s.key);
              setActiveYear(null);
            }}
            className="trend-step"
            style={{
              border: '1px solid var(--rule)',
              borderLeftWidth: i === 0 ? 1 : 0,
              borderRadius:
                i === 0 ? '3px 0 0 3px' : i === STEP_DEFS.length - 1 ? '0 3px 3px 0' : 0,
              background: on ? 'var(--ink)' : 'var(--paper-raised)',
              color: on ? 'var(--paper)' : 'var(--ink-mid)',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Тренд във времето' }]} />
      <main id="main">
        {/* combined header — title + lede on the left, the four KPIs inline on the right (design) */}
        <header className="trend-header">
          <div className="trend-header-main">
            <p className="trend-header-kicker">Анализ · Тренд във времето</p>
            <h1 className="trend-header-title">
              Тренд във <em>времето</em>
            </h1>
            <p className="trend-header-lede">
              Как се движат разходите за обществени поръчки през годините — месечен обем, брой
              договори и типичните пикове в края на годината. Договорите без валидна дата на
              сключване не влизат в графиката.
            </p>
          </div>
          <div className="trend-header-kpis">
            <div className="trend-hk">
              <div className="trend-hk-v">{money(kpis.totalValueEur)}</div>
              <div className="trend-hk-l">
                ОБЩО ЗА ПЕРИОДА
                <MetricInfo
                  title="Общо за периода"
                  summary="Сумарната стойност на всички договори с потвърдена стойност за обхванатия период."
                  readout={`Средно ≈ ${money(perYearValue)} на година.`}
                />
              </div>
            </div>
            <div className="trend-hk">
              <div className="trend-hk-v">{count(kpis.contracts)}</div>
              <div className="trend-hk-l">
                ДОГОВОРА
                <MetricInfo
                  title="Договора"
                  summary="Броят договори с потвърдена дата на сключване и стойност (без анулираните и без невалидни дати)."
                  readout={`≈ ${count(Math.round(perYearContracts))} на година.`}
                />
              </div>
            </div>
            <div className="trend-hk">
              <div className="trend-hk-v">{kpis.avgEur > 0 ? money(kpis.avgEur) : '—'}</div>
              <div className="trend-hk-l">
                СРЕДЕН ДОГОВОР
                <MetricInfo
                  align="end"
                  title="Среден договор"
                  summary="Общата стойност, разделена на броя договори — средна, не медианна."
                  readout="Малък брой много големи договори изкривяват средното нагоре; типичният договор е доста по-малък."
                />
              </div>
            </div>
            <div className="trend-hk">
              <div className="trend-hk-v trend-hk-v--accent">
                {kpis.peak ? money(kpis.peak.valueEur) : '—'}
              </div>
              <div className="trend-hk-l">
                {kpis.peak ? `ПИК · ${shortMonthLabel(kpis.peak.period)}` : 'ПИК'}
                <MetricInfo
                  align="end"
                  title="Пик"
                  summary="Месецът с най-висока сумарна стойност на сключени договори в периода."
                  readout={
                    peakRatio
                      ? `${peakRatio.toFixed(1).replace('.', ',')}× над типичния месец${peakIsYearEnd ? ' — обикновено края на годината' : ''}.`
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        </header>

        {/* filter bar: angle switcher + step toggle (client) + sector/funding (server) + active-year chip */}
        <div className="trend-filterbar">
          <AngleSwitch
            angle="time"
            hrefFor={(a) => (a === 'time' ? '/trends' : `/trends?angle=${a}`)}
          />
          {stepToggle}
          <Link
            to={curToggleHref}
            preventScrollReset
            className="trend-cur-toggle"
            aria-current={cur || undefined}
          >
            вкл. текущия месец
          </Link>

          <Form
            method="get"
            role="group"
            aria-label="Филтри на тренда"
            onChange={(e) => submit(e.currentTarget)}
            className="trend-filter-form"
          >
            <label className="trend-filter-label">
              <span>Сектор</span>
              <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
                <option value="">Всички сектори</option>
                {data.sectors.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.short}
                  </option>
                ))}
              </select>
            </label>
            <label className="trend-filter-label">
              <span>Финансиране</span>
              <select name="funding" defaultValue={sel('funding')}>
                <option value="">Всякакво</option>
                <option value="eu">Само с финансиране от ЕС</option>
                <option value="national">Само без финансиране от ЕС</option>
              </select>
            </label>
            {cur && <input type="hidden" name="cur" value="1" />}
            <noscript>
              <button type="submit">Покажи</button>
            </noscript>
          </Form>

          {activeYear != null && (
            <button type="button" onClick={() => setActiveYear(null)} className="trend-year-chip">
              {activeYear} ✕
            </button>
          )}

          <div className="trend-total">
            Общо <b>{money(data.totalValueEur)}</b> за периода
          </div>
        </div>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {unknownSector && (
          <Callout variant="warning" title="Непознат филтър">
            <p className="trend-callout-p">
              Избраният сектор не съществува. Показваме всички сектори.
            </p>
          </Callout>
        )}

        {/* main grid */}
        <div className="trend-grid">
          <div className="trend-col">
            {chartFull && (
              <div
                className="trend-fs-backdrop"
                aria-hidden="true"
                onClick={() => setChartFull(false)}
              />
            )}
            {/* chart panel (modal overlay when fullscreen) */}
            <div
              ref={dialogRef}
              className={`trend-panel trend-chart-panel${chartFull ? ' trend-chart-panel--full' : ''}`}
              role={chartFull ? 'dialog' : undefined}
              aria-modal={chartFull || undefined}
              aria-labelledby={chartFull ? 'trend-fs-title' : undefined}
            >
              {chartFull && (
                <div className="trend-fs-head">
                  <div className="trend-fs-head-main">
                    <div className="trend-fs-kicker">— ТРЕНД ВЪВ ВРЕМЕТО · ЦЯЛ ЕКРАН</div>
                    <h2 id="trend-fs-title" className="trend-fs-title">
                      Разходи по <em>{axisWord}</em>
                    </h2>
                    <div className="trend-fs-meta">{chartMeta}</div>
                  </div>
                  <div className="trend-fs-head-aside">
                    <div className="trend-fs-kpi">
                      <div className="trend-fs-kpi-v">{money(kpis.totalValueEur)}</div>
                      <div className="trend-fs-kpi-l">ОБЩО ЗА ПЕРИОДА</div>
                    </div>
                    {kpis.peak && (
                      <div className="trend-fs-kpi">
                        <div className="trend-fs-kpi-v trend-fs-kpi-v--accent">
                          {money(kpis.peak.valueEur)}
                        </div>
                        <div className="trend-fs-kpi-l">
                          ПИК · {shortMonthLabel(kpis.peak.period)}
                        </div>
                      </div>
                    )}
                    {stepToggle}
                    <button
                      ref={closeBtnRef}
                      type="button"
                      className="trend-fs-close"
                      onClick={() => setChartFull(false)}
                    >
                      ✕ ЗАТВОРИ
                    </button>
                  </div>
                </div>
              )}
              <div className="trend-panel-head">
                {!chartFull && <h2 className="trend-panel-title">{chartTitle}</h2>}
                <div className="trend-legend">
                  <LegendItem swatch={<Swatch box />}>договори</LegendItem>
                  <LegendItem swatch={<Swatch line />}>тренд €</LegendItem>
                  {hasPartial && (
                    <LegendItem swatch={<Swatch dashed />}>текущ (частичен)</LegendItem>
                  )}
                  <span className="trend-legend-meta">{chartMeta}</span>
                  {!chartFull && (
                    <button
                      ref={fsTriggerRef}
                      type="button"
                      className="trend-fs-btn"
                      onClick={() => setChartFull(true)}
                      aria-label="Разгледай графиката на цял екран"
                      title="Цял екран"
                    >
                      ⤢ ЦЯЛ ЕКРАН
                    </button>
                  )}
                </div>
              </div>
              <div className="trend-chart-body">
                {hasChart ? (
                  <TrendComboChart
                    points={display}
                    trendWindow={trendWindow}
                    barRatio={barRatio}
                    ariaLabel={ariaLabel}
                  />
                ) : (
                  <p className="muted trend-chart-empty">
                    Няма достатъчно данни за избраните филтри.
                  </p>
                )}
              </div>
            </div>

            {/* year table */}
            <div className="trend-panel trend-years-panel">
              <div className="trend-panel-head">
                <h2 className="trend-panel-title">
                  По <em>години</em>
                </h2>
                <span className="trend-hint">кликни година за филтър ↓</span>
              </div>
              {data.years.length > 0 ? (
                <div className="ov-table-scroll">
                  <table className="trend-years">
                    <caption className="sr-only">
                      Разходи по години: стойност, брой договори, среден договор, дял и промяна
                      спрямо предходната година. Изберете година, за да филтрирате графиката.
                    </caption>
                    <thead>
                      <tr>
                        <th>ГОДИНА</th>
                        <th>СТОЙНОСТ</th>
                        <th>ДОГОВОРИ</th>
                        <th>СРЕДЕН</th>
                        <th>ДЯЛ</th>
                        <th>СПРЯМО ПРЕДХ.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.years.map((y) => {
                        const yr = Number(y.year);
                        const on = activeYear === yr;
                        const share = grandTotal > 0 ? y.valueEur / grandTotal : 0;
                        const avg = y.contracts > 0 ? y.valueEur / y.contracts : 0;
                        const pos = (y.yoyPct ?? 0) >= 0;
                        const barW =
                          y.yoyPct == null
                            ? 0
                            : Math.min(64, (Math.abs(y.yoyPct) / YOY_BAR_MAX) * 64);
                        return (
                          <tr
                            key={y.year}
                            style={{ background: on ? 'var(--accent-bg)' : 'transparent' }}
                          >
                            <td className="c-year">
                              <button
                                type="button"
                                aria-pressed={on}
                                onClick={() => setActiveYear(on ? null : yr)}
                                className="trend-year-btn"
                              >
                                {y.year}
                              </button>
                              {y.partial && <span className="muted small"> частично</span>}
                            </td>
                            <td className="c-value">{money(y.valueEur)}</td>
                            <td className="c-num">{count(y.contracts)}</td>
                            <td className="c-num">{avg > 0 ? money(avg) : '—'}</td>
                            <td className="c-share">{pct(share)}</td>
                            <td className="c-yoy">
                              <span className="trend-yoy-cell">
                                <span
                                  aria-hidden="true"
                                  className="trend-yoy-bar"
                                  style={{
                                    width: barW,
                                    background:
                                      y.yoyPct == null
                                        ? 'transparent'
                                        : pos
                                          ? 'var(--accent)'
                                          : 'color-mix(in oklch, var(--ink) 35%, transparent)',
                                  }}
                                />
                                <span
                                  className="trend-yoy-pct"
                                  style={{
                                    color:
                                      y.yoyPct == null
                                        ? 'var(--ink-soft)'
                                        : pos
                                          ? 'var(--accent)'
                                          : 'var(--ink-mid)',
                                  }}
                                >
                                  {y.yoyPct == null ? '—' : signedPct(y.yoyPct)}
                                </span>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted trend-years-empty">Няма данни за избрания срез.</p>
              )}
            </div>
          </div>

          {/* right rail: newest contracts */}
          <div className="trend-panel trend-rail">
            <div className="trend-rail-head">
              <h2 className="trend-panel-title">
                Най-нови <em>договори</em>
              </h2>
              <a href="/trends.rss" className="trend-rail-rss">
                RSS ↗
              </a>
            </div>
            <div className="trend-rail-submeta">Върхът на кривата · {sectorMeta}</div>
            {latest.length > 0 ? (
              <ul className="trend-rail-list">
                {latest.map((c) => (
                  <li key={c.id} className="trend-rail-item">
                    <div className="trend-rail-row">
                      <span className="trend-rail-date">{c.signedAt ? date(c.signedAt) : '—'}</span>
                      <span className="trend-rail-val">
                        {c.valueEur != null ? money(c.valueEur) : 'непотвърдена'}
                      </span>
                    </div>
                    <div className="clamp1 trend-rail-buyer">
                      <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
                    </div>
                    <div className="clamp1 trend-rail-seller">
                      <span className="trend-rail-seller-arrow">→</span>{' '}
                      <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                    </div>
                    <div className="trend-rail-tags">
                      {c.sectorCode && sectorShortByCode.has(c.sectorCode) && (
                        <span className="trend-rail-sector">
                          {sectorShortByCode.get(c.sectorCode)}
                        </span>
                      )}
                      {c.euFunded && <span className="trend-rail-eu">ЕС</span>}
                      <Link to={`/contracts/${c.id}`} className="trend-rail-more">
                        договор ↗
                      </Link>
                    </div>
                  </li>
                ))}
                <li className="trend-rail-end" aria-hidden="true">
                  — край на списъка —
                </li>
              </ul>
            ) : (
              <p className="muted trend-rail-empty">Няма договори за избрания срез.</p>
            )}
          </div>
        </div>

        <Callout title="За покритието на данните">
          <p className="trend-callout-p">
            Графиката включва договорите с валидна дата на сключване ({pct(data.coverage.pct)} от
            тях).{' '}
            {cur
              ? 'Текущият месец е включен по избор („вкл. текущия месец") и е отбелязан като частичен — стойността му още се натрупва.'
              : 'Текущият месец е непълен и по подразбиране е изключен от графиката — включи го с „вкл. текущия месец".'}{' '}
            Виж методологията за подробности.
          </p>
        </Callout>

        <p className="small muted source-line">Данни: Регистър на обществените поръчки (АОП)</p>
      </main>
    </>
  );
}

function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="trend-legend-item">
      {swatch}
      {children}
    </span>
  );
}

function Swatch({ box, line, dashed }: { box?: boolean; line?: boolean; dashed?: boolean }) {
  if (box) return <span aria-hidden="true" className="trend-sw-box" />;
  if (dashed) return <span aria-hidden="true" className="trend-sw-dashed" />;
  return <span aria-hidden="true" className="trend-sw-line" />;
}

// ── „Договори — обзор" lenses (?angle=cpv | cross) ────────────────────────────────────────────────
// Re-applied from the sigma-plus обзор feature: per-CPV-group price distributions and the shared
// filtered contract cards. Every control is a plain <Link> mutating the query string, so the lens
// views are fully SSR/no-JS capable.

// Per-group distribution strip: p10–p90 box, real-value dot cloud (log x), median line. Dots at
// ≥5× the group median are highlighted — the same "worth a look" cue as the card labels. All
// geometry helpers (jitter, log scale) live in lib/obzor-cpv.ts.
function DistStrip({ g, gMax }: { g: CpvLensGroup; gMax: number }) {
  const lx = makeLx(gMax);
  return (
    <svg viewBox="0 0 320 30" className="ov-dist" aria-hidden="true">
      <line className="ov-dist-axis" x1={6} y1={16} x2={314} y2={16} />
      <rect
        className="ov-dist-box"
        x={lx(g.p10Eur).toFixed(1)}
        y={11}
        width={Math.max(0, lx(g.p90Eur) - lx(g.p10Eur)).toFixed(1)}
        height={10}
        rx={2}
      />
      {g.sampleEur.map((v, i) => {
        const hi = v >= g.medianEur * 5;
        return (
          <circle
            key={i}
            className={hi ? 'ov-dot is-outlier' : 'ov-dot'}
            cx={lx(v).toFixed(1)}
            cy={(16 + jitter(g.group, i) * 15).toFixed(1)}
            r={hi ? 3 : 2}
          />
        );
      })}
      <line
        className="ov-dist-median"
        x1={lx(g.medianEur).toFixed(1)}
        y1={4}
        x2={lx(g.medianEur).toFixed(1)}
        y2={28}
      />
    </svg>
  );
}

function DistAxis({ gMax }: { gMax: number }) {
  const lx = makeLx(gMax);
  const ticks: number[] = [];
  for (let v = LOG_MIN; v <= gMax; v *= 10) ticks.push(v);
  return (
    <svg viewBox="0 0 320 16" className="ov-dist ov-dist-ticks" aria-hidden="true">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={lx(v).toFixed(1)} y1={0} x2={lx(v).toFixed(1)} y2={4} />
          <text x={lx(v).toFixed(1)} y={13} textAnchor="middle">
            {axisLabel(v)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function TrendsOverview({ loaderData }: { loaderData: OverviewData }) {
  const { angle, sort, cpvSort, year, cpvSel, trend, stats, method, contracts, medians } =
    loaderData;
  const [sp] = useSearchParams();
  const navigating = useNavigation().state !== 'idle';

  // Every control is a Link that patches the query string (null deletes a key; an array replaces
  // every occurrence of a repeatable key — the CPV multi-select).
  const hrefWith = (patch: Record<string, string | string[] | null>): string => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (Array.isArray(v)) for (const item of v) next.append(k, item);
      else if (v != null) next.set(k, v);
    }
    const qs = next.toString();
    return qs ? `/trends?${qs}` : '/trends';
  };

  // Toggle one CPV group in/out of the multi-select (a plain GET Link — no-JS friendly). The set is
  // written sorted so equal selections always share one canonical URL/edge-cache key.
  const hrefToggleCpv = (group: string): string => {
    const next = (
      cpvSel.includes(group) ? cpvSel.filter((g) => g !== group) : [...cpvSel, group]
    ).sort();
    return hrefWith({ cpv: next.length ? next : null });
  };

  // Cohort baseline per CPV group, all rollup-sourced: top-N lens rows first, on-demand cohort
  // medians for the rest. A group with no entry (< 30 priced peers) gets no „спрямо типичното" badge.
  const cohorts = new Map<string, { name: string | null; medianEur: number }>();
  for (const m of medians) cohorts.set(m.code, { name: m.label, medianEur: m.medianEur });
  for (const g of stats.groups) cohorts.set(g.group, { name: g.name, medianEur: g.medianEur });

  const datedContracts = trend.points.reduce((sum, p) => sum + p.contracts, 0);
  const totals: Total[] = [
    { num: money(trend.totalValueEur), label: 'обща стойност' },
    { num: count(datedContracts), label: 'договора' },
    { num: count(stats.totalGroups), label: 'CPV групи' },
  ];

  const gMax = logMax(stats.groups);
  const cpvRows = [...stats.groups].sort((a, b) =>
    cpvSort === 'med'
      ? b.medianEur - a.medianEur
      : cpvSort === 'code'
        ? a.group.localeCompare(b.group)
        : b.contracts - a.contracts,
  );

  const chips: { label: string; clear: Record<string, string | string[] | null> }[] = [];
  for (const g of cpvSel) {
    const rest = cpvSel.filter((c) => c !== g);
    chips.push({ label: `CPV ${g}`, clear: { cpv: rest.length ? rest : null } });
  }
  if (year) chips.push({ label: year, clear: { year: null } });
  const lensHint = angle === 'cpv' ? 'кликни CPV ред, за да филтрираш' : 'избери година и CPV код';

  const scopeParts: string[] = [];
  for (const g of cpvSel) scopeParts.push(`CPV ${g}`);
  if (year) scopeParts.push(year);
  const scopeText = scopeParts.length ? scopeParts.join(' · ') : 'всички договори';

  const sorts = [
    { key: 'date', label: 'Най-нови' },
    { key: 'value', label: 'Стойност' },
  ] as const;
  const cpvSorts = [
    { key: 'n', label: 'Договори' },
    { key: 'med', label: 'Типична' },
    { key: 'code', label: 'CPV' },
  ] as const;

  const yearCards = trend.years.map((y) => ({
    ...y,
    active: y.year === year,
    href: hrefWith({ year: y.year === year ? null : y.year }),
  }));

  const cpvPanel = (compact: boolean) => (
    <div className="ov-panel ov-cpv" data-compact={compact || undefined}>
      <div className="ov-panel-head">
        <div>
          <h2 className="ov-panel-title">
            {compact ? (
              <>
                Стеснѝ по <em>CPV код</em>
              </>
            ) : (
              <>
                Цени по <em>CPV код</em>
              </>
            )}
          </h2>
          {!compact && (
            <p className="ov-panel-hint">
              Всеки код събира сходни поръчки. Разсейването е нормално — обемите варират. Кликни
              ред, за да видиш договорите. Показани са {stats.groups.length}-те групи с най-много
              договори.
              <MetricInfo
                title="Как се смятат типичното и отклоненията"
                summary={`Всеки 5-цифрен CPV код е кохорта от сходни поръчки; „типична" е медианата на стойностите ѝ. Необичайно скъпите договори се засичат с устойчива статистика върху логаритъма на стойността (log-MAD), при отклонение z ≥ ${method.zThreshold} само нагоре и само в кохорти с поне ${count(method.minCohortSize)} поръчки с потвърдена стойност. Оцветените точки в лентата са стойности ≥5× медианата.`}
                readout={`${count(stats.totalGroups)} кохорти · ${count(method.flaggedCount)} маркирани договора. Голяма стойност ≠ надплащане — данните нямат количества, затова това е ориентир за преглед, не оценка.`}
              />
            </p>
          )}
        </div>
        {!compact && (
          <div className="ov-seg" role="group" aria-label="Подредба на CPV групите">
            {cpvSorts.map((s) => (
              <Link
                key={s.key}
                to={hrefWith({ cpvSort: s.key === 'n' ? null : s.key })}
                preventScrollReset
                aria-current={cpvSort === s.key || undefined}
              >
                {s.label}
              </Link>
            ))}
          </div>
        )}
      </div>
      {!compact && (
        <div className="ov-cpv-head" aria-hidden="true">
          <span>CPV</span>
          <span>Категория</span>
          <span className="num">Типична</span>
          <span className="num">Догов.</span>
          <span>Разпределение · лог €</span>
        </div>
      )}
      {cpvRows.map((g) => {
        const active = cpvSel.includes(g.group);
        return (
          <Link
            key={g.group}
            to={hrefToggleCpv(g.group)}
            preventScrollReset
            className={`ov-cpv-row${active ? ' is-active' : ''}`}
            aria-current={active || undefined}
          >
            {compact && (
              <span className="ov-check" aria-hidden="true">
                {active ? '✓' : ''}
              </span>
            )}
            <span className="ov-cpv-code mono">{g.group}</span>
            <span className="ov-cpv-name">
              <span className="clamp">{g.name ?? `CPV група ${g.group}`}</span>
              {!compact && (
                <span className="ov-cpv-range">
                  диапазон p10–p90 · {money(g.p10Eur)} – {money(g.p90Eur)}
                </span>
              )}
            </span>
            <span className="ov-cpv-med mono">{money(g.medianEur)}</span>
            {!compact && (
              <>
                <span className="ov-cpv-n mono">{count(g.contracts)}</span>
                <DistStrip g={g} gMax={gMax} />
              </>
            )}
          </Link>
        );
      })}
      {!compact && (
        <div className="ov-cpv-foot">
          <DistAxis gMax={gMax} />
        </div>
      )}
    </div>
  );

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Договори — обзор' }]} />
      <main id="main" className="ov-lens">
        <PageHeader
          kicker="Обзор на договорите"
          title={
            <>
              Договори, погледнати под <em>различен ъгъл</em>
            </>
          }
          lede="Един и същи списък договори — по CPV код, или време и CPV наведнъж. Изберѝ ъгъл; списъкът долу се сглобява от избора. Договорите без валидна дата или стойност не влизат в изгледа."
        />

        <TotalsStrip totals={totals} label="Обобщение на обзора" />

        <nav className="ov-controls" aria-label="Ъгъл на гледане и филтри">
          <span className="ov-controls-label">Ъгъл на гледане</span>
          <AngleSwitch
            angle={angle}
            hrefFor={(a) => hrefWith({ angle: a === 'time' ? null : a })}
          />
          <div className="ov-chips">
            {chips.length ? (
              <>
                <span className="ov-controls-label">Филтри</span>
                {chips.map((c) => (
                  <Link
                    key={c.label}
                    to={hrefWith(c.clear)}
                    preventScrollReset
                    className="ov-chip"
                    aria-label={`Премахни филтъра ${c.label}`}
                  >
                    {c.label} <span aria-hidden="true">✕</span>
                  </Link>
                ))}
              </>
            ) : (
              <span className="ov-hint">{lensHint}</span>
            )}
          </div>
        </nav>

        {/* Announce server-rendered chart/list updates when a CPV code or year is (de)selected. */}
        <p className="sr-only" role="status">
          {navigating
            ? 'Обновяване на данните…'
            : cpvSel.length
              ? `Графиката и списъкът показват ${count(cpvSel.length)} ${plural(cpvSel.length, 'избрана CPV група', 'избрани CPV групи')}.`
              : 'Графиката и списъкът показват всички CPV групи.'}
        </p>

        {angle === 'cpv' && cpvPanel(false)}

        {angle === 'cross' && (
          <div className="ov-cross">
            <section className="ov-panel ov-cross-year" aria-label="Избор на година">
              <h2 className="ov-panel-title">
                Избери <em>година</em>
              </h2>
              <p className="ov-panel-hint">
                После стеснѝ по CPV код от съседния списък — графиката се преизчислява само върху
                избраните групи.
              </p>
              {trend.points.length < 2 && (
                <p className="muted ov-cross-chart-empty">
                  Няма достатъчно данни за избраните CPV групи.
                </p>
              )}
              {trend.points.length >= 2 && (
                <ComboTrendChart
                  points={trend.points}
                  granularity={trend.granularity}
                  cssHeight={260}
                  interactive={false}
                  ariaLabel={
                    cpvSel.length
                      ? `Брой договори и € обем във времето само за избраните CPV групи: ${cpvSel.join(', ')}`
                      : 'Брой договори и € обем във времето за всички CPV групи'
                  }
                />
              )}
              <div className="ov-years">
                {yearCards.map((y) => (
                  <Link
                    key={y.year}
                    to={y.href}
                    preventScrollReset
                    className={`ov-year is-slim${y.active ? ' is-active' : ''}`}
                    aria-current={y.active || undefined}
                  >
                    <span className="ov-year-label mono">{y.year}</span>
                  </Link>
                ))}
              </div>
            </section>
            {cpvPanel(true)}
          </div>
        )}

        <section className="ov-panel ov-list" aria-label="Договори за избора">
          <div className="ov-panel-head">
            <div>
              <h2 className="ov-panel-title">
                {sort === 'value' ? 'Договори · по стойност' : 'Договори · най-нови'}
              </h2>
              <p className="ov-panel-hint">
                {count(contracts.length)} {plural(contracts.length, 'договор', 'договора')}
                {contracts.length === 24 ? ' (показани първите 24)' : ''} · {scopeText}
              </p>
            </div>
            <div className="ov-panel-tools">
              <span className="ov-controls-label">Подредба</span>
              <div className="ov-seg" role="group" aria-label="Подредба на договорите">
                {sorts.map((s) => (
                  <Link
                    key={s.key}
                    to={hrefWith({ sort: s.key === 'date' ? null : s.key })}
                    preventScrollReset
                    aria-current={sort === s.key || undefined}
                  >
                    {s.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
          {contracts.length ? (
            <ul className="ov-cards">
              {contracts.map((c) => {
                const cohort = c.cpvGroup ? cohorts.get(c.cpvGroup) : undefined;
                const rel = cohort ? relLabel(c.valueEur, cohort.medianEur) : null;
                return (
                  <li key={c.id}>
                    <Link to={`/contracts/${c.id}`} className="ov-card">
                      <span className="ov-card-top">
                        <span className="ov-card-date mono">{date(c.signedAt)}</span>
                        <span className="ov-card-val mono">{money(c.valueEur)}</span>
                      </span>
                      <span className="ov-card-buyer clamp">{c.authorityName}</span>
                      <span className="ov-card-seller clamp">
                        <span aria-hidden="true">→ </span>
                        {c.bidderName}
                      </span>
                      <span className="ov-card-foot">
                        {c.cpvGroup && <span className="ov-card-cpv mono">CPV {c.cpvGroup}</span>}
                        <span className="ov-card-cohort clamp">{cohort?.name ?? ''}</span>
                        {rel && <span className={`ov-card-rel mono ${rel.cls}`}>{rel.text}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ov-empty">Няма договори за този избор.</p>
          )}
          <p className="ov-note">
            „Спрямо типичното" сравнява стойността на договора с медианата за неговия CPV код.
            Данните нямат количества, затова по-високата стойност често значи просто по-голям обем —
            това е ориентир за разглеждане, не оценка.
          </p>
        </section>

        <Callout title="За покритието на данните">
          <p className="trend-callout-p">
            Изгледът включва договорите с валидна дата на сключване и стойност в евро. Последният
            период е непълен и е отбелязан като „частично". Виж методологията за подробности.
          </p>
        </Callout>
      </main>
    </>
  );
}
