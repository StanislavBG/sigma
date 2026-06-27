import { Link } from 'react-router';
import {
  getCompetitionSummary,
  getFlows,
  getRegionalSpending,
  getSpendingTrend,
  getTopOverruns,
} from '@sigma/db';
import { count, money, pct, signedPct } from '@sigma/shared';
import type { ReactNode } from 'react';
import type { Route } from './+types/analytics';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Choropleth } from '../components/Choropleth';
import { TrendChart } from '../components/TrendChart';
import { SingleOfferPortion } from '../components/SingleOfferPortion';
import { Section, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { ANALYTICS_LENSES } from '../lib/analytics-lenses';
import { seoMeta } from '../lib/meta';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/analytics',
    title: 'Анализи — СИГМА',
    description:
      'Четири аналитични изгледа към обществените поръчки: потоци, карта, тренд и конкуренция.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const [flows, regional, trend, competition, overruns] = await Promise.all([
    getFlows(db, { top: 3 }),
    getRegionalSpending(db, { funding: 'all' }),
    getSpendingTrend(db, { funding: 'all', granularity: 'year' }, { includeSectors: false }),
    getCompetitionSummary(db),
    getTopOverruns(db, { by: 'absolute', limit: 3 }),
  ]);

  return {
    overruns: {
      totalOverrunEur: overruns.totalOverrunEur,
      count: overruns.count,
      top: overruns.rows.slice(0, 3),
    },
    flows: flows.pairs.slice(0, 3),
    regions: regional.regions.filter((region) => region.valueEur > 0).slice(0, 3),
    allRegions: regional.regions,
    regionTotal: regional.totalValueEur,
    trend: {
      points: trend.points,
      latest: trend.years.at(-1) ?? null,
      peak: trend.years.reduce(
        (best, year) => (best == null || year.valueEur > best.valueEur ? year : best),
        null as (typeof trend.years)[number] | null,
      ),
    },
    competition: {
      totals: competition.totals,
      topConcentration: competition.topConcentration,
    },
  };
}

// Scoped styles for the hero tile — kept here (not in app.css) so a parallel agent's app.css edits
// don't collide. Uses the shared design tokens; no raw mock hexes.
const OVERRUNS_HERO_CSS = `
.overruns-hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:0;
  margin-bottom:var(--s-5);border:1px solid var(--rule);border-top:3px solid var(--accent);
  border-radius:4px;background:var(--paper-warm);overflow:hidden;color:var(--ink);
  text-decoration:none;transition:box-shadow .15s ease,border-color .15s ease}
.overruns-hero:hover{box-shadow:0 2px 14px rgba(40,30,15,.08);border-color:var(--ink-soft)}
.overruns-hero:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.overruns-hero-main{padding:var(--s-5)}
.overruns-hero-title{margin:var(--s-2) 0 0;font:600 26px/1.1 var(--font-serif);letter-spacing:-.01em;color:var(--ink)}
.overruns-hero-title em{font-style:italic;color:var(--accent)}
.overruns-hero .desc{margin-top:var(--s-2);max-width:46ch;color:var(--ink-mid)}
.overruns-hero-kpis{display:flex;gap:var(--s-5);margin:var(--s-4) 0 0;padding:var(--s-3) 0 0;border-top:1px solid var(--rule)}
.overruns-hero-kpis .num{margin:0;font:600 22px/1 var(--font-mono);font-variant-numeric:tabular-nums;color:var(--ink)}
.overruns-hero-kpis dt{margin-top:6px;font:500 9px/1 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft)}
.overruns-hero .lens-link{margin-top:var(--s-4)}
.overruns-hero .lens-link span{color:var(--accent);font:500 12px/1 var(--font-mono);letter-spacing:.04em}
.overruns-hero-aside{padding:var(--s-5);border-left:1px solid var(--rule);background:var(--paper)}
@media (max-width:760px){.overruns-hero{grid-template-columns:1fr}
  .overruns-hero-aside{border-left:none;border-top:1px solid var(--rule)}}
`;

function LensLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="lens-link">
      <Link to={to}>{children}</Link>
    </p>
  );
}

const overrunsLens = ANALYTICS_LENSES.find((lens) => 'hero' in lens && lens.hero);
const gridLenses = ANALYTICS_LENSES.filter((lens) => !('hero' in lens && lens.hero));

