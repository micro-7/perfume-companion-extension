import { describe, expect, it } from 'vitest';
import type { Generate } from '../llm';
import { NoProviderError, QuotaExceededError } from '../llm/errors';
import type { ServerMessage } from '../shared/messages';
import type { Shop } from '../shared/shops';
import type { PageData } from '../shared/types';
import { fakeFetch, listing, memoryCache, shop } from '../test/fakes';
import { LookupSession, type PageResult } from './session';

const page: PageData = { url: 'https://x.in/p', title: 't', text: 'Dior Sauvage', jsonLd: [], meta: {} };
const ok: PageResult = { ok: true, page };

const detection = (over: Record<string, unknown> = {}) => ({
  found: true,
  name: 'Sauvage',
  brand: 'Dior',
  concentration: '',
  notes: { top: [], heart: [], base: [], flat: [] },
  currentPrice: { amountInr: 0, siteName: 'X' },
  ...over,
});
const notes = { top: ['Bergamot'], heart: [], base: [], flat: [], description: 'Fresh and peppery.' };
const dupes = {
  dupes: [
    { name: 'Club de Nuit Intense Man', brand: 'Armaf', similarity: 85, reason: 'fresh' },
    { name: 'Eros', brand: 'Versace', similarity: 60, reason: '' },
  ],
};
const notListed = { found: false, productTitle: '', priceInr: 0, url: '', inStock: false, variant: '', exactMatch: false };

/** Which of the model requests this is, judged by its prompt. */
function kind(prompt: string): string {
  if (prompt.startsWith('Is this page')) return 'detect';
  if (prompt.includes('Suggest up to 8')) return 'dupes';
  if (prompt.includes('reminds me of')) return 'frag';
  if (prompt.includes('- description:')) return 'notes';
  if (prompt.includes('Search results page')) return 'price';
  if (prompt.includes('on each of these')) return 'gbatch';
  if (prompt.includes('Find the current price')) return 'gprice';
  return 'other';
}

const answers: Record<string, unknown> = {
  detect: detection(),
  notes,
  dupes,
  frag: { pageUrl: '', similar: [] },
  price: notListed,
  gprice: notListed,
  gbatch: { results: [] },
};

type Handler = (
  kind: string,
  req: { prompt: string },
  signal?: AbortSignal,
) => Promise<{ raw?: unknown; provider?: 'gemini' | 'ollama' } | undefined>;

function makeSession(handler?: Handler, shops: Shop[] = [shop('Alpha', 'alpha.in')], hasAccess = false) {
  const sent: ServerMessage[] = [];
  const calls: string[] = [];
  const generate = (async (req: { prompt: string; parse: (x: unknown) => unknown }, signal?: AbortSignal) => {
    const k = kind(req.prompt);
    calls.push(k);
    const r = (await handler?.(k, req, signal)) ?? {};
    return { data: req.parse(r.raw ?? answers[k]), provider: r.provider ?? 'gemini' };
  }) as unknown as Generate;
  const session = new LookupSession({
    generate,
    send: (m) => sent.push(m),
    getShops: async () => shops,
    hasAccess: async () => hasAccess,
    cache: memoryCache(),
    fetchImpl: fakeFetch({ 'alpha.in': { html: listing('Dior Sauvage', 8000) } }),
  });
  return { session, sent, calls, types: () => sent.map((m) => m.type) };
}

const cardTypes = (types: string[]) => types.filter((t) => !t.startsWith('prices') && !t.startsWith('dupes'));

