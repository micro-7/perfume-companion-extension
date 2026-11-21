import type { Generate, LlmRequest } from '../llm';
import { withoutIngredients } from '../shared/ingredients';
import { extractStructuredPriceInr, priceAppearsInText } from '../shared/page';
import type { CurrentPrice, Notes, PageData, Perfume } from '../shared/types';
import {
  optionalNumber,
  optionalString,
  requireBoolean,
  requireObject,
  stringArray,
  type JsonSchema,
} from '../shared/validate';

export interface Detection {
  found: boolean;
  perfume: Perfume | null;
  /** Notes listed on the page itself (may be empty). */
  pageNotes: Notes;
  currentPrice: CurrentPrice;
}

const strings = { type: 'array', items: { type: 'string' } };

export const DETECTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    name: { type: 'string' },
    brand: { type: 'string' },
    concentration: { type: 'string' },
    notes: {
      type: 'object',
      properties: { top: strings, heart: strings, base: strings, flat: strings },
      required: ['top', 'heart', 'base', 'flat'],
    },
    currentPrice: {
      type: 'object',
      properties: { amountInr: { type: 'number' }, siteName: { type: 'string' } },
      required: ['amountInr', 'siteName'],
    },
  },
  required: ['found', 'name', 'brand', 'concentration', 'notes', 'currentPrice'],
};

interface RawDetection {
  found: boolean;
  name: string;
  brand: string;
  concentration: string;
  notes: Notes;
  priceInr: number | null;
  siteName: string;
}