// Prominent hero tile for the „Раздуване" lens — larger than a lens card, leading to /overruns, in the
// editorial design language (warm panel, accent rule, mono numerics). Wired to real corpus figures.
function OverrunsHero({
  totalOverrunEur,
  count: overrunCount,
  top,
}: {
  totalOverrunEur: number;
  count: number;
  top: { contractSlug: string; subject: string; deltaEur: number; pct: number }[];
}) {
  if (!overrunsLens) return null;
  return (
    <Link
      to={overrunsLens.href}
      className="overruns-hero"
      aria-label={`${overrunsLens.title} — ${overrunsLens.desc}`}
    >
      <div className="overruns-hero-main">
        <p className="kicker info" style={{ color: 'var(--accent)' }}>
          Анализ · Акцент
        </p>
        <h3 className="overruns-hero-title">
          Раздуване на <em>договорите</em>
        </h3>
        <p className="desc">{overrunsLens.desc}</p>
        <dl className="overruns-hero-kpis">
          <div>
            <dd className="num">{money(totalOverrunEur)}</dd>
            <dt>общо раздуване</dt>
          </div>
          <div>
            <dd className="num">{count(overrunCount)}</dd>
            <dt>раздути договора</dt>
          </div>
        </dl>
        <p className="lens-link">
          <span>Виж раздуването →</span>
        </p>
      </div>
      <div className="overruns-hero-aside">
        <p className="lens-preview-title">Най-силно раздути договори</p>
        {top.length ? (
          <ul className="lens-list">
            {top.map((c) => (
              <li key={c.contractSlug}>
                <span className="lens-name">{c.subject}</span>
                <span className="lens-value" style={{ color: 'var(--accent)' }}>
                  +{money(c.deltaEur)}
                </span>
                <span className="lens-meta">{signedPct(c.pct)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Все още няма потвърдено раздуване в данните.</p>
        )}
      </div>
    </Link>
  );
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { flows, regions, allRegions, regionTotal, trend, competition, overruns } = loaderData;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Анализи' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализи"
          title="Анализи"
          lede="Четири начина да проследиш едни и същи обществени поръчки: като движение на пари, карта, времева линия и сигнал за слаба конкуренция."
        />

        <Section
          id="lenses"
          title="Изгледи"
          hint="Всеки изглед отговаря на различен въпрос, но всички водят обратно към конкретните договори."
        >
          <style>{OVERRUNS_HERO_CSS}</style>
          <OverrunsHero
            totalOverrunEur={overruns.totalOverrunEur}
            count={overruns.count}
            top={overruns.top}
          />
          <div className="tiles analytics-lenses">
            {gridLenses.map((lens) => (
              <article className="tile lens-card" key={lens.href}>
                <p className="kicker info">Изглед</p>
                <h3>
                  <Link to={lens.href}>{lens.title}</Link>
                </h3>
                <p className="desc">{lens.desc}</p>
                {lens.href === '/flows' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">Най-големи национални потоци</p>
                    {flows.length ? (
                      <ul className="lens-list">
                        {flows.map((flow) => (
                          <li key={`${flow.authoritySlug}-${flow.bidderSlug}`}>
                            <span className="lens-name">
                              {flow.authorityName} → {flow.bidderDisplayName}
                            </span>
                            <span className="lens-value">{money(flow.wonEur)}</span>
                            <span className="lens-meta">{count(flow.contracts)} договора</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">Няма достатъчно данни за потоци.</p>
                    )}
                  </div>
                )}
                {lens.href === '/map' && (
                  <div className="lens-preview">
                    <div className="lens-map">
                      <Choropleth regions={allRegions} />
                    </div>
                    <p className="lens-preview-title">Водещи области по стойност</p>
                    {regions.length ? (
                      <ul className="lens-list">
                        {regions.map((region) => (
                          <li key={region.nuts3}>
                            <span className="lens-name">{region.name}</span>
                            <span className="lens-value">{money(region.valueEur)}</span>
                            <span className="lens-share">
                              <ShareBar
                                ratio={regionTotal > 0 ? region.valueEur / regionTotal : 0}
                              />
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">Няма достатъчно данни по области.</p>
                    )}
                  </div>
                )}
                {lens.href === '/trends' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">Годишен национален тренд</p>
                    {trend.points.length >= 2 ? (
                      <>
                        <div className="lens-chart">
                          <TrendChart points={trend.points} granularity="year" />
                        </div>
                        <dl className="lens-metrics">
                          {trend.latest && (
                            <div>
                              <dt>{trend.latest.partial ? 'Текуща година' : 'Последна година'}</dt>
                              <dd>
                                {trend.latest.year} · {money(trend.latest.valueEur)}
                                {trend.latest.partial && <span className="muted"> · частично</span>}
                              </dd>
                            </div>
                          )}
                          {trend.peak && (
                            <div>
                              <dt>Пик</dt>
                              <dd>
                                {trend.peak.year} · {money(trend.peak.valueEur)}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </>
                    ) : (
                      <p className="muted">Няма достатъчно данни за тренд.</p>
                    )}
                  </div>
                )}
                {lens.href === '/competition' && (
                  <div className="lens-preview">
                    <p className="lens-preview-title">Национален дял с една оферта</p>
                    <SingleOfferPortion
                      valueEur={competition.totals.singleOfferValueEur}
                      totalEur={competition.totals.valueEur}
                      singleOffer={competition.totals.singleOffer}
                      contracts={competition.totals.contracts}
                    />
                    {competition.topConcentration && (
                      <p className="small muted">
                        Най-концентриран възложител:{' '}
                        <Link to={`/authorities/${competition.topConcentration.slug}`}>
                          {competition.topConcentration.name}
                        </Link>{' '}
                        (индекс {pct(competition.topConcentration.hhi)})
                      </p>
                    )}
                  </div>
                )}
                <LensLink to={lens.href}>Виж {lens.title.toLowerCase()} →</LensLink>
              </article>
            ))}
          </div>
        </Section>
      </main>
    </>
  );
}
