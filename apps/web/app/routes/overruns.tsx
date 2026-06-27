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
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

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

// Leaderboard of the most-ballooned individual contracts (absolute / percent toggle).
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

// „Кой системно подписва ниско и после раздува“ — authorities by total overrun €.
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
  {
    key: 'count',
    header: 'Договори',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.count),
  },
];

// Which CPV sectors inflate most.
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
  {
    key: 'count',
    header: 'Договори',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.count),
  },
];

// Overrun € by signing year — the trend.
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

export default function Overruns({ loaderData }: Route.ComponentProps) {
  const { data, by } = loaderData;
  const { corpus, rows, byAuthority, bySector, byYear } = data;
  const [sp] = useSearchParams();

  const totals: Total[] = [
    { num: money(corpus.totalOverrunEur), label: 'общо раздуване след подписване' },
    { num: count(corpus.count), label: 'договора с нараснала стойност' },
    { num: corpus.count ? signedPct(corpus.medianPct) : '—', label: 'медианно раздуване' },
    { num: corpus.count ? signedPct(corpus.avgPct) : '—', label: 'средно раздуване' },
    {
      num: corpus.corpusSigningEur > 0 ? pct(corpus.shareOfSigning) : '—',
      label: 'дял от стойността при сключване',
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
          kicker="Анализ"
          title="Раздуване на договорите"
          lede="Кои договори по обществени поръчки се раздуха най-много, след като вече бяха подписани — чрез последващи анекси. Сравняваме стойността при сключване със сегашната стойност и подреждаме по най-голямото нарастване — по договори, по институции, по сектори и по години. Това е описателен показател, не присъда: зад всеки лев стои конкретният договор."
        />

        <TotalsStrip totals={totals} label="Обобщение на раздуването" />

        <Section
          id="leaderboard"
          title={
            <>
              Най-голямо <em>раздуване</em> на стойността
            </>
          }
          hint="Договори, чиято стойност след анекси надхвърля стойността при сключване. Подредени по абсолютно или по процентно нарастване."
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
          </div>

          {rows.length ? (
            <DataTable
              columns={contractColumns}
              rows={rows}
              getKey={(r) => r.contractId}
              caption="Договори, подредени по нарастване на стойността след подписване"
            />
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
          hint="Обща сума на раздуването по година на сключване на договора. Договори без разпознаваема дата на сключване попадат в „Неизвестна“."
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
              <p className="m-0">Все още няма раздути договори с разпознаваема година в данните.</p>
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
