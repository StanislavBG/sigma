import { Link } from 'react-router';
import { count, money, pct } from '@sigma/shared';
import type { AuthorityDetail, CompanyDetail } from '@sigma/api-contract';
import {
  authorityIdFromSlug,
  authoritySlug,
  bidderIdFromSlug,
  companySlug,
  getAuthority,
  getCompany,
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
    const [a, b] = await Promise.all([resolve(aS), resolve(bS)]);
    return { kind, aSlug: aS, bSlug: bS, a, b, isExample };
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

export default function Compare({ loaderData }: Route.ComponentProps) {
  const { kind, aSlug, bSlug, a, b, isExample } = loaderData;
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
          lede={`„По-зле ли е моята община от съседната?" Изберете две ${labels.many} и ги сравнете по общите показатели. Всяко число идва от реалните договори зад профила — без сравнима стойност колоната остава „—".`}
        />

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
