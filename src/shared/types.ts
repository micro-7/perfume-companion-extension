export interface Notes {
  top: string[];
  heart: string[];
  base: string[];
  /** Notes known only as one flat list (no top/heart/base split). */
  flat: string[];
}

export interface Perfume {
  name: string;
  brand: string;
  /** e.g. "Eau de Parfum", or "" when unknown. */
  concentration: string;
}

export interface PageData {
  url: string;
  title: string;
  text: string;
  /** The whole page text (whitespace collapsed, capped), not cut to the size sent for detection. */
  fullText?: string;
  /** Raw contents of application/ld+json script blocks. */
  jsonLd: string[];
  meta: Record<string, string>;
}

export interface CurrentPrice {
  /** Price on the page the user is on, in rupees; null if not found. */
  amountInr: number | null;
  siteName: string;
}

export interface NotesCardData extends Notes {
  description: string;
}

export type PriceStatus = 'found' | 'not-found' | 'search-unavailable';

export interface PriceRow {
  shopId: string;
  shopName: string;
  domain: string;
  status: PriceStatus;
  priceInr?: number;
  /** Product page on the shop's own domain. */
  url?: string;
  inStock?: boolean;
  /** What was found, e.g. "50 ml" or "Eau de Parfum", when it is not an exact match. */
  variant?: string;
  exactMatch?: boolean;
  /** Found through grounded web search instead of the shop's own search page. */
  viaSearch?: boolean;
  /** For rows without a price: what went wrong, shown on hover so the user can see why. */
  reason?: string;
  /** The price of the page the user is on, used as is (no lookup needed). */
  fromPage?: boolean;
}

export interface Dupe {
  /** Stable key used to match price updates to the right entry. */
  key: string;
  name: string;
  brand: string;
  /** 0-100. */
  similarity: number;
  /** Named by both the AI and Fragrantica ("Confirmed by Fragrantica"). */
  confirmed: boolean;
  /** On Fragrantica's "reminds me of" list, whether or not the AI also named it. */
  onFragrantica: boolean;
  reason: string;
}

export interface DupesResult {
  dupes: Dupe[];
  /** False when Fragrantica data could not be used. */
  trustedAvailable: boolean;
  /** Fewer than 2 reliable dupes. */
  few: boolean;
  /** Set when the user is on a Fragrantica page but its "reminds me of" list was not in the page text. */
  trustedReason?: 'not-on-page';
}
