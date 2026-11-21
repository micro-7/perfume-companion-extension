import { describe, expect, it } from 'vitest';
import { cheapest, chooseBaseline, findHereShop, formatInr, lowOutlierShopIds, savings, sortRows } from './prices';
import type { PriceRow } from './types';

const row = (shopName: string, priceInr?: number, status: PriceRow['status'] = 'found'): PriceRow => ({
  shopId: shopName.toLowerCase().replace(/ /g, ''),
  shopName,
  domain: `${shopName.toLowerCase().replace(/ /g, '')}.in`,
  status,
  priceInr,
});

describe('formatInr', () => {
  it('uses Indian digit grouping with the rupee sign', () => {
    expect(formatInr(18000)).toBe('₹18,000');
    expect(formatInr(1234567)).toBe('₹12,34,567');
    expect(formatInr(999.6)).toBe('₹1,000');
  });
});

describe('sortRows', () => {
  it('sorts found rows cheapest first', () => {
    const sorted = sortRows([row('A', 18000), row('B', 16500), row('C', 19200)]);
    expect(sorted.map((r) => r.priceInr)).toEqual([16500, 18000, 19200]);
  });

  it('puts rows without a price at the bottom, search-unavailable last', () => {
    const sorted = sortRows([
      row('Zed', undefined, 'not-found'),
      row('Gone', undefined, 'search-unavailable'),
      row('Cheap', 100),
      row('Alpha', undefined, 'not-found'),
    ]);
    expect(sorted.map((r) => r.shopName)).toEqual(['Cheap', 'Alpha', 'Zed', 'Gone']);
  });

  it('does not change the input array', () => {
    const rows = [row('A', 2), row('B', 1)];
    sortRows(rows);
    expect(rows[0].shopName).toBe('A');
  });
});

describe('savings', () => {
  it('is the baseline minus the price', () => {
    expect(savings(20000, 18000)).toBe(2000);
  });

  it('is null for an equal or higher price', () => {
    expect(savings(20000, 20000)).toBeNull();
    expect(savings(20000, 21000)).toBeNull();
  });

  it('is null when the baseline or price is unknown', () => {
    expect(savings(null, 18000)).toBeNull();
    expect(savings(undefined, 18000)).toBeNull();
    expect(savings(20000, undefined)).toBeNull();
  });
});

describe('findHereShop', () => {
  const shops = [
    { id: 'amazon.in', domain: 'amazon.in' },
    { id: 'nykaa.com', domain: 'nykaa.com' },
  ];

  it('matches the current page to a configured shop, with www and subdomains', () => {
    expect(findHereShop('https://www.amazon.in/dp/B0', shops)?.id).toBe('amazon.in');
    expect(findHereShop('https://m.nykaa.com/x', shops)?.id).toBe('nykaa.com');
  });

  it('returns null for other sites, look-alikes and bad URLs', () => {
    expect(findHereShop('https://fragrantica.com/p', shops)).toBeNull();
    expect(findHereShop('https://notamazon.in/p', shops)).toBeNull();
    expect(findHereShop('not a url', shops)).toBeNull();
  });
});

describe('chooseBaseline', () => {
  const rows = [row('Cheap', 100), row('Dear', 500)];
  const base = { currentPrice: null, currentSiteName: '', hereRow: null, rows, explore: false };

  it('uses the current site price when known', () => {
    expect(chooseBaseline({ ...base, currentPrice: 20000, currentSiteName: 'Amazon' })).toEqual({ amount: 20000, label: 'Amazon' });
  });

  it('names the baseline after the configured shop when the user is on one of their shops', () => {
    expect(
      chooseBaseline({ ...base, currentPrice: 20000, currentSiteName: 'amazon.in', hereRow: row('Amazon', 20000) }),
    ).toEqual({ amount: 20000, label: 'Amazon' });
  });

  it('falls back to the "You are here" shop price', () => {
    expect(chooseBaseline({ ...base, hereRow: row('Nykaa', 300) })).toEqual({ amount: 300, label: 'Nykaa' });
  });

  it('is null on a normal page when neither is known', () => {
    expect(chooseBaseline(base)).toBeNull();
  });

  it('while exploring a dupe, uses the most expensive shop price', () => {
    expect(chooseBaseline({ ...base, explore: true })).toEqual({ amount: 500, label: 'Dear' });
  });

  it('while exploring, needs at least two prices to compare', () => {
    expect(chooseBaseline({ ...base, explore: true, rows: [row('Only', 100)] })).toBeNull();
  });
});

describe('cheapest', () => {
  it('returns the lowest found row, or null', () => {
    expect(cheapest([row('A', 5), row('B', 3), row('C', undefined, 'not-found')])?.shopName).toBe('B');
    expect(cheapest([row('C', undefined, 'not-found')])).toBeNull();
    expect(cheapest([])).toBeNull();
  });

  it('skips an implausibly low price when there are enough prices to judge', () => {
    const rows = [row('Decant', 850), row('A', 8550), row('B', 9500), row('C', 10500), row('D', 11500)];
    expect(cheapest(rows)?.shopName).toBe('A');
  });
});

describe('lowOutlierShopIds (the Splash decant at ₹850 among bottles at ₹8,550-₹12,600)', () => {
  const real = [row('Splash', 850), row('Belvish', 8550), row('Network', 9500), row('Charm', 10500), row('Fragstalk', 11500), row('MOM', 12600), row('Nykaa', 14900)];

  it('flags a price far below the median', () => {
    expect([...lowOutlierShopIds(real)]).toEqual(['splash']);
  });

  it('does not flag ordinary spread, including a genuinely good deal', () => {
    expect(lowOutlierShopIds([row('A', 6500), row('B', 8550), row('C', 9500), row('D', 10500)]).size).toBe(0);
  });

  it('needs at least 4 prices before judging anything', () => {
    expect(lowOutlierShopIds([row('A', 100), row('B', 9000), row('C', 9500)]).size).toBe(0);
  });

  it('ignores rows without a price', () => {
    expect(lowOutlierShopIds([...real, row('Gone', undefined, 'not-found')]).size).toBe(1);
  });
});