export function parseDetection(raw: unknown): RawDetection {
  const o = requireObject(raw, 'detection');
  const notes = o.notes === undefined || o.notes === null ? {} : requireObject(o.notes, 'notes');
  const price = o.currentPrice === undefined || o.currentPrice === null ? {} : requireObject(o.currentPrice, 'currentPrice');
  return {
    found: requireBoolean(o, 'found'),
    name: optionalString(o, 'name'),
    brand: optionalString(o, 'brand'),
    concentration: optionalString(o, 'concentration'),
    // Ingredient lists ("Alcohol, Aqua, Limonene") are sometimes mistaken for notes.
    notes: {
      top: withoutIngredients(stringArray(notes, 'top')),
      heart: withoutIngredients(stringArray(notes, 'heart')),
      base: withoutIngredients(stringArray(notes, 'base')),
      flat: withoutIngredients(stringArray(notes, 'flat')),
    },
    priceInr: optionalNumber(price, 'amountInr'),
    siteName: optionalString(price, 'siteName'),
  };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * A small local model often returns the whole shop title as the name ("Christian Dior Sauvage Eau de
 * Toilette Spray For Men (Citrus)"). Shops cannot find that, so strip what is not the perfume's name:
 * the brand, "(Citrus)", "Eau de Toilette" (kept as the concentration), "Spray", "For Men", sizes.
 * A bare "Parfum" or "Extrait" stays: "Sauvage Parfum" is a different perfume from "Sauvage".
 */
export function cleanPerfumeName(name: string, brand: string, concentration: string): { name: string; concentration: string } {
  let n = ` ${name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()} `;
  let conc = concentration.trim();
  const eau = /\s(eau de (?:toilette|parfum|cologne)|edt|edp)(?=\s)/i.exec(n);
  if (eau) {
    const names: Record<string, string> = {
      'eau de toilette': 'Eau de Toilette',
      'eau de parfum': 'Eau de Parfum',
      'eau de cologne': 'Eau de Cologne',
      edt: 'Eau de Toilette',
      edp: 'Eau de Parfum',
    };
    if (!conc) conc = names[eau[1].toLowerCase()] ?? eau[1];
    n = n.replace(eau[0], ' ');
  }
  n = n
    .replace(/\s(?:for|pour)\s(?:men|women|him|her|man|woman)(?=\s)/gi, ' ')
    .replace(/\s(?:spray|vaporisateur)(?=\s)/gi, ' ')
    .replace(/\s\d+(?:\.\d+)?\s?(?:ml|oz|fl\.? ?oz)(?=\s)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const b = brand.trim().replace(/\s+/g, ' ');
  if (b && n.toLowerCase().startsWith(`${b.toLowerCase()} `)) n = n.slice(b.length + 1).trim();
  // "Christian Dior Sauvage" when the brand was given as just "Dior".
  const last = b.split(' ').at(-1) ?? '';
  const lead = /^christian\s+/i.exec(n);
  if (lead && last && b.toLowerCase().endsWith('dior') && n.slice(lead[0].length).toLowerCase() !== n.toLowerCase()) n = n.slice(lead[0].length).trim();
  return { name: n || name.trim(), concentration: conc };
}

/**
 * When the page shows the price in several places, the one written most often is this product's.
 * A small model sometimes takes a price from a different product (₹298 for a ₹17,900 perfume).
 */
export function mostRepeatedPrice(text: string): { amount: number; count: number } | null {
  if (!/₹|\brs\.?|\binr\b/i.test(text)) return null;
  const counts = new Map<number, number>();
  for (const m of text.matchAll(/(?:₹|rs\.?)\s*(\d[\d,]*)(?:\.\d+)?/gi)) {
    const v = Number.parseInt(m[1].replaceAll(',', ''), 10);
    if (v >= 100) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: { amount: number; count: number } | null = null;
  for (const [amount, count] of counts) if (!best || count > best.count) best = { amount, count };
  return best;
}

function countOf(page: PageData, amount: number): number {
  const t = `${page.title}\n${page.text}`;
  let n = 0;
  for (const m of t.matchAll(/(?:₹|rs\.?)\s*(\d[\d,]*)(?:\.\d+)?/gi)) {
    if (Number.parseInt(m[1].replaceAll(',', ''), 10) === Math.round(amount)) n++;
  }
  return n;
}

/** Does the page look like a shop page for a product (so "no perfume found" is probably a slip)? */
export function looksLikeProductPage(page: PageData): boolean {
  const t = `${page.title}\n${page.text}`;
  const priced = /₹\s?\d|\brs\.?\s?\d/i.test(t);
  const shop = /add to (cart|bag|basket)|buy now/i.test(t) || page.jsonLd.some((j) => /"@type"\s*:\s*"Product"/.test(j));
  return priced && shop;
}

/** Turns the model's answer into a Detection. A perfume needs both a name and a brand. */
export function toDetection(raw: RawDetection, page: PageData, fromLocalModel = false): Detection {
  const siteName = raw.siteName || page.meta['og:site_name'] || hostname(page.url);
  const noNotes: Notes = { top: [], heart: [], base: [], flat: [] };
  if (!raw.found || !raw.name || !raw.brand) {
    return { found: false, perfume: null, pageNotes: noNotes, currentPrice: { amountInr: null, siteName } };
  }
  const cleaned = cleanPerfumeName(raw.name, raw.brand, raw.concentration);
  const modelPrice = raw.priceInr != null && priceAppearsInText(`${page.title}\n${page.text}`, raw.priceInr) ? raw.priceInr : null;
  // Only for the small local model (Gemini's answer is used as before): if it picked a price that
  // the page shows rarely while another price is shown 3+ times and at least 3x as often, it
  // probably took another product's price (₹298 for a ₹17,900 perfume), so use the common one.
  const common = fromLocalModel && modelPrice != null ? mostRepeatedPrice(`${page.title}\n${page.text}`) : null;
  const pagePrice =
    modelPrice != null && common && common.amount !== modelPrice && common.count >= 3 && common.count >= 3 * Math.max(1, countOf(page, modelPrice))
      ? common.amount
      : modelPrice;
  return {
    found: true,
    perfume: { name: cleaned.name, brand: raw.brand, concentration: cleaned.concentration },
    pageNotes: raw.notes,
    // Price from the page's own structured data beats the model's reading of the text. A price the
    // model gives is used only if it is really written on the page in rupees; on a page that shows
    // another currency (EUR 151.00) the model converts, and an invented price would make every
    // "you save" figure wrong.
    currentPrice: {
      amountInr: extractStructuredPriceInr(page) ?? pagePrice,
      siteName,
    },
  };
}

const SYSTEM =
  'You read the text of a web page and identify the perfume (fragrance) it is about. ' +
  'Answer with JSON only. Never invent data that is not on the page, except where told to.';

export function buildDetectionPrompt(page: PageData): string {
  const meta = Object.entries(page.meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const jsonLd = page.jsonLd.join('\n').slice(0, 4000);
  const lines: string[] = [
    'Is this page about a specific perfume product? Fill in the JSON:',
    '- found: true only if the page is mainly about one specific perfume.',
    '- name: the perfume name only, without brand, size or concentration (e.g. "Sauvage").',
    '- brand: the brand (e.g. "Dior").',
    '- concentration: e.g. "Eau de Parfum", or "" if not stated.',
    '- notes: top/heart/base scent notes ONLY if the page lists them; use "flat" if notes are listed without tiers. Otherwise empty arrays.',
    '  An "Ingredients" list (Alcohol, Aqua, Parfum, Limonene, Linalool...) is NOT notes: ignore it.',
    '- currentPrice.amountInr: the price of this product shown on the page in Indian rupees as a plain number, or 0 if not shown or not in rupees.',
    '- currentPrice.siteName: the name of the website or shop.',
    '',
    `URL: ${page.url}`,
    `Title: ${page.title}`,
  ];
  if (meta) lines.push(`Meta:\n${meta}`);
  if (jsonLd) lines.push(`Structured data:\n${jsonLd}`);
  lines.push('', 'Page text:', page.text);
  return lines.join('\n');
}

const tokens = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Is the perfume the one this page is about? Its name must be in the page title or address, and
 * (one word of) its brand in the title, address, meta tags or the start of the page.
 */
export function namedByPage(perfume: Perfume, page: PageData): boolean {
  const head = new Set(tokens(`${page.title} ${page.url} ${page.meta['og:title'] ?? ''} ${page.meta.title ?? ''}`));
  const name = tokens(perfume.name);
  if (name.length === 0 || !name.every((t) => head.has(t))) return false;
  // A "name" that is only the brand again ("Maison Martin Margiela" by Maison Martin Margiela) is not a perfume name.
  const brandWords = tokens(perfume.brand);
  if (brandWords.length > 0 && name.every((t) => brandWords.includes(t))) return false;
  // On a Fragrantica perfume page the address names the perfume: the answer must contain that
  // name (or be part of it).
  const fromUrl = fromFragranticaUrl(page.url);
  if (fromUrl) {
    const want = tokens(fromUrl.name);
    if (!want.every((t) => name.includes(t)) && !name.every((t) => want.includes(t))) return false;
  }
  const around = new Set([...head, ...tokens(`${Object.values(page.meta).join(' ')} ${page.text.slice(0, 1500)}`)]);
  const brand = tokens(perfume.brand).filter((t) => t.length >= 3);
  return brand.length === 0 || brand.some((t) => around.has(t));
}

/** fragrantica.com/perfume/Dior/Sauvage-31861.html -> Dior, Sauvage. */
export function fromFragranticaUrl(url: string): { brand: string; name: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)fragrantica\.com$/i.test(u.hostname)) return null;
    const m = /^\/perfume\/([^/]+)\/(.+?)-\d+\.html$/i.exec(u.pathname);
    if (!m) return null;
    const words = (s: string) => decodeURIComponent(s).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const brand = words(m[1]);
    const name = words(m[2]);
    return brand && name ? { brand, name } : null;
  } catch {
    return null;
  }
}

export async function detectPerfume(
  generate: Generate,
  page: PageData,
  signal?: AbortSignal,
): Promise<Detection> {
  const req: LlmRequest<RawDetection> = {
    system: SYSTEM,
    prompt: buildDetectionPrompt(page),
    schema: DETECTION_SCHEMA,
    parse: parseDetection,
  };
  const first = await generate(req, signal);
  const firstDetection = toDetection(first.data, page, first.provider === 'ollama');
  // Gemini's answer is used as it is. Everything below is only for the small local model.
  if (first.provider !== 'ollama') return firstDetection;

  // The local model's answer is trusted if the perfume it names is the one in the page's title or
  // address. If it named something else (a perfume from the sidebar, ads or reviews) or said "not a
  // perfume" on a priced shop page, it is asked once more with the title and address pointed out.
  const agrees = firstDetection.found && firstDetection.perfume && namedByPage(firstDetection.perfume, page);
  if (agrees) return firstDetection;
  const hint = fromFragranticaUrl(page.url);
  // "Not a perfume" is final on a page that is neither a priced shop page nor a Fragrantica perfume page.
  if (!firstDetection.found && !looksLikeProductPage(page) && !hint) return firstDetection;

  const fromUrl: Detection | null = hint
    ? {
        found: true,
        perfume: { name: hint.name, brand: hint.brand, concentration: '' },
        pageNotes: { top: [], heart: [], base: [], flat: [] },
        currentPrice: { amountInr: null, siteName: hostname(page.url) },
      }
    : null;
  const again: LlmRequest<RawDetection> = {
    ...req,
    prompt: [
      req.prompt,
      '',
      'Important: the perfume this page is about is the one named in the page title and the URL above, not one that is only mentioned in suggestions, reviews, ads or lists.',
      `Page title: ${page.title}`,
      hint ? `The URL says the brand is "${hint.brand}" and the perfume is "${hint.name}".` : '',
      'If the main product is a perfume, answer found=true with its name and brand.',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  };
  let secondDetection: Detection;
  try {
    const second = await generate(again, signal);
    secondDetection = toDetection(second.data, page, second.provider === 'ollama');
  } catch (e) {
    // The extra request is only a check. If it fails, the first answer stands, as it did before
    // the check existed (never turn a good answer into an error).
    if (signal?.aborted) throw e;
    return fromUrl ?? firstDetection;
  }
  if (secondDetection.found && secondDetection.perfume && namedByPage(secondDetection.perfume, page)) return secondDetection;
  // Still not the page's perfume. On Fragrantica the address names it exactly; otherwise it is
  // better to say nothing was detected than to show the wrong perfume.
  if (fromUrl) return fromUrl;
  return { found: false, perfume: null, pageNotes: { top: [], heart: [], base: [], flat: [] }, currentPrice: firstDetection.currentPrice };
}
