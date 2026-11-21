import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  extractStructuredPriceInr,
  finalizePage,
  priceAppearsInText,
  limitText,
  pickProductJsonLd,
} from './page';

const productLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Dior Sauvage EDT',
  offers: { '@type': 'Offer', price: '8,990.00', priceCurrency: 'INR' },
});

describe('page text helpers', () => {
  it('collapses runs of spaces and blank lines into single spaces and newlines', () => {
    expect(collapseWhitespace('a   b\n\n\n\n c   d')).toBe('a b\nc d');
  });

  it('leaves short text alone and cuts long text, keeping the start and the end', () => {
    expect(limitText('short', 100)).toBe('short');
    const long = 'S'.repeat(50) + 'M'.repeat(500) + 'E'.repeat(50);
    const out = limitText(long, 100);
    expect(out.startsWith('S'.repeat(50))).toBe(true);
    expect(out.endsWith('E'.repeat(20))).toBe(true);
    expect(out.length).toBeLessThan(120);
  });

  it('applies the default 15,000 character limit when finalizing a page', () => {
    const page = finalizePage({ url: 'u', title: 't', text: 'x'.repeat(40_000), jsonLd: [], meta: {} });
    expect(page.text.length).toBeLessThan(15_100);
  });
});

describe('priceAppearsInText (an invented price must not be believed)', () => {
  const eur = `CHRISTIAN DIOR SAUVAGE 100ML EAU DE TOILETTE FOR MEN
€151.00
Tax included. Free shipping above ₹2,000`;

  it('rejects a price the model converted from another currency (EUR 151 became 15,500)', () => {
    expect(priceAppearsInText(eur, 15500)).toBe(false);
  });

  it('accepts a price that is written on the page in rupees, in the usual formats', () => {
    expect(priceAppearsInText('Sale price Rs. 12,400.00 Save Rs. 600.00', 12400)).toBe(true);
    expect(priceAppearsInText('MRP ₹9,999 now ₹8,750', 8750)).toBe(true);
    expect(priceAppearsInText('INR 14900 only', 14900)).toBe(true);
    expect(priceAppearsInText('Price Rs 1,23,456', 123456)).toBe(true); // Indian digit grouping
  });

  it('rounds, so ₹12,399.60 matches 12,400', () => {
    expect(priceAppearsInText('Rs. 12,399.60', 12400)).toBe(true);
  });

  it('needs the page to mention rupees at all', () => {
    expect(priceAppearsInText('Price 12,400', 12400)).toBe(false);
    expect(priceAppearsInText('€12,400', 12400)).toBe(false);
  });

  it('rejects an amount that is simply not there', () => {
    expect(priceAppearsInText('Rs. 12,400.00', 9999)).toBe(false);
  });
});

describe('structured data', () => {
  it('finds Product nodes, including inside @graph and arrays, and skips bad JSON', () => {
    const graph = JSON.stringify({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Product', 'Thing'], name: 'X' }] });
    const found = pickProductJsonLd(['{not json', productLd, graph, JSON.stringify([{ '@type': 'Product', name: 'Y' }])]);
    expect(found.map((p) => p.name)).toEqual(['Dior Sauvage EDT', 'X', 'Y']);
  });

  it('reads an INR price from JSON-LD offers, including comma formats', () => {
    expect(extractStructuredPriceInr({ jsonLd: [productLd], meta: {} })).toBe(8990);
  });

  it('reads lowPrice from an offer list', () => {
    const ld = JSON.stringify({
      '@type': 'Product',
      offers: [{ '@type': 'AggregateOffer', lowPrice: 7500, priceCurrency: 'INR' }],
    });
    expect(extractStructuredPriceInr({ jsonLd: [ld], meta: {} })).toBe(7500);
  });

  it('ignores prices that are not in rupees', () => {
    const usd = JSON.stringify({ '@type': 'Product', offers: { price: 99, priceCurrency: 'USD' } });
    expect(extractStructuredPriceInr({ jsonLd: [usd], meta: {} })).toBeNull();
    expect(
      extractStructuredPriceInr({ jsonLd: [], meta: { 'product:price:amount': '99', 'product:price:currency': 'USD' } }),
    ).toBeNull();
  });

  it('falls back to product meta tags in rupees', () => {
    expect(
      extractStructuredPriceInr({
        jsonLd: [],
        meta: { 'product:price:amount': '6,499', 'product:price:currency': 'INR' },
      }),
    ).toBe(6499);
  });

  it('returns null when there is nothing', () => {
    expect(extractStructuredPriceInr({ jsonLd: [], meta: {} })).toBeNull();
  });
});
