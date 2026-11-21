import { describe, expect, it, vi } from 'vitest';
import type { Generate } from '../llm';
import type { PageData } from '../shared/types';
import { buildDetectionPrompt, cleanPerfumeName, detectPerfume, fromFragranticaUrl, namedByPage, parseDetection, toDetection } from './detect';
import { fakeGenerate } from '../test/fakes';
import { BadResponseError } from '../llm/errors';

const page = (over: Partial<PageData> = {}): PageData => ({
  url: 'https://www.amazon.in/dp/B0',
  title: 'Dior Sauvage EDT 100ml',
  text: 'Dior Sauvage Eau de Toilette 100ml ₹9,200',
  jsonLd: [],
  meta: {},
  ...over,
});

const raw = (over: Record<string, unknown> = {}) => ({
  found: true,
  name: 'Sauvage',
  brand: 'Dior',
  concentration: 'Eau de Toilette',
  notes: { top: ['Bergamot'], heart: [], base: [], flat: [] },
  currentPrice: { amountInr: 9200, siteName: 'Amazon.in' },
  ...over,
});

describe('detection result handling', () => {
  it('returns the perfume, the notes on the page and the price', () => {
    const d = toDetection(parseDetection(raw()), page());
    expect(d.found).toBe(true);
    expect(d.perfume).toEqual({ name: 'Sauvage', brand: 'Dior', concentration: 'Eau de Toilette' });
    expect(d.pageNotes.top).toEqual(['Bergamot']);
    expect(d.currentPrice).toEqual({ amountInr: 9200, siteName: 'Amazon.in' });
  });

  it('treats found:false, a missing name or a missing brand as not found', () => {
    for (const over of [{ found: false }, { name: '' }, { brand: '  ' }]) {
      const d = toDetection(parseDetection(raw(over)), page());
      expect(d.found).toBe(false);
      expect(d.perfume).toBeNull();
    }
  });

  it('prefers the price in the page structured data over the model reading', () => {
    const ld = JSON.stringify({ '@type': 'Product', offers: { price: 8990, priceCurrency: 'INR' } });
    const d = toDetection(parseDetection(raw()), page({ jsonLd: [ld] }));
    expect(d.currentPrice.amountInr).toBe(8990);
  });

  it('does not believe a price the model converted from another currency (a page showing EUR 151.00)', () => {
    const eurPage = page({ text: `CHRISTIAN DIOR SAUVAGE 100ML EAU DE TOILETTE
€151.00
Tax included.`, url: 'https://perfumepalace.in/products/x' });
    const d = toDetection(parseDetection(raw({ currentPrice: { amountInr: 15500, siteName: 'Perfume Palace' } })), eurPage);
    expect(d.currentPrice.amountInr).toBeNull();
  });

  it('keeps a model price that really is written on the page in rupees', () => {
    const d = toDetection(parseDetection(raw({ currentPrice: { amountInr: 12400, siteName: 'Perfume Palace' } })), page({ text: 'Sauvage Regular price Rs. 13,000.00 Sale price Rs. 12,400.00' }));
    expect(d.currentPrice.amountInr).toBe(12400);
  });

  it('uses no price when neither source has one (0 means unknown)', () => {
    const d = toDetection(parseDetection(raw({ currentPrice: { amountInr: 0, siteName: '' } })), page());
    expect(d.currentPrice.amountInr).toBeNull();
    expect(d.currentPrice.siteName).toBe('amazon.in');
  });

  it('works when notes and price are left out of the answer', () => {
    const d = toDetection(parseDetection({ found: true, name: 'Sauvage', brand: 'Dior' }), page());
    expect(d.found).toBe(true);
    expect(d.pageNotes).toEqual({ top: [], heart: [], base: [], flat: [] });
  });

  it('drops an ingredient list the model mistook for notes', () => {
    const d = toDetection(
      parseDetection(
        raw({ notes: { top: [], heart: [], base: [], flat: ['Alcohol', 'Parfum (Fragrance)', 'Aqua (Water)', 'Limonene'] } }),
      ),
      page(),
    );
    expect(d.pageNotes.flat).toEqual([]);
  });

  it('rejects an answer that is not an object or has no found flag', () => {
    expect(() => parseDetection('hello')).toThrow(BadResponseError);
    expect(() => parseDetection({ name: 'x' })).toThrow(BadResponseError);
  });

  it('puts the URL, title and page text in the prompt', () => {
    const prompt = buildDetectionPrompt(page({ meta: { 'og:site_name': 'Amazon' } }));
    expect(prompt).toContain('https://www.amazon.in/dp/B0');
    expect(prompt).toContain('Dior Sauvage Eau de Toilette 100ml');
    expect(prompt).toContain('og:site_name: Amazon');
  });

  it('runs the model and converts the result', async () => {
    const generate = vi.fn(async (r: { parse: (x: unknown) => unknown }) => ({
      data: r.parse(raw()),
      provider: 'gemini' as const,
    })) as unknown as Generate;
    const d = await detectPerfume(generate, page());
    expect(d.perfume?.brand).toBe('Dior');
  });
});

