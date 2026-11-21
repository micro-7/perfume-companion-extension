import type { CurrentPrice, DupesResult, NotesCardData, Perfume, PriceRow } from './types';

/** Worker -> side panel. */
export type ServerMessage =
  | { type: 'lookup:start' }
  | { type: 'restricted' }
  | { type: 'detect:none' }
  | { type: 'detect:error'; message: string }
  | {
      type: 'detect:done';
      perfume: Perfume;
      currentPrice: CurrentPrice;
      /** True when this lookup came from clicking a dupe (no page, no current-site price). */
      explore?: boolean;
    }
  | { type: 'notes:done'; notes: NotesCardData }
  | { type: 'notes:error'; message: string }
  | { type: 'prices:start'; total: number; hereShopId: string | null }
  | { type: 'prices:row'; row: PriceRow }
  | { type: 'prices:progress'; done: number; total: number }
  | { type: 'prices:empty' }
  | { type: 'dupes:list'; result: DupesResult }
  | { type: 'dupes:price'; key: string; best: PriceRow | null }
  | { type: 'dupes:error'; message: string }
  | { type: 'provider:fallback' };

/** Side panel -> worker. */
export type ClientMessage =
  /** `resume`: the panel lost its connection mid-lookup and wants the lookup run again for this tab. */
  | { type: 'ready'; tabId: number; resume?: boolean }
  | { type: 'retry' }
  | { type: 'retry:notes' }
  | { type: 'retry:dupes' }
  /** "Check price" on a dupe whose price is not looked up automatically. */
  | { type: 'dupe:price'; dupe: { key: string; name: string; brand: string } }
  | { type: 'lookup'; perfume: Perfume }
  | { type: 'cancel' };

export const PORT_NAME = 'lookup';
