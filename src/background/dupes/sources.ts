import type { Generate, LlmRequest } from '../../llm';
import { BadResponseError } from '../../llm/errors';
import type { PageData, Perfume } from '../../shared/types';
import { isObject, optionalNumber, optionalString, requireObject, type JsonSchema } from '../../shared/validate';
import { focusOnPhrase, isUnusable, reduceHtml } from '../prices/html';
import type { Candidate } from './merge';

const str = { type: 'string' };

// ---------- AI suggestions ----------

export const LLM_DUPES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    dupes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, brand: str, similarity: { type: 'number' }, reason: str },
        required: ['name', 'brand', 'similarity', 'reason'],
      },
    },
  },
  required: ['dupes'],
};

export function parseLlmDupes(raw: unknown): Candidate[] {
  const o = requireObject(raw, 'dupes');
  if (!Array.isArray(o.dupes)) throw new BadResponseError('"dupes" must be an array');
  return o.dupes
    .filter(isObject)
    .map((d) => ({
      name: optionalString(d, 'name'),
      brand: optionalString(d, 'brand'),
      similarity: optionalNumber(d, 'similarity') ?? 0,
      reason: optionalString(d, 'reason'),
      source: 'llm' as const,
    }))
    .filter((d) => d.name && d.brand)
    .slice(0, 8);
}

export function buildLlmDupesPrompt(p: Perfume): string {
  const label = [p.brand, p.name, p.concentration].filter(Boolean).join(' ');
  return [
    `Perfume: ${label}`,
    'Suggest up to 8 cheaper perfumes that smell very similar to it (well-known "dupes" or clones), best first.',
    `Do NOT include ${p.brand} ${p.name} itself or any of its flankers or versions from ${p.brand} (e.g. "${p.name} Elixir", "${p.name} Intense").`,
    'Only real perfumes that you are confident exist and are sold in India.',
    'similarity: 0-100, how close the scent is. reason: a few plain words on why it is similar.',
  ].join('\n');
}

export async function llmDupes(generate: Generate, perfume: Perfume, signal: AbortSignal): Promise<Candidate[]> {
  const req: LlmRequest<Candidate[]> = {
    system: 'You are a perfume expert who knows which affordable perfumes smell like expensive ones. Answer with JSON only.',
    prompt: buildLlmDupesPrompt(perfume),
    schema: LLM_DUPES_SCHEMA,
    parse: parseLlmDupes,
  };
  return (await generate(req, signal)).data;
}

// ---------- Fragrantica "This perfume reminds me of" ----------

const SIMILAR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pageUrl: str,
    similar: { type: 'array', items: { type: 'object', properties: { name: str, brand: str }, required: ['name', 'brand'] } },
  },
  required: ['pageUrl', 'similar'],
};

interface SimilarAnswer {
  pageUrl: string;
  similar: Array<{ name: string; brand: string }>;
}

export function parseSimilar(raw: unknown): SimilarAnswer {
  const o = requireObject(raw, 'similar');
  if (!Array.isArray(o.similar)) throw new BadResponseError('"similar" must be an array');
  return {
    pageUrl: optionalString(o, 'pageUrl'),
    similar: o.similar
      .filter(isObject)
      .map((s) => ({ name: optionalString(s, 'name'), brand: optionalString(s, 'brand') }))
      .filter((s) => s.name),
  };
}

/**
 * How many of Fragrantica's list are read. The list is long (dozens), ordered by votes, and the
 * perfumes further along are the interesting alternatives; reading only the first 10 left most
 * of it out. Far down the list the ranking gives them little weight anyway.
 */
export const FRAGRANTICA_DEPTH = 30;

const toCandidates = (list: SimilarAnswer['similar']): Candidate[] =>
  list.slice(0, FRAGRANTICA_DEPTH).map((s, i) => ({ name: s.name, brand: s.brand, source: 'fragrantica' as const, position: i }));

export function isFragranticaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'fragrantica.com' || host.endsWith('.fragrantica.com');
  } catch {
    return false;
  }
}

const SIMILAR_RULES =
  'List the perfumes in the "This perfume reminds me of" section, in the order shown, each with name and brand. ' +
  'Copy each name exactly as it is written on the page. If a name ends with "by X", X is the brand. ' +
  'Leave pageUrl as "" if unknown. Do not add perfumes that are not in that section, and never add one from memory: ' +
  'if the section is not in the text, return an empty list.';

/** The heading of Fragrantica's list of similar perfumes. */
const SECTION = /this perfume reminds me of/i;

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/**
 * Keeps only perfumes whose name really is in the page text. When the section is missing the AI
 * tends to fill the list from memory; a name that is not on the page is not Fragrantica's.
 */
