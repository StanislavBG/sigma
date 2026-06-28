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
  // One clean cohort: 39 peers tightly around 10k + one obvious 1000× inflated contract.
  function makeCohort() {
    const rows = [];
    for (let i = 0; i < 39; i++) rows.push({ id: `c:${i}`, value: 9000 + (i % 7) * 300 });
    rows.push({ id: 'c:outlier', value: 10_000_000 }); // ~1000× the typical ~10k
    return new Map([['45000', rows]]);
  }

  it('flags the high-tail outlier with a mult and a high percentile', () => {
    const { stats, outliers, samples } = computeCohorts(makeCohort());
    assert.equal(stats.length, 1);
    assert.equal(stats[0].code, '45000');
    assert.equal(stats[0].n, 40);
    assert.equal(outliers.length, 1);
    const o = outliers[0];
    assert.equal(o.contractId, 'c:outlier');
    assert.ok(o.mult > 100); // far above the cohort median
    assert.ok(o.percentile >= 95 && o.percentile <= 100);
    // inflated_share is €-weighted: the one giant contract dominates the cohort total.
    assert.ok(stats[0].inflatedShare > 0.9);
    assert.ok(samples.length > 0);
  });

  it('never flags the low tail (cheap contracts are not "inflated")', () => {
    const rows = [];
    for (let i = 0; i < 39; i++) rows.push({ id: `c:${i}`, value: 1_000_000 + (i % 5) * 1000 });
    rows.push({ id: 'c:cheap', value: 1 }); // a huge NEGATIVE z — must NOT be flagged
    const { outliers } = computeCohorts(new Map([['45000', rows]]));
    assert.equal(outliers.length, 0);
  });

  it('excludes too-small and degenerate cohorts honestly', () => {
    const small = new Map([['00001', [{ id: 'a', value: 100 }]]]);
    const degenerate = new Map([
      ['00002', Array.from({ length: 40 }, (_, i) => ({ id: `d:${i}`, value: 500 }))],
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

  it('exposes the documented thresholds', () => {
    assert.equal(MIN_COHORT_SIZE, 30);
  });
});
