import { describe, expect, it } from 'vitest';
import type { AuthorityDetail, CompanyDetail } from '@sigma/api-contract';
import {
  buildComparisonRows,
  normalizeAuthority,
  normalizeCompany,
  type CompareEntity,
} from './compare';

function entity(overrides: Partial<CompareEntity>): CompareEntity {
  return {
    kind: 'authority',
    slug: 'x',
    name: 'X',
    totalEur: 0,
    contracts: 0,
    counterparties: 0,
    counterpartyLabel: 'Различни изпълнители',
    avgEur: 0,
    avgBids: null,
    euSharePct: 0,
    sectors: [],
    ...overrides,
  };
}

const byKey = (rows: ReturnType<typeof buildComparisonRows>, key: string) => {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
};

describe('buildComparisonRows', () => {
  it('carries both values and judges competition metrics by the higher side', () => {
    const a = entity({ totalEur: 1000, counterparties: 12, avgBids: 3.5 });
    const b = entity({ totalEur: 500, counterparties: 4, avgBids: 1.2 });
    const rows = buildComparisonRows(a, b);

    // Neutral metric: both values present, no winner painted.
    const total = byKey(rows, 'total');
    expect(total.a).toBe(1000);
    expect(total.b).toBe(500);
    expect(total.betterSide).toBeNull();

    // More suppliers and more bids = healthier competition → side A wins both.
    expect(byKey(rows, 'counterparties').betterSide).toBe('a');
    expect(byKey(rows, 'avgBids').betterSide).toBe('a');
  });

  it('flags the lower competition side when B leads', () => {
    const a = entity({ counterparties: 2 });
    const b = entity({ counterparties: 9 });
    expect(byKey(buildComparisonRows(a, b), 'counterparties').betterSide).toBe('b');
  });

  it('marks equal competition values as a tie, not a win', () => {
    const a = entity({ counterparties: 5, avgBids: 2 });
    const b = entity({ counterparties: 5, avgBids: 2 });
    const rows = buildComparisonRows(a, b);
    expect(byKey(rows, 'counterparties').betterSide).toBe('equal');
    expect(byKey(rows, 'avgBids').betterSide).toBe('equal');
  });

  it('never judges when avgBids is unknown on a side', () => {
    const a = entity({ avgBids: null });
    const b = entity({ avgBids: 3 });
    expect(byKey(buildComparisonRows(a, b), 'avgBids').betterSide).toBeNull();
  });

  it('handles one entity missing — present side keeps its value, no verdict', () => {
    const a = entity({ totalEur: 800, counterparties: 7 });
    const rows = buildComparisonRows(a, null);

    const total = byKey(rows, 'total');
    expect(total.a).toBe(800);
    expect(total.b).toBeNull();

    // Even a competition metric stays unjudged when there's nothing to compare against.
    const counterparties = byKey(rows, 'counterparties');
    expect(counterparties.b).toBeNull();
    expect(counterparties.betterSide).toBeNull();

    // Both sides missing → every value null.
    const empty = buildComparisonRows(null, null);
    expect(empty.every((r) => r.a === null && r.b === null && r.betterSide === null)).toBe(true);
  });
});

describe('normalizeAuthority', () => {
  it('projects the authority DTO onto the shared shape (top-3 sectors)', () => {
    const dto = {
      slug: '000695089',
      name: 'Община Тест',
      spentEur: 5000,
      contracts: 10,
      suppliers: 6,
      avgEur: 500,
      euSharePct: 0.25,
      avgBids: 2.1,
      sectors: [
        { short: 'строит.', sharePct: 0.5, code: '45', label: 'x', valueEur: 1 },
        { short: 'софтуер', sharePct: 0.3, code: '72', label: 'y', valueEur: 1 },
        { short: 'храни', sharePct: 0.1, code: '15', label: 'z', valueEur: 1 },
        { short: 'друго', sharePct: 0.05, code: '99', label: 'w', valueEur: 1 },
      ],
    } as unknown as AuthorityDetail;

    const e = normalizeAuthority(dto);
    expect(e.totalEur).toBe(5000);
    expect(e.counterparties).toBe(6);
    expect(e.counterpartyLabel).toBe('Различни изпълнители');
    expect(e.sectors).toHaveLength(3);
    expect(e.sectors[0].short).toBe('строит.');
  });
});

describe('normalizeCompany', () => {
  it('derives avg € from won/contracts and uses the single primary sector', () => {
    const dto = {
      slug: 'n123',
      displayName: 'Тест ЕООД',
      wonEur: 3000,
      contracts: 4,
      authorities: 3,
      euSharePct: 0.1,
      avgBids: 1.5,
      sector: { short: 'строит.', code: '45', label: 'x' },
      sectorSharePct: 0.8,
    } as unknown as CompanyDetail;

    const e = normalizeCompany(dto);
    expect(e.totalEur).toBe(3000);
    expect(e.avgEur).toBe(750);
    expect(e.counterpartyLabel).toBe('Възложители');
    expect(e.sectors).toEqual([{ short: 'строит.', sharePct: 0.8 }]);
  });

  it('avoids divide-by-zero when a company has no counted contracts', () => {
    const dto = {
      slug: 'n0',
      displayName: 'Празна',
      wonEur: 0,
      contracts: 0,
      authorities: 0,
      euSharePct: 0,
      avgBids: null,
      sector: null,
      sectorSharePct: null,
    } as unknown as CompanyDetail;
    expect(normalizeCompany(dto).avgEur).toBe(0);
  });
});
