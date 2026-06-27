// Pure RSS 2.0 builder for the „Най-ново" feed. Kept free of React/DB so it unit-tests without a
// worker or sqlite — the resource route (routes/trends.rss.tsx) only wires data + headers around it.

import type { ContractListItem } from '@sigma/api-contract';
import { money } from '@sigma/shared';

// Public canonical origin for absolute links/guids in the feed (readers dereference these directly,
// so they must not depend on the request host — staging/preview hosts would poison subscriptions).
export const FEED_BASE = 'https://sigma.midt.bg';

/** Escape the five XML predefined entities. Applied to every interpolated text node and attribute. */
export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
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

/** Build a complete, well-formed RSS 2.0 document for the newest contracts. */
export function buildContractsRss(
  items: ContractListItem[],
  opts?: { base?: string; lastBuildDate?: string | null },
): string {
  const base = opts?.base ?? FEED_BASE;
  const channel = [
    `<title>СИГМА — Най-нови договори</title>`,
    `<link>${xmlEscape(`${base}/trends`)}</link>`,
    `<atom:link href="${xmlEscape(`${base}/trends.rss`)}" rel="self" type="application/rss+xml" />`,
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
