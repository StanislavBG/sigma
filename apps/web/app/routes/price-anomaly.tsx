import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, money, moneyBare } from '@sigma/shared';
// 10 cohort rows per page — the full-width browse table is paginated rather than scrolled.
const PAGE_SIZE = 10;
import {
  type CohortOutlierRow,
  type CohortSort,
  type CohortStatRow,
  getCohortOutliers,
  getCohortStats,
  getPriceAnomalyKpis,
} from '@sigma/db';
import type { Route } from './+types/price-anomaly';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { MetricInfo } from '../components/MetricInfo';
import { Callout } from '../components/ui';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import {
  cardStripGeometry,
  cohortStripGeometry,
  fmtMult,
  fmtPercentile,
  sharedDomain,
} from '../lib/price-anomaly-chart';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/price-anomaly',
    title: 'Раздути спрямо сходни — СИГМА',
    description:
      'Кои договори са необичайно скъпи спрямо сходни поръчки от същата категория (CPV) и горе-долу същото време (±1 година). Сравняваме всеки договор само със съвременниците му, за да не броим поскъпването през годините за аномалия, и маркираме онези, чиято стойност силно изпъква над типичната за групата. Голяма стойност не означава надплащане: всеки маркиран договор е за проверка, проследим до конкретния договор.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

const SORTS: CohortSort[] = ['inflatedShare', 'outlierCount', 'n'];
function parseSort(raw: string | null): CohortSort {
  return raw && (SORTS as string[]).includes(raw) ? (raw as CohortSort) : 'inflatedShare';
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sort = parseSort(sp.get('sort'));
  // Repeatable `?cohort=CODE` — the selected CPV cohorts that facet the V4 scorecards. Shareable, SSR,
  // works with no JS. De-duplicate so a doubled param can't widen the IN-list.
  const selected = [...new Set(sp.getAll('cohort').filter(Boolean))];
  const requestedPage = Math.max(1, Number(sp.get('page') ?? '1') || 1);
  const db = context.cloudflare.env.DB;
  return withDbRetry(async () => {
    // KPIs first (one cheap round trip): cohortCount drives the pager, so the page is clamped to the
    // real range before the LIMIT/OFFSET read — an out-of-range ?page can't yield a misleading empty list.
    const kpis = await getPriceAnomalyKpis(db);
    const pageCount = Math.max(1, Math.ceil(kpis.cohortCount / PAGE_SIZE));
    const page = Math.min(requestedPage, pageCount);
    // Then two parallel bounded reads, no duplicate COUNT:
    //   1) getCohortStats — the page's 10 cohort-browse rows (ORDER BY whitelisted sort, LIMIT/OFFSET) +
    //      ONE IN-list sample query for only those page codes.  (= 2 statements)
    //   2) getCohortOutliers — the flagged contracts, optionally faceted to `selected`, mult DESC, LIMIT.
    const [cohorts, outliers] = await Promise.all([
      getCohortStats(db, { sort, page, limit: PAGE_SIZE }),
      getCohortOutliers(db, { codes: selected.length ? selected : undefined }),
    ]);
    return { kpis, cohorts, outliers, sort, selected, page, pageCount };
  });
}

// ── sort tabs (drive ?sort=, preserving the cohort selection) ─────────────────────────────────────
const SORT_TABS: { key: CohortSort; label: string }[] = [
  { key: 'inflatedShare', label: 'РАЗДУТ ДЯЛ' },
  { key: 'outlierCount', label: 'АНОМАЛИИ' },
  { key: 'n', label: 'ДОГОВОРИ' },
];

