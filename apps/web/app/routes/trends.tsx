import { type CSSProperties, type ReactNode, useMemo, useState } from 'react';
import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { count, date, money, pct, signedPct } from '@sigma/shared';
import { CPV_SECTORS } from '@sigma/config';
import { getSpendingTrend, listContracts } from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { TrendComboChart } from '../components/TrendComboChart';
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

const MONO = "'IBM Plex Mono', ui-monospace, monospace";

const PANEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--paper-warm)',
  border: '1px solid var(--rule)',
  borderRadius: 4,
};

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

  const kpis = useMemo(() => computeKpis(data.points), [data.points]);
  const growth = useMemo(() => estimateYoyGrowth(data.points), [data.points]);
  const combined = useMemo(() => {
    const forecast = buildForecast(data.points, growth);
    return combineSeries(data.points, forecast);
  }, [data.points, growth]);

  const display = useMemo(
    () => aggregate(combined, step, activeYear),
    [combined, step, activeYear],
  );

  const hasChart = display.length >= 2;
  const trendWindow = activeYear ? 3 : step === 'month' ? 7 : step === 'quarter' ? 4 : 3;
  const barRatio = step === 'year' ? 0.5 : step === 'quarter' ? 0.6 : 0.62;
  const axisWord =
    activeYear || step === 'month' ? 'месеци' : step === 'quarter' ? 'тримесечия' : 'години';

  const growthTxt = `${growth.value >= 1 ? '+' : ''}${Math.round((growth.value - 1) * 100)}%`;
  const firstYear = combined.length ? combined[0]!.period.slice(0, 4) : '';
  const lastYear = combined.length ? combined.at(-1)!.period.slice(0, 4) : '';
  const chartMeta = activeYear
    ? String(activeYear)
    : `${firstYear}–${lastYear} · ръст ${growthTxt}/год`;
  const chartTitle = activeYear ? `Разходи по месеци · ${activeYear}` : `Разходи по ${axisWord}`;
  const ariaLabel = `Разходи за обществени поръчки и брой договори по ${axisWord}${
    activeYear ? `, ${activeYear} г.` : ''
  }. Колоните са броят договори, плътната линия е трендът на стойността, а пунктираният участък „ПРОГНОЗА" е сезонна прогноза. Точните стойности са в таблицата „По години" по-долу.`;

  // Year table figures (share + average + YoY bar), all derived from the loader's per-year rows.
  const grandTotal = data.years.reduce((a, y) => a + y.valueEur, 0);
  const YOY_BAR_MAX = 2.8; // a +280% YoY fills the bar

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Тренд във времето' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ · Тренд във времето"
          title={
            <>
              Тренд във <em>времето</em>
            </>
          }
          lede="Как се движат разходите за обществени поръчки през годините — месечен обем, брой договори и типичните пикове в края на годината. Договорите без валидна дата на сключване не влизат в графиката."
        />

        {/* KPI strip */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0,
            margin: '0 0 18px',
            borderTop: '1px solid var(--rule)',
            borderBottom: '1px solid var(--rule)',
          }}
        >
          <Kpi value={money(kpis.totalValueEur)} label="ОБЩО ЗА ПЕРИОДА" />
          <Kpi value={count(kpis.contracts)} label="ДОГОВОРА" />
          <Kpi value={kpis.avgEur > 0 ? money(kpis.avgEur) : '—'} label="СРЕДЕН ДОГОВОР" />
          <Kpi
            value={kpis.peak ? money(kpis.peak.valueEur) : '—'}
            label={kpis.peak ? `ПИК · ${shortMonthLabel(kpis.peak.period)}` : 'ПИК'}
            accent
          />
        </div>

        {/* filter bar: step toggle (client) + sector/funding (server) + active-year chip */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
            padding: '10px 14px',
            background: 'var(--paper-warm)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            marginBottom: 14,
          }}
        >
          <div role="group" aria-label="Стъпка на графиката" style={{ display: 'flex' }}>
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
                  style={{
                    font: `500 10px/1 ${MONO}`,
                    letterSpacing: '0.08em',
                    padding: '7px 11px',
                    cursor: 'pointer',
                    border: '1px solid var(--rule)',
                    borderLeftWidth: i === 0 ? 1 : 0,
                    borderRadius:
                      i === 0 ? '3px 0 0 3px' : i === STEP_DEFS.length - 1 ? '0 3px 3px 0' : 0,
                    background: on ? 'var(--ink)' : 'var(--paper)',
                    color: on ? 'var(--paper)' : 'var(--ink-mid)',
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          <Form
            method="get"
            role="group"
            aria-label="Филтри на тренда"
            onChange={(e) => submit(e.currentTarget)}
            style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--ink-soft)' }}>Сектор</span>
              <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
                <option value="">Всички сектори</option>
                {data.sectors.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.short}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--ink-soft)' }}>Финансиране</span>
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
            <button
              type="button"
              onClick={() => setActiveYear(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                font: `500 10px/1 ${MONO}`,
                padding: '7px 10px',
                background: 'var(--ink)',
                color: 'var(--paper)',
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              {activeYear} ✕
            </button>
          )}

          <div style={{ marginLeft: 'auto', font: `400 11px/1 ${MONO}`, color: 'var(--ink-mid)' }}>
            Общо <b style={{ color: 'var(--ink)' }}>{money(data.totalValueEur)}</b> за периода
          </div>
        </div>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {unknownSector && (
          <Callout variant="warning" title="Непознат филтър">
            <p style={{ margin: 0 }}>Избраният сектор не съществува. Показваме всички сектори.</p>
          </Callout>
        )}

        {/* main grid */}
        <div className="trend-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            {/* chart panel */}
            <div style={{ ...PANEL, padding: '14px 16px 10px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-serif, Georgia, serif)',
                    fontSize: 16,
                    fontWeight: 600,
                  }}
                >
                  {chartTitle}
                </h2>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    font: `400 9.5px/1 ${MONO}`,
                    color: 'var(--ink-soft)',
                    flexWrap: 'wrap',
                  }}
                >
                  <LegendItem swatch={<Swatch box />}>договори</LegendItem>
                  <LegendItem swatch={<Swatch line />}>тренд €</LegendItem>
                  <LegendItem swatch={<Swatch dashed />}>прогноза</LegendItem>
                  <span style={{ color: 'var(--ink-mid)' }}>{chartMeta}</span>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                {hasChart ? (
                  <TrendComboChart
                    points={display}
                    trendWindow={trendWindow}
                    barRatio={barRatio}
                    ariaLabel={ariaLabel}
                  />
                ) : (
                  <p className="muted" style={{ padding: '24px 0' }}>
                    Няма достатъчно данни за избраните филтри.
                  </p>
                )}
              </div>
            </div>

            {/* year table */}
            <div style={{ ...PANEL, padding: '12px 16px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-serif, Georgia, serif)',
                    fontSize: 16,
                    fontWeight: 600,
                  }}
                >
                  По години
                </h2>
                <span style={{ font: `400 10px/1 ${MONO}`, color: 'var(--ink-soft)' }}>
                  кликни година за филтър ↓
                </span>
              </div>
              {data.years.length > 0 ? (
                <table
                  className="trend-years"
                  style={{ width: '100%', borderCollapse: 'collapse' }}
                >
                  <caption className="sr-only">
                    Разходи по години: стойност, брой договори, среден договор, дял и промяна спрямо
                    предходната година. Изберете година, за да филтрирате графиката.
                  </caption>
                  <thead>
                    <tr
                      style={{
                        font: `500 8.5px/1 ${MONO}`,
                        letterSpacing: '0.1em',
                        color: 'var(--ink-soft)',
                      }}
                    >
                      <th style={{ textAlign: 'left', padding: '7px 8px 6px 0' }}>ГОДИНА</th>
                      <th style={{ textAlign: 'right', padding: '7px 8px 6px' }}>СТОЙНОСТ</th>
                      <th style={{ textAlign: 'right', padding: '7px 8px 6px' }}>ДОГОВОРИ</th>
                      <th style={{ textAlign: 'right', padding: '7px 8px 6px' }}>СРЕДЕН</th>
                      <th style={{ textAlign: 'right', padding: '7px 8px 6px' }}>ДЯЛ</th>
                      <th style={{ textAlign: 'right', padding: '7px 0 6px 8px' }}>
                        СПРЯМО ПРЕДХ.
                      </th>
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
                          style={{
                            borderBottom: '1px solid var(--rule-soft)',
                            background: on ? 'var(--accent-bg)' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '6px 8px 6px 0' }}>
                            <button
                              type="button"
                              aria-pressed={on}
                              onClick={() => setActiveYear(on ? null : yr)}
                              style={{
                                font: `600 12px/1 ${MONO}`,
                                color: 'var(--accent)',
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                              }}
                            >
                              {y.year}
                            </button>
                            {y.partial && <span className="muted small"> частично</span>}
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              padding: '6px 8px',
                              font: `600 12px/1 ${MONO}`,
                            }}
                          >
                            {money(y.valueEur)}
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              padding: '6px 8px',
                              font: `400 11px/1 ${MONO}`,
                              color: 'var(--ink-mid)',
                            }}
                          >
                            {count(y.contracts)}
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              padding: '6px 8px',
                              font: `400 11px/1 ${MONO}`,
                              color: 'var(--ink-mid)',
                            }}
                          >
                            {avg > 0 ? money(avg) : '—'}
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              padding: '6px 8px',
                              font: `400 11px/1 ${MONO}`,
                              color: 'var(--ink-soft)',
                            }}
                          >
                            {pct(share)}
                          </td>
                          <td style={{ padding: '6px 0 6px 8px' }}>
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                                gap: 8,
                              }}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  height: 5,
                                  borderRadius: 3,
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
                                style={{
                                  font: `500 10.5px/1 ${MONO}`,
                                  minWidth: 52,
                                  textAlign: 'right',
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
              ) : (
                <p className="muted" style={{ marginTop: 10 }}>
                  Няма данни за избрания срез.
                </p>
              )}
            </div>
          </div>

          {/* right rail: newest contracts */}
          <div style={{ ...PANEL, padding: '12px 0 0' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                padding: '0 16px 10px',
                borderBottom: '1px solid var(--rule)',
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-serif, Georgia, serif)',
                  fontSize: 16,
                  fontWeight: 600,
                }}
              >
                Най-нови договори
              </h2>
              <a
                href="/trends.rss"
                style={{
                  font: `500 9px/1 ${MONO}`,
                  letterSpacing: '0.1em',
                  color: 'var(--accent)',
                }}
              >
                RSS ↗
              </a>
            </div>
            {latest.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {latest.map((c) => (
                  <li
                    key={c.id}
                    style={{ padding: '9px 16px', borderTop: '1px solid var(--rule-soft)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 10,
                      }}
                    >
                      <span style={{ font: `500 9.5px/1 ${MONO}`, color: 'var(--ink-soft)' }}>
                        {c.signedAt ? date(c.signedAt) : '—'}
                      </span>
                      <span
                        style={{
                          font: `600 11px/1 ${MONO}`,
                          color: 'var(--ink)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.valueEur != null ? money(c.valueEur) : 'непотвърдена'}
                      </span>
                    </div>
                    <div
                      className="clamp1"
                      style={{ marginTop: 5, fontSize: 11.5, fontWeight: 500 }}
                    >
                      <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
                    </div>
                    <div
                      className="clamp1"
                      style={{ marginTop: 2, fontSize: 11, color: 'var(--ink-mid)' }}
                    >
                      <span style={{ color: 'var(--accent)' }}>→</span>{' '}
                      <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                    </div>
                    <div style={{ marginTop: 5 }}>
                      <Link
                        to={`/contracts/${c.id}`}
                        className="muted small"
                        style={{ fontSize: 11 }}
                      >
                        {c.subject || c.procedureLabel}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ padding: 16 }}>
                Няма договори за избрания срез.
              </p>
            )}
          </div>
        </div>

        <Callout title="За покритието на данните">
          <p style={{ margin: 0 }}>
            Графиката включва договорите с валидна дата на сключване ({pct(data.coverage.pct)} от
            тях). Последният период е непълен и е изключен от трендовата линия. Участъкът „ПРОГНОЗА"
            е сезонна прогноза, изчислена от месечните данни (същият календарен месец предходна
            година, умножен по средния годишен ръст {growthTxt}) — не са реални договори. Виж
            методологията за подробности.
          </p>
        </Callout>

        <style>{`
          .trend-grid { display: grid; grid-template-columns: minmax(0, 1.95fr) minmax(300px, 1fr); gap: 14px; }
          @media (max-width: 880px) { .trend-grid { grid-template-columns: 1fr; } }
        `}</style>
      </main>
    </>
  );
}

function Kpi({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div style={{ padding: '12px 22px', borderLeft: '1px solid var(--rule)' }}>
      <div style={{ font: `600 25px/1 ${MONO}`, color: accent ? 'var(--accent)' : 'var(--ink)' }}>
        {value}
      </div>
      <div
        style={{
          marginTop: 4,
          font: `500 9px/1 ${MONO}`,
          letterSpacing: '0.14em',
          color: 'var(--ink-soft)',
        }}
      >
        {label}
      </div>
    </div>
  );
}

function LegendItem({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {swatch}
      {children}
    </span>
  );
}

function Swatch({ box, line, dashed }: { box?: boolean; line?: boolean; dashed?: boolean }) {
  if (box) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          background: 'color-mix(in oklch, var(--ink) 40%, transparent)',
          display: 'inline-block',
          borderRadius: 1,
        }}
      />
    );
  }
  if (dashed) {
    return (
      <span
        aria-hidden="true"
        style={{ width: 14, borderTop: '1.6px dashed var(--accent)', display: 'inline-block' }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14,
        height: 2.4,
        background: 'var(--ink)',
        display: 'inline-block',
        borderRadius: 2,
      }}
    />
  );
}
