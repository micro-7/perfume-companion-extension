import type { Generate, LlmRequest } from '../../llm';
import { SearchUnavailableError } from '../../llm/errors';
import type { Shop } from '../../shared/shops';
import type { Perfume, PriceRow } from '../../shared/types';
import {
  isObject,
  optionalNumber,
  optionalString,
  requireBoolean,
  requireObject,
  type JsonSchema,
} from '../../shared/validate';
import { BadResponseError } from '../../llm/errors';
import { priceAppearsInText } from '../../shared/page';
import { buildSearchUrl, focusOnProduct, isUnusable, MAX_REDUCED_CHARS, reduceHtml, resolveProductUrl, searchQuery } from './html';

export interface PriceDeps {
  generate: Generate;
  signal: AbortSignal;
  /** Whether the extension may fetch this shop's pages directly. */
  hasAccess: (shop: Shop) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// ---------- model answer ----------

export interface Extracted {
  found: boolean;
  productTitle: string;
  priceInr: number | null;
  url: string;
  inStock: boolean;
  variant: string;
  exactMatch: boolean;
}

const priceProps = {
  found: { type: 'boolean' },
  productTitle: { type: 'string' },
  priceInr: { type: 'number' },
  url: { type: 'string' },
  inStock: { type: 'boolean' },
  variant: { type: 'string' },
  exactMatch: { type: 'boolean' },
};
const priceRequired = Object.keys(priceProps);

export const PRICE_SCHEMA: JsonSchema = { type: 'object', properties: priceProps, required: priceRequired };

export const PRICE_LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: { type: 'object', properties: { shop: { type: 'string' }, ...priceProps }, required: ['shop', ...priceRequired] },
    },
  },
  required: ['results'],
};

function parseExtractedObject(o: Record<string, unknown>): Extracted {
  return {
    found: requireBoolean(o, 'found'),
    productTitle: optionalString(o, 'productTitle'),
    priceInr: optionalNumber(o, 'priceInr'),
    url: optionalString(o, 'url'),
    inStock: o.inStock !== false,
    variant: optionalString(o, 'variant'),
    exactMatch: o.exactMatch === true,
  };
}

export function parseExtracted(raw: unknown): Extracted {
  return parseExtractedObject(requireObject(raw, 'price'));
}

export function parseExtractedList(raw: unknown): Array<Extracted & { shop: string }> {
  const o = requireObject(raw, 'prices');
  if (!Array.isArray(o.results)) throw new BadResponseError('"results" must be an array');
  return o.results.filter(isObject).map((r) => ({ shop: optionalString(r, 'shop').toLowerCase(), ...parseExtractedObject(r) }));
}

const SYSTEM =
  'You read online shop pages and find the listing for one perfume. Answer with JSON only. ' +
  'Never invent a price or a link that is not on the page.';

const FIELD_RULES = [
  'Rules:',
  '- Pick the listing for this exact perfume from this exact brand. Ignore look-alikes, "inspired by" products, gift sets and other perfumes whose name merely contains the same word.',
  '- Prefer the same concentration. If several sizes are listed prefer 100 ml, else the largest bottle.',
  '- IGNORE samples, decants, testers, travel sizes and minis (anything under 30 ml). Never use the "from" price of a size range if it belongs to a sample or decant: use the price of the full-size bottle.',
  '- priceInr: the selling price in Indian rupees as a plain number (the discounted price, not the crossed-out MRP).',
  '- url: the product page link exactly as given in [link: ...].',
  '- productTitle: the listing title exactly as shown.',
  '- variant: the size and concentration of the listing you picked, e.g. "100 ml Eau de Toilette".',
  '- exactMatch: true only if it is the same perfume AND the same concentration.',
  '- If the perfume is not listed, set found to false.',
].join('\n');

export function buildExtractPrompt(perfume: Perfume, shop: Shop, reduced: string): string {
  return [`Perfume: ${searchQuery(perfume)}`, `Shop: ${shop.name} (${shop.domain})`, FIELD_RULES, '', 'Search results page:', reduced].join('\n');
}

// ---------- rows ----------

const baseRow = (shop: Shop) => ({ shopId: shop.id, shopName: shop.name, domain: shop.domain });

export const notFoundRow = (shop: Shop, reason?: string): PriceRow => ({ ...baseRow(shop), status: 'not-found', reason });

const unavailableRow = (shop: Shop, reason?: string): PriceRow => ({ ...baseRow(shop), status: 'search-unavailable', reason });

