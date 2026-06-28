import { useRef } from 'react';
import { Form, useSearchParams } from 'react-router';

// An in-page search box for the list routes (Институции / Фирми / Договори). The backend already
// filters these lists by the `q` URL param (FTS over search_index), so this is purely the input.
//
// Progressive enhancement: it is a real `<Form method="get">` that submits to the current route, so
// with JS off (or before hydration) Enter / the button submits exactly like any GET form. Every other
// active param (filters + sort) rides along as a hidden field, and `cursor`/`page` are dropped so a new
// search starts from page one. With JS, typing live-submits after a short debounce (matching the site
// search). Clearing the native `type="search"` field submits an empty `q` and removes the filter.
export function ListSearch({
  placeholder = 'Търси по име или ЕИК…',
  label = 'Търсене в списъка',
}: {
  placeholder?: string;
  label?: string;
}) {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Preserve the active filters + sort; drop q (this field owns it) and the pagination cursor.
  const carried = [...sp.entries()].filter(([k]) => k !== 'q' && k !== 'cursor' && k !== 'page');

  return (
    <Form
      method="get"
      role="search"
      className="list-search"
      onChange={(e) => {
        const form = e.currentTarget;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => form.requestSubmit(), 300);
      }}
    >
      {carried.map(([k, v]) => (
        <input type="hidden" name={k} value={v} key={`${k}=${v}`} />
      ))}
      <label className="list-search-field">
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" className="list-search-icon">
          ⌕
        </span>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={placeholder}
          autoComplete="off"
          className="list-search-input"
        />
      </label>
      <button type="submit" className="list-search-btn">
        Намери
      </button>
    </Form>
  );
}
