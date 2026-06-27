import { describe, expect, it } from 'vitest';
import type { ContractListItem } from '@sigma/api-contract';
import { buildContractsRss, rfc822, xmlEscape, FEED_BASE } from './rss';

function makeItem(over: Partial<ContractListItem> = {}): ContractListItem {
  return {
    id: 'c-1',
    subject: 'Доставка на материали',
    unp: '00001-2024-0001',
    sectorCode: '45',
    euFunded: false,
    isConsortium: false,
    authoritySlug: '000695089',
    authorityName: 'Община Бургас',
    bidderSlug: '131468980',
    bidderName: 'Алфа ЕООД',
    bidderDisplayName: 'Алфа ЕООД',
    bidderKind: 'company',
    procedureLabel: 'Открита процедура',
    signedAt: '2024-10-14',
    bidsReceived: 3,
    valueEur: 1234567,
    ...over,
  };
}

describe('buildContractsRss', () => {
  it('emits one <item> per contract', () => {
    const xml = buildContractsRss([
      makeItem({ id: 'a' }),
      makeItem({ id: 'b' }),
      makeItem({ id: 'c' }),
    ]);
    expect(xml.match(/<item>/g)).toHaveLength(3);
    expect(xml.match(/<\/item>/g)).toHaveLength(3);
  });

  it('produces a well-formed RSS 2.0 envelope', () => {
    const xml = buildContractsRss([makeItem()]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<channel>');
    expect(xml.trimEnd().endsWith('</rss>')).toBe(true);
    // every opened tag we emit is closed exactly once
    for (const tag of ['rss', 'channel', 'item', 'title', 'link', 'guid', 'description']) {
      expect(xml.match(new RegExp(`<${tag}[ >]`, 'g'))?.length).toBe(
        xml.match(new RegExp(`</${tag}>`, 'g'))?.length,
      );
    }
  });

  it('builds the title as "<authority> → <company>: <value>"', () => {
    const xml = buildContractsRss([
      makeItem({ authorityName: 'Община X', bidderDisplayName: 'Бета ООД' }),
    ]);
    expect(xml).toContain('<title>Община X → Бета ООД:');
  });

  it('XML-escapes text so the document has no raw entities', () => {
    const xml = buildContractsRss([
      makeItem({
        authorityName: 'A & B',
        bidderDisplayName: '<Гама>',
        subject: 'Тест "кавички" & <таг>',
      }),
    ]);
    expect(xml).toContain('A &amp; B');
    expect(xml).toContain('&lt;Гама&gt;');
    expect(xml).toContain('&quot;');
    // no unescaped ampersand survives anywhere in the body
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml)).toBe(false);
  });

  it('links and guids are absolute against the public base', () => {
    const xml = buildContractsRss([makeItem({ id: 'xyz' })]);
    expect(xml).toContain(`<link>${FEED_BASE}/contracts/xyz</link>`);
    expect(xml).toContain(`<guid isPermaLink="true">${FEED_BASE}/contracts/xyz</guid>`);
  });

  it('emits an RFC-822 pubDate when a signing date is present, omits it otherwise', () => {
    const withDate = buildContractsRss([makeItem({ signedAt: '2024-10-14' })]);
    expect(withDate).toContain('<pubDate>Mon, 14 Oct 2024 00:00:00 GMT</pubDate>');
    const noDate = buildContractsRss([makeItem({ signedAt: null })]);
    expect(noDate).not.toContain('<pubDate>');
  });

  it('labels suspect (null) values rather than printing a number', () => {
    const xml = buildContractsRss([makeItem({ valueEur: null })]);
    expect(xml).toContain('непотвърдена стойност');
  });
});

describe('rfc822', () => {
  it('converts an ISO date (with or without time) to RFC-822', () => {
    expect(rfc822('2024-01-02')).toBe('Tue, 02 Jan 2024 00:00:00 GMT');
    expect(rfc822('2024-01-02T15:30:00Z')).toBe('Tue, 02 Jan 2024 00:00:00 GMT');
  });
  it('returns null for missing or malformed input', () => {
    expect(rfc822(null)).toBeNull();
    expect(rfc822('')).toBeNull();
    expect(rfc822('not-a-date')).toBeNull();
  });
});

describe('xmlEscape', () => {
  it('escapes all five predefined entities', () => {
    expect(xmlEscape(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });
});
