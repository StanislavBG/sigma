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
      'Шест аналитични изгледа към обществените поръчки: раздуване на стойността, потоци, карта, тренд, конкуренция и сравнение — всеки води обратно към конкретните договори.',
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
        <p className="kicker info overruns-hero-kicker">Анализ · Акцент</p>
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
                <span className="lens-value lens-value-accent">+{money(c.deltaEur)}</span>
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
          lede="Шест начина да проследиш едни и същи обществени поръчки: раздуване на стойността след сключване, движение на парите, карта, времева линия, сигнал за слаба конкуренция и сравнение между институции."
        />

        <Section
          id="lenses"
          title="Изгледи"
          hint="Всеки изглед отговаря на различен въпрос, но всички водят обратно към конкретните договори."
        >
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
