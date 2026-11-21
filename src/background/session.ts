import { describeError } from '../llm/errors';
import type { Generate } from '../llm';
import { storageCache, type CacheStore } from '../shared/cache';
import { AUTO_PRICED_DUPES } from '../shared/dupes';
import type { ServerMessage } from '../shared/messages';
import { findHereShop } from '../shared/prices';
import type { Shop } from '../shared/shops';
import type { Dupe, Notes, PageData, Perfume } from '../shared/types';
import { detectPerfume } from './detect';
import { lookupDupes } from './dupes/orchestrate';
import { getNotes } from './notes';
import { bestPrice, lookupPrices } from './prices/orchestrate';

export type PageResult = { ok: true; page: PageData } | { ok: false };

export interface SessionDeps {
  generate: Generate;
  send: (msg: ServerMessage) => void;
  getShops: () => Promise<Shop[]>;
  hasAccess: (shop: Shop) => Promise<boolean>;
  cache?: CacheStore;
  fetchImpl?: typeof fetch;
  /** Told when a lookup starts (true) and when none is running any more (false). */
  onBusy?: (busy: boolean) => void;
}

interface RunContext {
  ac: AbortController;
  send: (msg: ServerMessage) => void;
  generate: Generate;
}

interface Found {
  perfume: Perfume;
  pageNotes: Notes;
  page: PageData | null;
  /** Price shown on the page the user is on, in rupees (null if unknown or no page). */
  pagePriceInr: number | null;
}

const NO_NOTES: Notes = { top: [], heart: [], base: [], flat: [] };

/**
 * One side panel's lookup. Starting a new lookup, or the panel closing, cancels the running one:
 * its requests are aborted and nothing more is sent to the panel.
 */
export class LookupSession {
  private ac: AbortController | null = null;
  private last: { kind: 'page'; page: Promise<PageResult> } | { kind: 'perfume'; perfume: Perfume } | null = null;
  private found: Found | null = null;
  private running = 0;
  /** The context of the latest lookup, so a later click ("Check price") can use its connection. */
  private current: RunContext | null = null;

  constructor(private deps: SessionDeps) {}

  /** Runs a lookup and reports when work starts and stops, so the worker can be kept alive meanwhile. */
  private async tracked<T>(fn: () => Promise<T>): Promise<T> {
    if (++this.running === 1) this.deps.onBusy?.(true);
    try {
      return await fn();
    } finally {
      if (--this.running === 0) this.deps.onBusy?.(false);
    }
  }

  private get cache(): CacheStore {
    return this.deps.cache ?? storageCache;
  }

  /** Lookup for the page the user clicked the icon on. */
  start(page: Promise<PageResult>): Promise<void> {
    this.last = { kind: 'page', page };
    return this.tracked(() => this.runPage(page));
  }

  /** Lookup for a perfume chosen in the panel (a dupe): no page, no detection. */
  explore(perfume: Perfume): Promise<void> {
    this.last = { kind: 'perfume', perfume };
    return this.tracked(() => this.runPerfume(perfume));
  }

  /** Runs the whole lookup again. */
  retry(): Promise<void> {
    const last = this.last;
    if (!last) return Promise.resolve();
    return this.tracked(() => (last.kind === 'page' ? this.runPage(last.page) : this.runPerfume(last.perfume)));
  }

  /** Runs only the notes again (the perfume is already known). */
  async retryNotes(): Promise<void> {
    if (!this.found) return;
    const f = this.found;
    await this.tracked(() => this.runNotes(this.newContext(), f.perfume, f.pageNotes));
  }

  /** Runs only the dupes again. */
  async retryDupes(): Promise<void> {
    if (!this.found) return;
    const f = this.found;
    await this.tracked(() => this.runDupes(this.newContext(), f.perfume, f.page));
  }

  cancel(): void {
    this.ac?.abort();
    this.ac = null;
  }

  private newContext(): RunContext {
    this.cancel();
    const ac = new AbortController();
    this.ac = ac;
    const send = (msg: ServerMessage) => {
      if (!ac.signal.aborted) this.deps.send(msg);
    };
    let announced = false;
    const generate: Generate = async (req, signal) => {
      const result = await this.deps.generate(req, signal ?? ac.signal);
      if (result.provider === 'ollama' && !announced) {
        announced = true;
        send({ type: 'provider:fallback' });
      }
      return result;
    };
    this.current = { ac, send, generate };
    return this.current;
  }

