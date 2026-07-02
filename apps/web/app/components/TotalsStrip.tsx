import { MetricInfo } from './MetricInfo';

// Bordered metric strip (ink hairlines, serif numerics). Each cell is a big number + a mono caps label.
export interface Total {
  num: string;
  label: string;
  // Optional ⓘ explanation next to the label (same MetricInfo idiom as the header KPIs elsewhere).
  info?: { title: string; summary: string; readout?: string; align?: 'start' | 'end' };
}

export function TotalsStrip({ totals, label }: { totals: Total[]; label?: string }) {
  return (
    <dl className="totals" aria-label={label}>
      {totals.map((t) => (
        <div className="cell" key={t.label}>
          <span className="num">{t.num}</span>
          <span className="label">
            {t.label}
            {t.info ? (
              <MetricInfo
                title={t.info.title}
                summary={t.info.summary}
                readout={t.info.readout}
                align={t.info.align}
              />
            ) : null}
          </span>
        </div>
      ))}
    </dl>
  );
}
