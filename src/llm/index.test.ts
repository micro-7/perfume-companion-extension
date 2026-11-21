import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { geminiOk, jsonResponse, ollamaOk } from '../test/helpers';
import {
  AuthError,
  BadResponseError,
  NoProviderError,
  OriginNotAllowedError,
  SearchUnavailableError,
  ServerError,
} from './errors';
import { describeError } from './errors';
import { createLlm, type LlmRequest } from './index';

interface Obj {
  v: number;
}
const req: LlmRequest<Obj> = {
  system: 's',
  prompt: 'p',
  schema: { type: 'object' },
  parse: (raw) => {
    const o = raw as { v?: unknown };
    if (typeof o?.v !== 'number') throw new BadResponseError('v must be a number');
    return { v: o.v };
  },
};

const quota = () =>
  jsonResponse(429, {
    error: {
      status: 'RESOURCE_EXHAUSTED',
      message: 'quota',
      details: [{ '@type': 'x.RetryInfo', retryDelay: '30s' }],
    },
  });
const tags = () => jsonResponse(200, { models: [{ name: 'qwen3:8b', details: { parameter_size: '8B' } }] });

function setup(settings: Partial<Settings>, handler: (url: string, body: string) => Response | Promise<Response>) {
  let cooldown = 0;
  let clock = 1_000_000;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    return handler(u, String(init?.body ?? ''));
  });
  const waits: number[] = [];
  const llm = createLlm({
    sleep: async (ms) => {
      waits.push(ms);
    },
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }),
    getCooldownUntil: async () => cooldown,
    setCooldownUntil: async (t) => {
      cooldown = t;
    },
    origin: 'chrome-extension://abc',
    now: () => clock,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    makeLimiter: () => ({ schedule: (fn) => fn() }),
  });
  return {
    llm,
    calls,
    waits,
    getCooldown: () => cooldown,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const isGemini = (u: string) => u.includes('generativelanguage');

describe('createLlm', () => {
  let key: Partial<Settings>;
  beforeEach(() => {
    key = { geminiApiKey: 'test-key' };
  });

  it('answers with Gemini when the key is set and the quota is fine', async () => {
    const t = setup(key, () => geminiOk({ v: 1 }));
    const r = await t.llm.generate(req);
    expect(r).toEqual({ data: { v: 1 }, provider: 'gemini' });
    expect(t.calls.every(isGemini)).toBe(true);
  });

  it('retries on Ollama when Gemini returns 429, and starts a cooldown', async () => {
    const t = setup(key, (u) => (isGemini(u) ? quota() : u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 2 })));
    const r = await t.llm.generate(req);
    expect(r).toEqual({ data: { v: 2 }, provider: 'ollama' });
    expect(t.getCooldown()).toBe(1_000_000 + 30_000);
  });

  it('skips Gemini during the cooldown and goes back to it afterwards', async () => {
    const t = setup(key, (u) => {
      if (isGemini(u)) return t.getCooldown() === 0 ? quota() : geminiOk({ v: 9 });
      return u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 2 });
    });
    await t.llm.generate(req); // quota -> cooldown
    t.calls.length = 0;

    const during = await t.llm.generate(req);
    expect(during.provider).toBe('ollama');
    expect(t.calls.some(isGemini)).toBe(false);

    t.advance(31_000);
    const after = await t.llm.generate(req);
    expect(after).toEqual({ data: { v: 9 }, provider: 'gemini' });
  });

  it('uses 60 seconds when Gemini gives no retry delay', async () => {
    const t = setup(key, (u) =>
      isGemini(u)
        ? jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'x' } })
        : u.endsWith('/api/tags')
          ? tags()
          : ollamaOk({ v: 2 }),
    );
    await t.llm.generate(req);
    expect(t.getCooldown()).toBe(1_000_000 + 60_000);
  });

  it('goes straight to Ollama when there is no Gemini key', async () => {
    const t = setup({}, (u) => (u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 3 })));
    const r = await t.llm.generate(req);
    expect(r.provider).toBe('ollama');
    expect(t.calls.some(isGemini)).toBe(false);
  });

  it('uses the model chosen in settings without listing models', async () => {
    const t = setup({ ollamaModel: 'llama3.2:3b' }, () => ollamaOk({ v: 4 }));
    await t.llm.generate(req);
    expect(t.calls.some((u) => u.endsWith('/api/tags'))).toBe(false);
    const body = JSON.parse(String(t.calls.length)) as never;
    expect(body).toBeDefined();
  });

  it('does not hide a bad API key behind the fallback', async () => {
    const t = setup(key, () => jsonResponse(403, { error: { message: 'bad key' } }));
    await expect(t.llm.generate(req)).rejects.toBeInstanceOf(AuthError);
    expect(t.calls.every(isGemini)).toBe(true);
  });

  it('retries once on a Gemini 5xx, then reports the error', async () => {
    let n = 0;
    const t = setup(key, () => {
      n++;
      return n === 1 ? jsonResponse(503, { error: { message: 'busy' } }) : geminiOk({ v: 5 });
    });
    expect((await t.llm.generate(req)).data).toEqual({ v: 5 });
    expect(n).toBe(2);
  });

  const busy = () => jsonResponse(503, { error: { status: 'UNAVAILABLE', message: 'high demand' } });
  const busyGemini = (u: string) => (isGemini(u) ? busy() : u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 6 }));

  it('waits and retries a busy model twice (2 s, then 6 s), then answers with Ollama instead of an error', async () => {
    const t = setup(key, busyGemini);
    const r = await t.llm.generate(req);
    expect(r).toEqual({ data: { v: 6 }, provider: 'ollama' });
    expect(t.calls.filter(isGemini)).toHaveLength(3); // the first try and two retries
    expect(t.waits).toEqual([2000, 6000]);
  });

  it('a busy model does not start the cooldown, so the next request tries Gemini again', async () => {
    let geminiBusy = true;
    const t = setup(key, (u) => (isGemini(u) ? (geminiBusy ? busy() : geminiOk({ v: 1 })) : u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 6 })));
    expect((await t.llm.generate(req)).provider).toBe('ollama');
    expect(t.getCooldown()).toBe(0);

    geminiBusy = false; // Gemini recovers
    expect((await t.llm.generate(req)).provider).toBe('gemini'); // no 60 s wait on the local model
  });

  it('falls back to Ollama when Gemini cannot be reached at all', async () => {
    const t = setup(key, (u) => {
      if (isGemini(u)) throw new TypeError('failed to fetch');
      return u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 6 });
    });
    expect((await t.llm.generate(req)).provider).toBe('ollama');
  });

  it('when Gemini is busy and Ollama is down too, says Gemini is busy (not "out of quota")', async () => {
    const t = setup(key, (u) => {
      if (isGemini(u)) return busy();
      throw new TypeError('connection refused');
    });
    const err = await t.llm.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as NoProviderError).geminiProblem).toBe('busy');
    expect(describeError(err)).toMatch(/Gemini is busy or not reachable/);
    expect(describeError(err)).not.toMatch(/quota/);
  });

  it('still shows an error for a bad key or an unreadable answer: only server trouble falls back', async () => {
    const badKey = setup(key, () => jsonResponse(403, { error: { message: 'bad key' } }));
    await expect(badKey.llm.generate(req)).rejects.toBeInstanceOf(AuthError);
    expect(badKey.calls.every(isGemini)).toBe(true);

    const unreadable = setup(key, (u) => (isGemini(u) ? geminiOk({ v: 'nope' }) : ollamaOk({ v: 6 })));
    await expect(unreadable.llm.generate(req)).rejects.toBeInstanceOf(BadResponseError);
    expect(unreadable.calls.every(isGemini)).toBe(true);
  });

  it('a busy model does not move a web-search request to Ollama (web search only exists on Gemini)', async () => {
    const t = setup(key, busyGemini);
    await expect(t.llm.generate({ ...req, grounding: {} })).rejects.toBeInstanceOf(ServerError);
    expect(t.calls.every(isGemini)).toBe(true);
  });

  it('succeeds on the second retry when the model recovers', async () => {
    let n = 0;
    const t = setup(key, () => (++n < 3 ? jsonResponse(503, { error: { message: 'busy' } }) : geminiOk({ v: 8 })));
    expect((await t.llm.generate(req)).data).toEqual({ v: 8 });
    expect(t.waits).toEqual([2000, 6000]);
  });

  it('fails grounded requests fast while Gemini is unavailable, never using Ollama', async () => {
    const t = setup({}, () => ollamaOk({ v: 1 }));
    await expect(t.llm.generate({ ...req, grounding: { site: 'shop.in' } })).rejects.toBeInstanceOf(
      SearchUnavailableError,
    );
    expect(t.calls).toHaveLength(0);
  });

  // On some free keys Google Search grounding has no quota at all while ordinary answers work fine.
  const isSearch = (body: string) => body.includes('google_search');
  const searchRefused = (u: string, body: string) =>
    isSearch(body) ? quota() : u.includes('generativelanguage') ? geminiOk({ v: 1 }) : ollamaOk({ v: 2 });

  it('a refused web search turns web search off for a while, but NOT ordinary answers', async () => {
    const t = setup(key, searchRefused);
    await expect(t.llm.generate({ ...req, grounding: {} })).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(t.getCooldown()).toBe(0); // the global Gemini cooldown was not started
  });

  it('after a refused web search, ordinary requests still go to Gemini, not Ollama', async () => {
    const t = setup(key, searchRefused);
    await expect(t.llm.generate({ ...req, grounding: {} })).rejects.toBeInstanceOf(SearchUnavailableError);
    t.calls.length = 0;
    const r = await t.llm.generate(req);
    expect(r.provider).toBe('gemini');
    expect(t.calls.every(isGemini)).toBe(true);
  });

  it('does not try web search again until the web-search cooldown ends', async () => {
    let grounded = 0;
    const t = setup(key, (_u, body) => {
      if (isSearch(body)) grounded++;
      return isSearch(body) ? quota() : geminiOk({ v: 1 });
    });
    await expect(t.llm.generate({ ...req, grounding: {} })).rejects.toBeInstanceOf(SearchUnavailableError);
    await expect(t.llm.generate({ ...req, grounding: {} })).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(grounded).toBe(1); // the second one failed fast, without a request

    t.advance(31_000); // the retry delay Gemini gave was 30 s
    await expect(t.llm.generate({ ...req, grounding: {} })).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(grounded).toBe(2);
  });

  it('an ordinary quota error still starts the global cooldown', async () => {
    const t = setup(key, (u) => (u.includes('generativelanguage') ? quota() : u.endsWith('/api/tags') ? tags() : ollamaOk({ v: 2 })));
    await t.llm.generate(req);
    expect(t.getCooldown()).toBeGreaterThan(1_000_000);
  });

  it('retries once when the answer is not valid, then succeeds', async () => {
    let n = 0;
    const t = setup(key, () => (++n === 1 ? geminiOk({ v: 'nope' }) : geminiOk({ v: 7 })));
    expect((await t.llm.generate(req)).data).toEqual({ v: 7 });
    expect(n).toBe(2);
  });

  it('gives up with a bad-response error after the second invalid answer', async () => {
    const t = setup(key, () => geminiOk({ v: 'nope' }));
    await expect(t.llm.generate(req)).rejects.toBeInstanceOf(BadResponseError);
    expect(t.calls).toHaveLength(2);
  });

  it('reports no provider when Gemini is out of quota and Ollama is down', async () => {
    const t = setup(key, (u) => {
      if (isGemini(u)) return quota();
      throw new TypeError('connection refused');
    });
    const err = await t.llm.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as NoProviderError).hadGeminiKey).toBe(true);
  });

  it('keeps the origin error so the user is told how to fix OLLAMA_ORIGINS', async () => {
    const t = setup({}, () => new Response('no', { status: 403 }));
    const err = await t.llm.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as NoProviderError).ollamaCause).toBeInstanceOf(OriginNotAllowedError);
  });
});
