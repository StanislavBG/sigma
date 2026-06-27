import { Link } from 'react-router';
import type { ContractListItem } from '@sigma/api-contract';
import { count, date, moneyBare } from '@sigma/shared';
import { listContracts } from '@sigma/db';
import type { Route } from './+types/latest';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

const FEED_SIZE = 30;

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/latest',
    title: 'Най-ново — СИГМА',
    description:
      'Обратнохронологичен поток на най-новите сключени договори по обществени поръчки. Има и RSS емисия за следене.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  // Page `Cache-Control` (publicCache) memoises the full response at the edge — no per-query cache.
  return withDbRetry(async () => {
    const result = await listContracts(env.DB, { sort: 'date-desc', pageSize: FEED_SIZE });
    return { items: result.items };
  });
}

export default function Latest({ loaderData }: Route.ComponentProps) {
  const { items } = loaderData;

  const columns: Column<ContractListItem>[] = [
    {
      key: 'date',
      header: 'Сключен',
      isTitle: true,
      cell: (c) => date(c.signedAt),
    },
    {
      key: 'parties',
      header: 'Възложител · Изпълнител',
      cell: (c) => (
        <>
          <span className="from">
            <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>{' '}
            <span className="who">възложител</span>
          </span>
          <span className="to">
            <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>{' '}
            <span className="who">изпълнител</span>
          </span>
        </>
      ),
    },
    {
      key: 'subject',
      header: 'Договор',
      secondary: true,
      cell: (c) => <Link to={`/contracts/${c.id}`}>{c.subject}</Link>,
    },
    {
      key: 'value',
      header: 'Стойност (€)',
      align: 'money',
      cell: (c) =>
        c.valueEur != null ? (
          moneyBare(c.valueEur)
        ) : (
          <span className="suspect">данните се проверяват</span>
        ),
    },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Най-ново' }]} />
      <main id="main">
        <PageHeader
          kicker="Поток"
          title="Най-ново"
          lede="Най-новите сключени договори по обществени поръчки, подредени от най-скорошния. Следете потока през RSS емисията, без регистрация."
        />

        <p className="muted">
          <a href="/latest.rss">RSS емисия</a> — абонирайте се, за да следите новите договори в своя
          четец.
        </p>

        {items.length === 0 ? (
          <Section id="feed" title="Най-нови договори">
            <p className="muted">
              Все още няма налични договори. Когато бъдат заредени данни, най-новите ще се появят
              тук.
            </p>
          </Section>
        ) : (
          <Section
            id="feed"
            title="Най-нови договори"
            hint={`Последните ${count(items.length)} сключени договора.`}
          >
            <DataTable
              columns={columns}
              rows={items}
              getKey={(c) => c.id}
              caption="Най-нови договори по обществени поръчки"
            />
          </Section>
        )}

        <Callout title="Какво е „договор“ в СИГМА">
          <p className="m-0">
            Един възложен договор по обществена поръчка, на ниво обособена позиция (лот).
            Стойностите са в евро — изчистена, съпоставима стойност на договора.
          </p>
        </Callout>
      </main>
    </>
  );
}
