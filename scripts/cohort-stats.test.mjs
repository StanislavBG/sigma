import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cohortLogMad,
  computeCohorts,
  median,
  quantileSample,
  robustZ,
  MIN_COHORT_SIZE,
} from './cohort-stats.mjs';

describe('median', () => {
  it('returns the middle of an odd-length array', () => {
    assert.equal(median([3, 1, 2]), 2);
  });
  it('averages the two middles of an even-length array', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it('does not mutate the input', () => {
    const a = [3, 1, 2];
    median(a);
    assert.deepEqual(a, [3, 1, 2]);
  });
  it('is NaN for an empty array', () => {
    assert.ok(Number.isNaN(median([])));
  });
});

describe('cohortLogMad', () => {
  it('returns null for a cohort below the minimum size', () => {
    assert.equal(cohortLogMad([1, 2, 3], { minCohort: 30 }), null);
  });

  it('returns null for a degenerate cohort (MAD = 0) — never divides by zero', () => {
    const values = Array.from({ length: 40 }, () => 1000); // identical → MAD = 0
    assert.equal(cohortLogMad(values), null);
  });

  it('recovers median in EUR space from the log median', () => {
    // 41 powers of 10 around 1e4 → median is the middle value 1e4, MAD > 0.
    const values = Array.from({ length: 41 }, (_, i) => 1000 * Math.pow(1.1, i));
    const stat = cohortLogMad(values);
    assert.ok(stat);
    assert.ok(Math.abs(stat.medianEur - values[20]) < 1e-6);
    assert.ok(stat.logMad > 0);
    assert.equal(stat.n, 41);
  });
});

describe('robustZ', () => {
  it('is 0 at the median and positive above it', () => {
    const { medianLog, logMad } = cohortLogMad(
      Array.from({ length: 41 }, (_, i) => 1000 * Math.pow(1.1, i)),
    );
    assert.ok(Math.abs(robustZ(Math.exp(medianLog), medianLog, logMad)) < 1e-9);
    assert.ok(robustZ(Math.exp(medianLog) * 100, medianLog, logMad) > 0);
  });
});

describe('quantileSample', () => {
  it('returns every value when the cohort is at or below the sample size', () => {
    assert.deepEqual(quantileSample([3, 1, 2], 30), [1, 2, 3]);
  });
  it('caps at `size` and spans low→high', () => {
    const values = Array.from({ length: 500 }, (_, i) => i + 1);
    const s = quantileSample(values, 30);
    assert.equal(s.length, 30);
    assert.equal(s[0], 1); // lowest
    assert.equal(s[s.length - 1], 500); // highest
  });
});

describe('computeCohorts', () => {
  // A fixed day so every test contract shares the same ±1-year window unless we deliberately spread them.
  const DAY = '2021-06-15';

  // One clean cohort, all signed the same day: 39 peers tightly around 10k + one obvious 1000× contract.
  function makeCohort() {
    const rows = [];
    for (let i = 0; i < 39; i++)
      rows.push({ id: `c:${i}`, value: 9000 + (i % 7) * 300, signedAt: DAY });
    rows.push({ id: 'c:outlier', value: 10_000_000, signedAt: DAY }); // ~1000× the typical ~10k
    return new Map([['45000', rows]]);
  }

  it('flags the high-tail outlier with a WINDOW-relative mult, percentile and window median', () => {
    const { stats, outliers, samples } = computeCohorts(makeCohort());
    assert.equal(stats.length, 1);
    assert.equal(stats[0].code, '45000');
    assert.equal(stats[0].n, 40);
    assert.equal(outliers.length, 1);
    const o = outliers[0];
    assert.equal(o.contractId, 'c:outlier');
    assert.ok(o.mult > 100); // far above the window median
    assert.ok(o.percentile >= 95 && o.percentile <= 100);
    assert.ok(o.windowMedianEur > 9000 && o.windowMedianEur < 12000); // the ±1yr median it was judged on
    assert.ok(Math.abs(o.mult - o.valueEur / o.windowMedianEur) < 1e-9); // mult is window-relative
    // inflated_share is €-weighted: the one giant contract dominates the cohort total.
    assert.ok(stats[0].inflatedShare > 0.9);
    assert.ok(samples.length > 0);
  });

  it('never flags the low tail (cheap contracts are not "inflated")', () => {
    const rows = [];
    for (let i = 0; i < 39; i++)
      rows.push({ id: `c:${i}`, value: 1_000_000 + (i % 5) * 1000, signedAt: DAY });
    rows.push({ id: 'c:cheap', value: 1, signedAt: DAY }); // a huge NEGATIVE z — must NOT be flagged
    const { outliers } = computeCohorts(new Map([['45000', rows]]));
    assert.equal(outliers.length, 0);
  });

  it('excludes too-small and degenerate cohorts honestly', () => {
    const small = new Map([['00001', [{ id: 'a', value: 100, signedAt: DAY }]]]);
    const degenerate = new Map([
      [
        '00002',
        Array.from({ length: 40 }, (_, i) => ({ id: `d:${i}`, value: 500, signedAt: DAY })),
      ],
    ]);
    assert.equal(computeCohorts(small).stats.length, 0);
    assert.equal(computeCohorts(small).tooSmall, 1);
    assert.equal(computeCohorts(degenerate).stats.length, 0);
    assert.equal(computeCohorts(degenerate).degenerate, 1);
  });

  it('uses labelFor to resolve the cohort label', () => {
    const { stats } = computeCohorts(makeCohort(), {
      labelFor: (code) => `label-${code}`,
    });
    assert.equal(stats[0].label, 'label-45000');
  });

  // ── temporal (±1-year) window semantics ───────────────────────────────────────────────────────────
  it('is inflation-adjusted: a contract normal vs its own era is NOT flagged though it is huge vs the whole history', () => {
    const rows = [];
    // 200 old contracts (2016–2018) around 10k — these dominate the all-period pool.
    for (let i = 0; i < 200; i++)
      rows.push({ id: `old:${i}`, value: 9500 + (i % 9) * 120, signedAt: `2017-06-15` });
    // 35 recent contracts (2024) around 500k — high vs the whole corpus, but normal among themselves.
    for (let i = 0; i < 35; i++)
      rows.push({ id: `new:${i}`, value: 490_000 + (i % 7) * 3000, signedAt: `2024-06-15` });
    const { stats, outliers } = computeCohorts(new Map([['45000', rows]]));
    assert.equal(stats.length, 1);
    assert.equal(stats[0].n, 235); // group total stays all-period
    assert.ok(stats[0].medianEur < 20000); // the all-period „ТИПИЧНА" is the cheap-era median
    assert.equal(outliers.length, 0); // every 2024 contract is normal vs its 2024 window → none flagged
  });

  it('still flags a genuine within-era outlier, judged against its ±1yr window not the whole group', () => {
    const rows = [];
    for (let i = 0; i < 200; i++)
      rows.push({ id: `old:${i}`, value: 9500 + (i % 9) * 120, signedAt: `2017-06-15` });
    for (let i = 0; i < 35; i++)
      rows.push({ id: `new:${i}`, value: 490_000 + (i % 7) * 3000, signedAt: `2024-06-15` });
    rows.push({ id: 'new:huge', value: 50_000_000, signedAt: '2024-06-15' }); // ~100× the 2024 median
    const { outliers } = computeCohorts(new Map([['45000', rows]]));
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].contractId, 'new:huge');
    assert.ok(outliers[0].windowMedianEur > 400_000 && outliers[0].windowMedianEur < 600_000);
    assert.ok(outliers[0].mult > 50); // ×median is relative to the 2024 window, not the 10k group median
  });

  it('does not evaluate contracts whose ±1yr window has < 30 peers (sparse CPV-year), even an extreme one', () => {
    const rows = [];
    // Only 20 recent peers — window too small to judge anything.
    for (let i = 0; i < 20; i++)
      rows.push({ id: `r:${i}`, value: 100_000 + i * 1000, signedAt: '2024-06-15' });
    rows.push({ id: 'r:huge', value: 99_000_000, signedAt: '2024-06-15' });
    // Pad the GROUP to ≥30 with far-away (2010) contracts so the group qualifies but the recent window doesn't.
    for (let i = 0; i < 30; i++)
      rows.push({ id: `far:${i}`, value: 8000 + i * 50, signedAt: '2010-01-15' });
    const { stats, outliers, sparseWindow } = computeCohorts(new Map([['45000', rows]]));
    assert.equal(stats.length, 1); // group qualifies (51 ≥ 30)
    assert.equal(outliers.length, 0); // but the 2024 window has only 21 peers → not evaluated
    assert.ok(sparseWindow >= 21);
  });

  it('excludes undated contracts from windowed detection but keeps them in the group total + median', () => {
    const rows = [];
    for (let i = 0; i < 40; i++)
      rows.push({ id: `d:${i}`, value: 9000 + (i % 7) * 300, signedAt: DAY });
    rows.push({ id: 'u:1', value: 10_000_000, signedAt: null }); // undated giant — cannot be placed in time
    rows.push({ id: 'u:2', value: 20_000_000, signedAt: '' });
    const { stats, outliers, undated } = computeCohorts(new Map([['45000', rows]]));
    assert.equal(stats[0].n, 42); // all 42 count toward the group total
    assert.equal(undated, 2);
    assert.equal(outliers.length, 0); // the undated giants are never flagged (excluded honestly)
  });

  it('exposes the documented thresholds', () => {
    assert.equal(MIN_COHORT_SIZE, 30);
  });
});
