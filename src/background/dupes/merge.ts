import type { Dupe, DupesResult, Perfume } from '../../shared/types';

export interface Candidate {
  name: string;
  brand: string;
  source: 'llm' | 'fragrantica';
  /** LLM similarity, 0-100. */
  similarity?: number;
  /** 0-based position in Fragrantica's list. */
  position?: number;
  reason?: string;
}

interface Merged {
  name: string;
  brand: string;
  llmSimilarity?: number;
  fragranticaPosition?: number;
  reason: string;
}

const CONCENTRATION_WORDS = ['eau de parfum', 'eau de toilette', 'eau de cologne', 'edp', 'edt', 'edc', 'parfum', 'extrait', 'cologne', 'perfume'];

function basic(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeBrand(brand: string): string {
  return basic(brand);
}

/**
 * Name without brand, "by X", concentration words and punctuation, for comparing names.
 * "Club de Nuit Intense Man by Armaf" -> "club de nuit intense man".
 */

export function normalizeName(name: string, brand: string): string {
  let n = ` ${basic(name)} `;
  n = n.replace(/ by [a-z0-9 ]+$/, ' ');
  for (const w of CONCENTRATION_WORDS) n = n.replace(new RegExp(` ${w} `, 'g'), ' ');
  // Only a leading brand ("Armaf Club de Nuit...") is dropped. A brand inside the name
  // ("Bleu de Chanel") is part of the perfume's name and must stay.
  const b = normalizeBrand(brand);
  if (b && n.startsWith(` ${b} `)) n = n.slice(b.length + 1);
  const plain = n.replace(/\s+/g, ' ').trim();
  return withoutMasculineTags(plain);
}

/**
 * "Club de Nuit Urban Elixir" (Fragrantica) and "Club de Nuit Urban Man Elixir" (the AI) are one
 * perfume: the masculine tags are not part of its name. Only clearly redundant tags are dropped:
 * "man" and "men" anywhere, and the phrases "pour homme", "for him/men/man" and "pour lui". A bare
 * "Homme" stays, because it is part of names such as "L'Homme Ideal" (not the women's "L'Ideal"),
 * and feminine tags stay too: "... Woman" is a different perfume from "... Man".
 */
function withoutMasculineTags(name: string): string {
  const words = name.split(' ');
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (w === 'man' || w === 'men') continue;
    if (w === 'pour' && (next === 'homme' || next === 'lui')) {
      i++;
      continue;
    }
    if (w === 'for' && (next === 'him' || next === 'men' || next === 'man')) {
      i++;
      continue;
    }
    kept.push(w);
  }
  return kept.join(' ') || name;
}

export function normalizeKey(brand: string, name: string): string {
  return `${normalizeBrand(brand)}|${normalizeName(name, brand)}`;
}

