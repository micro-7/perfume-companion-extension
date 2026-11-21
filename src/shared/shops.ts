export interface Shop {
  id: string;
  name: string;
  /** Search page with a {query} placeholder, e.g. https://shop.in/search?q={query} */
  searchUrl: string;
  /** Host without "www.", e.g. shop.in */
  domain: string;
  /** Whether the extension has permission to fetch this shop's pages directly. */
  directAccess: boolean;
}

export interface ShopInput {
  name: string;
  searchUrl: string;
}

const KEY = 'shops';
const SEEDED = 'seeded';

export function domainOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

/** Host permission pattern for a shop. "*.shop.in" also matches "shop.in" itself and "www.shop.in". */
export function originPatterns(searchUrl: string): string[] {
  const u = new URL(searchUrl.replace('{query}', 'q'));
  const host = u.hostname.toLowerCase();
  // IP addresses and localhost cannot take a "*." prefix.
  if (host === 'localhost' || /^[\d.]+$/.test(host)) return [`${u.protocol}//${host}/*`];
  return [`${u.protocol}//*.${host.replace(/^www\./, '')}/*`];
}

export async function hasDirectAccess(shop: Pick<Shop, 'searchUrl'>): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: originPatterns(shop.searchUrl) });
  } catch {
    return false;
  }
}

/** Returns an error message, or null when the shop can be added. */
export function validateShop(input: ShopInput, existing: Shop[]): string | null {
  const name = input.name.trim();
  const url = input.searchUrl.trim();
  if (!name) return 'Enter a shop name.';
  let parsed: URL;
  try {
    parsed = new URL(url.replace('{query}', 'test'));
  } catch {
    return 'Enter a full web address, starting with https://';
  }
  if (parsed.protocol !== 'https:') return 'The address must start with https://';
  if (!url.includes('{query}')) return 'The address must contain {query} where the search words go.';
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (existing.some((s) => s.domain === domain)) return `${domain} is already in the list.`;
  return null;
}

export function makeShop(input: ShopInput, directAccess: boolean): Shop {
  const searchUrl = input.searchUrl.trim();
  const domain = domainOf(searchUrl.replace('{query}', 'test'));
  return {
    id: domain,
    name: input.name.trim(),
    searchUrl,
    domain,
    directAccess,
  };
}

export async function getShops(): Promise<Shop[]> {
  const r = await chrome.storage.local.get(KEY);
  return (r[KEY] as Shop[] | undefined) ?? [];
}

async function setShops(shops: Shop[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: shops });
}

/** Adds a shop. Throws with a readable message if it is invalid. */
export async function addShop(input: ShopInput, directAccess: boolean): Promise<Shop> {
  const shops = await getShops();
  const error = validateShop(input, shops);
  if (error) throw new Error(error);
  const shop = makeShop(input, directAccess);
  await setShops([...shops, shop]);
  return shop;
}

export async function removeShop(id: string): Promise<void> {
  await setShops((await getShops()).filter((s) => s.id !== id));
}

export async function setDirectAccess(id: string, directAccess: boolean): Promise<void> {
  await setShops((await getShops()).map((s) => (s.id === id ? { ...s, directAccess } : s)));
}

/**
 * Writes the bundled default shops the first time only. Later runs (reloads, updates)
 * never overwrite the user's list.
 */
export async function seedShopsIfNeeded(defaults: ShopInput[]): Promise<boolean> {
  const r = await chrome.storage.local.get(SEEDED);
  if (r[SEEDED]) return false;
  const shops = await getShops();
  for (const d of defaults) {
    if (validateShop(d, shops) === null) shops.push(makeShop(d, false));
  }
  await chrome.storage.local.set({ [KEY]: shops, [SEEDED]: true });
  return true;
}
