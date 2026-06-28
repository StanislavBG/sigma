// Pure RSS 2.0 builder for the „Най-ново" feed. Kept free of React/DB so it unit-tests without a
// worker or sqlite — the resource route (routes/trends.rss.tsx) only wires data + headers around it.

import type { ContractListItem } from '@sigma/api-contract';
import { money } from '@sigma/shared';

// Public canonical origin for absolute links/guids in the feed (readers dereference these directly,
// so they must not depend on the request host — staging/preview hosts would poison subscriptions).
export const FEED_BASE = 'https://sigma.midt.bg';

/**
 * Escape the five XML predefined entities, after stripping characters that XML 1.0 forbids outright.
 * Dirty registry free-text can carry C0 control bytes (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F); tab, LF and
 * CR are the only control chars XML 1.0 permits, so the rest are dropped — otherwise a single stray
 * byte makes the whole feed fail to parse. Applied to every interpolated text node and attribute.
 */
export function xmlEscape(s: string): string {
  // Strip the C0 control bytes XML 1.0 forbids (tab/LF/CR excepted) before escaping the entities.
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return clean.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );
}

// ISO signing date (`YYYY-MM-DD`, possibly with a time suffix) → RFC-822 date for <pubDate>. Returns
// null when the date is absent or unparseable, so the caller simply omits the element (RSS allows it).
export function rfc822(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d.toUTCString();
}

function item(c: ContractListItem): string {
  const link = `${FEED_BASE}/contracts/${c.id}`;
  const value = c.valueEur != null ? money(c.valueEur) : 'непотвърдена стойност';
  const title = `${c.authorityName} → ${c.bidderDisplayName}: ${value}`;
  const pubDate = rfc822(c.signedAt);
  const parts = [
    `<title>${xmlEscape(title)}</title>`,
    `<link>${xmlEscape(link)}</link>`,
    `<guid isPermaLink="true">${xmlEscape(link)}</guid>`,
    `<description>${xmlEscape(c.subject)}</description>`,
  ];
  if (pubDate) parts.push(`<pubDate>${xmlEscape(pubDate)}</pubDate>`);
  return `<item>${parts.join('')}</item>`;
}

/**
 * Build a complete, well-formed RSS 2.0 document for the newest contracts. When the feed is filtered
 * (`?sector=…&funding=…`), pass that query string as `query` so the channel `<link>` and the
 * `atom:link rel="self"` carry it too — a filtered subscription must not self-identify as the global
 * feed.
 */
export function buildContractsRss(
  items: ContractListItem[],
  opts?: { base?: string; lastBuildDate?: string | null; query?: string },
): string {
  const base = opts?.base ?? FEED_BASE;
  const qs = opts?.query ? `?${opts.query}` : '';
  const channel = [
    `<title>СИГМА — Най-нови договори</title>`,
    `<link>${xmlEscape(`${base}/trends${qs}`)}</link>`,
    `<atom:link href="${xmlEscape(`${base}/trends.rss${qs}`)}" rel="self" type="application/rss+xml" />`,
    `<description>${xmlEscape('Най-новите сключени договори по обществени поръчки в България.')}</description>`,
    `<language>bg</language>`,
  ];
  if (opts?.lastBuildDate)
    channel.push(`<lastBuildDate>${xmlEscape(opts.lastBuildDate)}</lastBuildDate>`);
  const body = items.map(item).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `<channel>${channel.join('')}${body}</channel>\n` +
    `</rss>\n`
  );
}
