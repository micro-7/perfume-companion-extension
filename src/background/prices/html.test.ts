import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSearchUrl, focusOnPhrase, focusOnProduct, isUnusable, reduceHtml, resolveProductUrl, searchQuery, searchTerms } from './html';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shop = { searchUrl: 'https://www.perfumepalace.in/search?q={query}', domain: 'perfumepalace.in' };
const sauvage = { name: 'Sauvage', brand: 'Dior', concentration: 'Eau de Toilette' };

describe('buildSearchUrl', () => {
  it('searches for brand and name only: extra words make shops return nothing', () => {
    expect(searchQuery(sauvage)).toBe('Dior Sauvage Eau de Toilette'); // the full description is for the model
    expect(buildSearchUrl(shop, sauvage)).toBe('https://www.perfumepalace.in/search?q=Dior%20Sauvage');
  });

  it('drops "Christian" from "Christian Dior" (shops sell it as "Dior"), but keeps other brands whole', () => {
    expect(searchTerms({ brand: 'Christian Dior', name: 'Sauvage' })).toBe('Dior Sauvage');
    expect(searchTerms({ brand: 'Yves Saint Laurent', name: 'Y' })).toBe('Yves Saint Laurent Y');
    expect(searchTerms({ brand: 'Christian', name: 'X' })).toBe('Christian X'); // a one-word brand is kept
  });

  it('encodes special characters', () => {
    expect(buildSearchUrl(shop, { name: "L'Homme & Co", brand: 'YSL', concentration: 'Eau de Parfum' })).toContain('YSL%20L\'Homme%20%26%20Co');
  });
});

describe('reduceHtml', () => {
  const reduced = reduceHtml(fixture('search-results.html'));

  it('removes scripts, styles, svg and noscript content', () => {
    expect(reduced).not.toContain('dataLayer');
    expect(reduced).not.toContain('display: grid');
    expect(reduced).not.toContain('<circle');
    expect(reduced).not.toContain('Please enable JavaScript');
  });

  it('keeps product names, prices and decoded entities', () => {
    expect(reduced).toContain('Dior Sauvage Eau de Toilette 100ml');
    expect(reduced).toContain('₹8,750');
    expect(reduced).toContain("Men's Perfumes");
  });

  it('keeps links as text plus [link: href]', () => {
    expect(reduced).toContain('[link: /products/dior-sauvage-edt-100ml]');
  });

  it('keeps JSON-LD data in a "Structured data" block', () => {
    expect(reduced.startsWith('Structured data:')).toBe(true);
    expect(reduced).toContain('ItemList');
  });

  it('cuts to the size limit', () => {
    expect(reduceHtml('<p>' + 'word '.repeat(5000) + '</p>', 8000).length).toBeLessThanOrEqual(8000);
  });
});

