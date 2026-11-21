import { AUTO_PRICED_DUPES } from '../shared/dupes';
import type { ServerMessage } from '../shared/messages';
import type { CurrentPrice, Dupe, Perfume } from '../shared/types';
import {
  button,
  cardHeading,
  el,
  loadingLine,
  renderDupesCard,
  renderNotesBody,
  renderNotesCard,
  renderPricesCard,
  type CardsState,
} from './cards';

export { cardHeading, renderNotesBody };

export interface PanelActions {
  retry: () => void;
  retryNotes: () => void;
  retryDupes: () => void;
  openOptions: () => void;
  /** Run the full lookup for this perfume (a dupe the user clicked). */
  lookup: (perfume: Perfume) => void;
  /** Stop the lookup that is running. */
  cancel: () => void;
  /** Look up the price of one dupe ("Check price"). */
  checkDupePrice: (d: Dupe) => void;
}

interface Snapshot {
  state: CardsState;
}

/** Everything for the page's perfume has arrived, so it can be shown again without new requests. */
function isComplete(s: CardsState): boolean {
  if (s.notes.status === 'loading' || s.prices.status === 'loading' || s.dupes.status === 'loading') return false;
  // Dupes beyond the automatically priced ones wait for a click, so they do not hold the lookup open.
  const pending = (s.dupes.result?.dupes ?? []).filter((d, i) => (i < AUTO_PRICED_DUPES || s.dupes.requested[d.key]) && !(d.key in s.dupes.prices));
  return pending.length === 0;
}

function newState(perfume: Perfume, currentPrice: CurrentPrice, explore: boolean): CardsState {
  return {
    perfume,
    currentPrice,
    explore,
    notes: { status: 'loading' },
    prices: { status: 'loading', total: 0, done: 0, hereShopId: null, rows: [] },
    dupes: { status: 'loading', prices: {}, requested: {} },
  };
}

/** The side panel UI. Messages from the worker go in; DOM changes come out. */
export class PanelView {
  private readonly status = el('div', 'status');
  private readonly back = el('div', 'back-bar');
  private readonly cards = el('div', 'cards');
  private readonly badge = el('span', 'badge', 'Using local model');

  private state: CardsState | null = null;
  /** A lookup was started and has not yet reached detection (or failed before it). */
  private loading = false;
  private history: Snapshot[] = [];
  /** The next lookup was started from this panel (a dupe click or Back), so keep the history. */
  private expectExplore = false;
  /** When going Back to a half-finished page, keep its current-site price for the savings text. */
  private restore: Pick<CardsState, 'currentPrice' | 'explore'> & { hereShopId: string | null } | null = null;

  constructor(
    root: HTMLElement,
    private readonly actions: PanelActions,
  ) {
    const header = el('header', 'top');
    const title = el('h1', undefined, 'Perfume Companion');
    this.badge.hidden = true;
    title.append(this.badge);
    header.append(title, button('Options', () => this.actions.openOptions()));
    this.status.hidden = true;
    this.back.hidden = true;
    root.replaceChildren(header, this.back, this.status, this.cards);
  }

  /** Shown before the first lookup message arrives, and when the connection drops. */
  showMessage(text: string): void {
    this.setStatus(el('p', undefined, text));
  }

  /** True while a lookup has not finished: waiting for detection, or some card still loading. */
  inProgress(): boolean {
    if (this.loading) return true;
    return this.state !== null && !isComplete(this.state);
  }

  showReconnecting(): void {
    this.setStatus(loadingLine('Lost the connection to the extension. Reconnecting…'));
  }

  /** Reconnecting did not work: say so and offer a button instead of an endless spinner. */
  showConnectionLost(onRetry: () => void): void {
    this.setError('Lost the connection to the extension and could not reconnect.', onRetry, 'Try again');
  }

