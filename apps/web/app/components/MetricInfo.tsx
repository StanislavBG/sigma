// A small ⓘ affordance next to a metric label. On hover or keyboard focus it reveals an elegant
// popover with a plain-language summary of the metric and an „analytical readout" — a short, often
// data-driven, interpretation. Pure CSS show/hide (`:hover` / `:focus-within`), so it is SSR-safe and
// needs no client JS. The button carries the full text as its aria-label, so screen-reader users get
// the same information without the visual popover (which is aria-hidden).
export function MetricInfo({
  title,
  summary,
  readout,
  align = 'start',
}: {
  title: string;
  summary: string;
  // Plain string so the readout is always reflected verbatim into the aria-label (all callers pass a
  // string — the screen-reader text must never silently drop a non-string interpretation).
  readout?: string;
  // Which edge the popover anchors to — use 'end' for right-most metrics so it doesn't clip.
  align?: 'start' | 'end';
}) {
  const aria = readout ? `${title}. ${summary} ${readout}`.trim() : `${title}. ${summary}`;
  return (
    <span className="metric-info">
      <button type="button" className="metric-info-btn" aria-label={aria}>
        i
      </button>
      <span className={`metric-info-pop${align === 'end' ? ' is-end' : ''}`} aria-hidden="true">
        <span className="metric-info-title">{title}</span>
        <span className="metric-info-summary">{summary}</span>
        {readout ? <span className="metric-info-readout">{readout}</span> : null}
      </span>
    </span>
  );
}