// ── Cohort browse — ONE full-width paginated table: stats + the inline distribution strip per row ─────
function CohortBrowse({
  cohorts,
  selected,
  sort,
  cohortHref,
  sortHref,
}: {
  cohorts: CohortStatRow[];
  selected: string[];
  sort: CohortSort;
  cohortHref: (code: string) => string;
  sortHref: (sort: CohortSort) => string;
}) {
  const maxShare = Math.max(0.0001, ...cohorts.map((c) => c.inflatedShare));
  // Shared log scale recomputed over the visible page's rows, so the strips on this page are comparable.
  const { min, max } = sharedDomain(cohorts);
  return (
    <section className="pa-panel pa-browse" aria-labelledby="pa-browse-h">
      <div className="pa-panel-head">
        <div>
          <div className="pa-kicker">— Избери категория</div>
          <h2 id="pa-browse-h" className="pa-panel-title">
            Колко обикновено <em>струва…</em>
          </h2>
        </div>
        <div className="pa-seg" role="group" aria-label="Подреди категориите">
          {SORT_TABS.map((t) => (
            <Link
              key={t.key}
              to={sortHref(t.key)}
              aria-current={sort === t.key ? 'true' : undefined}
              rel="nofollow"
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="pa-browse-headrow">
        <span>CPV</span>
        <span>КАТЕГОРИЯ</span>
        <span className="pa-th pa-th-r">
          ТИПИЧНА
          <MetricInfo
            title="Типична цена"
            summary="Типичната цена в тази категория: подредени по стойност, това е тази по средата — половината договори са по-евтини, половината по-скъпи."
          />
        </span>
        <span className="pa-th pa-th-r">
          ДОГОВ.
          <MetricInfo
            title="Договори"
            summary="Колко договора има в категорията за целия период."
          />
        </span>
        <span className="pa-th pa-th-r">
          АНОМ.
          <MetricInfo
            title="Аномалии"
            summary="Колко договора са маркирани като необичайно скъпи спрямо сходните си по време (±1 година)."
          />
        </span>
        <span className="pa-th pa-th-share">
          РАЗДУТ ДЯЛ
          <MetricInfo
            align="end"
            title="Раздут дял"
            summary="Каква част от парите в категорията са в маркираните договори — по стойност, не по брой."
          />
        </span>
        <span className="pa-th pa-th-strip">
          РАЗПРЕДЕЛЕНИЕ
          <MetricInfo
            align="end"
            title="Разпределение"
            summary="Всяка точка е договор, подреден по стойност (вляво евтини, вдясно скъпи). Линията е типичната цена; маркираните със скъпо изпъкване са оцветени."
          />
        </span>
      </div>
      <ul className="pa-browse-list">
        {cohorts.map((c) => {
          const on = selected.includes(c.code);
          const sharePct = Math.round(c.inflatedShare * 100);
          const strip = cohortStripGeometry(c.sample, c.medianEur, min, max);
          return (
            <li key={c.code}>
              <Link
                to={cohortHref(c.code)}
                rel="nofollow"
                aria-pressed={on}
                className={on ? 'pa-browse-row is-on' : 'pa-browse-row'}
              >
                <span className="pa-browse-code">{c.code}</span>
                <span className="clamp1 pa-browse-name">{c.label}</span>
                <span className="pa-r pa-browse-med">{money(c.medianEur)}</span>
                <span className="pa-r pa-browse-n">{count(c.n)}</span>
                <span className="pa-r pa-browse-out">▲{count(c.outlierCount)}</span>
                <span className="pa-browse-share">
                  <span className="pa-share-track" aria-hidden="true">
                    <span
                      className="pa-share-fill"
                      style={{ width: `${Math.max(4, (c.inflatedShare / maxShare) * 100)}%` }}
                    />
                  </span>
                  <span className="pa-share-pct">{sharePct}%</span>
                </span>
                <span className="pa-browse-strip">
                  <svg
                    viewBox="0 0 360 32"
                    className="pa-strip"
                    role="img"
                    aria-label={`Разпределение на стойностите за сходни поръчки от категория ${c.code} ${c.label}: ${count(c.n)} договора, типична стойност ${moneyBare(c.medianEur)}, ${count(c.outlierCount)} маркирани за проверка.`}
                  >
                    <line x1="6" y1="16" x2="354" y2="16" className="pa-strip-axis" />
                    {strip.dots.map((d, i) => (
                      <circle
                        key={i}
                        cx={d.x}
                        cy={d.y}
                        r={d.r}
                        className={d.big ? 'pa-dot is-big' : 'pa-dot'}
                      />
                    ))}
                    <line x1={strip.medX} y1="4" x2={strip.medX} y2="28" className="pa-strip-med" />
                  </svg>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="pa-browse-legend">
        <span className="pa-legend-item">
          <span aria-hidden="true" className="pa-legend-med" />
          типична цена
        </span>
        <span className="pa-legend-item">
          <span aria-hidden="true" className="pa-legend-big" />
          маркиран ≥5× над типичната
        </span>
        <span className="pa-browse-selcount">
          избор · {selected.length ? `${count(selected.length)} избрани` : 'няма'}
        </span>
      </div>
    </section>
  );
}

// ── V4 — flagged-contract scorecards ───────────────────────────────────────────────────────────────
function Scorecard({
  outlier,
  rank,
  cohort,
}: {
  outlier: CohortOutlierRow;
  rank: number;
  cohort?: CohortStatRow;
}) {
  // The flagged contract was judged against its ±1-year window, so the card's median + multiple are the
  // WINDOW median (honest: mult = value / windowMedian). Fall back to deriving it from value/mult only if
  // a pre-0004 row lacks the stored window median (so the strip is never blank, never fabricated). The
  // distribution dots come from the cohort's ALL-PERIOD sample — context around the windowed median.
  const medianEur =
    outlier.windowMedianEur > 0
      ? outlier.windowMedianEur
      : outlier.mult > 0
        ? outlier.valueEur / outlier.mult
        : 0;
  const sample = cohort?.sample ?? [];
  const strip = cardStripGeometry(sample, medianEur, outlier.valueEur);
  const cohortName = cohort?.label ?? outlier.cpvDescription ?? outlier.code;
  return (
    <li className="pa-card">
      <div className="pa-card-top">
        <div className="pa-card-id">
          <span className="pa-card-rank">{rank}</span>
          <span className="pa-card-cpv">CPV {outlier.code}</span>
        </div>
        <div className="pa-card-mult">
          <div className="pa-card-mult-v">{fmtMult(outlier.mult)}</div>
          <div className="pa-card-mult-l">пъти над типичната (±1 г.)</div>
        </div>
      </div>
      <div className="clamp2 pa-card-title">
        <Link to={`/contracts/${outlier.contractSlug}`}>
          {outlier.subject ?? 'Договор без предмет'}
        </Link>
      </div>
      <div className="clamp1 pa-card-buyer">
        <Link to={`/authorities/${outlier.authoritySlug}`}>{outlier.authorityName}</Link>
        <span className="pa-card-cohort"> · {cohortName}</span>
      </div>
      <svg
        viewBox="0 0 320 34"
        className="pa-card-strip"
        role="img"
        aria-label={`Стойност ${moneyBare(outlier.valueEur)} спрямо типичната ${moneyBare(medianEur)} за сходни поръчки от категория ${outlier.code} — ${fmtMult(outlier.mult)} над типичната; сред най-скъпите ${fmtPercentile(outlier.percentile)}.`}
      >
        <line x1="6" y1="18" x2="314" y2="18" className="pa-strip-axis" />
        {strip.dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} className="pa-dot" />
        ))}
        <line
          x1={strip.medX}
          y1="5"
          x2={strip.medX}
          y2="31"
          className="pa-strip-med is-dashed"
        />
        <text x={strip.medX} y="34" textAnchor="middle" className="pa-strip-ticktext">
          типична
        </text>
        <circle cx={strip.hiX} cy="18" r="6" className="pa-card-hi" />
      </svg>
      <dl className="pa-card-figs">
        <div>
          <dt>СТОЙНОСТ</dt>
          <dd className="pa-fig-val">{moneyBare(outlier.valueEur)}</dd>
        </div>
        <div>
          <dt>ТИПИЧНА ±1Г</dt>
          <dd className="pa-fig-med">{moneyBare(medianEur)}</dd>
        </div>
        <div className="pa-r">
          <dt>СРЕД НАЙ-СКЪПИ</dt>
          <dd className="pa-fig-pct">{fmtPercentile(outlier.percentile)}</dd>
        </div>
      </dl>
    </li>
  );
}

// ── Methodology — the complete, honest „как се смята" block (scannable: headings + short paragraphs) ──
function Methodology() {
  return (
    <section className="pa-panel pa-method" aria-labelledby="pa-method-h">
      <div className="pa-panel-head pa-panel-head--col">
        <div className="pa-kicker">— Методология · как се смята</div>
        <h2 id="pa-method-h" className="pa-panel-title">
          Как четем „<em>раздут</em>" — изцяло и честно
        </h2>
      </div>
      <div className="pa-method-body">
        <div className="pa-method-block">
          <h3>1 · С какво сравняваме всеки договор</h3>
          <p>
            Всеки договор го сравняваме само със <strong>сходни поръчки от същата категория и
            горе-долу същото време</strong>: поръчки от същата категория на поръчката (CPV —
            петцифрен код, напр. 45233 — пътно строителство), подписани в рамките на{' '}
            <strong>±1 година</strong> от него. Всеки договор си има собствена група от такива
            съвременници.
          </p>
          <p>
            <strong>Защо ±1 година:</strong> цените растат през годините. Ако сравним договор от
            2018 г. със сходни от 2024 г., бъркаме инфлацията с аномалия — един просто по-нов договор
            би изглеждал „скъп". Като държим времето приблизително постоянно, сигналът е „скъп спрямо
            сходни по време", а не „скъп спрямо цялата история".
          </p>
          <p>
            <strong>Разгледана алтернатива:</strong> вместо този плъзгащ се прозорец можехме да делим
            всяка цена на типичната за нейната категория и година и да подреждаме така изгладените
            стойности за целия период. Това би запазило повече договори, но въвежда скокове на
            границите на годините и нестабилни ориентири за редки категории в дадена година. Избрахме
            ±1-годишния прозорец — по-плавен и по-лесен за обяснение.
          </p>
        </div>

        <div className="pa-method-block">
          <h3>2 · Само обща стойност — няма количества</h3>
          <p>
            Източникът няма единични цени или количества, а само <strong>общата стойност</strong> на
            договора. Затова мерим „голям спрямо сходни по време", а не надплащане за единица.{' '}
            <strong>Висока стойност ≠ надплащане</strong> — голям договор може да е напълно законен
            голям обхват.
          </p>
        </div>

        <div className="pa-method-block">
          <h3>3 · Кога маркираме договор</h3>
          <p>
            Маркираме договор, когато стойността му е <strong>силно над типичната за групата</strong>{' '}
            — толкова над нея, че да изпъква дори след като отчетем колко цените в категорията
            обикновено се разминават. Сравняваме пропорционално (колко пъти, не с колко лева), защото
            цените се различават с порядъци. Гледаме само <strong>нагоре</strong> — скъпите договори,
            никога евтините.
          </p>
          <p>
            <strong>Метод, който един-единствен гигантски договор не може да изкриви:</strong> мерим
            „типичното" и „обичайното разминаване" така, че една екстремна стойност да не издърпа
            летвата нагоре и да скрие останалите аномалии — за разлика от обикновеното средно, което
            един огромен договор лесно подвежда.
          </p>
        </div>

        <div className="pa-method-block">
          <h3>4 · Поне 30 сходни поръчки</h3>
          <p>
            Договор се оценява само ако в неговия прозорец има{' '}
            <strong>поне 30 сходни поръчки</strong>. Под този праг съвременните съседи са твърде
            малко, за да е надеждна оценката. Изключват се честно: <strong>редки категории в дадена
            година</strong> (твърде малко поръчки) и <strong>договори без дата на подписване</strong>{' '}
            (не могат да се поставят във времето). Те не се маркират — просто не се оценяват.
          </p>
        </div>

        <div className="pa-method-block">
          <h3>5 · Как се чете всяко число</h3>
          <ul>
            <li>
              <strong>ТИПИЧНА</strong> — типичната стойност на групата за <em>целия период</em>
              (контекст в таблицата; ориентир „колко обикновено струва").
            </li>
            <li>
              <strong>ТИПИЧНА ±1Г / ×пъти</strong> — типичната стойност за сходните поръчки в
              ±1-годишния прозорец и колко пъти над нея е договорът. Точно срещу тази стойност е
              засечен.
            </li>
            <li>
              <strong>СРЕД НАЙ-СКЪПИ</strong> — на кое място е договорът сред сходните си по време:
              напр. „1%" значи, че е сред най-скъпия 1% в прозореца.
            </li>
            <li>
              <strong>РАЗДУТ ДЯЛ</strong> — каква част от парите в категорията седят в маркирани
              договори (спрямо общата сума, не броя).
            </li>
            <li>
              <strong>Лентата на разпределението</strong> е <em>контекст за целия период</em> —
              показва формата на категорията. Засичането обаче е <em>в прозореца</em>; затова точка
              може да изглежда висока на лентата, но да е нормална спрямо своите съвременници.
            </li>
          </ul>
        </div>

        <div className="pa-method-block">
          <h3>6 · Ограничения и честни уговорки</h3>
          <ul>
            <li>
              <strong>Рамкови споразумения и многогодишни договори</strong> изглеждат огромни спрямо
              сходни „на доставка" — голям обхват, не задължително надплащане.
            </li>
            <li>
              <strong>Грешно етикетиране на категорията (CPV)</strong> може да сложи договор в чужда
              група и да изкриви сравнението.
            </li>
            <li>
              <strong>Малки групи</strong> (близо до 30 поръчки) дават по-нестабилен ориентир от
              пълните категории.
            </li>
            <li>
              Всеки маркиран договор е <strong>за проверка</strong>, не доказателство. Повече за
              метода и източниците — в <Link to="/methodology">методологията</Link>.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export default function PriceAnomaly({ loaderData }: Route.ComponentProps) {
  const { kpis, cohorts, outliers, sort, selected, page, pageCount } = loaderData;
  const [sp] = useSearchParams();
  const navigating = useNavigation().state !== 'idle';

  const byCode = new Map(cohorts.map((c) => [c.code, c]));

  // URL builders — pure, so the toggles are real <Link>s (SSR + no-JS + shareable).
  const cohortHref = (code: string) => {
    const params = new URLSearchParams(sp);
    const current = new Set(params.getAll('cohort'));
    params.delete('cohort');
    if (current.has(code)) current.delete(code);
    else current.add(code);
    for (const c of current) params.append('cohort', c);
    const qs = params.toString();
    return qs ? `/price-anomaly?${qs}` : '/price-anomaly';
  };
  const sortHref = (next: CohortSort) => {
    const params = new URLSearchParams(sp);
    if (next === 'inflatedShare') params.delete('sort');
    else params.set('sort', next);
    params.delete('page'); // a new sort reorders the whole list — start from page 1
    const qs = params.toString();
    return qs ? `/price-anomaly?${qs}` : '/price-anomaly';
  };
  // Page link — preserves the sort + the cohort selection, drops `page` for page 1 (the canonical URL).
  const pageHref = (n: number) => {
    const params = new URLSearchParams(sp);
    if (n <= 1) params.delete('page');
    else params.set('page', String(n));
    const qs = params.toString();
    return qs ? `/price-anomaly?${qs}` : '/price-anomaly';
  };
  const clearHref = () => {
    const params = new URLSearchParams(sp);
    params.delete('cohort');
    const qs = params.toString();
    return qs ? `/price-anomaly?${qs}` : '/price-anomaly';
  };

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: 'Анализи', to: '/analytics' },
          { label: 'Раздути спрямо сходни' },
        ]}
      />
      <main id="main" className="pa-page">
        <header className="pa-mast">
          <div className="pa-mast-main">
            <p className="pa-mast-kicker">— Анализ · Аномални цени спрямо сходни</p>
            <h1 className="pa-mast-title">
              Раздути спрямо <em>сходни поръчки</em>
            </h1>
            <p className="pa-mast-lede">
              Изберѝ категории от таблицата горе — всеки ред показва типичната цена и разпределението на
              стойностите. Картончетата долу показват всеки маркиран договор спрямо сходните му поръчки
              от същата категория (CPV).
            </p>
          </div>
          <dl className="pa-mast-kpis" aria-label="Метод на анализа">
            <div className="pa-hk">
              <dd className="pa-hk-v">{count(kpis.cohortCount)}</dd>
              <dt className="pa-hk-l">
                CPV ГРУПИ · ±1 Г.
                <MetricInfo
                  title="Категории · ±1 година"
                  summary="Всеки договор сравняваме само със сходните поръчки от същата категория (CPV — петцифрен код), подписани в рамките на ±1 година от него. Така сравнението е спрямо съвременници, а не спрямо цялата история, където поскъпването през годините изкривява. Тук се брои колко категории имат достатъчно такива съседи."
                />
              </dt>
            </div>
            <div className="pa-hk">
              <dd className="pa-hk-v">≥ {count(kpis.minCohortSize)}</dd>
              <dt className="pa-hk-l">
                МИН. СХОДНИ ПОРЪЧКИ
                <MetricInfo
                  title="Минимум сходни поръчки"
                  summary="Договор се оценява само ако в неговия ±1-годишен прозорец от същата категория има поне 30 сходни поръчки с потвърдена стойност. Под този праг съседите са твърде малко, за да е надеждна оценката — затова редки категории в дадена година и договори без дата на подписване се изключват от засичането (честно, не маркирани)."
                />
              </dt>
            </div>
            <div className="pa-hk">
              <dd className="pa-hk-v accent">≥ {kpis.zThreshold}× над обичайното</dd>
              <dt className="pa-hk-l">
                ПРАГ ЗА МАРКИРАНЕ
                <MetricInfo
                  align="end"
                  title="Праг за маркиране"
                  summary="Маркираме договор, когато стойността му е силно над типичната за сходните му по време (±1 г.) поръчки — поне толкова над нея, че да изпъква дори след като отчетем колко цените в категорията обикновено се разминават. Сравняваме пропорционално (колко пъти, не с колко лева) и гледаме само нагоре — скъпите, не евтините. Методът е устойчив: един-единствен гигантски договор не може да изкриви летвата."
                  readout="Висока стойност ≠ надплащане — данните нямат количества, затова е „за проверка“, не доказателство."
                />
              </dt>
            </div>
          </dl>
        </header>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване…' : 'Изгледът е обновен.'}
        </p>

        {cohorts.length === 0 ? (
          <Callout title="Няма категории за анализ">
            <p className="m-0">
              Все още няма категории с достатъчно сходни поръчки (поне 30) в обхванатите данни.
            </p>
          </Callout>
        ) : (
          <>
            <CohortBrowse
              cohorts={cohorts}
              selected={selected}
              sort={sort}
              cohortHref={cohortHref}
              sortHref={sortHref}
            />
            {pageCount > 1 && (
              <nav className="paging pa-paging" aria-label="Навигация по страници">
                <div>
                  стр. <strong>{count(page)}</strong> от <strong>{count(pageCount)}</strong> · по{' '}
                  {PAGE_SIZE} категории
                </div>
                <div className="ctrl">
                  {page > 1 ? (
                    <Link to={pageHref(page - 1)} rel="prev nofollow">
                      ‹ Предишна
                    </Link>
                  ) : (
                    <span aria-disabled="true" className="disabled">
                      ‹ Предишна
                    </span>
                  )}
                  {page < pageCount ? (
                    <Link to={pageHref(page + 1)} rel="next nofollow">
                      Следваща ›
                    </Link>
                  ) : (
                    <span aria-disabled="true" className="disabled">
                      Следваща ›
                    </span>
                  )}
                </div>
              </nav>
            )}
          </>
        )}

        <section className="pa-panel pa-scorecards" aria-labelledby="pa-cards-h">
          <div className="pa-panel-head pa-panel-head--wrap">
            <div>
              <div className="pa-kicker">— Маркирани договори · подредени по пъти над типичната</div>
              <h2 id="pa-cards-h" className="pa-panel-title">
                Картончета на <em>аномалните</em> договори
              </h2>
            </div>
            <div className="pa-filter">
              <span className="pa-filter-label">ФИЛТЪР</span>
              {selected.length === 0 ? (
                <span className="pa-filter-all">
                  всички категории · {count(outliers.length)} договора
                </span>
              ) : (
                <>
                  {selected.map((code) => (
                    <Link
                      key={code}
                      to={cohortHref(code)}
                      rel="nofollow"
                      className="pa-chip"
                      aria-label={`Премахни категория ${byCode.get(code)?.label ?? code}`}
                    >
                      <span className="clamp1">{byCode.get(code)?.label ?? code}</span>
                      <span aria-hidden="true">✕</span>
                    </Link>
                  ))}
                  <Link to={clearHref()} rel="nofollow" className="pa-clear">
                    ИЗЧИСТИ ✕
                  </Link>
                </>
              )}
            </div>
          </div>

          {outliers.length === 0 ? (
            <p className="pa-cards-empty">Няма маркирани договори в избраните категории.</p>
          ) : (
            <ul className="pa-cards-grid">
              {outliers.map((o, i) => (
                <Scorecard key={o.contractId} outlier={o} rank={i + 1} cohort={byCode.get(o.code)} />
              ))}
            </ul>
          )}

          <p className="pa-caveat">
            <span className="pa-caveat-strong">⚠ Голяма стойност ≠ надплащане.</span> Данните нямат
            количества — точката на договора стои сред сходни поръчки само по обща стойност.
            Картончето маркира за проверка, не доказва злоупотреба.
          </p>
        </section>

        <Methodology />

        <p className="small muted source-line">Данни: Регистър на обществените поръчки (АОП)</p>
      </main>
    </>
  );
}
