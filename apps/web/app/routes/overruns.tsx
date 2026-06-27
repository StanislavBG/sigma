import { Link, useSearchParams } from 'react-router';
import { count, money, signedPct } from '@sigma/shared';
import { getTopOverruns, type OverrunRow } from '@sigma/db';
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
      'Кои договори се раздуха най-много след подписването чрез анекси. Класация по абсолютно и процентно нарастване, всеки лев проследим до конкретния договор.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const by = new URL(request.url).searchParams.get('by') === 'percent' ? 'percent' : 'absolute';
  const { env } = context.cloudflare;
  return withDbRetry(async () => {
    const data = await getTopOverruns(env.DB, { by });
    return { data, by };
  });
}

const columns: Column<OverrunRow>[] = [
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

export default function Overruns({ loaderData }: Route.ComponentProps) {
  const { data, by } = loaderData;
  const [sp] = useSearchParams();

  const totals: Total[] = [
    { num: money(data.totalOverrunEur), label: 'общо раздуване след подписване' },
    { num: count(data.count), label: 'договора с нараснала стойност' },
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
          lede="Кои договори по обществени поръчки се раздуха най-много, след като вече бяха подписани — чрез последващи анекси. Сравняваме стойността при сключване със сегашната стойност и подреждаме по най-голямото нарастване. Това е описателен показател, не присъда: зад всеки лев стои конкретният договор."
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

          {data.rows.length ? (
            <DataTable
              columns={columns}
              rows={data.rows}
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

        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          Раздуването е разликата между сегашната стойност и стойността при сключване, само за
          договори с поне един анекс и потвърдени стойности. Виж{' '}
          <Link to="/methodology#glossary">методологията</Link> за дефинициите.
        </p>
      </main>
    </>
  );
}
