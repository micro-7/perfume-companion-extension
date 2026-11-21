import { describe, expect, it } from 'vitest';
import { perfumeKey } from '../../shared/cache';
import { fakeFetch, fakeGenerate, memoryCache } from '../../test/fakes';
import { lookupDupes } from './orchestrate';

const sauvage = { name: 'Sauvage', brand: 'Dior', concentration: '' };
const frPage = {
  url: 'https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html',
  title: 't',
  text: 'Sauvage Dior for men. This perfume reminds me of Club de Nuit Intense Man by Armaf Y Yves Saint Laurent. Latest reviews.',
  jsonLd: [],
  meta: {},
};

const llmAnswer = {
  dupes: [
    { name: 'Armaf Club de Nuit Intense Man', brand: 'Armaf', similarity: 85, reason: 'fresh' },
    { name: 'Sauvage Elixir', brand: 'Dior', similarity: 95, reason: 'flanker' },
    { name: 'Eros', brand: 'Versace', similarity: 60, reason: '' },
  ],
};
const fragAnswer = {
  pageUrl: '',
  similar: [
    { name: 'Club de Nuit Intense Man by Armaf', brand: 'Armaf' },
    { name: 'Y', brand: 'Yves Saint Laurent' },
  ],
};

function setup(handler: (req: { prompt: string; grounding?: unknown }) => unknown) {
  const generate = fakeGenerate(handler as never);
  const cache = memoryCache();
  return { generate, cache, deps: { generate, cache, signal: new AbortController().signal, fetchImpl: fakeFetch({}) } };
}
const isFrag = (req: { prompt: string }) => req.prompt.startsWith('Fragrantica') || req.prompt.includes('fragrantica.com');

