import {
  BadResponseError,
  NoProviderError,
  OllamaUnreachableError,
  OriginNotAllowedError,
  QuotaExceededError,
  SearchUnavailableError,
  ServerError,
} from './errors';
import { geminiGenerate } from './gemini';
import { ollamaChat, ollamaTags } from './ollama';
import { pickOllamaModel } from './pickModel';
import { createRateLimiter, type RateLimiter } from './rateLimiter';
import type { Settings } from '../shared/settings';
import type { JsonSchema } from '../shared/validate';

export type Provider = 'gemini' | 'ollama';

/** Why Gemini did not answer a request that then went to Ollama. */
type GeminiProblem = 'quota' | 'busy';

export interface LlmRequest<T> {
  system: string;
  prompt: string;
  schema: JsonSchema;
  /** Needs Google Search; only Gemini can do this. */
  grounding?: { site?: string };
  /** Checks the raw JSON and returns the typed value; throws BadResponseError if it is wrong. */
  parse: (raw: unknown) => T;
}

export interface LlmResult<T> {
  data: T;
  provider: Provider;
}

export type Generate = <T>(req: LlmRequest<T>, signal?: AbortSignal) => Promise<LlmResult<T>>;

export interface LlmDeps {
  getSettings: () => Promise<Settings>;
  getCooldownUntil: () => Promise<number>;
  setCooldownUntil: (t: number) => Promise<void>;
  /**
   * Google Search grounding has its own quota (on some free tiers it is zero), separate from
   * ordinary answers. Kept apart so a refused web search never sends everything else to Ollama.
   * Defaults to memory that lasts as long as the service worker.
   */
  getGroundingCooldownUntil?: () => Promise<number>;
  setGroundingCooldownUntil?: (t: number) => Promise<void>;
  /** The extension origin, e.g. chrome-extension://<id>. */
  origin: string;
  now?: () => number;
  /** Wait between retries (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  makeLimiter?: (perMinute: number) => RateLimiter;
}

const DEFAULT_COOLDOWN_MS = 60_000;
/** Waits before the 1st and 2nd retry of a Gemini 5xx. */
const RETRY_DELAYS_MS = [2000, 6000];
/** When web search is refused without a retry time, do not ask again for this long. */
const DEFAULT_GROUNDING_COOLDOWN_MS = 30 * 60_000;

/** Runs the call; if the answer fails validation, runs it one more time. */
async function validated<T>(call: () => Promise<unknown>, parse: (raw: unknown) => T): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return parse(await call());
    } catch (e) {
      if (!(e instanceof BadResponseError)) throw e;
      last = e;
    }
  }
  throw last;
}

export function createLlm(deps: LlmDeps): { generate: Generate } {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limiters = new Map<number, RateLimiter>();
  const limiterFor = (rpm: number): RateLimiter => {
    let l = limiters.get(rpm);
    if (!l) {
      l = deps.makeLimiter ? deps.makeLimiter(rpm) : createRateLimiter({ perMinute: rpm, now });
      limiters.set(rpm, l);
    }
    return l;
  };

  async function viaGemini<T>(s: Settings, req: LlmRequest<T>, signal?: AbortSignal): Promise<T> {
    const once = () =>
      limiterFor(s.geminiRpm).schedule(async () => {
        const r = await geminiGenerate({
          apiKey: s.geminiApiKey,
          model: s.geminiModel,
          system: req.system,
          prompt: req.prompt,
          schema: req.schema,
          grounding: req.grounding,
          signal,
          fetchImpl: deps.fetchImpl,
        });
        return r.data;
      });
    // A busy Gemini model answers 503 for a while. Retrying straight away does not help, so wait first.
    return validated(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once();
        } catch (e) {
          const retryable = e instanceof ServerError && e.retryable && attempt < RETRY_DELAYS_MS.length;
          if (!retryable) throw e;
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }, req.parse);
  }

  async function viaOllama<T>(s: Settings, req: LlmRequest<T>, signal?: AbortSignal): Promise<T> {
    const base = { baseUrl: s.ollamaUrl, origin: deps.origin, signal, fetchImpl: deps.fetchImpl };
    let model = s.ollamaModel;
    if (!model) {
      model = pickOllamaModel(await ollamaTags(base));
      if (!model) throw new OllamaUnreachableError('Ollama is running but has no models installed.');
    }
    const chosen = model;
    return validated(
      () => ollamaChat({ ...base, model: chosen, system: req.system, prompt: req.prompt, schema: req.schema }),
      req.parse,
    );
  }

  async function startCooldown(e: QuotaExceededError): Promise<void> {
    await deps.setCooldownUntil(now() + (e.retryDelayMs ?? DEFAULT_COOLDOWN_MS));
  }

  let groundingCooldown = 0;
  const getGroundingCooldown = deps.getGroundingCooldownUntil ?? (async () => groundingCooldown);
  const setGroundingCooldown =
    deps.setGroundingCooldownUntil ??
    (async (t: number) => {
      groundingCooldown = t;
    });

  const generate: Generate = async <T>(req: LlmRequest<T>, signal?: AbortSignal): Promise<LlmResult<T>> => {
    const s = await deps.getSettings();
    const cooldownUntil = await deps.getCooldownUntil();
    const geminiReady = !!s.geminiApiKey && now() >= cooldownUntil;

    // Grounded search only exists on Gemini.
    if (req.grounding) {
      if (!geminiReady || now() < (await getGroundingCooldown())) throw new SearchUnavailableError();
      try {
        return { data: await viaGemini(s, req, signal), provider: 'gemini' };
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          // Only web search is switched off for a while. Ordinary answers keep using Gemini.
          await setGroundingCooldown(now() + (e.retryDelayMs ?? DEFAULT_GROUNDING_COOLDOWN_MS));
          throw new SearchUnavailableError();
        }
        throw e;
      }
    }

    let geminiProblem: GeminiProblem | undefined;
    if (geminiReady) {
      try {
        return { data: await viaGemini(s, req, signal), provider: 'gemini' };
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          await startCooldown(e); // every request goes to Ollama until the quota is back
          geminiProblem = 'quota';
        } else if (e instanceof ServerError) {
          // Still failing after the waits and retries (repeated 503s, a timeout, no connection):
          // answer this request with Ollama instead of an error. No cooldown, because one busy
          // moment must not move every later request to the slower local model.
          geminiProblem = 'busy';
        } else {
          throw e; // a bad key or an unreadable answer is shown, not hidden behind the fallback
        }
      }
    }

    try {
      return { data: await viaOllama(s, req, signal), provider: 'ollama' };
    } catch (e) {
      if (e instanceof OllamaUnreachableError || e instanceof OriginNotAllowedError) {
        throw new NoProviderError(e, !!s.geminiApiKey, geminiProblem);
      }
      throw e;
    }
  };

  return { generate };
}
