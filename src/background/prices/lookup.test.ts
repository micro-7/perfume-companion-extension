import { describe, expect, it } from 'vitest';
import { SearchUnavailableError } from '../../llm/errors';
import { fakeFetch, fakeGenerate, listing, shop } from '../../test/fakes';
import { batchShopPrices, groundedShopPrice, lookupShopPrice, parseExtracted, parseExtractedList, toRow, whyUnusable, type PriceDeps } from './lookup';

const sauvage = { name: 'Sauvage', brand: 'Dior', concentration: 'Eau de Toilette' };
const palace = shop('Perfume Palace', 'perfumepalace.in');
const nykaa = shop('Nykaa', 'nykaa.com');

const found = (price: number, url = '/products/dior-sauvage', over: Record<string, unknown> = {}) => ({
  found: true,
  productTitle: 'Dior Sauvage EDT 100ml',
  priceInr: price,
  url,
  inStock: true,
  variant: '100 ml Eau de Toilette',
  exactMatch: true,
  ...over,
});
const notListed = { found: false, productTitle: '', priceInr: 0, url: '', inStock: false, variant: '', exactMatch: false };

function deps(over: Partial<PriceDeps> & { generate: PriceDeps['generate'] }): PriceDeps {
  return { signal: new AbortController().signal, hasAccess: async () => true, ...over };
}

describe('parsing', () => {
  it('reads a found listing and treats a price of 0 as unknown', () => {
    expect(parseExtracted(found(8750)).priceInr).toBe(8750);
    expect(parseExtracted(found(0)).priceInr).toBeNull();
  });

  it('rejects an answer without the found flag', () => {
    expect(() => parseExtracted({ priceInr: 5 })).toThrow();
    expect(() => parseExtractedList({ results: 'no' })).toThrow();
  });
});

describe('lookupShopPrice: direct fetch', () => {
  it('fetches the shop search page, asks the model, and returns a found row with an absolute link', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Dior Sauvage EDT', 8750) } });
    const generate = fakeGenerate(() => found(8750));
    const row = await lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl }));

    expect(row).toMatchObject({
      status: 'found',
      shopName: 'Perfume Palace',
      priceInr: 8750,
      url: 'https://www.perfumepalace.in/products/dior-sauvage',
      exactMatch: true,
    });
    expect(row.viaSearch).toBeUndefined();
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://www.perfumepalace.in/search?q=Dior%20Sauvage');
    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0].grounding).toBeUndefined();
    expect(generate.calls[0].prompt).toContain('Dior Sauvage EDT');
  });

  it('keeps the variant when it is not an exact match', () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Dior Sauvage EDP 60ml', 7900) } });
    const generate = fakeGenerate(() => found(7900, '/p/1', { variant: '60 ml Eau de Parfum', exactMatch: false }));
    return lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl })).then((row) => {
      expect(row.exactMatch).toBe(false);
      expect(row.variant).toBe('60 ml Eau de Parfum');
    });
  });

  it('rejects a product link on another domain and falls back to grounded search', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Dior Sauvage', 999) } });
    let n = 0;
    const generate = fakeGenerate((req) => {
      n++;
      return req.grounding ? notListed : found(999, 'https://evil.example.com/dior');
    });
    const row = await lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl }));
    expect(n).toBe(2);
    expect(row.status).toBe('not-found');
  });

  it('falls back to grounded search when the model says the perfume is not on the page', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Something else', 100) } });
    const generate = fakeGenerate((req) => (req.grounding ? found(8800, 'https://perfumepalace.in/p/x') : notListed));
    const row = await lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl }));
    expect(row).toMatchObject({ status: 'found', priceInr: 8800, viaSearch: true });
  });
});