describe('lookupDupes', () => {
  it('asks both sources, merges, cross-checks and ranks them into one list', async () => {
    const t = setup((req) => (isFrag(req) ? fragAnswer : llmAnswer));
    const r = await lookupDupes(sauvage, frPage, t.deps);

    expect(t.generate.calls).toHaveLength(2);
    expect(r.trustedAvailable).toBe(true);
    // the flanker is gone; the cross-confirmed dupe (both sources) is first
    expect(r.dupes.map((d) => d.name)).toEqual(['Club de Nuit Intense Man', 'Y', 'Eros']);
    expect(r.dupes[0].confirmed).toBe(true);
    expect(r.dupes[1].confirmed).toBe(false);
  });

  it('runs the two sources at the same time', async () => {
    const started: string[] = [];
    const generate = fakeGenerate((req) => {
      started.push(isFrag(req) ? 'frag' : 'llm');
      return isFrag(req) ? fragAnswer : llmAnswer;
    });
    await lookupDupes(sauvage, frPage, { generate, cache: memoryCache(), signal: new AbortController().signal });
    expect(started.sort()).toEqual(['frag', 'llm']);
  });

  it('still returns the AI list when Fragrantica is unavailable, and says so', async () => {
    const t = setup((req) => {
      if (isFrag(req)) throw new Error('blocked');
      return llmAnswer;
    });
    const r = await lookupDupes(sauvage, frPage, t.deps);
    expect(r.trustedAvailable).toBe(false);
    expect(r.dupes.map((d) => d.name)).toEqual(['Club de Nuit Intense Man', 'Eros']);
    expect(r.dupes.every((d) => !d.confirmed)).toBe(true);
  });

  it('fails when the AI source fails (so the card can offer Retry)', async () => {
    const t = setup((req) => {
      if (isFrag(req)) return fragAnswer;
      throw new Error('no ai');
    });
    await expect(lookupDupes(sauvage, frPage, t.deps)).rejects.toThrow('no ai');
  });

  it('caches the list and answers from the cache next time', async () => {
    const t = setup((req) => (isFrag(req) ? fragAnswer : llmAnswer));
    await lookupDupes(sauvage, frPage, t.deps);
    const calls = t.generate.calls.length;
    const again = await lookupDupes(sauvage, frPage, t.deps);
    expect(t.generate.calls.length).toBe(calls);
    expect(again.dupes.length).toBeGreaterThan(0);
  });

  describe('lists written by the local Ollama model', () => {
    const answerFor = (req: { prompt: string }) => (isFrag(req) ? fragAnswer : llmAnswer);
    const withProvider = (provider: 'gemini' | 'ollama', handler = answerFor) => {
      const generate = fakeGenerate(handler as never, provider);
      const cache = memoryCache();
      return { generate, cache, deps: { generate, cache, signal: new AbortController().signal, fetchImpl: fakeFetch({}) } };
    };

    it('shows the list but does not store it', async () => {
      const t = withProvider('ollama');
      const r = await lookupDupes(sauvage, frPage, t.deps);
      expect(r.dupes.length).toBeGreaterThan(0);
      expect(t.cache.store.size).toBe(0);
    });

    it('asks again next time, and a later Gemini list replaces it and is stored', async () => {
      const cache = memoryCache();
      const local = fakeGenerate(answerFor as never, 'ollama');
      await lookupDupes(sauvage, frPage, { generate: local, cache, signal: new AbortController().signal });
      expect(cache.store.size).toBe(0);

      const gemini = fakeGenerate(answerFor as never, 'gemini');
      const r = await lookupDupes(sauvage, frPage, { generate: gemini, cache, signal: new AbortController().signal });
      expect(gemini.calls.length).toBeGreaterThan(0); // nothing stale was served
      expect(r.dupes.length).toBeGreaterThan(0);
      expect(cache.store.size).toBe(1);
    });

    it('does not store the list if only one of the two sources came from Ollama', async () => {
      const cache = memoryCache();
      const gemini = fakeGenerate(answerFor as never, 'gemini');
      const mixed = (async (req: Parameters<typeof gemini>[0], signal?: AbortSignal) => {
        const r = await gemini(req, signal);
        return isFrag(req) ? { ...r, provider: 'ollama' as const } : r;
      }) as typeof gemini;
      await lookupDupes(sauvage, frPage, { generate: mixed, cache, signal: new AbortController().signal });
      expect(cache.store.size).toBe(0);
    });

    it('still serves a list that Gemini cached earlier', async () => {
      const cache = memoryCache();
      await lookupDupes(sauvage, frPage, { generate: fakeGenerate(answerFor as never, 'gemini'), cache, signal: new AbortController().signal });
      const local = fakeGenerate(answerFor as never, 'ollama');
      const r = await lookupDupes(sauvage, frPage, { generate: local, cache, signal: new AbortController().signal });
      expect(local.calls).toHaveLength(0);
      expect(r.dupes.length).toBeGreaterThan(0);
    });
  });

  it("ignores a dupe list saved by an older version (it may hold perfumes the AI remembered, not the page's list)", async () => {
    const t = setup((req) => (isFrag(req) ? fragAnswer : llmAnswer));
    const stale = { dupes: [{ key: 'chanel|bleu de chanel', name: 'Bleu de Chanel', brand: 'Chanel', similarity: 70, confirmed: false, reason: '' }], trustedAvailable: true, few: true };
    t.cache.store.set(`dupes:${perfumeKey(sauvage)}`, stale); // the old key format, no version
    const r = await lookupDupes(sauvage, frPage, t.deps);
    expect(t.generate.calls.length).toBeGreaterThan(0); // asked afresh
    expect(r.dupes.map((d) => d.name)).not.toContain('Bleu de Chanel');
  });

  it('does not cache an empty result', async () => {
    const t = setup((req) => (isFrag(req) ? { pageUrl: '', similar: [] } : { dupes: [] }));
    const r = await lookupDupes(sauvage, frPage, t.deps);
    expect(r.few).toBe(true);
    expect(t.cache.store.size).toBe(0);
  });
});
