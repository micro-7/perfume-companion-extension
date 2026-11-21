import { vi } from 'vitest';
import type { Generate, LlmRequest } from '../llm';
import type { CacheStore } from '../shared/cache';
import type { Shop } from '../shared/shops';

export type Answer = unknown | Error | (() => unknown);

/**
 * A fake model. `handler` sees each request and returns the raw JSON the model would answer
 * (or throws). The raw answer goes through the request's own parser, like the real one.
 */
export function fakeGenerate(
  handler: (req: LlmRequest<unknown>) => unknown,
  provider: 'gemini' | 'ollama' = 'gemini',
): Generate & { calls: Array<LlmRequest<unknown>> } {
  const calls: Array<LlmRequest<unknown>> = [];
  const fn = (async (req: LlmRequest<unknown>) => {
    calls.push(req);
    const raw = handler(req);
    return { data: req.parse(raw), provider };
  }) as unknown as Generate & { calls: Array<LlmRequest<unknown>> };
  fn.calls = calls;
  return fn;
}

export function memoryCache(): CacheStore & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T>(k: string) => (store.get(k) as T | undefined) ?? null,
    set: async <T>(k: string, v: T) => {
      store.set(k, v);
    },
  };
}

export const shop = (name: string, domain = `${name.toLowerCase().replace(/ /g, '')}.in`): Shop => ({
  id: domain,
  name,
  searchUrl: `https://www.${domain}/search?q={query}`,
  domain,
  directAccess: true,
});

/** A fetch that serves a fixed page per URL host. */
export function fakeFetch(pages: Record<string, { status?: number; html: string } | Error>) {
  return vi.fn(async (url: string | URL | Request) => {
    const host = new URL(String(url)).hostname.replace(/^www\./, '');
    const page = pages[host];
    if (!page) return new Response('not found', { status: 404 });
    if (page instanceof Error) throw page;
    return new Response(page.html, { status: page.status ?? 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

export const listing = (title: string, price: number, extra = '') =>
  `<html><body><main>${'Search results. '.repeat(30)}<a href="/products/${title.toLowerCase().replace(/\W+/g, '-')}">${title}</a> Price ₹${price} ${extra}</main></body></html>`;
