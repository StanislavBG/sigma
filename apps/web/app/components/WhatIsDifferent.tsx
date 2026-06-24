import { useEffect, useState } from 'react';

// A persistent floating button + modal that explains how THIS instance (Sigma Plus, the independent,
// live-published extension) relates to Sigma Core (sigma.midt.bg). Same data, same source — never in
// conflict; the differentiators are the live operator-published pipeline and the analytical lenses
// (Network and Competition). Content is intentionally brief and presentable. The standalone, shareable
// version of the same one-pager lives at docs/sigma-plus-vs-core.html.
export function WhatIsDifferent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="wid-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Какво е различно?
      </button>

      {open && (
        <div className="wid-overlay" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="wid-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wid-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="wid-close"
              aria-label="Затвори"
              onClick={() => setOpen(false)}
            >
              ×
            </button>

            <p className="wid-kicker">СИГМА Plus · вдъхновени от СИГМА Core</p>
            <h2 id="wid-title">Какво е различно тук</h2>

            <p className="wid-lede">
              Тази платформа (<strong>СИГМА Plus</strong>) е вдъхновена от отворената природа на{' '}
              <strong>СИГМА Core</strong> (<a href="https://sigma.midt.bg">sigma.midt.bg</a>).
              Стъпваме на <strong>същите данни</strong> и <strong>същия източник</strong> и добавяме
              собствена интерпретация и акценти. Благодарим на екипа на СИГМА Core за отворения код
              и данни. 🙏
            </p>

            <div className="wid-grid">
              <section className="wid-card">
                <h3>Данни и източник</h3>
                <ul>
                  <li>
                    Единствен източник: <strong>ЦАИС ЕОП</strong> отворени данни (
                    <code>storage.eop.bg</code>) — същата основа като Core.
                  </li>
                  <li>
                    ~193 600 договора (2020–2026), ~4 870 възложители; стойности нормализирани в
                    евро.
                  </li>
                  <li>
                    Без измислени данни: показва се само реалното (празно е празно), не се добавят
                    примерни стойности.
                  </li>
                </ul>
              </section>

              <section className="wid-card">
                <h3>Нашият подход</h3>
                <ul>
                  <li>
                    <strong>Самостоятелно поддържан</strong> набор: ETL върви локално и публикува
                    към живия сайт.
                  </li>
                  <li>
                    <strong>Инкрементално</strong>: на всеки 30 мин се зареждат само новите дни и се
                    публикува само при реална промяна.
                  </li>
                  <li>Собствено хостване — наша интерпретация върху общата отворена основа.</li>
                </ul>
              </section>

              <section className="wid-card wid-card--accent">
                <h3>Акцент: Мрежа на връзките</h3>
                <p>
                  Его-граф около една институция или фирма — преките контрагенти и техните следващи
                  връзки. Откроява <strong>клъстери</strong> и споделени доставчици, които общата
                  схема на потоците не показва. Кликане върху възел пренастройва центъра.
                </p>
              </section>

              <section className="wid-card wid-card--accent">
                <h3>Акцент: Конкуренция</h3>
                <p>
                  Колко конкурентни са поръчките: <strong>дял на договорите с една оферта</strong> и{' '}
                  <strong>концентрация на доставчиците (HHI)</strong> по възложител — бързи сигнали
                  за ниска конкуренция.
                </p>
              </section>
            </div>

            <p className="wid-foot">
              С благодарност към екипа на <strong>СИГМА Core</strong> за отворената платформа и
              данни, които правят тази работа възможна. Източник (CC-BY 4.0): АОП / ЦАИС ЕОП.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
