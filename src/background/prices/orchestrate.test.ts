import { describe, expect, it } from 'vitest';
import { CACHE_FORMAT, perfumeKey } from '../../shared/cache';
import type { ServerMessage } from '../../shared/messages';
import { fakeFetch, fakeGenerate, listing, memoryCache, shop } from '../../test/fakes';
import { SearchUnavailableError } from '../../llm/errors';
import { bestPrice, lookupPrices } from './orchestrate';

const sauvage = { name: 'Sauvage', brand: 'Dior', concentration: '' };
const shops = [shop('Alpha', 'alpha.in'), shop('Beta', 'beta.in'), shop('Gamma', 'gamma.in')];
const found = (price: number, host: string) => ({
  found: true,
  productTitle: 'Dior Sauvage EDT 100ml',
  priceInr: price,
  url: `https://${host}/p/1`,
  inStock: true,
  variant: '100 ml',
  exactMatch: true,
});
const prices: Record<string, number> = { 'alpha.in': 9000, 'beta.in': 8000, 'gamma.in': 8500 };
const pages = Object.fromEntries(Object.keys(prices).map((h) => [h, { html: listing('Sauvage', prices[h]) }]));

function setup(cache = memoryCache()) {
  const sent: ServerMessage[] = [];
  const generate = fakeGenerate((req) => {
    const host = /\((\w+\.in)\)/.exec(req.prompt)?.[1] ?? '';
    return found(prices[host] ?? 1, host);
  });
  return {
    sent,
    cache,
    generate,
    deps: { generate, cache, signal: new AbortController().signal, hasAccess: async () => true, fetchImpl: fakeFetch(pages) },
    send: (m: ServerMessage) => sent.push(m),
  };
}

describe('lookupPrices', () => {
  it('starts, streams a row and a progress count per shop, and covers every shop', async () => {
    const t = setup();
    const rows = await lookupPrices(sauvage, shops, 'beta.in', t.deps, t.send);

    expect(rows).toHaveLength(3);
    expect(t.sent[0]).toEqual({ type: 'prices:start', total: 3, hereShopId: 'beta.in' });
    expect(t.sent.filter((m) => m.type === 'prices:row')).toHaveLength(3);
    const progress = t.sent.filter((m) => m.type === 'prices:progress');
    expect(progress.map((m) => (m.type === 'prices:progress' ? m.done : 0))).toEqual([1, 2, 3]);
    expect(progress.every((m) => m.type === 'prices:progress' && m.total === 3)).toBe(true);
    // a row always comes before its progress count
    const firstRow = t.sent.findIndex((m) => m.type === 'prices:row');
    const firstProgress = t.sent.findIndex((m) => m.type === 'prices:progress');
    expect(firstRow).toBeLessThan(firstProgress);
  });

  it('reports an empty shop list without any request', async () => {
    const t = setup();
    await lookupPrices(sauvage, [], null, t.deps, t.send);
    expect(t.sent).toEqual([{ type: 'prices:empty' }]);
    expect(t.generate.calls).toHaveLength(0);
  });

  it('caches found rows and uses them next time without calling the model', async () => {
    const t = setup();
    await lookupPrices(sauvage, shops, null, t.deps, t.send);
    expect([...t.cache.store.keys()].sort()).toEqual(
      shops.map((s) => `price:${CACHE_FORMAT}:${perfumeKey(sauvage)}:${s.id}`).sort(),
    );

    const before = t.generate.calls.length;
    t.sent.length = 0;
    await lookupPrices(sauvage, shops, null, t.deps, t.send);
    expect(t.generate.calls.length).toBe(before);
    expect(t.sent.filter((m) => m.type === 'prices:row')).toHaveLength(3);
  });

  it('the page the user is on is shown with its own price and link, with no lookup for that shop', async () => {
    const t = setup();
    const rows = await lookupPrices(sauvage, shops, 'beta.in', t.deps, t.send, { priceInr: 12400, url: 'https://beta.in/products/sauvage-here' });
    const here = rows.find((r) => r.shopId === 'beta.in')!;
    expect(here).toMatchObject({ status: 'found', priceInr: 12400, url: 'https://beta.in/products/sauvage-here', fromPage: true });
    // only the other two shops needed the model
    expect(t.generate.calls).toHaveLength(2);
    expect(t.sent.filter((m) => m.type === 'prices:row')).toHaveLength(3);
    expect(t.sent.filter((m) => m.type === 'prices:progress').map((m) => (m.type === 'prices:progress' ? m.done : 0))).toEqual([1, 2, 3]);
  });

  it('looks the shop up normally when the price of the page is not known', async () => {
    const t = setup();
    await lookupPrices(sauvage, shops, 'beta.in', t.deps, t.send, null);
    expect(t.generate.calls).toHaveLength(3);
  });

  it('does not store the page price in the cache (it is not a lookup result)', async () => {
    const t = setup();
    await lookupPrices(sauvage, shops.slice(1, 2), 'beta.in', t.deps, t.send, { priceInr: 12400, url: 'https://beta.in/p' });
    expect(t.cache.store.size).toBe(0);
  });

  it('ignores price rows saved by older versions of the extension', async () => {
    const t = setup();
    const stale = { shopId: 'alpha.in', shopName: 'Alpha', domain: 'alpha.in', status: 'found', priceInr: 15500, url: 'https://alpha.in/p' };
    t.cache.store.set(`price:${perfumeKey(sauvage)}:alpha.in`, stale); // the old key format, no version
    const rows = await lookupPrices(sauvage, shops.slice(0, 1), null, t.deps, t.send);
    expect(rows[0].priceInr).toBe(9000); // looked up afresh, not the stale 15,500
  });

  it('does not cache "not found" or "search unavailable" rows', async () => {
    const cache = memoryCache();
    const sent: ServerMessage[] = [];
    const generate = fakeGenerate(() => {
      throw new SearchUnavailableError();
    });
    await lookupPrices(
      sauvage,
      shops.slice(0, 1),
      null,
      { generate, cache, signal: new AbortController().signal, hasAccess: async () => false },
      (m) => sent.push(m),
    );
    const row = sent.find((m) => m.type === 'prices:row');
    expect(row && row.type === 'prices:row' && row.row.status).toBe('search-unavailable');
    expect(cache.store.size).toBe(0);
  });
});