describe('look-alikes and reasons (found with real shop pages)', () => {
  const lookalike = found(900, '/products/al-bait-sauvage', { productTitle: 'Al Bait Al Dimashqi Bergamot Pepper Sauvage Eau de Parfum 75ml' });
  const noWeb = (answer: Record<string, unknown>) => fakeGenerate((req) => (req.grounding ? notListed : answer));

  it('accepts a listing whose title contains the perfume name', () => {
    expect(toRow(palace, parseExtracted(found(8750)), false, sauvage)?.priceInr).toBe(8750);
  });

  it('rejects a listing for a different perfume that merely shares a word with the name', () => {
    const ex = parseExtracted(found(8750, '/p/x', { productTitle: 'Armaf Club de Nuit Intense Man 105ml' }));
    expect(toRow(palace, ex, false, sauvage)).toBeNull();
    expect(whyUnusable(palace, ex, sauvage)).toMatch(/different perfume/);
  });

  it('rejects a look-alike that borrows the name but is from another brand', () => {
    const ex = parseExtracted(lookalike);
    expect(whyUnusable(palace, ex, sauvage)).toMatch(/different brand/);
    expect(toRow(palace, ex, false, sauvage)).toBeNull();
  });

  it('accepts the brand in the product link when the title leaves it out, and "Christian Dior" for Dior', () => {
    const slug = parseExtracted(found(8750, '/products/dior-sauvage-edt-100ml', { productTitle: 'Sauvage Eau de Toilette 100ml' }));
    expect(whyUnusable(palace, slug, sauvage)).toBeNull();
    const full = parseExtracted(found(8750, '/p/1', { productTitle: 'Christian Dior Sauvage EDT for Men' }));
    expect(whyUnusable(palace, full, { name: 'Sauvage', brand: 'Christian Dior' })).toBeNull();
    expect(whyUnusable(palace, parseExtracted(found(1, '/p/1', { productTitle: 'Dior Sauvage' })), { name: 'Sauvage', brand: 'Christian Dior' })).toBeNull();
  });

  it('checks every word of a multi-word name', () => {
    const bleu = { name: 'Bleu de Chanel' };
    expect(whyUnusable(palace, parseExtracted(found(1, '/p', { productTitle: 'Chanel Bleu de Chanel EDP 100ml' })), bleu)).toBeNull();
    expect(whyUnusable(palace, parseExtracted(found(1, '/p', { productTitle: 'Bleu Parfum 100ml' })), bleu)).toMatch(/different/);
  });

  it('does not check the title when there is none, or when the name has no usable words', () => {
    expect(whyUnusable(palace, parseExtracted(found(1, '/p', { productTitle: '' })), sauvage)).toBeNull();
    expect(whyUnusable(palace, parseExtracted(found(1, '/p', { productTitle: 'Anything' })), { name: 'Y' })).toBeNull();
  });

  it('a look-alike on the shop page gives "not found" with the reason, instead of a wrong price', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Al Bait Sauvage', 900) } });
    const row = await lookupShopPrice(palace, sauvage, deps({ generate: noWeb(lookalike), fetchImpl }));
    expect(row.status).toBe('not-found');
    expect(row.reason).toMatch(/different brand/);
  });

  it('keeps the reason from the shop page when web search is unavailable', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Something', 100) } });
    const generate = fakeGenerate((req) => {
      if (req.grounding) throw new SearchUnavailableError();
      return notListed;
    });
    const row = await lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl }));
    expect(row.status).toBe('search-unavailable');
    expect(row.reason).toBe('the perfume is not on the shop page; web search is unavailable');
  });

  it('says so when the model could not read the page', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('X', 1) } });
    const generate = fakeGenerate((req) => {
      if (req.grounding) throw new SearchUnavailableError();
      throw new Error('503 busy');
    });
    const row = await lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl }));
    expect(row.reason).toMatch(/AI could not read the page \(503 busy\)/);
  });

  it('says so when the shop page was blocked, and when there is no access', async () => {
    const blocked = fakeFetch({ 'perfumepalace.in': { status: 403, html: '' } });
    const noGround = fakeGenerate(() => {
      throw new SearchUnavailableError();
    });
    expect((await lookupShopPrice(palace, sauvage, deps({ generate: noGround, fetchImpl: blocked }))).reason).toMatch(/blocked or empty/);
    expect((await lookupShopPrice(palace, sauvage, deps({ generate: noGround, hasAccess: async () => false }))).reason).toMatch(/no direct access/);
  });

  it('tells the model to ignore samples, decants and look-alikes', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Dior Sauvage', 8750) } });
    const generate = fakeGenerate(() => found(8750));
    await lookupShopPrice(palace, sauvage, deps({ generate, fetchImpl }));
    const prompt = generate.calls[0].prompt;
    expect(prompt).toMatch(/IGNORE samples, decants/);
    expect(prompt).toMatch(/look-alikes/);
  });
});