  private async runPage(pagePromise: Promise<PageResult>): Promise<void> {
    this.found = null;
    const ctx = this.newContext();
    ctx.send({ type: 'lookup:start' });

    const res = await pagePromise;
    if (ctx.ac.signal.aborted) return;
    if (!res.ok) {
      ctx.send({ type: 'restricted' });
      return;
    }

    let detection;
    try {
      detection = await detectPerfume(ctx.generate, res.page, ctx.ac.signal);
    } catch (e) {
      ctx.send({ type: 'detect:error', message: describeError(e) });
      return;
    }
    if (ctx.ac.signal.aborted) return; // cancelled while detecting: do not start the cards
    if (!detection.found || !detection.perfume) {
      ctx.send({ type: 'detect:none' });
      return;
    }

    this.found = {
      perfume: detection.perfume,
      pageNotes: detection.pageNotes,
      page: res.page,
      pagePriceInr: detection.currentPrice.amountInr,
    };
    ctx.send({ type: 'detect:done', perfume: detection.perfume, currentPrice: detection.currentPrice });
    await this.runCards(ctx, this.found);
  }

  private async runPerfume(perfume: Perfume): Promise<void> {
    const ctx = this.newContext();
    ctx.send({ type: 'lookup:start' });
    this.found = { perfume, pageNotes: NO_NOTES, page: null, pagePriceInr: null };
    ctx.send({ type: 'detect:done', perfume, currentPrice: { amountInr: null, siteName: '' }, explore: true });
    await this.runCards(ctx, this.found);
  }

  /** Notes, prices and dupes run at the same time; each card fills in when its data arrives. */
  private async runCards(ctx: RunContext, f: Found): Promise<void> {
    await Promise.all([
      this.runNotes(ctx, f.perfume, f.pageNotes),
      this.runPrices(ctx, f.perfume, f.page, f.pagePriceInr),
      this.runDupes(ctx, f.perfume, f.page),
    ]);
  }

  private async runNotes(ctx: RunContext, perfume: Perfume, pageNotes: Notes): Promise<void> {
    try {
      const notes = await getNotes(ctx.generate, perfume, pageNotes, ctx.ac.signal, { cache: this.cache });
      ctx.send({ type: 'notes:done', notes });
    } catch (e) {
      ctx.send({ type: 'notes:error', message: describeError(e) });
    }
  }

  private priceDeps(ctx: RunContext) {
    return {
      generate: ctx.generate,
      signal: ctx.ac.signal,
      hasAccess: this.deps.hasAccess,
      fetchImpl: this.deps.fetchImpl,
      cache: this.cache,
    };
  }

  private async runPrices(ctx: RunContext, perfume: Perfume, page: PageData | null, pagePriceInr: number | null): Promise<void> {
    try {
      const shops = await this.deps.getShops();
      const here = page ? findHereShop(page.url, shops) : null;
      const hereRow = page && pagePriceInr != null ? { priceInr: pagePriceInr, url: page.url } : null;
      await lookupPrices(perfume, shops, here?.id ?? null, this.priceDeps(ctx), ctx.send, hereRow);
    } catch {
      // Each shop already reports its own failure; this only happens when the lookup was cancelled.
    }
  }

  private async runDupes(ctx: RunContext, perfume: Perfume, page: PageData | null): Promise<void> {
    let shops: Shop[];
    try {
      const result = await lookupDupes(perfume, page, {
        generate: ctx.generate,
        signal: ctx.ac.signal,
        cache: this.cache,
        fetchImpl: this.deps.fetchImpl,
      });
      ctx.send({ type: 'dupes:list', result });
      shops = await this.deps.getShops();
      // Only the best-ranked dupes are priced at once; the others wait for a click (see priceDupe).
      await Promise.all(result.dupes.slice(0, AUTO_PRICED_DUPES).map((d) => this.priceOneDupe(ctx, d, shops)));
    } catch (e) {
      ctx.send({ type: 'dupes:error', message: describeError(e) });
    }
  }

  private async priceOneDupe(ctx: RunContext, d: Pick<Dupe, 'key' | 'name' | 'brand'>, shops: Shop[]): Promise<void> {
    let best = null;
    try {
      best = await bestPrice({ name: d.name, brand: d.brand, concentration: '' }, shops, this.priceDeps(ctx));
    } catch {
      // shown as "Price not found"
    }
    ctx.send({ type: 'dupes:price', key: d.key, best });
  }

  /** Looks up the price of one dupe the user asked for ("Check price"). Does not cancel anything else. */
  async priceDupe(d: Pick<Dupe, 'key' | 'name' | 'brand'>): Promise<void> {
    // After a reconnect (new worker) or after Back (which cancels), there is no live context: make one.
    const ctx = this.current && !this.current.ac.signal.aborted ? this.current : this.newContext();
    await this.tracked(async () => this.priceOneDupe(ctx, d, await this.deps.getShops()));
  }
}