export function onlyNamedInText(list: SimilarAnswer['similar'], text: string): SimilarAnswer['similar'] {
  const lower = text.toLowerCase();
  return list.filter((s) => {
    const w = words(s.name);
    if (w.length > 0) return w.every((word) => lower.includes(word));
    // A one-letter name such as YSL's "Y" cannot be matched inside other words: it must stand alone.
    const bare = s.name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return bare.length > 0 && new RegExp(`(^|[^a-z0-9])${bare}([^a-z0-9]|$)`).test(lower);
  });
}

async function extractSimilarFromText(generate: Generate, perfume: Perfume, text: string, signal: AbortSignal) {
  const { data } = await generate(
    {
      system: 'You read Fragrantica perfume pages. Answer with JSON only.',
      prompt: `Fragrantica page for ${perfume.brand} ${perfume.name}.\n${SIMILAR_RULES}\n\nPage:\n${text}`,
      schema: SIMILAR_SCHEMA,
      parse: parseSimilar,
    },
    signal,
  );
  return data.similar;
}

export interface FragranticaDeps {
  generate: Generate;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

const plain = (s: string) => ` ${s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * AI-suggested perfumes whose full name (and brand) is written in Fragrantica's list text but that
 * the extraction step did not return or spelled differently. They are on Fragrantica's list too,
 * so they are returned as Fragrantica candidates (after the ones already read, in the order given).
 */
export function alsoInSection(suggested: Candidate[], section: string, alreadyRead: number): Candidate[] {
  const text = plain(section);
  const out: Candidate[] = [];
  for (const c of suggested) {
    const name = plain(c.name);
    const brandWords = plain(c.brand).trim().split(' ').filter((w) => w.length >= 2);
    if (name.trim() && text.includes(name) && brandWords.every((w) => text.includes(` ${w} `))) {
      out.push({ name: c.name, brand: c.brand, source: 'fragrantica', position: alreadyRead + out.length });
    }
  }
  return out;
}

export type FragranticaResult =
  | { available: true; candidates: Candidate[]; /** The list's text, to check other perfumes against. */ sectionText?: string }
  /** `not-on-page`: the user is on Fragrantica but the list was not in the page text. */
  | { available: false; reason?: 'not-on-page' };

/**
 * Fragrantica's "This perfume reminds me of" list:
 * 1. from the current page, when the user is on Fragrantica;
 * 2. otherwise find the page with grounded search, fetch it and read the list;
 * 3. if the fetch is blocked, use the list from the grounded answer;
 * 4. otherwise unavailable.
 */
export async function fragranticaSimilar(
  perfume: Perfume,
  page: PageData | null,
  deps: FragranticaDeps,
): Promise<FragranticaResult> {
  try {
    if (page && isFragranticaUrl(page.url)) {
      // The list is low on a long page and may load only when scrolled into view. If it is not in
      // the text, say so; do not ask the AI to read a section that is not there.
      const full = page.fullText ?? page.text;
      if (!SECTION.test(full)) return { available: false, reason: 'not-on-page' };
      const section = focusOnPhrase(full, SECTION, 15_000, 100);
      const list = onlyNamedInText(await extractSimilarFromText(deps.generate, perfume, section, deps.signal), section);
      return list.length
        ? { available: true, candidates: toCandidates(list), sectionText: section }
        : { available: false, reason: 'not-on-page' };
    }

    const { data: found } = await deps.generate(
      {
        system: 'You find perfume pages on fragrantica.com. Answer with JSON only.',
        prompt: `Find the fragrantica.com page for the perfume "${perfume.brand} ${perfume.name}" and give its URL as pageUrl.\n${SIMILAR_RULES}`,
        schema: SIMILAR_SCHEMA,
        grounding: { site: 'fragrantica.com' },
        parse: parseSimilar,
      },
      deps.signal,
    );

    if (found.pageUrl && isFragranticaUrl(found.pageUrl)) {
      try {
        const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(10_000)]);
        const res = await (deps.fetchImpl ?? fetch)(found.pageUrl, { credentials: 'include', signal });
        const html = await res.text();
        const full = reduceHtml(html, 400_000);
        if (!isUnusable(res.status, full, html)) {
          // The "reminds me of" section is far down a long page; send the part around it.
          const reduced = focusOnPhrase(full, /reminds me of|similar perfumes/i, 15_000);
          const list = onlyNamedInText(await extractSimilarFromText(deps.generate, perfume, reduced, deps.signal), reduced);
          if (list.length) return { available: true, candidates: toCandidates(list) };
        }
      } catch (e) {
        if (deps.signal.aborted) throw e;
        // blocked or failed: use the grounded answer below
      }
    }
    return found.similar.length ? { available: true, candidates: toCandidates(found.similar) } : { available: false };
  } catch (e) {
    if (deps.signal.aborted) throw e;
    return { available: false }; // includes SearchUnavailable while Gemini is in cooldown
  }
}
