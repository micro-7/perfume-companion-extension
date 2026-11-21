import { BadResponseError, OllamaUnreachableError, OriginNotAllowedError, ServerError } from './errors';
import { extractJson } from './json';
import type { JsonSchema } from '../shared/validate';

export interface OllamaModelInfo {
  name: string;
  details?: { parameter_size?: string };
  /** Set for cloud models that run on ollama.com. */
  remote_host?: string;
}

interface Base {
  baseUrl: string;
  /** The extension's origin, e.g. chrome-extension://abc..., shown when Ollama answers 403. */
  origin: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

async function request(url: string, init: RequestInit, b: Base): Promise<Response> {
  const doFetch = b.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: b.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new OllamaUnreachableError(`Could not reach Ollama at ${b.baseUrl}. Is it running?`);
  }
  if (res.status === 403) throw new OriginNotAllowedError(b.origin);
  return res;
}

export async function ollamaTags(b: Base): Promise<OllamaModelInfo[]> {
  const res = await request(`${b.baseUrl}/api/tags`, { method: 'GET' }, b);
  if (!res.ok) throw new ServerError(`Ollama returned HTTP ${res.status}`);
  const json = (await res.json()) as { models?: OllamaModelInfo[] };
  return json.models ?? [];
}

/**
 * Checks that Ollama accepts requests from this extension, the way real lookups send them.
 * A plain GET from an extension page can go out without an Origin header and pass even when
 * OLLAMA_ORIGINS blocks the extension, so this sends a POST (which always carries Origin).
 */
export async function ollamaCheckAccess(b: Base, model: string): Promise<void> {
  const res = await request(
    `${b.baseUrl}/api/show`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) },
    b,
  );
  if (!res.ok && res.status !== 404) throw new ServerError(`Ollama returned HTTP ${res.status}`);
}

export interface OllamaCall extends Base {
  model: string;
  system: string;
  prompt: string;
  schema: JsonSchema;
}

export async function ollamaChat(call: OllamaCall): Promise<unknown> {
  const res = await request(
    `${call.baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: call.model,
        stream: false,
        // Thinking models (qwen3.x etc.) otherwise spend minutes reasoning before a short JSON answer.
        think: false,
        format: call.schema,
        options: { temperature: 0.2 },
        messages: [
          { role: 'system', content: call.system },
          { role: 'user', content: call.prompt },
        ],
      }),
    },
    call,
  );
  if (res.status === 404) throw new ServerError(`Ollama model "${call.model}" is not installed`);
  if (!res.ok) throw new ServerError(`Ollama returned HTTP ${res.status}`);
  const json = (await res.json()) as { message?: { content?: string } };
  const content = json.message?.content ?? '';
  if (!content.trim()) throw new BadResponseError('Ollama returned an empty answer');
  return extractJson(content);
}
