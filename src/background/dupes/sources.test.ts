import { describe, expect, it } from 'vitest';
import { SearchUnavailableError } from '../../llm/errors';
import { fakeFetch, fakeGenerate } from '../../test/fakes';
import { alsoInSection, buildLlmDupesPrompt, FRAGRANTICA_DEPTH, fragranticaSimilar, isFragranticaUrl, llmDupes, onlyNamedInText, parseLlmDupes, parseSimilar } from './sources';

const sauvage = { name: 'Sauvage', brand: 'Dior', concentration: '' };
const signal = new AbortController().signal;
const page = (url: string, text = 'page text') => ({ url, title: 't', text, jsonLd: [], meta: {} });

const similar = (pageUrl: string, items: Array<[string, string]>) => ({
  pageUrl,
  similar: items.map(([name, brand]) => ({ name, brand })),
});

describe('AI dupe suggestions', () => {
  it('parses, drops entries without name or brand, and keeps at most 8', () => {
    const raw = { dupes: [...Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, brand: 'B', similarity: 80, reason: 'r' })), { name: '', brand: 'X' }] };
    const out = parseLlmDupes(raw);
    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({ source: 'llm', similarity: 80 });
    expect(() => parseLlmDupes({ dupes: 'no' })).toThrow();
  });

  it('tells the model not to include the original perfume or its flankers', () => {
    const prompt = buildLlmDupesPrompt(sauvage);
    expect(prompt).toMatch(/Do NOT include Dior Sauvage itself/);
    expect(prompt).toMatch(/flankers/);
  });

  it('asks the model and returns candidates', async () => {
    const generate = fakeGenerate(() => ({ dupes: [{ name: 'Club de Nuit Intense Man', brand: 'Armaf', similarity: 85, reason: 'same fresh opening' }] }));
    const out = await llmDupes(generate, sauvage, signal);
    expect(out[0].name).toBe('Club de Nuit Intense Man');
    expect(generate.calls[0].prompt).toContain('Dior Sauvage');
  });
});

describe('isFragranticaUrl', () => {
  it('accepts fragrantica hosts only', () => {
    expect(isFragranticaUrl('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html')).toBe(true);
    expect(isFragranticaUrl('https://fragrantica.com/x')).toBe(true);
    expect(isFragranticaUrl('https://fragrantica.com.evil.io/x')).toBe(false);
    expect(isFragranticaUrl('nope')).toBe(false);
  });

  it('parses a similar-perfumes answer', () => {
    expect(parseSimilar(similar('u', [['A', 'B']])).similar).toHaveLength(1);
    expect(() => parseSimilar({ similar: 'x' })).toThrow();
  });
});

describe('onlyNamedInText (the AI must not add perfumes that are not on the page)', () => {
  const text = 'this perfume reminds me of prada luna rossa carbon eau de toilette. armaf club de nuit urban elixir. y by yves saint laurent.';
  const item = (name: string, brand = 'B') => ({ name, brand });

  it('keeps a perfume whose name is written on the page, however the AI spelled the case', () => {
    expect(onlyNamedInText([item('Luna Rossa Carbon'), item('Club De Nuit Urban Elixir')], text)).toHaveLength(2);
  });

  it("drops a perfume from the AI's memory that is not on the page (Bleu de Chanel)", () => {
    expect(onlyNamedInText([item('Bleu de Chanel Eau de Parfum'), item('Luna Rossa Carbon')], text).map((s) => s.name)).toEqual(['Luna Rossa Carbon']);
  });

  it("checks a one-letter name such as YSL's 'Y' as a word of its own", () => {
    expect(onlyNamedInText([item('Y')], text)).toHaveLength(1);
    expect(onlyNamedInText([item('Y')], 'this perfume reminds me of luna rossa carbon')).toHaveLength(0); // "y" only inside other words
  });

  it('drops an empty name', () => {
    expect(onlyNamedInText([item('')], text)).toEqual([]);
  });
});