describe('prices that are not on the shop page (a page showing another currency)', () => {
  const eurPage = `<html><body><main>${'Search results. '.repeat(30)}<a href="/products/dior-sauvage">Dior Sauvage EDT 100ml</a> €151.00 Tax included. Rs. support: free delivery</main></body></html>`;
  const noWeb = (answer: Record<string, unknown>) => fakeGenerate((req) => (req.grounding ? notListed : answer));

  it('drops a converted price (the AI says 15,500, the page says EUR 151) instead of showing it as fact', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: eurPage } });
    const row = await lookupShopPrice(palace, sauvage, deps({ generate: noWeb(found(15500, '/products/dior-sauvage')), fetchImpl }));
    expect(row.status).toBe('not-found');
    expect(row.reason).toMatch(/not written on the page in rupees/);
    expect(row.priceInr).toBeUndefined();
  });

  it('keeps a price that is written on the page', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Dior Sauvage EDT', 8750) } });
    const row = await lookupShopPrice(palace, sauvage, deps({ generate: noWeb(found(8750)), fetchImpl }));
    expect(row).toMatchObject({ status: 'found', priceInr: 8750 });
  });

  it('applies to the dupe batch too', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: eurPage } });
    const generate = fakeGenerate((req) =>
      req.grounding ? { results: [] } : { results: [{ shop: 'perfumepalace.in', ...found(15500, '/products/dior-sauvage') }] },
    );
    const rows = await batchShopPrices([palace], sauvage, deps({ generate, fetchImpl }));
    expect(rows[0].status).toBe('not-found');
  });
});

describe('lookupShopPrice: fallbacks', () => {
  const grounded = (price: number) => (req: { grounding?: unknown }) => (req.grounding ? found(price, 'https://nykaa.com/p/1') : notListed);

  it('a blocked shop (403) uses grounded search and is marked "via search"', async () => {
    const fetchImpl = fakeFetch({ 'nykaa.com': { status: 403, html: 'Access Denied' } });
    const generate = fakeGenerate(grounded(9100));
    const row = await lookupShopPrice(nykaa, sauvage, deps({ generate, fetchImpl }));
    expect(row).toMatchObject({ status: 'found', priceInr: 9100, viaSearch: true });
    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0].grounding).toEqual({ site: 'nykaa.com' });
    expect(generate.calls[0].prompt).toContain('nykaa.com');
  });

  it('a bot-check page with status 200 also uses grounded search', async () => {
    const fetchImpl = fakeFetch({
      'nykaa.com': { html: '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>' },
    });
    const generate = fakeGenerate(grounded(9100));
    const row = await lookupShopPrice(nykaa, sauvage, deps({ generate, fetchImpl }));
    expect(row.viaSearch).toBe(true);
  });

  it('a network error or timeout uses grounded search', async () => {
    const fetchImpl = fakeFetch({ 'nykaa.com': new TypeError('failed to fetch') });
    const row = await lookupShopPrice(nykaa, sauvage, deps({ generate: fakeGenerate(grounded(9100)), fetchImpl }));
    expect(row.viaSearch).toBe(true);
  });

  it('a shop without direct access never fetches the shop and uses grounded search', async () => {
    const fetchImpl = fakeFetch({});
    const row = await lookupShopPrice(nykaa, sauvage, deps({ generate: fakeGenerate(grounded(9100)), fetchImpl, hasAccess: async () => false }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(row.viaSearch).toBe(true);
  });

  it('when both the direct fetch and the grounded search fail, the shop is "not found"', async () => {
    const fetchImpl = fakeFetch({ 'nykaa.com': { status: 500, html: '' } });
    const row = await lookupShopPrice(nykaa, sauvage, deps({ generate: fakeGenerate(() => notListed), fetchImpl }));
    expect(row.status).toBe('not-found');
    expect(row.priceInr).toBeUndefined();
  });

  it('while Gemini is unavailable, a blocked shop is "search unavailable"', async () => {
    const fetchImpl = fakeFetch({ 'nykaa.com': { status: 403, html: '' } });
    const generate = fakeGenerate(() => {
      throw new SearchUnavailableError();
    });
    const row = await lookupShopPrice(nykaa, sauvage, deps({ generate, fetchImpl }));
    expect(row.status).toBe('search-unavailable');
  });

  it('a model error during grounded search is "not found", not a crash', async () => {
    const row = await groundedShopPrice(
      nykaa,
      sauvage,
      deps({
        generate: fakeGenerate(() => {
          throw new Error('boom');
        }),
      }),
    );
    expect(row.status).toBe('not-found');
  });

  it('stops with an error when the lookup is cancelled', async () => {
    const ac = new AbortController();
    const fetchImpl = fakeFetch({ 'nykaa.com': new TypeError('x') });
    ac.abort();
    await expect(lookupShopPrice(nykaa, sauvage, deps({ generate: fakeGenerate(() => notListed), fetchImpl, signal: ac.signal }))).rejects.toThrow();
  });
});

