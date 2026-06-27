import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import type { ContractListItem, TrendYear } from '@sigma/api-contract';
import { count, date, money, pct, signedPct } from '@sigma/shared';
import { CPV_SECTORS } from '@sigma/config';
import { getSpendingTrend, listContracts } from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Тренд във времето — СИГМА' },
    {
      name: 'description',
      content:
        'Как се движат разходите за обществени поръчки във времето, по месеци и години, със сезонните пикове. Изцяло върху наличните данни.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sector = sp.get('sector');
  const granularity = sp.get('g') === 'year' ? 'year' : 'month';
  const db = context.cloudflare.env.DB;
  // A bogus ?sector would silently empty the chart; flag it and ignore it instead.
  const unknownSector = Boolean(sector) && !CPV_SECTORS.some((s) => s.code === sector);
  const validSector = unknownSector ? null : sector;
  const funding = (sp.get('funding') as 'eu' | 'national' | null) || 'all';
  const [data, latest] = await Promise.all([
    getSpendingTrend(db, { sector: validSector, funding, granularity }),
    // The newest contracts behind the curve — the "what just landed" tail of the time series. Respects
    // the page's sector/funding filters so it stays coherent with the chart above.
    listContracts(db, {
      sort: 'date-desc',
      sectors: validSector ? [validSector] : [],
      eu: funding === 'all' ? null : funding,
      pageSize: 12,
    }),
  ]);
  return { data, unknownSector, latest: latest.items };
}

export default function Trends({ loaderData }: Route.ComponentProps) {
  const { data, unknownSector, latest } = loaderData;
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  const yearColumns: Column<TrendYear>[] = [
    {
      key: 'year',
      header: 'Година',
      isTitle: true,
      cell: (r) => (
        <>
          {r.year}
          {r.partial && <span className="muted"> (частично)</span>}
        </>
      ),
    },
    { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
    { key: 'contracts', header: 'Договори', align: 'num', cell: (r) => count(r.contracts) },
    {
      key: 'yoy',
      header: 'Спрямо предходната',
      align: 'num',
      cell: (r) => (r.yoyPct == null ? '' : signedPct(r.yoyPct)),
    },
  ];

  const latestColumns: Column<ContractListItem>[] = [
    {
      key: 'signedAt',
      header: 'Сключен',
      isTitle: true,
      cell: (r) => <Link to={`/contracts/${r.id}`}>{r.signedAt ? date(r.signedAt) : '—'}</Link>,
    },
    {
      key: 'parties',
      header: 'Възложител → Изпълнител',
      cell: (r) => (
        <>
          <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>
          {' → '}
          <Link to={`/companies/${r.bidderSlug}`}>{r.bidderDisplayName}</Link>
        </>
      ),
    },
    {
      key: 'value',
      header: 'Стойност',
      align: 'money',
      cell: (r) => (r.valueEur != null ? money(r.valueEur) : 'непотвърдена'),
    },
  ];

  // Carry the active sector/funding filters onto the RSS feed so "subscribe" matches what's shown.
  const rssParams = new URLSearchParams();
  if (sp.get('sector') && !unknownSector) rssParams.set('sector', sp.get('sector')!);
  if (sp.get('funding')) rssParams.set('funding', sp.get('funding')!);
  const rssHref = `/trends.rss${rssParams.toString() ? `?${rssParams}` : ''}`;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Тренд във времето' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Тренд във времето"
          lede="Как се движат разходите за обществени поръчки през годините. Месечната графика показва обема и типичните пикове в края на годината. Договорите без валидна дата на сключване не влизат в графиката."
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label="Филтри на тренда"
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            Стъпка:
            <select name="g" defaultValue={sel('g')}>
              <option value="">Месечно</option>
              <option value="year">Годишно</option>
            </select>
          </label>
          <label>
            Сектор:
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">Всички сектори</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            Финансиране:
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

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {unknownSector && (
          <Callout variant="warning" title="Непознат филтър">
            <p style={{ margin: 0 }}>Избраният сектор не съществува. Показваме всички сектори.</p>
          </Callout>
        )}

        <Section
          id="chart"
          title={`Разходи по ${data.granularity === 'year' ? 'години' : 'месеци'}`}
          hint={`Общо ${money(data.totalValueEur)} за периода.`}
        >
          {data.points.length >= 2 ? (
            <TrendChart points={data.points} granularity={data.granularity} />
          ) : (
            <p className="muted">Няма достатъчно данни за избраните филтри.</p>
          )}
        </Section>

        <Section
          id="years"
          title="По години"
          hint="Сумарно за всяка година и промяната спрямо предходната."
        >
          <DataTable
            columns={yearColumns}
            rows={data.years}
            getKey={(r) => r.year}
            caption="Разходи по години"
          />
        </Section>

        <Section
          id="latest"
          title="Най-нови договори"
          hint={
            <>
              Последно сключените договори за избрания срез — върхът на кривата. Следете ги без
              профил през <a href={rssHref}>RSS емисията</a>.
            </>
          }
        >
          {latest.length > 0 ? (
            <DataTable
              columns={latestColumns}
              rows={latest}
              getKey={(r) => r.id}
              caption="Най-нови договори"
            />
          ) : (
            <p className="muted">Няма договори за избрания срез.</p>
          )}
        </Section>

        <Callout title="За покритието на данните">
          <p style={{ margin: 0 }}>
            Графиката включва договорите с валидна дата на сключване ({pct(data.coverage.pct)} от
            тях). Последният период е непълен и е отбелязан като „частично". Виж методологията за
            подробности.
          </p>
        </Callout>
      </main>
    </>
  );
}
