import type { PriceRow } from './types';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

/** 18000 -> "₹18,000" */
export function formatInr(amount: number): string {
  return inr.format(Math.round(amount));
}

const statusOrder = { found: 0, 'not-found': 1, 'search-unavailable': 2 } as const;

/** Found rows cheapest first, then rows without a price. Does not change the input. */
export function sortRows(rows: PriceRow[]): PriceRow[] {
  return [...rows].sort((a, b) => {
    const s = statusOrder[a.status] - statusOrder[b.status];
    if (s !== 0) return s;
    if (a.status === 'found') return (a.priceInr ?? Infinity) - (b.priceInr ?? Infinity);
    return a.shopName.localeCompare(b.shopName);
  });
}

/** Amount saved compared with the baseline, or null when the row is not cheaper. */
export function savings(baseline: number | null | undefined, price: number | undefined): number | null {
  if (baseline == null || price == null) return null;
  const diff = Math.round(baseline - price);
  return diff > 0 ? diff : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The configured shop the user is currently on, matched by domain (subdomains included). */
export function findHereShop<T extends { id: string; domain: string }>(pageUrl: string, shops: T[]): T | null {
  const host = hostOf(pageUrl);
  if (!host) return null;
  return shops.find((s) => host === s.domain || host.endsWith(`.${s.domain}`)) ?? null;
}

export interface Baseline {
  amount: number;
  /** Name used in "compared with X". */
  label: string;
}

/**
 * What savings are measured against:
 * - the current site's price, if known;
 * - otherwise the "You are here" shop's found price;
 * - while exploring a dupe (no current site), the most expensive shop price found.
 */
export function chooseBaseline(opts: {
  currentPrice: number | null;
  currentSiteName: string;
  hereRow: PriceRow | null;
  rows: PriceRow[];
  explore: boolean;
}): Baseline | null {
  // When the user is on one of their own shops, call it by the name they gave it.
  if (opts.currentPrice != null) {
    return { amount: opts.currentPrice, label: opts.hereRow?.shopName || opts.currentSiteName };
  }
  if (opts.hereRow?.status === 'found' && opts.hereRow.priceInr != null) {
    return { amount: opts.hereRow.priceInr, label: opts.hereRow.shopName };
  }
  if (opts.explore) {
    const found = opts.rows.filter((r) => r.status === 'found' && r.priceInr != null);
    if (found.length < 2) return null;
    const top = found.reduce((a, b) => ((b.priceInr ?? 0) > (a.priceInr ?? 0) ? b : a));
    return { amount: top.priceInr!, label: top.shopName };
  }
  return null;
}

/** A price below this share of the median is almost certainly a sample or decant, not the bottle. */
export const LOW_OUTLIER_RATIO = 0.4;
/** Fewer prices than this cannot say what is "normal". */
const MIN_PRICES_FOR_OUTLIERS = 4;

/** Shops whose price is far below the rest (needs at least 4 prices to judge). */
export function lowOutlierShopIds(rows: PriceRow[]): Set<string> {
  const found = rows.filter((r) => r.status === 'found' && r.priceInr != null);
  if (found.length < MIN_PRICES_FOR_OUTLIERS) return new Set();
  const prices = found.map((r) => r.priceInr!).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return new Set(found.filter((r) => r.priceInr! < median * LOW_OUTLIER_RATIO).map((r) => r.shopId));
}

/** The cheapest found row, ignoring implausibly low prices, or null. */
export function cheapest(rows: PriceRow[]): PriceRow | null {
  const low = lowOutlierShopIds(rows);
  return sortRows(rows).find((r) => r.status === 'found' && !low.has(r.shopId)) ?? null;
}
