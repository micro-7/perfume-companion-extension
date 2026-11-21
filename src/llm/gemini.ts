import { AuthError, BadResponseError, QuotaExceededError, ServerError } from './errors';
import { extractJson } from './json';
import type { JsonSchema } from '../shared/validate';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 45_000;

export interface GeminiCall {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  /** Used as the response schema for normal calls; described in the prompt for grounded calls. */
  schema: JsonSchema;
  /** Use Google Search grounding, optionally limited to one site. */
  grounding?: { site?: string };
  signal?: AbortSignal;
  /** Give up on a request after this long (default 45 s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GeminiResult {
  data: unknown;
  sources: Array<{ title: string; uri: string }>;
}

/** Reads the retry delay out of a Gemini error body ("34s", RetryInfo or "retry in 34.5s"). */
export function parseRetryDelayMs(body: unknown): number | null {
  const err = (body as { error?: { details?: unknown[]; message?: string } } | null)?.error;
  for (const d of err?.details ?? []) {
    const detail = d as { '@type'?: string; retryDelay?: string };
    if (detail['@type']?.endsWith('RetryInfo') && detail.retryDelay) {
      const m = /^([\d.]+)s$/.exec(detail.retryDelay);
      if (m) return Math.ceil(parseFloat(m[1]) * 1000);
    }
  }
  const m = /retry in ([\d.]+)s/i.exec(err?.message ?? '');
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}

export async function geminiGenerate(call: GeminiCall): Promise<GeminiResult> {
  const doFetch = call.fetchImpl ?? fetch;
  const grounded = !!call.grounding;

  let prompt = call.prompt;
  if (grounded) {
    const site = call.grounding?.site ? ` Only use information from ${call.grounding.site}.` : '';
    prompt +=
      `\n\nUse Google Search.${site} Respond with only one JSON object in a \`\`\`json fenced block that matches this JSON schema:\n` +
      JSON.stringify(call.schema);
  }

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: call.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: grounded
      ? { temperature: 0.2 }
      : { temperature: 0.2, responseMimeType: 'application/json', responseSchema: call.schema },
  };
  if (grounded) body.tools = [{ google_search: {} }];

  // A busy Gemini model can leave a request hanging for over a minute before answering 503.
  const timeout = AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await doFetch(`${BASE}/${encodeURIComponent(call.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': call.apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (call.signal?.aborted) throw e; // the caller cancelled: not an error to report
    if (timeout.aborted) throw new ServerError('Gemini took too long to answer', false);
    throw new ServerError('Could not reach the Gemini API');
  }

  if (!res.ok) {
    const parsed = await readBody(res);
    const err = (parsed as { error?: { status?: string; message?: string } }).error;
    const message = err?.message ?? `HTTP ${res.status}`;
    if (res.status === 429 || err?.status === 'RESOURCE_EXHAUSTED') {
      throw new QuotaExceededError(parseRetryDelayMs(parsed), message);
    }
    if (res.status === 401 || res.status === 403 || /api key/i.test(message)) throw new AuthError(message);
    if (res.status >= 500) throw new ServerError(message);
    throw new BadResponseError(message);
  }

  const json = (await readBody(res)) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { title?: string; uri?: string } }> };
    }>;
  };
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text.trim()) throw new BadResponseError('Gemini returned an empty answer');

  const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => ({ title: c.web?.title ?? '', uri: c.web?.uri ?? '' }))
    .filter((s) => s.uri);

  return { data: extractJson(text), sources };
}