describe('cleaning what a small local model returns', () => {
  const clean = (n: string, b: string, c = '') => cleanPerfumeName(n, b, c);

  it('reduces a whole shop title to the perfume name and keeps the concentration', () => {
    expect(clean('Christian Dior Sauvage Eau de Toilette Spray For Men (Citrus)', 'Christian Dior')).toEqual({
      name: 'Sauvage',
      concentration: 'Eau de Toilette',
    });
    expect(clean('Dior Sauvage EDP 100 ml', 'Dior')).toEqual({ name: 'Sauvage', concentration: 'Eau de Parfum' });
  });

  it('leaves clean names alone, including names that look like descriptions', () => {
    for (const [n, b] of [
      ['Sauvage', 'Dior'],
      ['Sauvage Elixir', 'Dior'],
      ['Sauvage Parfum', 'Dior'],
      ['Bleu de Chanel', 'Chanel'],
      ['Ventana Pour Homme', 'Armaf'],
      ['Eau Sauvage', 'Dior'],
      ['Club de Nuit Intense Man', 'Armaf'],
    ]) {
      expect(clean(n, b).name).toBe(n);
    }
  });

  it('keeps a concentration the model already gave', () => {
    expect(clean('Sauvage Eau de Toilette', 'Dior', 'Eau de Parfum').concentration).toBe('Eau de Parfum');
  });
});

describe('the current-page price from the small local model', () => {
  const amazonText = '₹17,900 ₹17,900 ₹17,900 ₹17,900 EMI ₹629 Other sellers ₹298 delivery';
  const amazon = page({ text: amazonText });

  it('replaces a price the page shows once when another is shown many times more often (local model only)', () => {
    const d = toDetection(parseDetection(raw({ currentPrice: { amountInr: 298, siteName: 'Amazon' } })), amazon, true);
    expect(d.currentPrice.amountInr).toBe(17900);
  });

  it('does not touch Gemini answers', () => {
    const d = toDetection(parseDetection(raw({ currentPrice: { amountInr: 298, siteName: 'Amazon' } })), amazon, false);
    expect(d.currentPrice.amountInr).toBe(298);
  });

  it('keeps the local model price when it is the common one', () => {
    const d = toDetection(parseDetection(raw({ currentPrice: { amountInr: 17900, siteName: 'Amazon' } })), amazon, true);
    expect(d.currentPrice.amountInr).toBe(17900);
  });
});