  handle(msg: ServerMessage): void {
    const s = this.state;
    switch (msg.type) {
      case 'lookup:start': {
        if (!this.expectExplore) this.history = [];
        const exploring = this.expectExplore;
        this.expectExplore = false;
        this.state = null;
        this.loading = true;
        this.badge.hidden = true;
        this.cards.replaceChildren();
        this.renderBack();
        this.setStatus(loadingLine(exploring ? 'Looking this one up…' : 'Reading this page…'));
        break;
      }
      case 'restricted':
        this.loading = false;
        this.cards.replaceChildren();
        this.setStatus(el('p', undefined, "This page can't be read. Open a perfume page on a website and click the icon again."));
        break;
      case 'detect:none':
        this.loading = false;
        this.cards.replaceChildren();
        this.setStatus(el('p', undefined, 'No perfume detected on this page'));
        break;
      case 'detect:error':
        this.loading = false;
        this.cards.replaceChildren();
        this.setError(msg.message, this.actions.retry);
        break;
      case 'detect:done': {
        this.loading = false;
        const r = this.restore;
        this.restore = null;
        this.state = newState(msg.perfume, r?.currentPrice ?? msg.currentPrice, r ? r.explore : !!msg.explore);
        if (r) this.state.prices.hereShopId = r.hereShopId;
        this.status.hidden = true;
        this.render();
        break;
      }
      case 'notes:done':
        if (s) s.notes = { status: 'done', data: msg.notes };
        this.render();
        break;
      case 'notes:error':
        if (s) s.notes = { status: 'error', message: msg.message };
        this.render();
        break;
      case 'prices:start':
        if (s) {
          s.prices.total = msg.total;
          s.prices.hereShopId = msg.hereShopId ?? s.prices.hereShopId;
        }
        this.render();
        break;
      case 'prices:row':
        if (s) s.prices.rows = [...s.prices.rows.filter((r) => r.shopId !== msg.row.shopId), msg.row];
        this.render();
        break;
      case 'prices:progress':
        if (s) {
          s.prices.done = msg.done;
          s.prices.total = msg.total;
          if (msg.done >= msg.total) s.prices.status = 'done';
        }
        this.render();
        break;
      case 'prices:empty':
        if (s) s.prices.status = 'empty';
        this.render();
        break;
      case 'dupes:list':
        if (s) s.dupes = { status: 'done', result: msg.result, prices: {}, requested: {} };
        this.render();
        break;
      case 'dupes:price':
        if (s) s.dupes.prices[msg.key] = msg.best;
        this.render();
        break;
      case 'dupes:error':
        if (s) s.dupes = { status: 'error', message: msg.message, prices: {}, requested: {} };
        this.render();
        break;
      case 'provider:fallback':
        this.badge.hidden = false;
        break;
    }
  }

  // ---------- dupes: explore and go back ----------

  private exploreDupe(d: Dupe): void {
    if (this.state) this.history.push({ state: this.state });
    this.expectExplore = true;
    this.actions.lookup({ name: d.name, brand: d.brand, concentration: '' });
  }

  private goBack(): void {
    const snap = this.history.pop();
    if (!snap) return;
    this.actions.cancel();
    if (isComplete(snap.state)) {
      // Everything is already here: redraw from memory, no new requests.
      this.expectExplore = false;
      this.state = snap.state;
      this.status.hidden = true;
      this.render();
      return;
    }
    // The earlier lookup was cut short when the dupe was clicked, so run it again.
    this.restore = {
      currentPrice: snap.state.currentPrice,
      explore: snap.state.explore,
      hereShopId: snap.state.prices.hereShopId,
    };
    this.expectExplore = true;
    this.actions.lookup(snap.state.perfume);
  }

  // ---------- drawing ----------

  private renderBack(): void {
    const prev = this.history.at(-1);
    this.back.hidden = !prev;
    this.back.replaceChildren();
    if (prev) this.back.append(button(`← Back to ${prev.state.perfume.name}`, () => this.goBack(), 'back'));
  }

  private render(): void {
    const s = this.state;
    this.renderBack();
    if (!s) return;
    const a = {
      retryNotes: () => this.actions.retryNotes(),
      retryDupes: () => {
        s.dupes = { status: 'loading', prices: {}, requested: {} };
        this.render();
        this.actions.retryDupes();
      },
      openOptions: () => this.actions.openOptions(),
      exploreDupe: (d: Dupe) => this.exploreDupe(d),
      checkDupePrice: (d: Dupe) => {
        s.dupes.requested[d.key] = true;
        this.render();
        this.actions.checkDupePrice(d);
      },
    };
    const retryNotes = () => {
      s.notes = { status: 'loading' };
      this.render();
      this.actions.retryNotes();
    };
    this.cards.replaceChildren(renderNotesCard(s, retryNotes), renderPricesCard(s, a), renderDupesCard(s, a));
  }

  private setStatus(content: HTMLElement): void {
    this.status.className = 'status';
    this.status.replaceChildren(content);
    this.status.hidden = false;
  }

  private setError(message: string, onRetry: () => void, label = 'Retry'): void {
    this.status.className = 'status error';
    this.status.replaceChildren(el('p', undefined, message), button(label, onRetry, 'primary'));
    this.status.hidden = false;
  }
}
