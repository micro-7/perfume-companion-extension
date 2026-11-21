import { describe, expect, it, vi } from 'vitest';
import type { Generate } from '../llm';
import type { Notes, Perfume } from '../shared/types';
import { countSentences, getNotes, mergeNotes, parseNotes, trimToSentences } from './notes';

const perfume: Perfume = { name: 'Sauvage', brand: 'Dior', concentration: '' };
const none: Notes = { top: [], heart: [], base: [], flat: [] };

function fakeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T>(k: string) => (store.get(k) as T | undefined) ?? null,
    set: async <T>(k: string, v: T) => {
      store.set(k, v);
    },
  };
}

const answer = (description: string, extra: Partial<Notes> = {}) => ({
  top: ['Bergamot', 'Pepper'],
  heart: ['Lavender'],
  base: ['Ambroxan'],
  flat: [],
  description,
  ...extra,
});

function generateFrom(...answers: unknown[]): Generate & { calls: number } {
  return generateWith('gemini', ...answers);
}

function generateWith(provider: 'gemini' | 'ollama', ...answers: unknown[]): Generate & { calls: number } {
  let i = 0;
  const fn = (async (req: { parse: (x: unknown) => unknown }) => {
    fn.calls++;
    return { data: req.parse(answers[Math.min(i++, answers.length - 1)]), provider };
  }) as unknown as Generate & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('sentences', () => {
  it('counts and trims sentences', () => {
    expect(countSentences('Fresh and peppery.')).toBe(1);
    expect(countSentences('Fresh. Peppery! A bit woody?')).toBe(3);
    expect(countSentences('One. Two. Three. Four.')).toBe(4);
    expect(countSentences('')).toBe(0);
    expect(trimToSentences('One. Two. Three. Four.', 3)).toBe('One. Two. Three.');
  });
});

describe('mergeNotes', () => {
  it('keeps page notes and fills the tiers the page does not list', () => {
    const merged = mergeNotes(
      { ...none, top: ['Lemon'] },
      { top: ['Bergamot'], heart: ['Lavender'], base: ['Ambroxan'], flat: [] },
    );
    expect(merged).toEqual({ top: ['Lemon'], heart: ['Lavender'], base: ['Ambroxan'], flat: [] });
  });

  it('keeps a flat list from the page as a flat list', () => {
    const merged = mergeNotes({ ...none, flat: ['Oud', 'Rose'] }, { ...none, top: ['X'] });
    expect(merged).toEqual({ top: [], heart: [], base: [], flat: ['Oud', 'Rose'] });
  });

  it('shows the pyramid when the page lists only a flat list that the pyramid agrees with (Perfume Palace)', () => {
    const page = { ...none, flat: ['Ambrox', 'Elemi resin', 'Calabrian bergamot', 'Patchouli', 'Provencal lavender', 'Pink pepper', 'Geranium', 'Sichuan pepper', 'Vetiver'] };
    const model = { top: ['Calabrian bergamot', 'Pepper'], heart: ['Sichuan pepper', 'Lavender', 'Pink pepper', 'Vetiver', 'Patchouli', 'Geranium', 'Elemi'], base: ['Ambroxan', 'Cedar', 'Labdanum'], flat: [] };
    expect(mergeNotes(page, model)).toEqual({ ...model, flat: [] });
  });

  it('keeps the page flat list when the pyramid disagrees with it', () => {
    const page = { ...none, flat: ['Oud', 'Rose', 'Saffron'] };
    expect(mergeNotes(page, { top: ['Lemon'], heart: ['Mint'], base: ['Musk'], flat: [] })).toEqual({ top: [], heart: [], base: [], flat: ['Oud', 'Rose', 'Saffron'] });
  });

  it('uses the model notes when the page lists none', () => {
    expect(mergeNotes(none, { ...none, top: ['X'] }).top).toEqual(['X']);
    expect(mergeNotes(none, { ...none, flat: ['Y'] }).flat).toEqual(['Y']);
  });

  it('leaves an unknown tier empty instead of inventing one', () => {
    const merged = mergeNotes(none, { top: ['X'], heart: ['Y'], base: [], flat: [] });
    expect(merged.base).toEqual([]);
  });
});

describe('parseNotes', () => {
  it('requires a description', () => {
    expect(() => parseNotes({ top: [], heart: [], base: [], flat: [] })).toThrow();
    expect(parseNotes(answer('Fresh.')).description).toBe('Fresh.');
  });
});

describe('getNotes', () => {
  it('returns merged notes with a 1-3 sentence description and caches them', async () => {
    const cache = fakeCache();
    const gen = generateFrom(answer('Fresh, peppery, a bit woody.'));
    const r = await getNotes(gen, perfume, { ...none, top: ['Lemon'] }, undefined, { cache });
    expect(r.top).toEqual(['Lemon']);
    expect(r.heart).toEqual(['Lavender']);
    expect(countSentences(r.description)).toBe(1);
    expect(cache.store.size).toBe(1);
  });

  it('shows notes written by the local Ollama model but does not store them', async () => {
    const cache = fakeCache();
    const r = await getNotes(generateWith('ollama', answer('Fresh and peppery.')), perfume, none, undefined, { cache });
    expect(r.description).toBe('Fresh and peppery.');
    expect(cache.store.size).toBe(0);
  });

  it('a later Gemini answer replaces the local one and is stored', async () => {
    const cache = fakeCache();
    await getNotes(generateWith('ollama', answer('Local guess.')), perfume, none, undefined, { cache });
    const gemini = generateWith('gemini', answer('Careful Gemini answer.'));
    const r = await getNotes(gemini, perfume, none, undefined, { cache });
    expect(gemini.calls).toBe(1); // asked again, nothing stale was served
    expect(r.description).toBe('Careful Gemini answer.');
    expect(cache.store.size).toBe(1);
  });

  it('does not store notes if any attempt, including a retry, came from Ollama', async () => {
    const cache = fakeCache();
    await getNotes(generateWith('ollama', answer('A. B. C. D.'), answer('Fine now.')), perfume, none, undefined, { cache });
    expect(cache.store.size).toBe(0);
  });

  it('answers from the cache without calling the model', async () => {
    const cache = fakeCache();
    const gen = generateFrom(answer('Fresh.'));
    await getNotes(gen, perfume, none, undefined, { cache });
    const again = await getNotes(gen, perfume, none, undefined, { cache });
    expect(gen.calls).toBe(1);
    expect(again.description).toBe('Fresh.');
  });

  it('asks again when the description is too long, then trims if it is still too long', async () => {
    const long = 'One. Two. Three. Four. Five.';
    const gen = generateFrom(answer(long), answer(long));
    const r = await getNotes(gen, perfume, none, undefined, { cache: fakeCache() });
    expect(gen.calls).toBe(2);
    expect(r.description).toBe('One. Two. Three.');
  });

  it('uses the second answer when the first description is too long', async () => {
    const gen = generateFrom(answer('A. B. C. D.'), answer('Fresh and clean.'));
    const r = await getNotes(gen, perfume, none, undefined, { cache: fakeCache() });
    expect(r.description).toBe('Fresh and clean.');
  });

  it('fails when the description is empty twice', async () => {
    const gen = generateFrom(answer('   '));
    await expect(getNotes(gen, perfume, none, undefined, { cache: fakeCache() })).rejects.toThrow();
  });

  it('does not cache a failure', async () => {
    const cache = fakeCache();
    const gen = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as Generate;
    await expect(getNotes(gen, perfume, none, undefined, { cache })).rejects.toThrow('down');
    expect(cache.store.size).toBe(0);
  });
});