describe('a small local model saying "not a perfume" on a priced shop page', () => {
  const shop = page({ text: 'Dior Sauvage 100ml ₹9,200 Add to cart' });

  it('asks once more and uses the second answer', async () => {
    let n = 0;
    const generate = fakeGenerate(() => (n++ === 0 ? raw({ found: false }) : raw()), 'ollama');
    const d = await detectPerfume(generate, shop);
    expect(d.found).toBe(true);
    expect(generate.calls).toHaveLength(2);
  });

  it('does not ask again on a page that is not a shop page', async () => {
    const generate = fakeGenerate(() => raw({ found: false }), 'ollama');
    const d = await detectPerfume(generate, page({ text: 'Wikipedia: the encyclopedia' }));
    expect(d.found).toBe(false);
    expect(generate.calls).toHaveLength(1);
  });

  it('never makes the extra request for Gemini', async () => {
    const generate = fakeGenerate(() => raw({ found: false }), 'gemini');
    const d = await detectPerfume(generate, shop);
    expect(d.found).toBe(false);
    expect(generate.calls).toHaveLength(1);
  });
});

describe('a small local model naming the wrong perfume (Fragrantica page, "Cool Water" answer)', () => {
  const frag = page({
    url: 'https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html',
    title: 'Sauvage Dior cologne - a fragrance for men 2015',
    text: 'Sauvage Dior for men Perfume Encyclopedia Latest Reviews Cool Water YVIDOFF ...',
  });
  const wrong = () => raw({ name: 'Cool Water', brand: 'YVIDOFF', concentration: 'Parfum' });

  it('reads the perfume from the page address when the local model keeps naming another one', async () => {
    const generate = fakeGenerate(wrong, 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume).toMatchObject({ name: 'Sauvage', brand: 'Dior' });
    expect(generate.calls).toHaveLength(2);
    expect(generate.calls[1].prompt).toContain('Sauvage Dior cologne');
    expect(generate.calls[1].prompt).toContain('the perfume is "Sauvage"');
  });

  it('uses the second answer when it names the right perfume', async () => {
    let n = 0;
    const generate = fakeGenerate(() => (n++ === 0 ? wrong() : raw({ name: 'Sauvage', brand: 'Dior', concentration: '' })), 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume).toMatchObject({ name: 'Sauvage', brand: 'Dior' });
  });

  it('does not ask again when the first answer is the page perfume', async () => {
    const generate = fakeGenerate(() => raw({ name: 'Sauvage', brand: 'Dior' }), 'ollama');
    await detectPerfume(generate, frag);
    expect(generate.calls).toHaveLength(1);
  });

  it('on a shop page with no address hint, a wrong answer twice means "not detected", not the wrong perfume', async () => {
    const shop = page({ title: 'Dior Sauvage 100ml', text: 'Sauvage ₹9,200 Add to cart Cool Water ₹1,000' });
    const generate = fakeGenerate(wrong, 'ollama');
    const d = await detectPerfume(generate, shop);
    expect(d.found).toBe(false);
  });

  it('leaves Gemini alone: its answer is used and no second request is made', async () => {
    const generate = fakeGenerate(wrong, 'gemini');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume?.name).toBe('Cool Water');
    expect(generate.calls).toHaveLength(1);
  });
});

describe('namedByPage and fromFragranticaUrl', () => {
  it('matches the perfume to the title or address', () => {
    expect(namedByPage({ name: 'Sauvage', brand: 'Dior', concentration: '' }, page())).toBe(true);
    expect(namedByPage({ name: 'Cool Water', brand: 'Davidoff', concentration: '' }, page())).toBe(false);
    expect(namedByPage({ name: 'Y', brand: 'Yves Saint Laurent', concentration: '' }, page({ title: 'Y Eau de Parfum - Yves Saint Laurent' }))).toBe(true);
  });

  it('reads brand and name out of a Fragrantica address', () => {
    expect(fromFragranticaUrl('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html')).toEqual({ brand: 'Dior', name: 'Sauvage' });
    expect(fromFragranticaUrl('https://www.fragrantica.com/perfume/Maison-Alhambra/Salvo-12345.html')).toEqual({ brand: 'Maison Alhambra', name: 'Salvo' });
    expect(fromFragranticaUrl('https://www.amazon.in/dp/B0')).toBeNull();
    expect(fromFragranticaUrl('https://www.fragrantica.com/news/some-article-1.html')).toBeNull();
  });
});

