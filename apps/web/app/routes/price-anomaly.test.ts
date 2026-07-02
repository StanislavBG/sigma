import { describe, expect, it } from 'vitest';
import { loader, priceAnomalyRedirectTarget } from './price-anomaly';

const target = (url: string) => priceAnomalyRedirectTarget(new URL(url));

describe('priceAnomalyRedirectTarget — /price-anomaly merged into the обзор CPV lens', () => {
  it('sends the bare page to the CPV lens', () => {
    expect(target('https://sigma.midt.bg/price-anomaly')).toBe('/trends?angle=cpv');
  });

  it('maps the repeatable ?cohort selection onto the lens ?cpv multi-select, sorted + deduped', () => {
    expect(target('https://x/price-anomaly?cohort=45233&cohort=15000&cohort=45233')).toBe(
      '/trends?angle=cpv&cpv=15000&cpv=45233',
    );
  });

  it('drops params without a lens equivalent (sort, page) and malformed cohorts', () => {
    expect(target('https://x/price-anomaly?sort=outlierCount&page=3&cohort=45233')).toBe(
      '/trends?angle=cpv&cpv=45233',
    );
    expect(target('https://x/price-anomaly?cohort=abc&cohort=123&cohort=999999')).toBe(
      '/trends?angle=cpv',
    );
  });
});

describe('loader', () => {
  it('issues a permanent (301) redirect to the lens', () => {
    const res = loader({
      request: new Request('https://x/price-anomaly?cohort=45233'),
      params: {},
      context: undefined,
    } as unknown as Parameters<typeof loader>[0]);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/trends?angle=cpv&cpv=45233');
  });
});
