import { vi } from 'vitest';

/** In-memory stand-in for chrome.storage.local / session. */
export function installChromeStorageMock(): { local: Record<string, unknown>; session: Record<string, unknown> } {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys?: string | string[]) => {
      if (keys === undefined) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    }),
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { id: 'testextensionid' },
  };
  return { local, session };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A Gemini generateContent success body whose text is the given JSON value. */
export function geminiOk(value: unknown): Response {
  return jsonResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

export function ollamaOk(value: unknown): Response {
  return jsonResponse(200, { message: { content: JSON.stringify(value) } });
}
