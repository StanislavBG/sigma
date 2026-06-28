import { Form, Link, useSubmit } from 'react-router';
import { count, money, moneyBare, pct } from '@sigma/shared';
import type { AuthorityDetail, CompanyDetail } from '@sigma/api-contract';
import {
  authorityIdFromSlug,
  authoritySlug,
  bidderIdFromSlug,
  companySlug,
  getAuthority,
  getCompany,
  getCompareLeaderboard,
  normalizeLeaderboardMetric,
  type CompareLeaderboard,
  type LeaderboardMetric,
} from '@sigma/db';
import type { Route } from './+types/compare';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Callout, Chip, Flag, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import {
  buildComparisonRows,
  normalizeAuthority,
  normalizeCompany,
  type CompareEntity,
  type CompareKind,
  type ComparisonRow,
  type MetricFormat,
} from '../lib/compare';

type Detail = AuthorityDetail | CompanyDetail;

const KIND_LABEL: Record<CompareKind, { one: string; many: string }> = {
  authority: { one: 'институция', many: 'институции' },
  company: { one: 'компания', many: 'компании' },
};

// The leaderboard dimensions. `reach` and `eu` labels flip by kind (suppliers↔clients).
const METRIC_LABEL: Record<LeaderboardMetric, { label: string; hint: (k: CompareKind) => string }> =
  {
    total: { label: 'Общо €', hint: (k) => (k === 'authority' ? 'похарчено' : 'спечелено') },
    avg: { label: 'Среден договор', hint: () => 'средна стойност на договор' },
    reach: {
      label: 'Контрагенти',
      hint: (k) => (k === 'authority' ? 'различни изпълнители' : 'различни възложители'),
    },
    eu: { label: 'Дял ЕС', hint: () => 'дял от стойността с финансиране от ЕС' },
  };
const METRIC_ORDER: LeaderboardMetric[] = ['total', 'avg', 'reach', 'eu'];

function fmtMetric(metric: LeaderboardMetric, v: number): string {
  if (metric === 'eu') return pct(v);
  if (metric === 'reach') return count(v);
  return money(v);
}

function parseKind(raw: string | null): CompareKind {
  return raw === 'company' ? 'company' : 'authority';
}

