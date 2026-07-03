import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, moneyBare } from '@sigma/shared';
import type { NetworkCounterpartyPage } from '@sigma/api-contract';
import { NETWORK_GRAPH_DEFAULT } from '@sigma/db';
import { Pagination } from './Pagination';
import { ShareBar, Chip } from './ui';
import { NETWORK_SELECTION_MAX, pageNav, withParams } from '../lib/filters';

// The entity profiles' counterparties table (authority „Топ изпълнители" / company „Откъде печели"),
// backed by the keyset-paginated flow_pairs query so EVERY counterparty is reachable — and doubling
// as the picker for the embedded „Мрежа" graph: each row carries a checkbox-style GET link (the
// cross-lens CPV picker idiom) that swaps the counterparty in or out of the graph via the repeatable
// `?net=<slug>` param. No ?net = the default top-NETWORK_GRAPH_DEFAULT by value (identical to the
// pre-picker page); an explicit selection is capped at NETWORK_SELECTION_MAX. All links are GET +
// preventScrollReset so selecting/paging never jumps the viewport.
export function ProfileCounterparties({
  profileKind,
  page,
  pageSize,
  totalEur,
  selection,
  defaultSlugs,
  warnShare,
  entityHeader,
  valueHeader,
  shareHeader,
}: {
  profileKind: 'authority' | 'company'; // the PROFILE's kind; rows toggle the opposite kind
  page: NetworkCounterpartyPage;
  pageSize: number;
  totalEur: number; // share denominator (authority: spentEur; company: wonEur)
  selection: string[]; // explicit ?net slugs (canonically sorted); empty = default top-6
  defaultSlugs: string[]; // the hop-1 slugs currently drawn when ?net is absent
  warnShare?: boolean; // authority profile flags ≥80% concentration
  entityHeader: string;
  valueHeader: string;
  shareHeader: string;
}) {
  const [sp] = useSearchParams();
  const navigating = useNavigation().state !== 'idle';
  const inGraph = selection.length > 0 ? selection : defaultSlugs;
  const inGraphSet = new Set(inGraph);
  const full = inGraph.length >= NETWORK_SELECTION_MAX;
  const nav = pageNav({
    base: sp,
    total: page.total,
    pageSize,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
  });
  const rankOffset = (nav.page - 1) * pageSize;

  // Toggling writes the WHOLE membership into ?net (sorted → one canonical URL per set). Removing
  // the last explicit slug drops the param entirely — back to the default top-6 view. Selection is
  // independent of the pager, so cursor/page are preserved and the viewport stays put.
  const toggleHref = (slug: string): string => {
    const next = inGraphSet.has(slug) ? inGraph.filter((s) => s !== slug) : [...inGraph, slug];
    return withParams(sp, { net: next.length ? [...next].sort() : null });
  };

  return (
    <>
      <p className="sr-only" role="status">
        {navigating
          ? 'Обновяване на данните…'
          : `В графа са избрани ${count(inGraph.length)} контрагенти. Страница ${count(nav.page)} от ${count(nav.pageCount)}.`}
      </p>
      {(selection.length > 0 || full) && (
        <p className="net-pick-bar small">
          {selection.length > 0 && (
            <Link className="net-reset-chip" to={withParams(sp, { net: null })} preventScrollReset>
              ↺ върни топ {NETWORK_GRAPH_DEFAULT}
            </Link>
          )}
          {full && (
            <span className="muted">
              Графът е пълен ({NETWORK_SELECTION_MAX}) — премахни един, за да добавиш друг.
            </span>
          )}
        </p>
      )}
      <div className="table-wrap tbl-cards tbl-roomy">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">В графа</span>
              </th>
              <th scope="col">#</th>
              <th scope="col">{entityHeader}</th>
              <th scope="col" className="num">
                {valueHeader}
              </th>
              <th scope="col" className="num">
                Договори
              </th>
              <th scope="col">{shareHeader}</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((r, i) => {
              const isCompanyRow = profileKind === 'authority';
              const slug = isCompanyRow ? r.companySlug : r.authoritySlug;
              const label = isCompanyRow ? r.companyLabel : r.authorityLabel;
              const href = isCompanyRow ? `/companies/${slug}` : `/authorities/${slug}`;
              const picked = inGraphSet.has(slug);
              const blocked = !picked && full;
              const share = totalEur > 0 ? r.valueEur / totalEur : 0;
              return (
                <tr key={slug} className={picked ? 'is-picked' : undefined}>
                  <td className="cell-pick" data-label="В графа">
                    {blocked ? (
                      <span
                        className="net-pick is-blocked"
                        title="Графът е пълен — премахни един, за да добавиш друг."
                        aria-hidden="true"
                      />
                    ) : (
                      <Link
                        className={`net-pick${picked ? ' is-on' : ''}`}
                        to={toggleHref(slug)}
                        preventScrollReset
                        aria-label={
                          picked ? `Премахни ${label} от графа` : `Добави ${label} в графа`
                        }
                      >
                        <span aria-hidden="true">{picked ? '✓' : ''}</span>
                      </Link>
                    )}
                  </td>
                  <td className="rank cell-rank" data-label="#">
                    {rankOffset + i + 1}
                  </td>
                  <td className="cell-title" data-label={entityHeader}>
                    <Link to={href}>{label}</Link>
                    {isCompanyRow && r.companyKind === 'consortium' && (
                      <>
                        {' '}
                        <Chip>обединение</Chip>
                      </>
                    )}
                  </td>
                  <td className="money" data-label={valueHeader}>
                    {moneyBare(r.valueEur)}
                  </td>
                  <td className="money" data-label="Договори">
                    {count(r.contracts)}
                  </td>
                  <td data-label="Дял">
                    <ShareBar ratio={share} warn={warnShare ? share >= 0.8 : undefined} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {page.total > pageSize && <Pagination nav={nav} pageSize={pageSize} />}
    </>
  );
}