/** Shared words divided by the larger word count: 1 for the same words in any order. */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function sameBrand(a: string, b: string): boolean {
  const x = normalizeBrand(a);
  const y = normalizeBrand(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * The name as shown to the user and used for the lookup: without a leading brand
 * ("Armaf Club de Nuit" -> "Club de Nuit") or a trailing "by Brand". A brand that is part
 * of the name in the middle ("Bleu de Chanel") is kept.
 */
export function cleanName(name: string, brand: string): string {
  // A small model sometimes starts a name with a list dash or bullet ("- Asad").
  let n = name.trim().replace(/\s+/g, ' ').replace(/^[\s\-–—•*·]+/, '');
  const by = /^(.*?)\s+by\s+(.+)$/i.exec(n);
  if (by?.[1] && sameBrand(by[2], brand)) n = by[1];
  const b = brand.trim().replace(/\s+/g, ' ');
  if (b && n.toLowerCase().startsWith(`${b.toLowerCase()} `)) n = n.slice(b.length + 1).trim();
  return n || name.trim();
}

/** "by Armaf" at the end of a name tells us the brand when the source left it out. */
function splitBy(c: Candidate): Candidate {
  if (c.brand.trim()) return c;
  const m = /^(.*)\s+by\s+(.+)$/i.exec(c.name.trim());
  return m ? { ...c, name: m[1], brand: m[2] } : c;
}

export function isSamePerfume(a: { name: string; brand: string }, b: { name: string; brand: string }): boolean {
  return sameBrand(a.brand, b.brand) && tokenSetSimilarity(normalizeName(a.name, a.brand), normalizeName(b.name, b.brand)) >= 0.85;
}

/** The original perfume itself, or a flanker of it (same brand, name contains the original name). */
export function isFlanker(candidate: { name: string; brand: string }, original: Perfume): boolean {
  if (!sameBrand(candidate.brand, original.brand)) return false;
  const orig = normalizeName(original.name, original.brand).split(' ').filter(Boolean);
  const cand = new Set(normalizeName(candidate.name, candidate.brand).split(' '));
  return orig.length > 0 && orig.every((t) => cand.has(t));
}

/** Combines candidates that name the same perfume in different ways. */
export function mergeCandidates(candidates: Candidate[]): Merged[] {
  const out: Merged[] = [];
  for (const raw of candidates.map(splitBy)) {
    if (!raw.name.trim() || !raw.brand.trim()) continue;
    const hit = out.find((m) => isSamePerfume(m, raw));
    const target =
      hit ??
      (() => {
        const m: Merged = { name: cleanName(raw.name, raw.brand), brand: raw.brand.trim(), reason: '' };
        out.push(m);
        return m;
      })();
    if (raw.source === 'llm') {
      target.llmSimilarity = Math.max(target.llmSimilarity ?? 0, clamp(raw.similarity ?? 0));
      if (!target.reason && raw.reason) target.reason = raw.reason;
      // Prefer the AI's spelling of the name; it is usually the cleaner one.
      if (hit) target.name = cleanName(raw.name, raw.brand);
    } else {
      target.fragranticaPosition = Math.min(target.fragranticaPosition ?? Infinity, raw.position ?? 0);
    }
  }
  return out;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Fragrantica gives no similarity score. Its list is ordered by how many people voted for each
 * perfume, so the position stands in for one: 80% for the first, 2 points less for each place,
 * never below 40%. (An estimate, shown as such in the notes; not a figure Fragrantica publishes.)
 */
export function fragranticaOnlySimilarity(position: number): number {
  return Math.max(40, 80 - 2 * position);
}

/**
 * Ranking score. A perfume on Fragrantica's list gets +15 and up to +10 more for a high place;
 * one that both the AI and Fragrantica name gets another +10, so a confirmed dupe always beats
 * a single-source one of similar similarity.
 */
function score(m: Merged): number {
  const base = m.llmSimilarity ?? fragranticaOnlySimilarity(m.fragranticaPosition ?? 0);
  if (m.fragranticaPosition === undefined) return base;
  const positionBonus = Math.max(0, 10 - m.fragranticaPosition);
  const bothSources = m.llmSimilarity !== undefined ? 10 : 0;
  return base + 15 + positionBonus + bothSources;
}

/**
 * Most dupes shown. Fragrantica's list is the reference: its carousel has about 20-25 perfumes, and
 * the card shows them all (minus the original's own versions) plus the AI's extra picks.
 */
export const MAX_DUPES = 30;

/** Merges, removes the original and its flankers, ranks them and keeps up to MAX_DUPES. */
export function rankDupes(
  original: Perfume,
  candidates: Candidate[],
  trustedAvailable: boolean,
  trustedReason?: DupesResult['trustedReason'],
): DupesResult {
  const ranked = mergeCandidates(candidates)
    .filter((m) => !isFlanker(m, original))
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_DUPES);
  const dupes: Dupe[] = ranked.map((m) => ({
    key: normalizeKey(m.brand, m.name),
    name: m.name,
    brand: m.brand,
    similarity: clamp(m.llmSimilarity ?? fragranticaOnlySimilarity(m.fragranticaPosition ?? 0)),
    confirmed: m.llmSimilarity !== undefined && m.fragranticaPosition !== undefined,
    onFragrantica: m.fragranticaPosition !== undefined,
    reason: m.reason,
  }));
  return { dupes, trustedAvailable, few: dupes.length < 2, ...(trustedReason ? { trustedReason } : {}) };
}