describe('LookupSession: page lookup', () => {
  it('starts, detects, then fills notes, prices and dupes (with a price per dupe)', async () => {
    const t = makeSession();
    await t.session.start(Promise.resolve(ok));

    expect(t.types().slice(0, 2)).toEqual(['lookup:start', 'detect:done']);
    expect(t.types()).toEqual(expect.arrayContaining(['notes:done', 'prices:start', 'prices:row', 'prices:progress', 'dupes:list']));
    expect(t.sent.filter((m) => m.type === 'dupes:price')).toHaveLength(2);
    expect(t.calls.filter((c) => c === 'detect')).toHaveLength(1);
  });

  it('runs notes, prices and dupes at the same time, not one after the other', async () => {
    const started = new Set<string>();
    let release: () => void = () => undefined;
    const all = new Promise<void>((r) => (release = r));
    const t = makeSession(async (k) => {
      started.add(k);
      if (['notes', 'dupes', 'gprice'].every((x) => started.has(x))) release();
      if (k !== 'detect') await all; // a sequential implementation would wait here forever
      return {};
    });
    await t.session.start(Promise.resolve(ok));
    expect(t.types()).toContain('notes:done');
    expect(t.types()).toContain('dupes:list');
  });

  it('marks the shop the user is on as "here"', async () => {
    const t = makeSession(undefined, [shop('Alpha', 'x.in')]);
    await t.session.start(Promise.resolve(ok));
    const start = t.sent.find((m) => m.type === 'prices:start');
    expect(start).toEqual({ type: 'prices:start', total: 1, hereShopId: 'x.in' });
  });

  it('reports an empty shop list', async () => {
    const t = makeSession(undefined, []);
    await t.session.start(Promise.resolve(ok));
    expect(t.types()).toContain('prices:empty');
    expect(t.types()).not.toContain('prices:row');
  });

  it('says "restricted" and makes no model call for an unreadable page', async () => {
    const t = makeSession();
    await t.session.start(Promise.resolve({ ok: false }));
    expect(t.types()).toEqual(['lookup:start', 'restricted']);
    expect(t.calls).toEqual([]);
  });

  it('says "none" and starts no cards when no perfume is found', async () => {
    const t = makeSession(async (k) => (k === 'detect' ? { raw: detection({ found: false }) } : undefined));
    await t.session.start(Promise.resolve(ok));
    expect(t.types()).toEqual(['lookup:start', 'detect:none']);
    expect(t.calls).toEqual(['detect']);
  });

  it('reports a detection error with a readable message', async () => {
    const t = makeSession(async () => {
      throw new NoProviderError(new Error('x'), false);
    });
    await t.session.start(Promise.resolve(ok));
    const err = t.sent.find((m) => m.type === 'detect:error');
    expect(err && 'message' in err && err.message).toMatch(/No AI provider is reachable/);
  });
});

describe('LookupSession: a long dupe list (the whole Fragrantica carousel)', () => {
  // Fragrantica's carousel: 12 perfumes (on top of the AI's own 2 suggestions)
  const carousel = {
    pageUrl: '',
    similar: Array.from({ length: 12 }, (_, i) => ({ name: `Perfume ${i}`, brand: `Brand ${i}` })),
  };
  const withTwelve = () => makeSession(async (k) => (k === 'frag' ? { raw: carousel } : undefined));
  const dupeList = (t: ReturnType<typeof makeSession>) => {
    const m = t.sent.find((x) => x.type === 'dupes:list');
    return m && m.type === 'dupes:list' ? m.result.dupes : [];
  };

  it('lists all of them but looks up prices only for the 4 best-ranked (each pricing means searching every shop)', async () => {
    const t = withTwelve();
    await t.session.start(Promise.resolve(ok));
    expect(dupeList(t).length).toBeGreaterThan(12); // 12 from the carousel plus the AI's own
    const priced = t.sent.filter((m) => m.type === 'dupes:price');
    expect(priced).toHaveLength(4);
    const firstFour = dupeList(t).slice(0, 4).map((d) => d.key);
    expect(priced.map((m) => (m.type === 'dupes:price' ? m.key : ''))).toEqual(expect.arrayContaining(firstFour));
  });

  it('"Check price" looks up exactly that one dupe and cancels nothing else', async () => {
    const t = withTwelve();
    await t.session.start(Promise.resolve(ok));
    const ninth = dupeList(t)[9];
    t.sent.length = 0;
    await t.session.priceDupe({ key: ninth.key, name: ninth.name, brand: ninth.brand });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ type: 'dupes:price', key: ninth.key });
  });

  it('"Check price" still works after a cancel (Back to finished results cancels the earlier lookup)', async () => {
    const t = withTwelve();
    await t.session.start(Promise.resolve(ok));
    const tenth = dupeList(t)[10];
    t.session.cancel();
    t.sent.length = 0;
    await t.session.priceDupe({ key: tenth.key, name: tenth.name, brand: tenth.brand });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ type: 'dupes:price', key: tenth.key });
  });

  it('"Check price" works on a brand-new session (Chrome stopped the worker and the panel reconnected)', async () => {
    const t = withTwelve();
    await t.session.priceDupe({ key: 'k', name: 'Asad', brand: 'Lattafa' });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ type: 'dupes:price', key: 'k' });
  });

  it('a few dupes are all priced at once, as before', async () => {
    const t = makeSession();
    await t.session.start(Promise.resolve(ok));
    expect(t.sent.filter((m) => m.type === 'dupes:price')).toHaveLength(dupeList(t).length);
  });
});