describe('the extra check must never turn a good answer into an error', () => {
  it('keeps the first answer when the second request fails and there is no address hint', async () => {
    const shop = page({ title: 'Dior Sauvage 100ml', text: 'Sauvage ₹9,200 Add to cart' });
    let n = 0;
    const generate = fakeGenerate(() => {
      if (n++ === 0) return raw({ found: false });
      throw new Error('Ollama returned HTTP 500');
    }, 'ollama');
    const d = await detectPerfume(generate, shop);
    expect(d.found).toBe(false);
  });

  it('on Fragrantica, a failing second request falls back to the address', async () => {
    const frag = page({ url: 'https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html', title: 'Sauvage Dior cologne - a fragrance for men' });
    let n = 0;
    const generate = fakeGenerate(() => {
      if (n++ === 0) return raw({ name: 'Cool Water', brand: 'YVIDOFF' });
      throw new Error('Ollama returned HTTP 500');
    }, 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume).toMatchObject({ name: 'Sauvage', brand: 'Dior' });
  });
});

describe('local model says "not a perfume" on a Fragrantica perfume page', () => {
  const frag = page({
    url: 'https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html',
    title: 'Sauvage Dior cologne - a fragrance for men 2015',
    text: 'Sauvage Dior for men Perfume Encyclopedia Latest Reviews',
  });

  it('asks again, then uses the perfume named in the address', async () => {
    const generate = fakeGenerate(() => raw({ found: false }), 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume).toMatchObject({ name: 'Sauvage', brand: 'Dior' });
    expect(generate.calls).toHaveLength(2);
  });

  it('does not do this for Gemini', async () => {
    const generate = fakeGenerate(() => raw({ found: false }), 'gemini');
    const d = await detectPerfume(generate, frag);
    expect(d.found).toBe(false);
    expect(generate.calls).toHaveLength(1);
  });

  it('a Fragrantica page that is not a perfume page (a news article) is still "not detected"', async () => {
    const news = page({ url: 'https://www.fragrantica.com/news/Some-Article-1234.html', title: 'Some article', text: 'News' });
    const generate = fakeGenerate(() => raw({ found: false }), 'ollama');
    const d = await detectPerfume(generate, news);
    expect(d.found).toBe(false);
    expect(generate.calls).toHaveLength(1);
  });
});

describe('local model repeats the brand as the name (Up At Dawn by Maison Martin Margiela)', () => {
  const frag = page({
    url: 'https://www.fragrantica.com/perfume/Maison-Martin-Margiela/Up-At-Dawn-120743.html',
    title: 'Up At Dawn Maison Martin Margiela for women and men',
    text: 'Up At Dawn Maison Martin Margiela for women and men Perfume Encyclopedia',
  });

  it('does not accept the brand as the perfume name; uses the address', async () => {
    const generate = fakeGenerate(() => raw({ name: 'Maison Martin Margiela', brand: 'MAISON MARTIN MARGIELA' }), 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume).toMatchObject({ name: 'Up At Dawn', brand: 'Maison Martin Margiela' });
  });

  it('accepts the right name straight away, with no second request', async () => {
    const generate = fakeGenerate(() => raw({ name: 'Up At Dawn', brand: 'Maison Martin Margiela' }), 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume?.name).toBe('Up At Dawn');
    expect(generate.calls).toHaveLength(1);
  });

  it('a name with words the page does not have ("Replica ...") falls back to the address name', async () => {
    const generate = fakeGenerate(() => raw({ name: 'Replica Up At Dawn', brand: 'Maison Martin Margiela' }), 'ollama');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume?.name).toBe('Up At Dawn');
  });

  it('keeps Gemini as it is', async () => {
    const generate = fakeGenerate(() => raw({ name: 'Maison Martin Margiela', brand: 'Maison Martin Margiela' }), 'gemini');
    const d = await detectPerfume(generate, frag);
    expect(d.perfume?.name).toBe('Maison Martin Margiela');
    expect(generate.calls).toHaveLength(1);
  });
});