describe('how much of the Fragrantica list is read', () => {
  it('reads up to 30 entries, not just the first 10 (the carousel is long)', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Perfume Number${i}`);
    const generate = fakeGenerate(() => similar('', names.map((n) => [n, 'Brand'] as [string, string])));
    const text = `This perfume reminds me of ${names.join(' ')}`;
    const r = await fragranticaSimilar({ name: 'Sauvage', brand: 'Dior', concentration: '' }, { url: 'https://www.fragrantica.com/p', title: 't', text, jsonLd: [], meta: {} }, { generate, signal: new AbortController().signal });
    expect(r.available && r.candidates).toHaveLength(FRAGRANTICA_DEPTH);
    expect(FRAGRANTICA_DEPTH).toBe(30);
    expect(r.available && r.candidates[29].position).toBe(29);
  });
});

describe('fragranticaSimilar on a real-looking Fragrantica page', () => {
  const FR = 'https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html';
  const lonely = (text: string, fullText?: string) => ({ ...page(FR, text), fullText });
  const run = (generate: ReturnType<typeof fakeGenerate>, p: ReturnType<typeof lonely>) =>
    fragranticaSimilar(sauvage, p, { generate, signal });

  it('reads the list in the page order, so the first non-Dior perfume is first (the real Sauvage page)', async () => {
    const generate = fakeGenerate(() =>
      similar('', [['Luna Rossa Carbon Eau de Toilette', 'Prada'], ['Sauvage Eau de Parfum', 'Dior'], ['Club De Nuit Urban Elixir', 'Armaf'], ['Ventana Pour Homme', 'Armaf']]),
    );
    const text = 'x. This perfume reminds me of PRADA Luna Rossa Carbon Eau de Toilette DIOR Sauvage Eau de Parfum ARMAF Club De Nuit Urban Elixir DIOR Sauvage Very Cool Spray ARMAF Ventana Pour Homme';
    const r = await run(generate, lonely(text));
    expect(r.available && r.candidates.map((c) => c.name)).toEqual(['Luna Rossa Carbon Eau de Toilette', 'Sauvage Eau de Parfum', 'Club De Nuit Urban Elixir', 'Ventana Pour Homme']);
  });

  it('does NOT show perfumes the AI made up when the list is not in the page text (it may load only on scroll)', async () => {
    // the page has no "reminds me of" section, and the AI answers from memory anyway
    const generate = fakeGenerate(() => similar('', [['Bleu de Chanel Eau de Parfum', 'Chanel'], ['Y Eau de Parfum', 'Yves Saint Laurent']]));
    const r = await run(generate, lonely('Sauvage Dior for men. Perfume Encyclopedia. Latest reviews.'));
    expect(r).toEqual({ available: false, reason: 'not-on-page' });
    expect(generate.calls).toHaveLength(0);
  });

  it('drops invented names even when the section heading is there', async () => {
    const generate = fakeGenerate(() => similar('', [['Bleu de Chanel Eau de Parfum', 'Chanel'], ['Luna Rossa Carbon', 'Prada']]));
    const r = await run(generate, lonely('This perfume reminds me of PRADA Luna Rossa Carbon. Reviews.'));
    expect(r.available && r.candidates.map((c) => c.name)).toEqual(['Luna Rossa Carbon']);
  });

  it('says "not on the page" when every name the AI gave is invented', async () => {
    const generate = fakeGenerate(() => similar('', [['Bleu de Chanel Eau de Parfum', 'Chanel']]));
    const r = await run(generate, lonely('This perfume reminds me of nothing we can read.'));
    expect(r).toEqual({ available: false, reason: 'not-on-page' });
  });

  it('uses the whole page text, because the cut-down text can lose a section low on a long page', async () => {
    const generate = fakeGenerate(() => similar('', [['Luna Rossa Carbon', 'Prada']]));
    const cutDown = 'head of page. ...'; // what detection sees: the middle is gone
    const whole = `${'filler. '.repeat(3000)}This perfume reminds me of PRADA Luna Rossa Carbon. ${'filler. '.repeat(500)}`;
    const r = await run(generate, lonely(cutDown, whole));
    expect(r.available && r.candidates[0].name).toBe('Luna Rossa Carbon');
    expect(generate.calls[0].prompt).toContain('This perfume reminds me of');
  });
});

describe('fragranticaSimilar', () => {
  const frag = (generate: ReturnType<typeof fakeGenerate>, p = null as ReturnType<typeof page> | null, fetchImpl?: typeof fetch) =>
    fragranticaSimilar(sauvage, p, { generate, signal, fetchImpl });

  it('uses the current page when the user is on Fragrantica, with no search and no fetch', async () => {
    const generate = fakeGenerate(() => similar('', [['Bleu de Chanel Eau de Parfum', 'Chanel'], ['Dior Homme Cologne', 'Dior']]));
    const fetchImpl = fakeFetch({});
    const text = 'Sauvage Dior for men. This perfume reminds me of Bleu de Chanel Eau de Parfum Dior Homme Cologne. Reviews.';
    const r = await frag(generate, page('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html', text), fetchImpl);

    expect(r).toMatchObject({ available: true });
    if (r.available) expect(r.candidates.map((c) => [c.name, c.position, c.source])).toEqual([['Bleu de Chanel Eau de Parfum', 0, 'fragrantica'], ['Dior Homme Cologne', 1, 'fragrantica']]);
    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0].grounding).toBeUndefined();
    expect(generate.calls[0].prompt).toContain('This perfume reminds me of Bleu de Chanel');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('on another site: finds the page with grounded search, fetches it, and reads the list from it', async () => {
    const html = `<html><body>${'Fragrantica page text. '.repeat(40)}<h2>This perfume reminds me of</h2><p>Y by YSL</p></body></html>`;
    const fetchImpl = fakeFetch({ 'fragrantica.com': { html } });
    const generate = fakeGenerate((req) =>
      req.grounding ? similar('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html', []) : similar('', [['Y', 'Yves Saint Laurent']]),
    );
    const r = await frag(generate, page('https://www.amazon.in/dp/B0'), fetchImpl);

    expect(generate.calls[0].grounding).toEqual({ site: 'fragrantica.com' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html');
    expect(generate.calls).toHaveLength(2);
    expect(r.available && r.candidates[0].name).toBe('Y');
  });

  it('when the fetch is blocked, uses the list from the grounded answer', async () => {
    const fetchImpl = fakeFetch({ 'fragrantica.com': { status: 403, html: 'Just a moment...' } });
    const generate = fakeGenerate(() => similar('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html', [['From grounded', 'Brand']]));
    const r = await frag(generate, null, fetchImpl);
    expect(r.available && r.candidates[0].name).toBe('From grounded');
    expect(generate.calls).toHaveLength(1);
  });

  it('ignores a page URL that is not on Fragrantica', async () => {
    const fetchImpl = fakeFetch({});
    const generate = fakeGenerate(() => similar('https://evil.example.com/x', [['Listed', 'Brand']]));
    const r = await frag(generate, null, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.available && r.candidates[0].name).toBe('Listed');
  });

  it('is unavailable when there is no list, when search is unavailable, or on any error', async () => {
    expect(await frag(fakeGenerate(() => similar('', [])))).toEqual({ available: false });
    expect(
      await frag(
        fakeGenerate(() => {
          throw new SearchUnavailableError();
        }),
      ),
    ).toEqual({ available: false });
    // on a Fragrantica page whose text has no such section: say so, and do not ask the AI at all
    const noSection = fakeGenerate(() => similar('', [['Invented', 'Brand']]));
    expect(await frag(noSection, page('https://www.fragrantica.com/p'))).toEqual({ available: false, reason: 'not-on-page' });
    expect(noSection.calls).toHaveLength(0);
    // a model error while reading the page is just "unavailable"
    expect(
      await frag(
        fakeGenerate(() => {
          throw new Error('boom');
        }),
        page('https://www.fragrantica.com/p', 'This perfume reminds me of Something'),
      ),
    ).toEqual({ available: false });
  });

  it('stops with an error when the lookup is cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const generate = fakeGenerate(() => {
      throw new Error('aborted');
    });
    await expect(fragranticaSimilar(sauvage, null, { generate, signal: ac.signal })).rejects.toThrow();
  });
});

describe('alsoInSection (AI suggestions that are written in Fragrantica\'s list)', () => {
  const section = 'This perfume reminds me of Prada Luna Rossa Carbon Armaf Club De Nuit Urban Elixir Lattafa Asad Zanzibar';
  const ai = (name: string, brand: string) => ({ name, brand, source: 'llm' as const, similarity: 80 });

  it('returns a suggestion whose whole name and brand are in the list text', () => {
    const r = alsoInSection([ai('Asad', 'Lattafa')], section, 5);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'Asad', source: 'fragrantica', position: 5 });
  });

  it('ignores one whose name is not there, or only some of whose words are', () => {
    expect(alsoInSection([ai('Kuro', 'Ajmal'), ai('Club De Nuit Intense', 'Armaf')], section, 0)).toEqual([]);
  });

  it('ignores a name that is there under a different brand', () => {
    expect(alsoInSection([ai('Asad', 'Armani')], section, 0)).toEqual([]);
  });
});