describe('LookupSession: keeping the worker alive', () => {
  it('reports busy while a lookup runs and idle when it ends (so the worker can be kept alive meanwhile)', async () => {
    const busy: boolean[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = makeSession(async (k) => {
      if (k === 'detect') await gate;
      return undefined;
    });
    // makeSession builds its own session; rebuild one with the hook
    const session = new LookupSession({
      generate: (async (req: { prompt: string; parse: (x: unknown) => unknown }) => {
        const k = kind(req.prompt);
        if (k === 'detect') await gate;
        return { data: req.parse(answers[k]), provider: 'gemini' };
      }) as unknown as Generate,
      send: () => undefined,
      getShops: async () => [],
      hasAccess: async () => false,
      cache: memoryCache(),
      onBusy: (b) => busy.push(b),
    });
    void t;
    const running = session.start(Promise.resolve(ok));
    await new Promise((r) => setTimeout(r, 0));
    expect(busy).toEqual([true]);
    release();
    await running;
    expect(busy).toEqual([true, false]);
  });

  it('reports busy once for overlapping runs, and idle only when the last one has ended', async () => {
    const busy: boolean[] = [];
    const session = new LookupSession({
      generate: (async (req: { prompt: string; parse: (x: unknown) => unknown }) => ({ data: req.parse(answers[kind(req.prompt)]), provider: 'gemini' })) as unknown as Generate,
      send: () => undefined,
      getShops: async () => [],
      hasAccess: async () => false,
      cache: memoryCache(),
      onBusy: (b) => busy.push(b),
    });
    await session.start(Promise.resolve(ok));
    await session.retryNotes();
    expect(busy).toEqual([true, false, true, false]);
  });
});

describe('LookupSession: cards fail independently', () => {
  it('a notes failure does not stop prices or dupes, and notes can be retried alone', async () => {
    let failNotes = true;
    const t = makeSession(async (k) => {
      if (k === 'notes' && failNotes) throw new QuotaExceededError(null);
      return undefined;
    });
    await t.session.start(Promise.resolve(ok));
    expect(t.types()).toEqual(expect.arrayContaining(['notes:error', 'dupes:list', 'prices:row']));

    failNotes = false;
    t.sent.length = 0;
    await t.session.retryNotes();
    expect(t.types()).toEqual(['notes:done']);
  });

  it('a dupes failure does not stop notes or prices, and dupes can be retried alone', async () => {
    let failDupes = true;
    const t = makeSession(async (k) => {
      if (k === 'dupes' && failDupes) throw new Error('ai down');
      return undefined;
    });
    await t.session.start(Promise.resolve(ok));
    expect(t.types()).toEqual(expect.arrayContaining(['dupes:error', 'notes:done', 'prices:row']));

    failDupes = false;
    t.sent.length = 0;
    await t.session.retryDupes();
    expect(t.types()).toContain('dupes:list');
    expect(t.types()).not.toContain('notes:done');
  });

  it('when a dupe has no price, it still gets a "dupes:price" with null', async () => {
    const t = makeSession();
    await t.session.start(Promise.resolve(ok));
    const prices = t.sent.filter((m) => m.type === 'dupes:price');
    expect(prices.every((m) => m.type === 'dupes:price' && m.best === null)).toBe(true);
  });
});

describe('LookupSession: exploring a dupe', () => {
  const armaf = { name: 'Club de Nuit Intense Man', brand: 'Armaf', concentration: '' };

  it('runs the full lookup for the dupe without detection or a page', async () => {
    const t = makeSession();
    await t.session.explore(armaf);

    expect(t.calls).not.toContain('detect');
    expect(t.types().slice(0, 2)).toEqual(['lookup:start', 'detect:done']);
    expect(t.sent[1]).toMatchObject({ type: 'detect:done', explore: true, perfume: armaf, currentPrice: { amountInr: null } });
    expect(t.types()).toEqual(expect.arrayContaining(['notes:done', 'prices:start', 'dupes:list']));
    expect(t.sent.find((m) => m.type === 'prices:start')).toMatchObject({ hereShopId: null });
  });

  it('retry after exploring repeats the dupe lookup, not the page', async () => {
    const t = makeSession();
    await t.session.start(Promise.resolve(ok));
    await t.session.explore(armaf);
    t.calls.length = 0;
    await t.session.retry();
    expect(t.calls).not.toContain('detect');
  });
});

describe('LookupSession: retry, fallback and cancel', () => {
  it('retries the whole lookup for the same page', async () => {
    const t = makeSession();
    await t.session.start(Promise.resolve(ok));
    await t.session.retry();
    expect(t.types().filter((x) => x === 'lookup:start')).toHaveLength(2);
    expect(t.calls.filter((c) => c === 'detect')).toHaveLength(2);
  });

  it('announces the local model once when Ollama answers', async () => {
    const t = makeSession(async () => ({ provider: 'ollama' }));
    await t.session.start(Promise.resolve(ok));
    expect(t.types().filter((x) => x === 'provider:fallback')).toHaveLength(1);
  });

  it('aborts pending work and sends nothing more once cancelled (the panel closed)', async () => {
    let seenSignal: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = makeSession(async (_k, _req, signal) => {
      seenSignal = signal;
      await gate;
      return undefined;
    });
    const running = t.session.start(Promise.resolve(ok));
    await new Promise((r) => setTimeout(r, 0));
    t.session.cancel();
    release();
    await running;

    expect(seenSignal?.aborted).toBe(true);
    expect(t.types()).toEqual(['lookup:start']);
    expect(t.calls).toEqual(['detect']); // the cards were never started
  });

  it('cancelling stops the cards of a lookup that is already running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = makeSession(async (k) => {
      if (k !== 'detect') await gate;
      return undefined;
    });
    const running = t.session.start(Promise.resolve(ok));
    await new Promise((r) => setTimeout(r, 10));
    t.session.cancel();
    release();
    await running;
    expect(cardTypes(t.types())).toEqual(['lookup:start', 'detect:done']);
    expect(t.types()).not.toContain('dupes:list');
  });

  it('cancels the earlier lookup when a new one starts', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const t = makeSession(async (k) => {
      if (first && k === 'detect') {
        first = false;
        await gate;
        return { raw: detection({ name: 'Old', brand: 'Old' }) };
      }
      return undefined;
    });
    const a = t.session.start(Promise.resolve(ok));
    await new Promise((r) => setTimeout(r, 0));
    await t.session.start(Promise.resolve(ok));
    release();
    await a;

    const done = t.sent.filter((m) => m.type === 'detect:done');
    expect(done).toHaveLength(1);
    expect(done[0].type === 'detect:done' && done[0].perfume.name).toBe('Sauvage');
  });
});
