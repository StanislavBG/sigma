import { Link } from 'react-router';
import { count, isNaturalPersonProfileName, money, pct, periodRange, plural } from '@sigma/shared';
import {
  NETWORK_GRAPH_DEFAULT,
  bidderIdFromSlug,
  getCompany,
  getEntityCounterparties,
  getEntityNetwork,
  getSpendingTrend,
} from '@sigma/db';
import type { Route } from './+types/company';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { DataTable } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { NetworkGraph } from '../components/NetworkGraph';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { MetricInfo } from '../components/MetricInfo';
import { ProfileCounterparties } from '../components/ProfileCounterparties';
import { Chip, OwnershipChip, Section, ExternalEikLink } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta } from '../lib/coverage';
import { networkColumns, networkRows, trendYearColumns } from '../lib/entity-tables';
import { NETWORK_SELECTION_MAX, PAGE_SIZE, networkSelection } from '../lib/filters';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

function isSingleNaturalPersonProfile(kind: string, legalForm: string | null): boolean {
  if (kind === 'consortium' || !legalForm) return false;
  const normalized = legalForm.trim().toUpperCase();
  return (
    normalized === 'ЕТ' ||
    normalized === 'ET' ||
    normalized.includes('ЕДНОЛИЧЕН ТЪРГОВЕЦ') ||
    normalized.includes('SOLE TRADER') ||
    normalized.includes('INDIVIDUAL')
  );
}

export function meta({ data, params, matches }: Route.MetaArgs) {
  const name = data?.company.displayName ?? 'Компания';
  const range = coverageRange(data?.coverage.coverageEndYear);
  const metaTags = seoMeta({
    matches,
    path: `/companies/${params.eik}`,
    title: `${name} — СИГМА`,
    description: `Профил на ${name} в обществените поръчки ${range}.`,
  });
  if (
    data?.company &&
    (isSingleNaturalPersonProfile(data.company.kind, data.company.legalForm) ||
      isNaturalPersonProfileName(data.company.displayName) ||
      (data.company.kind === 'consortium' && Boolean(data.company.membershipNote)))
  ) {
    metaTags.push({ name: 'robots', content: 'noindex' });
  }
  return metaTags;
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (!params.eik?.trim()) throw new Response('Not Found', { status: 404 });
  const id = bidderIdFromSlug(params.eik);
  if (!id) throw new Response('Not Found', { status: 404 });
  const db = context.cloudflare.env.DB;
  const sp = new URL(request.url).searchParams;
  // ?net — explicit graph membership picked from the counterparties table (authorities here).
  // Absent = the default top-6 by value, identical to the parameterless page.
  const selection = networkSelection(sp, 'authority');
  return withDbRetry(async () => {
    const [company, coverage, trend, network] = await Promise.all([
      getCompany(db, id),
      getCoverageMeta(db),
      getSpendingTrend(db, { bidderId: id, granularity: 'month' }, { includeSectors: false }),
      getEntityNetwork(
        db,
        { kind: 'company', id },
        {
          includeCenterOptions: false,
          neighbors: selection.ids.length ? selection.ids : undefined,
        },
      ),
    ]);
    if (!company) throw new Response('Not Found', { status: 404 });
    // Reuses the COUNT(*) getEntityNetwork already ran — one keyset page, no second identical scan.
    const counterparties = await getEntityCounterparties(
      db,
      { kind: 'company', id },
      { cursor: sp.get('cursor'), pageSize: PAGE_SIZE.profile, total: network.counterpartyTotal },
    );
    return { company, coverage, trend, network, counterparties, selection };
  });
}

