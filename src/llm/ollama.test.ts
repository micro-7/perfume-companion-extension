import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, ollamaOk } from '../test/helpers';
import { OllamaUnreachableError, OriginNotAllowedError, ServerError } from './errors';
import { ollamaChat, ollamaCheckAccess, ollamaTags } from './ollama';

const b = { baseUrl: 'http://localhost:11434', origin: 'chrome-extension://abc' };
const chat = { ...b, model: 'qwen3:8b', system: 's', prompt: 'p', schema: { type: 'object' } };

describe('ollama client', () => {
  it('sends the schema as format and parses the reply', async () => {
    const fetchImpl = vi.fn(async () => ollamaOk({ a: 1 }));
    const r = await ollamaChat({ ...chat, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ a: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, think: false, format: { type: 'object' } });
  });

  it('turns a 403 into an origin error that names the extension origin', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const err = await ollamaChat({ ...chat, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(OriginNotAllowedError);
    expect((err as OriginNotAllowedError).origin).toBe('chrome-extension://abc');
  });

  it('reports connection refused as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(ollamaChat({ ...chat, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(
      OllamaUnreachableError,
    );
  });

  it('reports a missing model as a server error', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(ollamaChat({ ...chat, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it('checks access with a POST so a blocked origin is caught', async () => {
    const blocked = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      ollamaCheckAccess({ ...b, fetchImpl: blocked as unknown as typeof fetch }, 'qwen3:8b'),
    ).rejects.toBeInstanceOf(OriginNotAllowedError);
    expect((blocked.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('POST');

    const fine = vi.fn(async () => jsonResponse(200, {}));
    await expect(ollamaCheckAccess({ ...b, fetchImpl: fine as unknown as typeof fetch }, 'qwen3:8b')).resolves.toBeUndefined();
  });

  it('lists installed models', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] }));
    const models = await ollamaTags({ ...b, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b', 'llama3.2:3b']);
  });
});
