import type { PageData } from './types';

/** Raw page capture from the injected script, before it is trimmed for the LLM. */
export const MAX_PAGE_CHARS = 15_000;
/** The most page text kept in full (for reading a section far down a long page). */
const FULL_TEXT_CHARS = 150_000;

export function collapseWhitespace(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Cuts long text, keeping the start (80%) and the end (20%) of the allowed length. */
export function limitText(text: string, max: number = MAX_PAGE_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return `${text.slice(0, head)}\n...\n${text.slice(text.length - tail)}`;
}

type Json = Record<string, unknown>;

function isProduct(node: Json): boolean {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes('Product') : t === 'Product';
}

/** Parses JSON-LD blocks and returns the schema.org Product nodes (including those inside @graph). */
export function pickProductJsonLd(blocks: string[]): Json[] {
  const out: Json[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Json;
    if (isProduct(obj)) out.push(obj);
    if (obj['@graph']) visit(obj['@graph']);
  };
  for (const raw of blocks) {
    try {
      visit(JSON.parse(raw));
    } catch {
      // ignore blocks that are not valid JSON
    }
  }
  return out;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Price in rupees from structured data on the page (JSON-LD offers first, then product meta tags).
 * Prices in another currency are ignored.
 */
export function extractStructuredPriceInr(page: Pick<PageData, 'jsonLd' | 'meta'>): number | null {
  for (const product of pickProductJsonLd(page.jsonLd)) {
    const offers = ([] as unknown[]).concat((product.offers as unknown) ?? []);
    for (const o of offers) {
      if (typeof o !== 'object' || o === null) continue;
      const offer = o as Json;
      if (offer.priceCurrency !== 'INR') continue;
      const price = toNumber(offer.price) ?? toNumber(offer.lowPrice);
      if (price) return price;
    }
  }
  const m = page.meta;
  const currency = m['product:price:currency'] ?? m['og:price:currency'];
  if (currency === 'INR') return toNumber(m['product:price:amount'] ?? m['og:price:amount']);
  return null;
}

/**
 * True when `amount` is written in `text` as a number (12,400 / 12400 / 12,400.00) and the text
 * mentions rupees. The AI is asked for rupee prices but can "helpfully" convert another currency:
 * on a page showing EUR 151.00 it answered 15,500. An amount that is not on the page is not a price.
 */
export function priceAppearsInText(text: string, amount: number): boolean {
  if (!/₹|\brs\.?|\binr\b|rupee/i.test(text)) return false;
  const target = Math.round(amount);
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    if (Math.round(Number.parseFloat(m[0].replaceAll(',', ''))) === target) return true;
  }
  return false;
}

/** Turns the injected script's raw capture into the data sent to the LLM. */
export function finalizePage(raw: PageData): PageData {
  const collapsed = collapseWhitespace(raw.text);
  return { ...raw, text: limitText(collapsed), fullText: collapsed.slice(0, FULL_TEXT_CHARS) };
}

/**
 * Runs inside the web page via chrome.scripting.executeScript. It must be self-contained:
 * it cannot use anything imported at module level.
 */
export async function extractPage(): Promise<PageData> {
  // Fragrantica fills its "This perfume reminds me of" row only when it is scrolled near. If it is
  // not in the page yet, scroll down until it appears (a few seconds at most), then put the page
  // back where the user had it. Only on Fragrantica, and only when the row is missing.
  if (location.hostname.endsWith('fragrantica.com')) {
    const rowLoaded = () => /this perfume reminds me of/i.test(document.body?.innerText ?? '');
    if (!rowLoaded()) {
      const startY = window.scrollY;
      const step = Math.max(400, window.innerHeight);
      for (let i = 0, y = startY; i < 20 && !rowLoaded(); i++) {
        y += step;
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      window.scrollTo({ top: startY, behavior: 'instant' });
    }
  }
  const meta: Record<string, string> = {};
  const wanted = [
    'og:title',
    'og:site_name',
    'og:price:amount',
    'og:price:currency',
    'product:price:amount',
    'product:price:currency',
  ];
  for (const el of Array.from(document.querySelectorAll('meta'))) {
    const key = el.getAttribute('property') ?? el.getAttribute('name');
    const content = el.getAttribute('content');
    if (key && content && wanted.includes(key)) meta[key] = content;
  }
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => s.textContent ?? '')
    .filter(Boolean)
    .slice(0, 20);
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 200_000),
    jsonLd,
    meta,
  };
}