export default function Company({ loaderData }: Route.ComponentProps) {
  const c = loaderData.company;
  const { trend, network } = loaderData;
  const range = coverageRange(loaderData.coverage.coverageEndYear);
  const noEikCompany = !c.isConsortium && !c.hasEik;
  const subjectPhrase = c.isConsortium ? 'това обединение' : 'тази компания';
  const wonVerb = c.isConsortium ? 'спечелило' : 'спечелила';
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: 'Компании', to: '/companies' },
          { label: c.displayName },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              {c.isConsortium ? 'Обединение' : 'Компания'}
              {noEikCompany && (
                <>
                  {' '}
                  · <Chip>без ЕИК</Chip>
                </>
              )}
              {c.ownershipKind && (
                <>
                  {' '}
                  · <OwnershipChip kind={c.ownershipKind} />
                </>
              )}
              {c.sector && (
                <>
                  {' '}
                  · <Chip>{c.sector.short}</Chip>
                </>
              )}
              {c.hasEik && c.eik && (
                <>
                  {' · '}ЕИК&nbsp;{c.eik}
                  <ExternalEikLink eik={c.eik} />
                </>
              )}
            </>
          }
          title={c.displayName}
          lede={`Колко публични средства е ${wonVerb} ${subjectPhrase} по обществени поръчки за периода ${range} г.`}
        />

        <FactsList
          label="Ключови показатели"
          rows={[
            { term: 'Общо спечелено', value: money(c.wonEur) },
            c.sector && {
              term: 'Основен сектор',
              value: `${c.sector.label} (CPV ${c.sector.code})`,
              sub: c.sectorSharePct != null ? `${pct(c.sectorSharePct)} от стойността` : undefined,
            },
            { term: 'Брой договори', value: count(c.contracts) },
            { term: 'Институции платци', value: count(c.authorities) },
            { term: 'Период', value: periodRange(c.periodFirst, c.periodLast) },
            { term: 'Дял с финансиране от ЕС', value: pct(c.euSharePct) },
            c.avgBids != null && {
              term: 'Средно оферти на търг',
              value: c.avgBids.toString().replace('.', ','),
            },
            {
              term: 'Вид субект',
              value: c.isConsortium ? 'обединение' : 'дружество',
              sub: c.isConsortium
                ? '(ДЗЗД / консорциум)'
                : noEikCompany
                  ? 'без ЕИК в източника'
                  : undefined,
            },
            c.settlement && { term: 'Седалище', value: c.settlement, sub: c.region ?? undefined },
            c.suspect > 0 && {
              term: 'Непотвърдена стойност',
              value: `${count(c.suspect)} ${plural(c.suspect, 'договор', 'договора')}`,
              sub: 'изключени от сумите — данните се проверяват',
            },
          ]}
        />

        <Section
          id="trend"
          title="Тренд"
          hint={`Спечеленото от ${c.displayName} във времето. Договорите без валидна дата не влизат в графиката.`}
        >
          {trend.points.length >= 2 ? (
            <>
              <TrendChart points={trend.points} granularity={trend.granularity} />
              <div className="mt-8">
                <DataTable
                  columns={trendYearColumns}
                  rows={trend.years}
                  getKey={(r) => r.year}
                  caption="Разходи по години"
                />
              </div>
            </>
          ) : (
            <p className="muted">Няма достатъчно данни за времева графика.</p>
          )}
        </Section>

        <Section
          id="network"
          title={
            <>
              Мрежа{' '}
              <MetricInfo
                title="Кой е в графа"
                summary={`По подразбиране графът показва топ ${NETWORK_GRAPH_DEFAULT} възложители по обща стойност. От таблицата „Откъде печели" по-долу можеш да сменяш състава — до ${NETWORK_SELECTION_MAX} едновременно.`}
              />
            </>
          }
          hint={
            <span>
              Най-силните преки връзки около {subjectPhrase} и по една следваща връзка за всеки
              възложител. <Link to={`/network?center=c:${c.slug}`}>Виж пълната мрежа →</Link>
            </span>
          }
        >
          {network.center && network.nodes.length >= 2 ? (
            <>
              <NetworkGraph data={network} />
              <div className="sr-only">
                <DataTable
                  columns={networkColumns}
                  rows={networkRows(network)}
                  getKey={(r) => `${r.from}-${r.to}`}
                  caption="Връзки в графа"
                />
              </div>
            </>
          ) : (
            <p className="muted">Няма достатъчно връзки за граф.</p>
          )}
        </Section>

        {/* Consortium membership. Shown only when the source row gave us something to break out
            (a `;`-list or the rare free-text dump). Plain companies and one-name "ИНТЕРБОЛГАРСТРОЙ
            ДЗЗД"-style rows skip the section — the kind=обединение badge above already says it.
            Per-member ЕИК / profile link is deliberately NOT surfaced even though `eik` /
            `resolvedSlug` are carried on the type — we don't have the data in v1 (parked on the
            Trade Register backfill), and labelling every row „ЕИК неустановен" turned into UI
            noise rather than information. When `resolvedSlug` lands the name will silently become
            a <Link>; until then we just show the names. */}
        {(c.participants.length > 0 || c.membershipNote) && (
          <Section
            id="participants"
            title={
              c.participants.length > 0
                ? `Участници в обединението (${count(c.participants.length)})`
                : 'Описание на обединението'
            }
            hint={
              c.participants.length > 0
                ? 'Имената са от описанието на договора в АОП. Сумите се водят на ниво обединение; отделни профили на участниците ще се появят след свързване с Търговския регистър.'
                : 'Източникът дава свободен текст вместо подреден списък с участници. Запазваме описанието както е в обявата.'
            }
          >
            {c.participants.length > 0 ? (
              <ol className="participants-list">
                {c.participants.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    {p.resolvedSlug ? (
                      // Already linked to a real company profile (post-TR resolution).
                      <Link to={`/companies/${p.resolvedSlug}`}>{p.name}</Link>
                    ) : (
                      p.name
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <blockquote className="empty-quote">{c.membershipNote}</blockquote>
            )}
          </Section>
        )}

        <Section
          id="from"
          title="Откъде печели"
          hint={`Институции, подредени по сумата, платена на ${c.displayName.replace(/\.$/, '')}. Отметката вляво определя кой е в графа „Мрежа" по-горе.`}
        >
          <ProfileCounterparties
            profileKind="company"
            page={loaderData.counterparties}
            pageSize={PAGE_SIZE.profile}
            totalEur={c.wonEur}
            selection={loaderData.selection.slugs}
            defaultSlugs={network.nodes.filter((n) => n.hop === 1).map((n) => n.slug)}
            entityHeader="Институция"
            valueHeader="Платено на компанията (€)"
            shareHeader="Дял от спечеленото"
          />
          <p className="small muted mt-s3">
            <Link to={`/contracts?bidder=${c.slug}`}>виж всички договори →</Link>
          </p>
        </Section>

        <div className="two-col">
          <Section
            id="how-win"
            title="Как печели"
            hint="Видът процедури, по които компанията е печелила договорите."
          >
            <StackedBar slices={c.procedureMix.filter((s) => s.sharePct >= 0.0005)} />
          </Section>

          <Section
            id="bids"
            title="Брой оферти на спечелените търгове"
            hint="Колко оферти е имало на спечелените от компанията търгове (там, където данните го показват)."
          >
            <table>
              <caption className="sr-only">Брой оферти на спечелените търгове</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Брой оферти</th>
                  <th scope="col">Брой търгове</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1 оферта</td>
                  <td className="money">{count(c.bids.one)} търга</td>
                </tr>
                <tr>
                  <td>2 оферти</td>
                  <td className="money">{count(c.bids.two)} търга</td>
                </tr>
                <tr>
                  <td>3 оферти</td>
                  <td className="money">{count(c.bids.three)} търга</td>
                </tr>
                <tr>
                  <td>4 и повече оферти</td>
                  <td className="money">{count(c.bids.fourPlus)} търга</td>
                </tr>
                {c.bids.unknown > 0 && (
                  <tr>
                    <td className="muted">няма данни</td>
                    <td className="money muted">{count(c.bids.unknown)} търга</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>
        </div>

        <Section
          id="latest"
          title="Договори"
          hint={
            <span>
              {Math.min(Math.max(c.recentContracts.length, c.topContracts.length), 7)} от{' '}
              {count(c.contracts)} {plural(c.contracts, 'договор', 'договора')} — превключи между
              най-новите и най-големите по стойност.
            </span>
          }
        >
          <div className="tabset" role="radiogroup" aria-label="Подреждане на договорите">
            <input
              type="radio"
              name="company-contracts"
              id="company-recent"
              className="tab-input"
              defaultChecked
            />
            <input type="radio" name="company-contracts" id="company-top" className="tab-input" />
            <div className="tab-labels">
              <label id="tab-company-recent" htmlFor="company-recent">
                Най-нови
              </label>
              <label id="tab-company-top" htmlFor="company-top">
                Най-големи по стойност
              </label>
            </div>
            <div
              className="tab-panel"
              data-tab="recent"
              role="group"
              aria-labelledby="tab-company-recent"
            >
              <ContractMiniTable items={c.recentContracts} counterparty="authority" />
            </div>
            <div
              className="tab-panel"
              data-tab="top"
              role="group"
              aria-labelledby="tab-company-top"
            >
              <ContractMiniTable items={c.topContracts} counterparty="authority" />
            </div>
          </div>
          <p className="small muted mt-8">
            <Link to={`/contracts?bidder=${c.slug}`}>
              Виж всички / филтрирай / свали като CSV →
            </Link>
          </p>
        </Section>
      </main>
    </>
  );
}
