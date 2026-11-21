import type { Shop } from '../../shared/shops';
import type { Perfume } from '../../shared/types';

export const MAX_REDUCED_CHARS = 8000;
const MIN_USABLE_CHARS = 300;

/** The perfume as a person would describe it: "Christian Dior Sauvage Eau De Toilette". Used in prompts. */
export function searchQuery(p: Perfume): string {
  return [p.brand, p.name, p.concentration].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Words that shop titles often leave out of a brand ("Christian Dior" is sold as "Dior"). */
const BRAND_PREFIXES = new Set(['christian', 'the']);

/**
 * What to type into a shop's search box. Shops match on every word, so extra words make results
 * disappear: "Christian Dior Sauvage Eau De Toilette" found nothing on a shop that sells
 * "Dior Sauvage EDT". Brand and name are enough; the model picks the right size and concentration.
 */
export function searchTerms(p: Pick<Perfume, 'brand' | 'name'>): string {
  const brandWords = p.brand.trim().split(/\s+/).filter(Boolean);
  const brand = brandWords.length > 1 && BRAND_PREFIXES.has(brandWords[0].toLowerCase()) ? brandWords.slice(1) : brandWords;
  return [...brand, p.name.trim()].join(' ').replace(/\s+/g, ' ').trim();
}

export function buildSearchUrl(shop: Pick<Shop, 'searchUrl'>, perfume: Perfume): string {
  return shop.searchUrl.replace('{query}', encodeURIComponent(searchTerms(perfume)));
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * Turns a shop's search page into short plain text for the model: removes scripts, styles and
 * markup, keeps JSON-LD product data and keeps links as "text [link: href]".
 * The service worker has no DOM, so this works on the HTML string.
 */
export function reduceHtml(html: string, max: number = MAX_REDUCED_CHARS): string {
  const jsonLd: string[] = [];
  let s = html.replace(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (_m, body: string) => {
      jsonLd.push(body.replace(/\s+/g, ' ').trim().slice(0, 1500));
      return ' ';
    },
  );
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|noscript|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return text ? ` ${text} [link: ${href}] ` : ' ';
    })
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  const ld = jsonLd.length ? `Structured data:\n${jsonLd.join('\n')}\n\n` : '';
  return (ld + s).slice(0, max);
}

const PRICE = /(?:₹|rs\.?|inr)\s?[\d,]{3,}/i;
/** Cap on the structured-data block that is always kept at the start. */
const HEAD_CAP = 1500;
/** Lines kept around a line that names the perfume (the price and link are usually just after it). */
const CARD_BEFORE = 1;
const CARD_AFTER = 4;
const LINE_CAP = 400;
/** How far back to look for a line break before a phrase. */
const LINE_SNAP = 2000;

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/**
 * Real shop pages are long: menus, filters, and dozens of look-alike products. This keeps only the
 * product cards that name the perfume (with their price lines), in page order, plus any structured
 * data from the top. Short pages are returned unchanged.
 */
export function focusOnProduct(reduced: string, perfume: Pick<Perfume, 'name' | 'brand'>, max: number = MAX_REDUCED_CHARS): string {
  if (reduced.length <= max) return reduced;
  const needed = words(perfume.name).length ? words(perfume.name) : words(perfume.brand);
  if (needed.length === 0) return reduced.slice(0, max);

  // The product cards that name the perfume: each matching line with the lines around it, where the
  // price and the link usually are. (On a real shop only 12 of 650 lines named it, but the listing
  // was at character 27,000, past any fixed window, behind menus and look-alikes.)
  const lines = reduced.split('\n');
  const matches: number[] = [];
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    if (needed.every((t) => l.includes(t))) matches.push(i);
  });
  if (matches.length === 0) return reduced.slice(0, max);

  const blocks = matches.map((i) => {
    const from = Math.max(0, i - CARD_BEFORE);
    const to = Math.min(lines.length - 1, i + CARD_AFTER);
    const text = lines.slice(from, to + 1).map((l) => l.slice(0, LINE_CAP));
    return { from, to, text, priced: PRICE.test(text.join(' ')) };
  });
  // Menus and filters mention the name without a price; prefer the cards that have one.
  const useful = blocks.some((b) => b.priced) ? blocks.filter((b) => b.priced) : blocks;

  const parts: string[] = [];
  let lastTo = -2;
  for (const b of useful) {
    const skip = Math.max(0, lastTo + 1 - b.from); // lines already included by the previous card
    if (b.from > lastTo + 1 && parts.length) parts.push('...');
    parts.push(...b.text.slice(skip));
    lastTo = Math.max(lastTo, b.to);
  }

  const headEnd = reduced.startsWith('Structured data:') ? reduced.indexOf('\n\n') : -1;
  const head = headEnd > 0 ? `${reduced.slice(0, Math.min(headEnd, HEAD_CAP))}\n\n` : '';
  return (head + parts.join('\n')).slice(0, max);
}

/** The text from just before the first match of `pattern`, for long pages (e.g. a Fragrantica section). */
export function focusOnPhrase(reduced: string, pattern: RegExp, max: number, lead = 300): string {
  if (reduced.length <= max) return reduced;
  const at = reduced.search(pattern);
  if (at < 0) return reduced.slice(0, max);
  const from = Math.max(0, at - lead);
  // Start at the line break just before, if there is one close by. Text with long lines has none,
  // and falling back to the very top would cut the section off.
  const lineStart = reduced.lastIndexOf('\n', from);
  const start = lineStart >= 0 && from - lineStart < LINE_SNAP ? lineStart + 1 : from;
  return reduced.slice(start, start + max);
}

const BOT_MARKERS =
  /captcha|cf-chl|challenge-platform|cf-browser-verification|just a moment\.\.\.|access denied|are you a (?:human|robot)|unusual traffic|pardon our interruption/i;

/** True when a fetched search page is no use: an HTTP error, a bot check, or (nearly) no content. */
export function isUnusable(status: number, reduced: string, rawHtml = ''): boolean {
  if (status < 200 || status >= 300) return true;
  if (BOT_MARKERS.test(rawHtml.slice(0, 20_000)) && reduced.length < 3000) return true;
  return reduced.trim().length < MIN_USABLE_CHARS;
}

/** Makes a product URL absolute and accepts it only if it is on the shop's own domain. */
export function resolveProductUrl(url: string | undefined, shop: Pick<Shop, 'searchUrl' | 'domain'>): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url, shop.searchUrl.replace('{query}', 'q'));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  return host === shop.domain || host.endsWith(`.${shop.domain}`) ? u.toString() : null;
}
