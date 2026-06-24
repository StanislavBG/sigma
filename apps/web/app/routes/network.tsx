import { Link, useNavigate, useNavigation } from 'react-router';
import { count, money } from '@sigma/shared';
import {
  authorityIdFromSlug,
  bidderIdFromSlug,
  getEntityNetwork,
  MAX_CENTERS,
  type NetworkParams,
} from '@sigma/db';
import type { NetworkCenter } from '@sigma/api-contract';
import type { Route } from './+types/network';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { NetworkGraph } from '../components/NetworkGraph';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Мрежа на връзките — СИГМА' },
    {
      name: 'description',
      content:
        'Мрежата от връзки около една институция или фирма: преките контрагенти и техните следващи връзки, които разкриват клъстери. Изцяло върху наличните данни.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

// One focus token: a:<authority-slug> | c:<company-slug>.
function parseCenterToken(token: string): NetworkParams | null {
  const i = token.indexOf(':');
  if (i < 1) return null;
  const kind = token.slice(0, i);
  const slug = token.slice(i + 1);
  if (kind === 'a' && slug) return { kind: 'authority', id: authorityIdFromSlug(slug) };
  if (kind === 'c' && slug) {
    const id = bidderIdFromSlug(slug);
    return id ? { kind: 'company', id } : null;
  }
  return null;
}

// ?center accepts a comma-separated focus list (a:… , c:…). Empty/malformed → biggest authority.
function parseCenters(raw: string | null): NetworkParams[] {
  if (!raw) return [];
  const out: NetworkParams[] = [];
  const seen = new Set<string>();
  for (const tok of raw.split(',')) {
    const p = parseCenterToken(tok.trim());
    if (!p) continue;
    const k = `${p.kind}:${p.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.slice(0, MAX_CENTERS);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = parseCenters(new URL(request.url).searchParams.get('center'));
  const data = await getEntityNetwork(context.cloudflare.env.DB, params.length ? params : null);
  // A well-formed but non-existent ?center should 404 like the other entity pages, not render an
  // empty 200 that then gets edge-cached. A missing or malformed ?center keeps the default centre.
  if (params.length && !data.center) {
    throw new Response('Not Found', { status: 404 });
  }
  return { data };
}

// The ?center token for a focus entity — the same grammar the loader parses and node clicks build.
export function centerToken(c: Pick<NetworkCenter, 'kind' | 'slug'>): string {
  return `${c.kind === 'authority' ? 'a' : 'c'}:${c.slug}`;
}

// Build the /network href for a focus-token list (empty → default view).
export function centersHref(tokens: string[]): string {
  return tokens.length ? `/network?center=${tokens.join(',')}` : '/network';
}

interface LinkRow {
  from: string;
  to: string;
  valueEur: number;
  contracts: number;
}

export default function Network({ loaderData }: Route.ComponentProps) {
  const { data } = loaderData;
  const navigate = useNavigate();
  const navigating = useNavigation().state !== 'idle';
  // Current focus list as ?center tokens; node clicks, chips and the picker add to / remove from it.
  const tokens = data.centers.map(centerToken);
  const atCapacity = tokens.length >= MAX_CENTERS;
  // Append a focus (dropping the oldest once at the cap, so the picker always adds something).
  const addFocus = (value: string) => {
    if (!value || tokens.includes(value)) return;
    navigate(centersHref([...tokens, value].slice(-MAX_CENTERS)));
  };
  const focusLabel =
    data.centers.length <= 1
      ? (data.center?.label ?? '')
      : `${data.centers
          .slice(0, -1)
          .map((c) => c.label)
          .join(', ')} и ${data.centers[data.centers.length - 1].label}`;

  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  // Normalise each row to the real procurement direction (authority -> company), regardless of how the
  // edge is oriented in the graph topology: the institution awards and pays the company, never the
  // reverse. Every edge connects one authority and one company.
  const rows: LinkRow[] = data.edges.map((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    const authority = a?.kind === 'authority' ? a : b;
    const company = a?.kind === 'authority' ? b : a;
    return {
      from: authority?.label ?? e.from,
      to: company?.label ?? e.to,
      valueEur: e.valueEur,
      contracts: e.contracts,
    };
  });
  const columns: Column<LinkRow>[] = [
    { key: 'from', header: 'От', isTitle: true, cell: (r) => r.from },
    { key: 'to', header: 'Към', cell: (r) => r.to },
    { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
    {
      key: 'contracts',
      header: 'Договори',
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts),
    },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Мрежа на връзките' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Мрежа на връзките"
          lede="Връзките около една институция или фирма: преките ѝ контрагенти и техните следващи връзки. Откроява клъстери, които общата схема на потоците не показва. Това е фокусирана околност, не целият граф."
        />

        <div className="flow-controls" role="group" aria-label="Фокус на графа">
          <label>
            Добави фокус:
            <select
              value=""
              onChange={(e) => addFocus(e.currentTarget.value)}
              disabled={navigating}
            >
              <option value="" disabled>
                Избери институция или фирма…
              </option>
              <optgroup label="Институции">
                {data.centerOptions.authorities.map((o) => (
                  <option key={o.value} value={o.value} disabled={tokens.includes(o.value)}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Компании">
                {data.centerOptions.companies.map((o) => (
                  <option key={o.value} value={o.value} disabled={tokens.includes(o.value)}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          {data.centers.length > 0 && (
            <ul className="focus-chips" aria-label="Текущ фокус">
              {data.centers.map((c) => {
                const tok = centerToken(c);
                const rest = tokens.filter((t) => t !== tok);
                return (
                  <li key={tok}>
                    <span className={`chip-dot ${c.kind}`} aria-hidden="true" />
                    {c.label}
                    <Link
                      className="chip-remove"
                      to={centersHref(rest)}
                      aria-label={`Премахни фокус ${c.label}`}
                    >
                      ×
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="focus-hint">
            {atCapacity
              ? `Максимум ${MAX_CENTERS} фокуса — нов клик измества най-стария.`
              : `Клик върху възел в графа добавя фокус (до ${MAX_CENTERS}).`}
          </p>
        </div>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {data.center && data.nodes.length >= 2 ? (
          <>
            <Section
              id="graph"
              title={
                <>
                  Връзки около <em>{focusLabel}</em>
                </>
              }
              hint="Цветовете различават фокус, институции и фирми. Дебелината на връзката е стойността. Клик върху възел го добавя/маха като фокус (до 3)."
            >
              <NetworkGraph data={data} centerTokens={tokens} maxCenters={MAX_CENTERS} />
            </Section>

            <Section id="links" title="Връзки в графа">
              <DataTable
                columns={columns}
                rows={rows}
                getKey={(r) => `${r.from}-${r.to}`}
                caption="Връзки в графа"
              />
            </Section>
          </>
        ) : (
          <Callout variant="warning" title="Няма достатъчно връзки">
            <p style={{ margin: 0 }}>
              За избраната същност няма достатъчно връзки за граф. Изберете друга от менюто.
            </p>
          </Callout>
        )}

        <Callout title="Какво показва">
          <p style={{ margin: 0 }}>
            Преките контрагенти на избраната същност и техните най-големи други връзки. Пълният граф
            не се показва; за общата картина виж <Link to="/flows">потоците</Link>.
          </p>
        </Callout>
      </main>
    </>
  );
}
