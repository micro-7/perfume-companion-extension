import { CACHE_FORMAT, perfumeKey, TTL, type CacheStore } from '../../shared/cache';
import type { ServerMessage } from '../../shared/messages';
import { cheapest } from '../../shared/prices';
import type { Shop } from '../../shared/shops';
import type { Perfume, PriceRow } from '../../shared/types';
import { batchShopPrices, lookupShopPrice, type PriceDeps } from './lookup';

const priceKey = (perfume: Perfume, shop: Shop) => `price:${CACHE_FORMAT}:${perfumeKey(perfume)}:${shop.id}`;

/** Only real prices are cached; "not found" and "search unavailable" are tried again next time. */
async function saveRow(cache: CacheStore, perfume: Perfume, shop: Shop, row: PriceRow): Promise<void> {
  if (row.status === 'found') await cache.set(priceKey(perfume, shop), row, TTL.price);
}

/**
 * Looks the perfume up in every configured shop at once and streams each row to the panel
 * as soon as it is ready.
 */
export async function lookupPrices(
  perfume: Perfume,
  shops: Shop[],
  hereShopId: string | null,
  deps: PriceDeps & { cache: CacheStore },
  send: (msg: ServerMessage) => void,
  /** The page the user is on, when it is one of the shops: its own price is used as is. */
  here?: { priceInr: number; url: string } | null,
): Promise<PriceRow[]> {
  if (shops.length === 0) {
    send({ type: 'prices:empty' });
    return [];
  }
  const total = shops.length;
  let done = 0;
  send({ type: 'prices:start', total, hereShopId });

  return Promise.all(
    shops.map(async (shop) => {
      // The page the user is on already shows this shop's price and link: no lookup needed.
      if (here && shop.id === hereShopId) {
        const row: PriceRow = {
          shopId: shop.id,
          shopName: shop.name,
          domain: shop.domain,
          status: 'found',
          priceInr: Math.round(here.priceInr),
          url: here.url,
          exactMatch: true,
          fromPage: true,
        };
        done++;
        send({ type: 'prices:row', row });
        send({ type: 'prices:progress', done, total });
        return row;
      }
      const cached = await deps.cache.get<PriceRow>(priceKey(perfume, shop));
      const row = cached ?? (await lookupShopPrice(shop, perfume, deps));
      if (!cached) await saveRow(deps.cache, perfume, shop, row);
      done++;
      send({ type: 'prices:row', row });
      send({ type: 'prices:progress', done, total });
      return row;
    }),
  );
}

/** Cheapest price for a dupe, using cached rows where possible and a batch lookup for the rest. */
export async function bestPrice(
  perfume: Perfume,
  shops: Shop[],
  deps: PriceDeps & { cache: CacheStore },
): Promise<PriceRow | null> {
  if (shops.length === 0) return null;
  const cached = await Promise.all(shops.map((s) => deps.cache.get<PriceRow>(priceKey(perfume, s))));
  const missing = shops.filter((_, i) => !cached[i]);
  const fresh = missing.length ? await batchShopPrices(missing, perfume, deps) : [];
  await Promise.all(fresh.map((row, i) => saveRow(deps.cache, perfume, missing[i], row)));
  return cheapest([...cached.filter((r): r is PriceRow => !!r), ...fresh]);
}