function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

const BRAND_FILLER = new Set(['the', 'by', 'de', 'la', 'le', 'of', 'and']);

/** Why a model answer cannot be used, or null when it can. */
export function whyUnusable(shop: Shop, ex: Extracted, perfume?: { name: string; brand?: string }): string | null {
  if (!ex.found) return 'the perfume is not on the shop page';
  if (ex.priceInr == null) return 'no price found in the listing';
  if (!resolveProductUrl(ex.url, shop)) return 'the product link was missing or not on the shop';
  if (!perfume || !ex.productTitle) return null;

  // The listing title must contain the perfume's name ("Sauvage")...
  const title = ex.productTitle.toLowerCase();
  const words = nameWords(perfume.name);
  if (words.length && !words.every((w) => title.includes(w))) return `the listing "${ex.productTitle}" is a different perfume`;
  // ...and its brand must show in the title or the product link, because shops are full of
  // look-alikes that borrow the name ("Al Bait Al Dimashqi Bergamot Pepper Sauvage").
  const brand = nameWords(perfume.brand ?? '').filter((w) => !BRAND_FILLER.has(w));
  const haystack = `${title} ${ex.url.toLowerCase()}`;
  if (brand.length && !brand.some((w) => haystack.includes(w))) return `the listing "${ex.productTitle}" is from a different brand`;
  return null;
}

/** Turns a model answer into a row, or null when it is not a usable result. */
export function toRow(shop: Shop, ex: Extracted, viaSearch: boolean, perfume?: { name: string; brand?: string }): PriceRow | null {
  if (whyUnusable(shop, ex, perfume)) return null;
  const url = resolveProductUrl(ex.url, shop)!;
  return {
    ...baseRow(shop),
    status: 'found',
    priceInr: Math.round(ex.priceInr!),
    url,
    inStock: ex.inStock,
    variant: ex.variant || undefined,
    exactMatch: ex.exactMatch,
    viaSearch: viaSearch || undefined,
  };
}

// ---------- fetching ----------

/** Fetches and reduces a shop's search page. Returns null when the page is unusable. */
export async function fetchSearchPage(shop: Shop, perfume: Perfume, deps: PriceDeps): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs ?? 10_000)]);
  try {
    const res = await doFetch(buildSearchUrl(shop, perfume), { credentials: 'include', signal, redirect: 'follow' });
    const html = await res.text();
    const full = reduceHtml(html, 400_000);
    if (isUnusable(res.status, full, html)) return null;
    // Real search pages start with menus; send the part around the product listing.
    return focusOnProduct(full, perfume, MAX_REDUCED_CHARS);
  } catch {
    if (deps.signal.aborted) throw deps.signal.reason ?? new DOMException('Aborted', 'AbortError');
    return null; // network error or timeout
  }
}

// ---------- grounded fallback ----------

/** `why` is what went wrong with the shop's own page, kept so the user can see why a row is empty. */
export async function groundedShopPrice(shop: Shop, perfume: Perfume, deps: PriceDeps, why?: string): Promise<PriceRow> {
  const prefix = why ? `${why}; ` : '';
  const req: LlmRequest<Extracted> = {
    system: SYSTEM,
    prompt: [
      `Find the current price of "${searchQuery(perfume)}" on ${shop.name} (${shop.domain}), an Indian online shop.`,
      `Search only ${shop.domain}. Give the product page URL on ${shop.domain}.`,
      FIELD_RULES,
    ].join('\n'),
    schema: PRICE_SCHEMA,
    grounding: { site: shop.domain },
    parse: parseExtracted,
  };
  try {
    const { data } = await deps.generate(req, deps.signal);
    return toRow(shop, data, true, perfume) ?? notFoundRow(shop, `${prefix}web search: ${whyUnusable(shop, data, perfume)}`);
  } catch (e) {
    if (deps.signal.aborted) throw e;
    if (e instanceof SearchUnavailableError) return unavailableRow(shop, `${prefix}web search is unavailable`);
    return notFoundRow(shop, `${prefix}web search failed (${e instanceof Error ? e.message : 'error'})`);
  }
}

// ---------- one shop ----------

const NOT_ON_PAGE = 'the price was not written on the page in rupees (the page may show another currency)';

/**
 * A price read from a shop's page must really be written there. Some shops switch currency by
 * location (a page showing EUR 151.00); the AI then "helpfully" converts, giving a price that no
 * shop shows. Such a result is dropped rather than shown as fact.
 */