export function meta({ data, matches }: Route.MetaArgs) {
  const kind = data?.kind ?? 'authority';
  const names = [data?.a, data?.b]
    .map((d) => (d ? entityName(kind, d) : null))
    .filter(Boolean) as string[];
  const title = names.length === 2 ? `${names[0]} срещу ${names[1]} — СИГМА` : 'Сравнение — СИГМА';
  return seoMeta({
    matches,
    path: '/compare',
    title,
    description:
      'Сравнете две институции или две компании едно до друго по общи показатели за обществените поръчки. Сравнението живее в адреса — споделя се с линк.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const kind = parseKind(sp.get('kind'));
  const aSlug = sp.get('a')?.trim() || null;
  const bSlug = sp.get('b')?.trim() || null;
  const db = context.cloudflare.env.DB;

  async function resolve(slug: string | null): Promise<Detail | null> {
    if (!slug) return null;
    if (kind === 'authority') return getAuthority(db, authorityIdFromSlug(slug));
    const id = bidderIdFromSlug(slug);
    return id ? getCompany(db, id) : null;
  }

  // Landing on bare /compare with an empty picker doesn't show what the tool does. Bootstrap a real
  // example — the two biggest entities by value — so the page renders a meaningful comparison on first
  // load; the picker stays below to swap in your own. Real rows only (never a fabricated pair).
  async function defaultExamplePair(): Promise<{ a: string; b: string } | null> {
    const sql =
      kind === 'company'
        ? 'SELECT bidder_id AS id FROM company_totals ORDER BY won_eur DESC, bidder_id LIMIT 2'
        : 'SELECT authority_id AS id FROM authority_totals ORDER BY spent_eur DESC, authority_id LIMIT 2';
    const { results } = await db.prepare(sql).all<{ id: string }>();
    if (results.length < 2) return null;
    const toSlug = kind === 'company' ? companySlug : authoritySlug;
    return { a: toSlug(results[0].id), b: toSlug(results[1].id) };
  }

  const metric = normalizeLeaderboardMetric(sp.get('metric'));
  const idOf = (slug: string | null): string | null =>
    !slug ? null : kind === 'authority' ? authorityIdFromSlug(slug) : bidderIdFromSlug(slug);

  return withDbRetry(async () => {
    let aS = aSlug;
    let bS = bSlug;
    let isExample = false;
    if (!aSlug && !bSlug) {
      const ex = await defaultExamplePair();
      if (ex) {
        aS = ex.a;
        bS = ex.b;
        isExample = true;
      }
    }
    const highlightIds = [idOf(aS), idOf(bS)].filter((x): x is string => x != null);
    const [a, b, leaderboard] = await Promise.all([
      resolve(aS),
      resolve(bS),
      getCompareLeaderboard(db, { kind, metric, highlightIds }),
    ]);
    return { kind, aSlug: aS, bSlug: bS, a, b, isExample, metric, leaderboard };
  });
}

function entityName(kind: CompareKind, d: Detail): string {
  return kind === 'authority' ? (d as AuthorityDetail).name : (d as CompanyDetail).displayName;
}

function toEntity(kind: CompareKind, d: Detail | null): CompareEntity | null {
  if (!d) return null;
  return kind === 'authority'
    ? normalizeAuthority(d as AuthorityDetail)
    : normalizeCompany(d as CompanyDetail);
}

function formatMetric(format: MetricFormat, value: number | null): string {
  if (value == null) return '—';
  switch (format) {
    case 'money':
      return money(value);
    case 'count':
      return count(value);
    case 'pct':
      return pct(value);
    case 'bids':
      // One decimal, comma as in the rest of the UI (e.g. „2,1").
      return (Math.round(value * 10) / 10).toString().replace('.', ',');
  }
}

function entityHref(kind: CompareKind, slug: string): string {
  return kind === 'authority' ? `/authorities/${slug}` : `/companies/${slug}`;
}

function MetricCell({
  row,
  side,
  better,
}: {
  row: ComparisonRow;
  side: 'a' | 'b';
  better: boolean;
}) {
  const value = side === 'a' ? row.a : row.b;
  return (
    <td className="money" data-label={side === 'a' ? 'A' : 'B'}>
      {better ? (
        <strong>{formatMetric(row.format, value)}</strong>
      ) : (
        formatMetric(row.format, value)
      )}
      {better && (
        <>
          {' '}
          <Flag variant="info">по-добре</Flag>
        </>
      )}
    </td>
  );
}

function SectorList({ entity }: { entity: CompareEntity }) {
  if (entity.sectors.length === 0) return <p className="muted">няма данни за сектори</p>;
  return (
    <ul className="plain">
      {entity.sectors.map((s) => (
        <li key={s.short}>
          {s.short} <span className="muted">({pct(s.sharePct)})</span>
        </li>
      ))}
    </ul>
  );
}

function Picker({
  kind,
  aSlug,
  bSlug,
  aMissing,
  bMissing,
}: {
  kind: CompareKind;
  aSlug: string | null;
  bSlug: string | null;
  aMissing: boolean;
  bMissing: boolean;
}) {
  const labels = KIND_LABEL[kind];
  const hint =
    kind === 'authority'
      ? 'Идентификаторът е ЕИК-то от адреса на профила, напр. /authorities/000695089 → 000695089.'
      : 'Идентификаторът е частта след /companies/ от адреса на профила.';
  return (
    <Section
      id="picker"
      title="Изберете какво да сравните"
      hint={`Въведете два идентификатора (slug) от адресите на две ${labels.many} и сравнете ги едно до друго. Сравнението се запазва в адреса — можете да го споделите с линк.`}
    >
      {(aMissing || bMissing) && (
        <p className="muted">
          {aMissing && bMissing
            ? `И двата идентификатора са невалидни или не съответстват на ${labels.many}.`
            : `Единият идентификатор е невалиден или не съответства на ${labels.one}. Проверете го по-долу.`}
        </p>
      )}
      <form method="get" action="/compare" className="compare-picker">
        <fieldset>
          <legend className="sr-only">Вид субект</legend>
          <label>
            <input
              type="radio"
              name="kind"
              value="authority"
              defaultChecked={kind === 'authority'}
            />{' '}
            Институции
          </label>{' '}
          <label>
            <input type="radio" name="kind" value="company" defaultChecked={kind === 'company'} />{' '}
            Компании
          </label>
        </fieldset>
        <p>
          <label htmlFor="cmp-a">Идентификатор A</label>
          <br />
          <input id="cmp-a" type="text" name="a" defaultValue={aSlug ?? ''} autoComplete="off" />
        </p>
        <p>
          <label htmlFor="cmp-b">Идентификатор B</label>
          <br />
          <input id="cmp-b" type="text" name="b" defaultValue={bSlug ?? ''} autoComplete="off" />
        </p>
        <p className="small muted">{hint}</p>
        <p>
          <button type="submit">Сравни</button>
        </p>
      </form>
    </Section>
  );
}

function Leaderboard({
  kind,
  metric,
  board,
  aSlug,
  bSlug,
}: {
  kind: CompareKind;
  metric: LeaderboardMetric;
  board: CompareLeaderboard;
  aSlug: string | null;
  bSlug: string | null;
}) {
  const submit = useSubmit();
  const labels = KIND_LABEL[kind];
  const href = (slug: string) =>
    kind === 'authority' ? `/authorities/${slug}` : `/companies/${slug}`;
  const max = Math.max(1, board.maxValue);
  const bar = (value: number, highlighted: boolean) => (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: `${Math.max(2, Math.round((value / max) * 72))}px`,
        height: '8px',
        borderRadius: '2px',
        background: highlighted ? 'var(--accent)' : 'var(--ink-mid)',
      }}
    />
  );

  return (
    <Section
      id="leaderboard"
      title={
        <>
          Класация · <Chip>{METRIC_LABEL[metric].label}</Chip>
        </>
      }
      hint={`${count(board.qualifying)} ${labels.many}, подредени по ${METRIC_LABEL[metric].hint(
        kind,
      )}. Избраните за сравнение са откроени. Средните стойности броят само същности с поне 5 договора.`}
    >
      <Form
        method="get"
        className="flow-controls"
        role="group"
        aria-label="Подреждане на класацията"
        onChange={(e) => submit(e.currentTarget)}
      >
        {aSlug && <input type="hidden" name="a" value={aSlug} />}
        {bSlug && <input type="hidden" name="b" value={bSlug} />}
        <label>
          Вид:
          <select name="kind" defaultValue={kind}>
            <option value="authority">Институции</option>
            <option value="company">Компании</option>
          </select>
        </label>
        <label>
          Подреди по:
          <select name="metric" defaultValue={metric}>
            {METRIC_ORDER.map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m].label}
              </option>
            ))}
          </select>
        </label>
      </Form>

      {board.pinned.length > 0 && (
        <p className="muted" style={{ marginTop: 0 }}>
          Къде стоят избраните:{' '}
          {board.pinned.map((p, i) => (
            <span key={p.slug}>
              {i > 0 && ' · '}
              <Link to={href(p.slug)}>{p.name}</Link>{' '}
              {p.rank > 0 ? (
                <>
                  <strong>#{count(p.rank)}</strong> от {count(board.qualifying)}
                  {board.qualifying > 0 &&
                    ` (${pct(1 - (p.rank - 1) / board.qualifying)} перцентил)`}
                </>
              ) : (
                <em>не се класира (под 5 договора)</em>
              )}
            </span>
          ))}
        </p>
      )}

      <div className="table-wrap">
        <table>
          <caption className="sr-only">Класация по {METRIC_LABEL[metric].label}</caption>
          <thead>
            <tr>
              <th scope="col" className="num">
                #
              </th>
              <th scope="col">{labels.one}</th>
              <th scope="col" className="num">
                {METRIC_LABEL[metric].label}
              </th>
              <th scope="col" className="num">
                Общо €
              </th>
              <th scope="col" className="num">
                Договори
              </th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r) => (
              <tr
                key={r.slug}
                style={
                  r.highlighted
                    ? { background: 'color-mix(in oklch, var(--accent) 12%, transparent)' }
                    : undefined
                }
              >
                <td className="num">{count(r.rank)}</td>
                <td>
                  <Link to={href(r.slug)}>{r.name}</Link>
                </td>
                <td className="num">
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                    {bar(r.metricValue, r.highlighted)}
                    <span>{fmtMetric(metric, r.metricValue)}</span>
                  </span>
                </td>
                <td className="num">{moneyBare(r.totalEur)} €</td>
                <td className="num">{count(r.contracts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export default function Compare({ loaderData }: Route.ComponentProps) {
  const { kind, aSlug, bSlug, a, b, isExample, metric, leaderboard } = loaderData;
  const ea = toEntity(kind, a);
  const eb = toEntity(kind, b);
  const labels = KIND_LABEL[kind];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Сравнение' }]} />
      <main id="main">
        <PageHeader
          kicker={
            <>
              Сравнение · <Chip>{labels.many}</Chip>
            </>
          }
          title="Едно до друго"
          lede={`„По-зле ли е моята община от съседната?" Класирай всички ${labels.many} по една мярка, виж къде стоят избраните, после ги разгледай едно до друго. Всяко число идва от реалните договори.`}
        />

        <Leaderboard kind={kind} metric={metric} board={leaderboard} aSlug={aSlug} bSlug={bSlug} />

        {ea && eb ? (
          <>
            {isExample && (
              <Callout title="Примерно сравнение">
                <p style={{ margin: 0 }}>
                  Показваме двете най-големи {labels.many} по стойност, за да видите как работи
                  изгледът. Изберете свои {labels.many} по-долу ↓ — или сменете на{' '}
                  <Link to="/compare?kind=company">компании</Link>.
                </p>
              </Callout>
            )}
            <Section
              id="scope"
              title="Сравнени субекти"
              hint="Сравнението е изцяло в адреса — копирайте линка, за да го споделите."
            >
              <p className="compare-chips">
                <Chip>
                  A: <Link to={entityHref(kind, ea.slug)}>{ea.name}</Link>
                </Chip>{' '}
                <Chip>
                  B: <Link to={entityHref(kind, eb.slug)}>{eb.name}</Link>
                </Chip>{' '}
                <Link className="small" to={`/compare?kind=${kind}`}>
                  Изчисти ↺
                </Link>
              </p>
            </Section>

            <Section
              id="scorecard"
              title="Показатели"
              hint="Където сравнението е смислено (конкуренция), по-добрата страна е удебелена и отбелязана. Останалите показатели са неутрални — повече или по-малко не значи по-добре."
            >
              <div className="table-wrap tbl-cards">
                <table>
                  <caption className="sr-only">
                    Сравнение на {ea.name} и {eb.name}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Показател</th>
                      <th scope="col" className="num">
                        {ea.name}
                      </th>
                      <th scope="col" className="num">
                        {eb.name}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {buildComparisonRows(ea, eb).map((row) => (
                      <tr key={row.key}>
                        <td className="cell-title" data-label="Показател">
                          {row.label}
                        </td>
                        <MetricCell row={row} side="a" better={row.betterSide === 'a'} />
                        <MetricCell row={row} side="b" better={row.betterSide === 'b'} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section
              id="sectors"
              title="Топ сектори"
              hint="Най-големите CPV категории по обем за всеки субект."
            >
              <div className="two-col">
                <div>
                  <h3>{ea.name}</h3>
                  <SectorList entity={ea} />
                </div>
                <div>
                  <h3>{eb.name}</h3>
                  <SectorList entity={eb} />
                </div>
              </div>
            </Section>

            {isExample && (
              <Picker kind={kind} aSlug={null} bSlug={null} aMissing={false} bMissing={false} />
            )}
          </>
        ) : (
          <Picker
            kind={kind}
            aSlug={aSlug}
            bSlug={bSlug}
            aMissing={Boolean(aSlug) && !ea}
            bMissing={Boolean(bSlug) && !eb}
          />
        )}
      </main>
    </>
  );
}