describe('bestPrice', () => {
  // The pages must really show the prices the fake model reports; a price that is not on the page is dropped.
  const dupePagesWith = (gammaPrice: number) =>
    fakeFetch({
      'alpha.in': { html: listing('Armaf CDNIM', 2650) },
      'beta.in': { html: listing('Armaf CDNIM', 2100) },
      'gamma.in': { html: listing('Armaf CDNIM', gammaPrice) },
    });
  const list = (rows: Array<[string, number]>) => ({
    results: rows.map(([host, price]) => ({ shop: host, ...found(price, host) })),
  });

  it('returns the cheapest row using a single batch call', async () => {
    const t = setup();
    const generate = fakeGenerate(() => list([['alpha.in', 2650], ['beta.in', 2100], ['gamma.in', 2400]]));
    const best = await bestPrice(sauvage, shops, { ...t.deps, generate, fetchImpl: dupePagesWith(2400) });
    expect(best).toMatchObject({ shopName: 'Beta', priceInr: 2100 });
    expect(generate.calls).toHaveLength(1);
  });

  it('returns null when no shop lists the dupe, and when there are no shops', async () => {
    const t = setup();
    const generate = fakeGenerate(() => ({ results: [] }));
    expect(await bestPrice(sauvage, shops, { ...t.deps, generate, hasAccess: async () => false })).toBeNull();
    expect(await bestPrice(sauvage, [], t.deps)).toBeNull();
  });

  it('uses cached rows and only looks up the missing shops', async () => {
    const t = setup();
    await lookupPrices(sauvage, shops.slice(0, 2), null, t.deps, t.send); // caches alpha and beta
    const generate = fakeGenerate(() => list([['gamma.in', 100]]));
    const best = await bestPrice(sauvage, shops, { ...t.deps, generate, fetchImpl: dupePagesWith(100) });
    expect(best).toMatchObject({ shopName: 'Gamma', priceInr: 100 });
    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0].prompt).toContain('gamma.in');
    expect(generate.calls[0].prompt).not.toContain('alpha.in');
  });
});