describe('focusOnProduct (long real-world pages)', () => {
  const menu = Array.from({ length: 600 }, (_, i) => `Menu item ${i} Dior Brands Shop All`).join('\n');
  const listing = 'Dior Sauvage Eau de Toilette 100ml [link: /products/dior-sauvage]\n₹8,750\nDior Homme 50ml [link: /products/homme]\n₹5,400';
  const page = `${menu}\n${listing}\n${'Footer text. '.repeat(50)}`;

  it('the plain top-of-page cut misses the product (what the real shops showed)', () => {
    expect(page.length).toBeGreaterThan(20_000);
    expect(page.slice(0, 8000)).not.toContain('Sauvage');
  });

  it('keeps the part around the product listing, with its price and link', () => {
    const focused = focusOnProduct(page, { name: 'Sauvage', brand: 'Dior' });
    expect(focused.length).toBeLessThanOrEqual(8000);
    expect(focused).toContain('Dior Sauvage Eau de Toilette 100ml [link: /products/dior-sauvage]');
    expect(focused).toContain('₹8,750');
  });

  it('finds a listing buried far down, behind look-alikes (Perfume Palace: result 24 of 34, character 27,000)', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Look-alike ${i} Eau de Parfum 100ml Regular price Rs. ${1000 + i}.00 [link: /products/other-${i}]`).join('\n');
    const real = 'Christian Dior Sauvage 100ml Eau De Toilette for Men Regular price Rs. 13,000.00 Sale price Rs. 12,400.00 [link: /products/christian-dior-sauvage-100ml-edt-for-men]';
    const page = `Search: 34 results found for "Dior Sauvage"\nPrice\nFilter\n${filler}\n${real}\nSold Out\n${filler}`;
    expect(page.indexOf(real)).toBeGreaterThan(20_000);
    const focused = focusOnProduct(page, { name: 'Sauvage', brand: 'Christian Dior' });
    expect(focused).toContain('christian-dior-sauvage-100ml-edt-for-men');
    expect(focused).toContain('Sale price Rs. 12,400.00');
    expect(focused.length).toBeLessThan(2000); // only the cards that name it, not the 800 other lines
  });

  it('keeps several matching cards in page order, joined without repeating lines', () => {
    const page = `${menu}\nDior Sauvage EDT 100ml [link: /a]\n₹8,000\nDior Sauvage EDP 60ml [link: /b]\n₹7,000\n${menu}`;
    const focused = focusOnProduct(page, { name: 'Sauvage', brand: 'Dior' });
    expect(focused.indexOf('/a')).toBeLessThan(focused.indexOf('/b'));
    expect(focused.split('Dior Sauvage EDT 100ml').length).toBe(2); // that line appears once
  });

  it('skips a menu mention of the name that has no price nearby', () => {
    const withMenuMention = `Dior Sauvage\n${menu}\n${listing}`;
    const focused = focusOnProduct(withMenuMention, { name: 'Sauvage', brand: 'Dior' });
    expect(focused).toContain('₹8,750');
  });

  it('falls back to the first named line when no price follows, and to the top when the name is absent', () => {
    expect(focusOnProduct(`${menu}\nDior Sauvage sold out\n${menu}`, { name: 'Sauvage', brand: 'Dior' })).toContain('Sauvage sold out');
    expect(focusOnProduct(menu + menu, { name: 'Eros', brand: 'Versace' }).startsWith('Menu item 0')).toBe(true);
  });

  it('keeps structured data from the top of the page', () => {
    const withLd = `Structured data:\n{"@type":"ItemList"}\n\n${page}`;
    const focused = focusOnProduct(withLd, { name: 'Sauvage', brand: 'Dior' });
    expect(focused.startsWith('Structured data:')).toBe(true);
    expect(focused).toContain('₹8,750');
  });

  it('matches every word of a multi-word name', () => {
    const p = `${menu}\nBleu de Chanel Eau de Parfum 100ml\n₹14,500\n${menu}`;
    expect(focusOnProduct(p, { name: 'Bleu de Chanel', brand: 'Chanel' })).toContain('₹14,500');
  });

  it('returns a short page unchanged', () => {
    expect(focusOnProduct('short page', { name: 'Sauvage', brand: 'Dior' })).toBe('short page');
  });
});

describe('focusOnPhrase', () => {
  it('finds a phrase far down text that has no line breaks at all (it used to start from the top)', () => {
    const text = `${'filler. '.repeat(3000)}This perfume reminds me of Luna Rossa Carbon. ${'filler. '.repeat(500)}`;
    const out = focusOnPhrase(text, /reminds me of/i, 2000);
    expect(out).toContain('Luna Rossa Carbon');
    expect(out.length).toBeLessThanOrEqual(2000);
  });

  it('starts just before the phrase on a long page', () => {
    const text = `${'nav line\n'.repeat(3000)}This perfume reminds me of\nBleu de Chanel\nY by YSL\n${'footer\n'.repeat(500)}`;
    const out = focusOnPhrase(text, /reminds me of/i, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain('Bleu de Chanel');
  });
});

describe('isUnusable', () => {
  it('flags HTTP errors', () => {
    expect(isUnusable(403, 'x'.repeat(2000))).toBe(true);
    expect(isUnusable(500, 'x'.repeat(2000))).toBe(true);
    expect(isUnusable(404, 'x'.repeat(2000))).toBe(true);
  });

  it('flags a Cloudflare challenge page even with a 200 status', () => {
    const html = fixture('cloudflare-challenge.html');
    expect(isUnusable(200, reduceHtml(html), html)).toBe(true);
  });

  it('flags a page with almost no text', () => {
    expect(isUnusable(200, 'Loading...')).toBe(true);
  });

  it('accepts a normal results page', () => {
    const html = fixture('search-results.html');
    expect(isUnusable(200, reduceHtml(html), html)).toBe(false);
  });

  it('does not mistake a long real page that mentions "captcha" for a bot check', () => {
    const html = `<p>${'Real product text. '.repeat(400)}</p><!-- recaptcha loaded -->`;
    expect(isUnusable(200, reduceHtml(html), html)).toBe(false);
  });
});

describe('resolveProductUrl', () => {
  it('makes relative links absolute on the shop', () => {
    expect(resolveProductUrl('/products/x', shop)).toBe('https://www.perfumepalace.in/products/x');
  });

  it('accepts absolute links on the shop domain and its subdomains', () => {
    expect(resolveProductUrl('https://perfumepalace.in/p/1', shop)).toBe('https://perfumepalace.in/p/1');
    expect(resolveProductUrl('https://m.perfumepalace.in/p/1', shop)).toBe('https://m.perfumepalace.in/p/1');
  });

  it('rejects other domains, look-alike domains and non-web links', () => {
    expect(resolveProductUrl('https://evil.example.com/products/dior', shop)).toBeNull();
    expect(resolveProductUrl('https://perfumepalace.in.evil.com/p', shop)).toBeNull();
    expect(resolveProductUrl('https://notperfumepalace.in/p', shop)).toBeNull();
    expect(resolveProductUrl('javascript:alert(1)', shop)).toBeNull();
    expect(resolveProductUrl('', shop)).toBeNull();
    expect(resolveProductUrl(undefined, shop)).toBeNull();
  });
});
