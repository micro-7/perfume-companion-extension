import type { Generate, LlmRequest } from '../llm';
import { BadResponseError } from '../llm/errors';
import { cacheGet, cacheSet, perfumeKey, TTL } from '../shared/cache';
import { withoutIngredients } from '../shared/ingredients';
import type { Notes, NotesCardData, Perfume } from '../shared/types';
import { requireObject, requireString, stringArray, type JsonSchema } from '../shared/validate';

const strings = { type: 'array', items: { type: 'string' } };

export const NOTES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { top: strings, heart: strings, base: strings, flat: strings, description: { type: 'string' } },
  required: ['top', 'heart', 'base', 'flat', 'description'],
};

export function parseNotes(raw: unknown): NotesCardData {
  const o = requireObject(raw, 'notes');
  return {
    top: withoutIngredients(stringArray(o, 'top')),
    heart: withoutIngredients(stringArray(o, 'heart')),
    base: withoutIngredients(stringArray(o, 'base')),
    flat: withoutIngredients(stringArray(o, 'flat')),
    description: requireString(o, 'description'),
  };
}

/** Splits text into sentences (ends at . ! or ? followed by a space or the end). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function countSentences(text: string): number {
  return splitSentences(text).length;
}

export function trimToSentences(text: string, max: number): string {
  return splitSentences(text).slice(0, max).join(' ');
}

const hasTiers = (n: Notes) => n.top.length + n.heart.length + n.base.length > 0;

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** True when at least half of the page's flat notes also appear in the model's pyramid. */
function agrees(pageFlat: string[], model: Notes): boolean {
  const known = [...model.top, ...model.heart, ...model.base].map(plain);
  const hits = pageFlat.filter((n) => {
    const x = plain(n);
    return x && known.some((k) => k.includes(x) || x.includes(k));
  }).length;
  return hits / pageFlat.length >= 0.5;
}

/**
 * Notes found on the page win. Tiers the page does not list are filled from the model.
 * A page that lists only a flat list keeps it as a flat list.
 */
export function mergeNotes(page: Notes, model: Notes): Notes {
  if (hasTiers(page)) {
    return {
      top: page.top.length ? page.top : model.top,
      heart: page.heart.length ? page.heart : model.heart,
      base: page.base.length ? page.base : model.base,
      flat: [],
    };
  }
  if (page.flat.length) {
    // The page lists the notes without tiers. If the model's pyramid agrees with that list
    // (most of the page's notes appear in it), the pyramid is more useful, so show that.
    if (hasTiers(model) && agrees(page.flat, model)) return { top: model.top, heart: model.heart, base: model.base, flat: [] };
    return { top: [], heart: [], base: [], flat: page.flat };
  }
  if (hasTiers(model)) return { top: model.top, heart: model.heart, base: model.base, flat: [] };
  return { top: [], heart: [], base: [], flat: model.flat };
}

const SYSTEM =
  'You are a perfume expert who explains scents to people with no fragrance knowledge. Answer with JSON only.';

export function buildNotesPrompt(perfume: Perfume, pageNotes: Notes, stricter = false): string {
  const known = hasTiers(pageNotes) || pageNotes.flat.length
    ? `Notes already listed on the page (keep them): ${JSON.stringify(pageNotes)}`
    : 'The page did not list any notes.';
  const label = [perfume.brand, perfume.name, perfume.concentration].filter(Boolean).join(' ');
  return [
    `Perfume: ${label}`,
    known,
    'Fill in the JSON:',
    '- top, heart, base: the note pyramid for this perfume, filling in any tier missing above. Use [] for a tier you do not know. Do not make notes up.',
    '- flat: only if the notes are known as a single list with no tiers; otherwise [].',
    '- description: how it smells, in plain everyday words (for example "fresh, peppery, a bit woody"). Not a list of note names.',
    stricter
      ? 'IMPORTANT: description must be between 1 and 3 sentences. Count them.'
      : 'The description must be 1 to 3 sentences.',
  ].join('\n');
}

export interface NotesDeps {
  cache?: {
    get: <T>(key: string) => Promise<T | null>;
    set: <T>(key: string, value: T, ttlMs: number) => Promise<void>;
  };
}

const defaultCache: NonNullable<NotesDeps['cache']> = {
  get: (k) => cacheGet(k),
  set: (k, v, ttl) => cacheSet(k, v, ttl),
};

export async function getNotes(
  generate: Generate,
  perfume: Perfume,
  pageNotes: Notes,
  signal?: AbortSignal,
  deps: NotesDeps = {},
): Promise<NotesCardData> {
  const cache = deps.cache ?? defaultCache;
  const key = `notes:${perfumeKey(perfume)}`;
  const cached = await cache.get<NotesCardData>(key);
  if (cached) return cached;

  let description = '';
  let model: NotesCardData | null = null;
  // Notes written by the small local model can be wrong. They are shown, but never stored,
  // so the next lookup asks again and a Gemini answer replaces them as soon as it is available.
  let answeredLocally = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const req: LlmRequest<NotesCardData> = {
      system: SYSTEM,
      prompt: buildNotesPrompt(perfume, pageNotes, attempt > 0),
      schema: NOTES_SCHEMA,
      parse: parseNotes,
    };
    const { data, provider } = await generate(req, signal);
    if (provider === 'ollama') answeredLocally = true;
    model = data;
    description = data.description;
    const n = countSentences(description);
    if (n >= 1 && n <= 3) break;
  }
  if (!model || countSentences(description) === 0) throw new BadResponseError('No scent description');

  const result: NotesCardData = {
    ...mergeNotes(pageNotes, model),
    description: trimToSentences(description, 3),
  };
  if (!answeredLocally) await cache.set(key, result, TTL.notes);
  return result;
}
