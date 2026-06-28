import { describe, expect, it } from 'vitest';
import { squarify, type TreemapCell } from './treemap';

const area = (c: TreemapCell) => c.w * c.h;

// Two cells overlap iff they intersect on both axes (touching edges don't count).
function overlaps(a: TreemapCell, b: TreemapCell): boolean {
  const eps = 1e-9;
  return (
    a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
  );
}

describe('squarify', () => {
  const RECT = { x: 0, y: 0, w: 6, h: 4 }; // the classic Bruls et al. example frame (area 24)

  it('returns one cell per positive item, keyed', () => {
    const cells = squarify(
      [
        { key: 'a', weight: 1 },
        { key: 'b', weight: 1 },
      ],
      RECT,
    );
    expect(cells.map((c) => c.key).sort()).toEqual(['a', 'b']);
  });

  it('makes each cell area proportional to its weight', () => {
    const items = [
      { key: 'a', weight: 6 },
      { key: 'b', weight: 6 },
      { key: 'c', weight: 4 },
      { key: 'd', weight: 3 },
      { key: 'e', weight: 2 },
      { key: 'f', weight: 2 },
      { key: 'g', weight: 1 },
    ];
    const totalWeight = items.reduce((s, it) => s + it.weight, 0);
    const totalArea = RECT.w * RECT.h;
    const cells = squarify(items, RECT);
    for (const it of items) {
      const cell = cells.find((c) => c.key === it.key)!;
      expect(area(cell)).toBeCloseTo((it.weight / totalWeight) * totalArea, 6);
    }
    // Cells tile the rect exactly — total area is conserved.
    const placed = cells.reduce((s, c) => s + area(c), 0);
    expect(placed).toBeCloseTo(totalArea, 6);
  });

  it('keeps every cell within the rect bounds', () => {
    const items = [
      { key: 'a', weight: 6 },
      { key: 'b', weight: 6 },
      { key: 'c', weight: 4 },
      { key: 'd', weight: 3 },
      { key: 'e', weight: 2 },
      { key: 'f', weight: 2 },
      { key: 'g', weight: 1 },
    ];
    const cells = squarify(items, RECT);
    const eps = 1e-9;
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(RECT.x - eps);
      expect(c.y).toBeGreaterThanOrEqual(RECT.y - eps);
      expect(c.x + c.w).toBeLessThanOrEqual(RECT.x + RECT.w + eps);
      expect(c.y + c.h).toBeLessThanOrEqual(RECT.y + RECT.h + eps);
      expect(c.w).toBeGreaterThan(0);
      expect(c.h).toBeGreaterThan(0);
    }
  });

  it('produces no overlapping cells', () => {
    const items = [
      { key: 'a', weight: 6 },
      { key: 'b', weight: 6 },
      { key: 'c', weight: 4 },
      { key: 'd', weight: 3 },
      { key: 'e', weight: 2 },
      { key: 'f', weight: 2 },
      { key: 'g', weight: 1 },
    ];
    const cells = squarify(items, RECT);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        expect(overlaps(cells[i]!, cells[j]!)).toBe(false);
      }
    }
  });

  it('honours the rect origin offset', () => {
    const cells = squarify([{ key: 'a', weight: 1 }], { x: 10, y: 20, w: 5, h: 5 });
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ key: 'a', x: 10, y: 20, w: 5, h: 5 });
  });

  it('drops zero / negative / non-finite weights', () => {
    const cells = squarify(
      [
        { key: 'a', weight: 4 },
        { key: 'zero', weight: 0 },
        { key: 'neg', weight: -3 },
        { key: 'nan', weight: Number.NaN },
      ],
      RECT,
    );
    expect(cells.map((c) => c.key)).toEqual(['a']);
    expect(area(cells[0]!)).toBeCloseTo(RECT.w * RECT.h, 6);
  });

  it('returns an empty layout for no positive items or a degenerate rect', () => {
    expect(squarify([], RECT)).toEqual([]);
    expect(squarify([{ key: 'a', weight: 0 }], RECT)).toEqual([]);
    expect(squarify([{ key: 'a', weight: 1 }], { x: 0, y: 0, w: 0, h: 5 })).toEqual([]);
  });
});