function priceIsOnPage(row: PriceRow, pageText: string): boolean {
  return row.priceInr != null && priceAppearsInText(pageText, row.priceInr);
}

/**
 * Price for one shop: the shop's own search page when we have access and it is usable,
 * otherwise (or when the page does not list the perfume) grounded web search on that shop.
 */
export async function lookupShopPrice(shop: Shop, perfume: Perfume, deps: PriceDeps): Promise<PriceRow> {
  let why = 'no direct access to the shop';
  if (await deps.hasAccess(shop)) {
    const reduced = await fetchSearchPage(shop, perfume, deps);
    if (!reduced) {
      why = 'the shop page was blocked or empty';
    } else {
      try {
        const { data } = await deps.generate(
          { system: SYSTEM, prompt: buildExtractPrompt(perfume, shop, reduced), schema: PRICE_SCHEMA, parse: parseExtracted },
          deps.signal,
        );
        const row = toRow(shop, data, false, perfume);
        if (row && priceIsOnPage(row, reduced)) return row;
        why = row ? NOT_ON_PAGE : (whyUnusable(shop, data, perfume) ?? 'no usable result');
      } catch (e) {
        if (deps.signal.aborted) throw e;
        why = `the AI could not read the page (${e instanceof Error ? e.message : 'error'})`;
      }
    }
  }
  return groundedShopPrice(shop, perfume, deps, why);
}

// ---------- many shops at once (dupe prices) ----------

const BATCH_PAGE_CHARS = 3000;

/**
 * Prices for one perfume across several shops with at most two model calls: one extraction
 * over every usable search page, and one grounded search for the shops that are left.
 */
export async function batchShopPrices(shops: Shop[], perfume: Perfume, deps: PriceDeps): Promise<PriceRow[]> {
  const rows = new Map<string, PriceRow>();
  const pages = await Promise.all(
    shops.map(async (shop) => ({ shop, reduced: (await deps.hasAccess(shop)) ? await fetchSearchPage(shop, perfume, deps) : null })),
  );

  const usable = pages.filter((p): p is { shop: Shop; reduced: string } => !!p.reduced);
  if (usable.length) {
    const sections = usable.map((p) => `=== Shop: ${p.shop.name} (${p.shop.domain}) ===\n${p.reduced.slice(0, BATCH_PAGE_CHARS)}`);
    try {
      const { data } = await deps.generate(
        {
          system: SYSTEM,
          prompt: [
            `Perfume: ${searchQuery(perfume)}`,
            'Below are search result pages from several shops. Return one result per shop, with "shop" set to the shop domain.',
            FIELD_RULES,
            '',
            ...sections,
          ].join('\n'),
          schema: PRICE_LIST_SCHEMA,
          parse: parseExtractedList,
        },
        deps.signal,
      );
      for (const r of data) {
        const page = usable.find((p) => p.shop.domain === r.shop.replace(/^www\./, ''));
        const row = page && toRow(page.shop, r, false, perfume);
        if (row && priceIsOnPage(row, page.reduced.slice(0, BATCH_PAGE_CHARS))) rows.set(page.shop.id, row);
      }
    } catch (e) {
      if (deps.signal.aborted) throw e;
    }
  }

  const rest = shops.filter((s) => !rows.has(s.id));
  if (rest.length) {
    try {
      const { data } = await deps.generate(
        {
          system: SYSTEM,
          prompt: [
            `Find the current price of "${searchQuery(perfume)}" on each of these Indian online shops: ${rest.map((s) => s.domain).join(', ')}.`,
            'Return one result per shop, with "shop" set to the shop domain and the product page URL on that domain.',
            FIELD_RULES,
          ].join('\n'),
          schema: PRICE_LIST_SCHEMA,
          grounding: {},
          parse: parseExtractedList,
        },
        deps.signal,
      );
      for (const r of data) {
        const shop = rest.find((s) => s.domain === r.shop.replace(/^www\./, ''));
        const row = shop && toRow(shop, r, true, perfume);
        if (row) rows.set(shop.id, row);
      }
    } catch (e) {
      if (deps.signal.aborted) throw e;
      if (e instanceof SearchUnavailableError) {
        for (const s of rest) rows.set(s.id, { ...baseRow(s), status: 'search-unavailable' });
      }
    }
  }

  return shops.map((s) => rows.get(s.id) ?? notFoundRow(s));
}
