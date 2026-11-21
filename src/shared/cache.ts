import type { Perfume } from './types';

const DAY = 24 * 60 * 60 * 1000;
/**
 * Part of the key of dupe lists and price rows. Raise it when the way they are produced changes in
 * a way that makes old entries wrong: old entries are then simply never found again. v2: dupe lists
 * saved before the Fragrantica fix could hold perfumes the AI remembered instead of the page's own
 * list, and price rows saved before the "price must be on the page" check could hold converted prices.
 * v3: dupe lists saved before the deeper Fragrantica read and the new ranking and merging.
 * v4: dupe lists saved before each dupe recorded whether it is on Fragrantica's list.
 * v5: dupe lists saved before AI suggestions written in Fragrantica's list were marked too.
 */
export const CACHE_FORMAT = 'v5';
export const TTL = { notes: 30 * DAY, price: 12 * 60 * 60 * 1000, dupes: 30 * DAY };

function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function perfumeKey(p: Perfume): string {
  return `${norm(p.brand)}|${norm(p.name)}|${norm(p.concentration)}`;
}

interface Entry<T> {
  value: T;
  expires: number;
}

export async function cacheGet<T>(key: string, now: () => number = Date.now): Promise<T | null> {
  const k = `cache:${key}`;
  const stored = await chrome.storage.local.get(k);
  const entry = stored[k] as Entry<T> | undefined;
  if (!entry || entry.expires <= now()) return null;
  return entry.value;
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number, now: () => number = Date.now): Promise<void> {
  const entry: Entry<T> = { value, expires: now() + ttlMs };
  await chrome.storage.local.set({ [`cache:${key}`]: entry });
}

export interface CacheStore {
  get: <T>(key: string) => Promise<T | null>;
  set: <T>(key: string, value: T, ttlMs: number) => Promise<void>;
}

export const storageCache: CacheStore = {
  get: (k) => cacheGet(k),
  set: (k, v, ttl) => cacheSet(k, v, ttl),
};
