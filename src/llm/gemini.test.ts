import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, geminiOk } from '../test/helpers';
import { AuthError, BadResponseError, QuotaExceededError, ServerError } from './errors';
import { geminiGenerate, parseRetryDelayMs } from './gemini';

const base = { apiKey: 'test-key', model: 'm', system: 's', prompt: 'p', schema: { type: 'object' } };

describe('geminiGenerate', () => {
  it('sends the key in a header, asks for JSON, and parses the answer', async () => {
    const fetchImpl = vi.fn(async () => geminiOk({ ok: true }));
    const r = await geminiGenerate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.data).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('test-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.tools).toBeUndefined();
  });

  it('maps HTTP 429 to a quota error with the retry delay', async () => {
    const body = {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        message: 'quota',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }],
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(429, body));
    const err = await geminiGenerate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).retryDelayMs).toBe(34_000);
  });

  it('treats RESOURCE_EXHAUSTED as quota even without a 429 status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { status: 'RESOURCE_EXHAUSTED', message: 'x' } }));
    await expect(geminiGenerate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('maps bad keys, server errors and other 4xx to their own errors', async () => {
    const cases: Array<[number, unknown, new (...a: never[]) => Error]> = [
      [403, { error: { message: 'forbidden' } }, AuthError],
      [400, { error: { message: 'API key not valid' } }, AuthError],
      [503, { error: { message: 'overloaded' } }, ServerError],
      [400, { error: { message: 'bad request' } }, BadResponseError],
    ];
    for (const [status, body, errType] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, body));
      await expect(geminiGenerate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(
        errType,
      );
    }
  });

  it('uses Google Search for grounded calls and reads JSON from a fenced block plus the sources', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        candidates: [
          {
            content: { parts: [{ text: 'Here you go:\n```json\n{"price": 1200}\n```' }] },
            groundingMetadata: { groundingChunks: [{ web: { title: 'Shop', uri: 'https://shop.in/p' } }] },
          },
        ],
      }),
    );
    const r = await geminiGenerate({
      ...base,
      grounding: { site: 'shop.in' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.data).toEqual({ price: 1200 });
    expect(r.sources).toEqual([{ title: 'Shop', uri: 'https://shop.in/p' }]);

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.generationConfig.responseSchema).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain('shop.in');
  });

  it('reports a network failure as a server error and an unreadable answer as a bad response', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('failed to fetch');
    });
    await expect(geminiGenerate({ ...base, fetchImpl: down as unknown as typeof fetch })).rejects.toBeInstanceOf(
      ServerError,
    );
    const junk = vi.fn(async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }));
    await expect(geminiGenerate({ ...base, fetchImpl: junk as unknown as typeof fetch })).rejects.toBeInstanceOf(
      BadResponseError,
    );
  });
});

describe('geminiGenerate: timeout and cancel', () => {
  /** A fetch that never answers on its own; it only ends when its signal is aborted. */
  const hanging = () =>
    vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
    }));

  it('gives up on a request that hangs (a busy model can take over a minute to say 503)', async () => {
    const err = await geminiGenerate({ ...base, timeoutMs: 30, fetchImpl: hanging() as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as Error).message).toMatch(/too long/);
    expect((err as ServerError).retryable).toBe(false); // retrying would stall a lookup for minutes
  });

  it('an ordinary 503 and a network failure are retryable', async () => {
    const busy = vi.fn(async () => jsonResponse(503, { error: { message: 'high demand' } }));
    const e1 = await geminiGenerate({ ...base, fetchImpl: busy as unknown as typeof fetch }).catch((e) => e);
    expect((e1 as ServerError).retryable).toBe(true);
    const down = vi.fn(async () => {
      throw new TypeError('failed to fetch');
    });
    const e2 = await geminiGenerate({ ...base, fetchImpl: down as unknown as typeof fetch }).catch((e) => e);
    expect((e2 as ServerError).retryable).toBe(true);
  });

  it('a cancelled lookup is not reported as an error', async () => {
    const ac = new AbortController();
    const p = geminiGenerate({ ...base, signal: ac.signal, timeoutMs: 5000, fetchImpl: hanging() as unknown as typeof fetch });
    ac.abort();
    const err = await p.catch((e) => e);
    expect(err).not.toBeInstanceOf(ServerError);
  });
});

describe('parseRetryDelayMs', () => {
  it('reads "retry in Ns" from the message when there are no details', () => {
    expect(parseRetryDelayMs({ error: { message: 'Please retry in 12.5s.' } })).toBe(12_500);
    expect(parseRetryDelayMs({ error: { message: 'nope' } })).toBeNull();
  });
});