describe('batchShopPrices', () => {
  const result = (shopDomain: string, price: number) => ({ shop: shopDomain, ...found(price, `https://${shopDomain}/p/1`) });

  it('uses one model call for all shop pages and returns one row per shop', async () => {
    const shops = [palace, nykaa];
    const fetchImpl = fakeFetch({
      'perfumepalace.in': { html: listing('Armaf CDNIM', 2650) },
      'nykaa.com': { html: listing('Armaf CDNIM', 2400) },
    });
    const generate = fakeGenerate(() => ({ results: [result('perfumepalace.in', 2650), result('nykaa.com', 2400)] }));
    const rows = await batchShopPrices(shops, sauvage, deps({ generate, fetchImpl }));

    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0].grounding).toBeUndefined();
    expect(rows.map((r) => [r.shopName, r.priceInr])).toEqual([['Perfume Palace', 2650], ['Nykaa', 2400]]);
  });

  it('sends the leftover shops to one grounded search', async () => {
    const shops = [palace, nykaa];
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('Armaf CDNIM', 2650) }, 'nykaa.com': { status: 403, html: '' } });
    const generate = fakeGenerate((req) =>
      req.grounding ? { results: [result('nykaa.com', 2500)] } : { results: [result('perfumepalace.in', 2650)] },
    );
    const rows = await batchShopPrices(shops, sauvage, deps({ generate, fetchImpl }));

    expect(generate.calls).toHaveLength(2);
    expect(rows[1]).toMatchObject({ shopName: 'Nykaa', priceInr: 2500, viaSearch: true });
    expect(rows[0].viaSearch).toBeUndefined();
  });

  it('ignores a result whose link is on another domain', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('X', 100) } });
    const generate = fakeGenerate((req) =>
      req.grounding ? { results: [] } : { results: [{ shop: 'perfumepalace.in', ...found(100, 'https://evil.example.com/x') }] },
    );
    const rows = await batchShopPrices([palace], sauvage, deps({ generate, fetchImpl }));
    expect(rows[0].status).toBe('not-found');
  });

  it('marks leftover shops "search unavailable" while Gemini is down', async () => {
    const generate = fakeGenerate(() => {
      throw new SearchUnavailableError();
    });
    const rows = await batchShopPrices([palace], sauvage, deps({ generate, hasAccess: async () => false }));
    expect(rows[0].status).toBe('search-unavailable');
  });

  it('keeps the order of the shop list even when answers come back in another order', async () => {
    const fetchImpl = fakeFetch({ 'perfumepalace.in': { html: listing('A', 1) }, 'nykaa.com': { html: listing('B', 2) } });
    const generate = fakeGenerate(() => ({ results: [result('nykaa.com', 2), result('perfumepalace.in', 1)] }));
    const rows = await batchShopPrices([palace, nykaa], sauvage, deps({ generate, fetchImpl }));
    expect(rows.map((r) => r.shopId)).toEqual(['perfumepalace.in', 'nykaa.com']);
  });
});
