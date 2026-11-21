import type { Generate } from '../../llm';
import { CACHE_FORMAT, perfumeKey, TTL, type CacheStore } from '../../shared/cache';
import type { DupesResult, PageData, Perfume } from '../../shared/types';
import { rankDupes } from './merge';
import { alsoInSection, fragranticaSimilar, llmDupes } from './sources';

export interface DupesDeps {
  generate: Generate;
  signal: AbortSignal;
  cache: CacheStore;
  fetchImpl?: typeof fetch;
}

/**
 * Asks the AI and Fragrantica at the same time, then merges and ranks.
 * The AI source failing is an error; Fragrantica failing only means "trusted data not available".
 */
export async function lookupDupes(perfume: Perfume, page: PageData | null, deps: DupesDeps): Promise<DupesResult> {
  const key = `dupes:${CACHE_FORMAT}:${perfumeKey(perfume)}`;
  const cached = await deps.cache.get<DupesResult>(key);
  if (cached) return cached;

  // A list that the small local model helped write can be wrong. It is shown but never stored,
  // so the next lookup asks again and a Gemini list replaces it as soon as one is available.
  // (The prices found for each dupe come from real shop pages and are cached separately.)
  let answeredLocally = false;
  const generate: Generate = async (req, signal) => {
    const r = await deps.generate(req, signal);
    if (r.provider === 'ollama') answeredLocally = true;
    return r;
  };

  const [fromLlm, fromFragrantica] = await Promise.all([
    llmDupes(generate, perfume, deps.signal),
    fragranticaSimilar(perfume, page, { ...deps, generate }),
  ]);
  let trusted = fromFragrantica.available ? fromFragrantica.candidates : [];
  // An AI suggestion that is written in Fragrantica's list on the page is on that list too, even if
  // the AI's reading of the list missed it or spelled it differently.
  if (fromFragrantica.available && fromFragrantica.sectionText) {
    trusted = [...trusted, ...alsoInSection(fromLlm, fromFragrantica.sectionText, trusted.length)];
  }
  const result = rankDupes(
    perfume,
    [...fromLlm, ...trusted],
    fromFragrantica.available,
    fromFragrantica.available ? undefined : fromFragrantica.reason,
  );
  if (result.dupes.length > 0 && !answeredLocally) await deps.cache.set(key, result, TTL.dupes);
  return result;
}
