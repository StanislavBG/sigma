import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { count, date, money, pct, signedPct } from '@sigma/shared';
import { CPV_SECTORS } from '@sigma/config';
import { getSpendingTrend, listContracts } from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { TrendComboChart } from '../components/TrendComboChart';
import { MetricInfo } from '../components/MetricInfo';
import { Callout } from '../components/ui';
import { publicCache } from '../lib/cache';
import { buildForecast, estimateYoyGrowth } from '../lib/trends-forecast';
import {
  aggregate,
  combineSeries,
  computeKpis,
  shortMonthLabel,
  type Step,
} from '../lib/trends-series';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Тренд във времето — СИГМА' },
    {
      name: 'description',
      content:
        'Как се движат разходите за обществени поръчки във времето — месечен обем, брой договори, сезонните пикове в края на годината и сезонна прогноза. Изцяло върху наличните данни.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sector = sp.get('sector');
  const db = context.cloudflare.env.DB;
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

  return { data, unknownSector, latest: latest.items, funding };
}

// Default chart window: the most recent N years of actuals (plus the forecast tail).
const CHART_TRAILING_YEARS = 5;

const STEP_DEFS: { key: Step; label: string }[] = [
  { key: 'month', label: 'МЕСЕЧНО' },
  { key: 'quarter', label: 'ТРИМЕСЕЧНО' },
  { key: 'year', label: 'ГОДИШНО' },
];

export default function Trends({ loaderData }: Route.ComponentProps) {
  const { data, unknownSector, latest } = loaderData;
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  // Step + year drill-down are client state over the one monthly series the loader returned.
  const [step, setStep] = useState<Step>('month');
  const [activeYear, setActiveYear] = useState<number | null>(null);

  // KPIs + coverage use the UNFILTERED actuals; the rendered line drops the partial as_of month.
  const kpis = useMemo(() => computeKpis(data.points), [data.points]);
  const growth = useMemo(() => estimateYoyGrowth(data.points), [data.points]);
  const combined = useMemo(() => {
    const forecast = buildForecast(data.points, growth);
    return combineSeries(data.points, forecast);
  }, [data.points, growth]);
  // When the seasonal base is absent buildForecast returns [] — the band, the ПРОГНОЗА legend swatch
  // and the methodology sentence below are all gated on this so we never describe an absent forecast.
  const hasForecast = useMemo(() => combined.some((p) => p.forecast), [combined]);

  // The current in-progress month's real partial value — shown as the „до момента" marker beside the
  // projection. Only in the default month view (periods map 1:1 with the chart's first-forecast slot).
  const partialPoint = useMemo(() => data.points.find((p) => p.partial) ?? null, [data.points]);
  const chartPartial =
    !activeYear && step === 'month' && hasForecast && partialPoint
      ? { valueEur: partialPoint.valueEur, contracts: partialPoint.contracts }
      : null;

  // Default chart view is the last CHART_TRAILING_YEARS of actuals + the forecast tail — the early
  // ramp-up years (and any stray junk year) are trimmed so the curve reads cleanly. A year drill-down
  // shows that single year in full.
  const windowed = useMemo(() => {
    if (activeYear) return combined;
    const actualYears = combined
      .filter((p) => !p.forecast)
      .map((p) => Number(p.period.slice(0, 4)));
    if (!actualYears.length) return combined;
    const minYear = Math.max(...actualYears) - (CHART_TRAILING_YEARS - 1);
    return combined.filter((p) => p.forecast || Number(p.period.slice(0, 4)) >= minYear);
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
  }. Колоните са броят договори, плътната линия е трендът на стойността, а пунктираният участък „ПРОГНОЗА" е сезонна прогноза. Точните стойности са в таблицата „По години" по-долу.`;

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
                  summary="Общата стойност, разделена на броя договори — средно аритметично, а не типичната стойност."
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

        {/* filter bar: step toggle (client) + sector/funding (server) + active-year chip */}
        <div className="trend-filterbar">
          {stepToggle}

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
                  {hasForecast && <LegendItem swatch={<Swatch dashed />}>прогноза</LegendItem>}
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
                    partial={chartPartial}
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
            тях). Последният период е непълен и е изключен от трендовата линия
            {chartPartial
              ? ' — натрупаната му стойност е отбелязана отделно като маркера „до момента".'
              : '.'}
            {hasForecast && (
              <>
                {' '}
                Участъкът „ПРОГНОЗА" е сезонна прогноза, изчислена от месечните данни (същият
                календарен месец предходна година, умножен по типичния годишен ръст{' '}
                {growthTxt} за последните 3 пълни години) — не са реални договори.
              </>
            )}{' '}
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
