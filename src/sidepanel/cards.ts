import { AUTO_PRICED_DUPES } from '../shared/dupes';
import { chooseBaseline, formatInr, lowOutlierShopIds, savings, sortRows } from '../shared/prices';
import type { CurrentPrice, Dupe, DupesResult, NotesCardData, Perfume, PriceRow } from '../shared/types';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function loadingLine(text: string): HTMLElement {
  const p = el('p');
  p.append(el('span', 'spinner'), document.createTextNode(text));
  return p;
}

export function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function externalLink(text: string, href: string): HTMLAnchorElement {
  const a = el('a', undefined, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  return a;
}

// ---------- state ----------

export interface NotesState {
  status: 'loading' | 'done' | 'error';
  data?: NotesCardData;
  message?: string;
}

export interface PricesState {
  status: 'loading' | 'done' | 'empty';
  total: number;
  done: number;
  hereShopId: string | null;
  rows: PriceRow[];
}

export interface DupesState {
  status: 'loading' | 'done' | 'error';
  result?: DupesResult;
  message?: string;
  /** A key that is missing = not looked up yet; null = looked up, no price found. */
  prices: Record<string, PriceRow | null>;
  /** Dupes beyond the automatically priced ones whose "Check price" was clicked (price on its way). */
  requested: Record<string, true>;
}

export interface CardsState {
  perfume: Perfume;
  currentPrice: CurrentPrice;
  explore: boolean;
  notes: NotesState;
  prices: PricesState;
  dupes: DupesState;
}

export interface CardActions {
  retryNotes: () => void;
  retryDupes: () => void;
  openOptions: () => void;
  exploreDupe: (d: Dupe) => void;
  /** Look up the price of one dupe that is not priced automatically. */
  checkDupePrice: (d: Dupe) => void;
}

export const cardHeading = (p: Perfume) => `${p.name} – ${p.brand}`;

// ---------- notes ----------

function tier(label: string, notes: string[]): HTMLElement | null {
  if (notes.length === 0) return null;
  const wrap = el('section', 'tier');
  wrap.append(el('h3', undefined, label));
  const chips = el('div', 'chips');
  for (const n of notes) chips.append(el('span', 'chip', n));
  wrap.append(chips);
  return wrap;
}

/** The Notes card body for finished data: description first, then the note groups. */
export function renderNotesBody(notes: NotesCardData): HTMLElement {
  const body = el('div', 'notes-body');
  body.append(el('p', 'desc', notes.description));
  for (const g of [tier('Top', notes.top), tier('Heart', notes.heart), tier('Base', notes.base), tier('Notes', notes.flat)]) {
    if (g) body.append(g);
  }
  return body;
}

export function renderNotesCard(s: CardsState, onRetry: () => void): HTMLElement {
  const card = el('article', 'card notes-card');
  card.append(el('h2', undefined, cardHeading(s.perfume)));
  if (s.perfume.concentration) card.append(el('div', 'sub', s.perfume.concentration));
  const body = el('div', 'card-body');
  if (s.notes.status === 'done' && s.notes.data) {
    body.append(renderNotesBody(s.notes.data));
  } else if (s.notes.status === 'error') {
    const err = el('div', 'error');
    err.append(el('p', undefined, s.notes.message ?? 'Something went wrong.'), button('Retry', onRetry));
    body.append(err);
  } else {
    body.append(loadingLine('Describing the scent…'));
  }
  card.append(body);
  return card;
}

// ---------- prices ----------

function priceRowEl(
  row: PriceRow,
  here: boolean,
  baseline: { amount: number; label: string } | null,
  tooLow = false,
): HTMLElement {
  const li = el('li', `price-row ${row.status}`);
  if (row.reason) li.title = row.reason; // hover to see why a shop has no price
  if (row.status !== 'found') {
    li.append(el('span', 'shop', row.shopName));
    li.append(
      el('span', 'muted', row.status === 'search-unavailable' ? 'Not found (search unavailable)' : 'Not found'),
    );
    // Say why, on its own line, so an empty shop can be understood without hovering.
    if (row.reason) li.append(el('span', 'reason', row.reason));
    return li;
  }

  const main = el('div', 'price-main');
  const name = row.url ? externalLink(row.shopName, row.url) : el('span', 'shop', row.shopName);
  main.append(name, document.createTextNode(`: ${formatInr(row.priceInr ?? 0)}`));
  li.append(main);

  const tags = el('div', 'tags');
  // No savings text for a price that looks like a sample: it would promise a saving that is not real.
  const saved = tooLow ? null : savings(baseline?.amount, row.priceInr);
  if (saved != null && baseline) {
    tags.append(el('span', 'save', `you save ${formatInr(saved)} compared with ${baseline.label}`));
  }
  if (tooLow) tags.append(el('span', 'tag warn', 'Looks too low: maybe a sample size, check the listing'));
  if (here) tags.append(el('span', 'tag', 'You are here'));
  if (row.viaSearch) tags.append(el('span', 'tag', 'via search'));
  if (row.exactMatch === false && row.variant) tags.append(el('span', 'tag warn', row.variant));
  if (row.inStock === false) tags.append(el('span', 'tag warn', 'Out of stock'));
  if (tags.childElementCount) li.append(tags);
  return li;
}

export function renderPricesCard(s: CardsState, a: CardActions): HTMLElement {
  const card = el('article', 'card prices-card');
  card.append(el('h2', undefined, 'Prices'));
  const p = s.prices;
  const body = el('div', 'card-body');

  if (p.status === 'empty') {
    const msg = el('p', undefined, 'No shops configured. ');
    msg.append(button('Add shops in Options', a.openOptions, 'linklike'));
    body.append(msg);
    card.append(body);
    return card;
  }

  if (p.rows.length === 0) {
    body.append(loadingLine(p.total ? `Checking ${p.total} shops…` : 'Checking shops…'));
    card.append(body);
    return card;
  }

  // Cheapest first, but a price far below the rest (probably a decant) goes after the real ones.
  const low = lowOutlierShopIds(p.rows);
  const sortedAll = sortRows(p.rows);
  const sorted = [
    ...sortedAll.filter((r) => r.status === 'found' && !low.has(r.shopId)),
    ...sortedAll.filter((r) => r.status === 'found' && low.has(r.shopId)),
    ...sortedAll.filter((r) => r.status !== 'found'),
  ];
  const hereRow = p.hereShopId ? (p.rows.find((r) => r.shopId === p.hereShopId) ?? null) : null;
  const baseline = chooseBaseline({
    currentPrice: s.currentPrice.amountInr,
    currentSiteName: s.currentPrice.siteName,
    hereRow,
    rows: p.rows,
    explore: s.explore,
  });

  const progress = el('div', 'sub');
  if (p.status === 'loading') progress.append(el('span', 'spinner'), document.createTextNode(`${p.done} of ${p.total} shops checked`));
  else progress.textContent = `${p.total} of ${p.total} shops checked`;
  body.append(progress);

  if (!baseline && !s.explore && s.currentPrice.amountInr == null) {
    body.append(el('p', 'muted', "The current site's price couldn't be read, so savings aren't shown."));
  } else if (s.explore && baseline) {
    body.append(el('p', 'muted', `Savings are compared with the most expensive shop (${baseline.label}).`));
  }

  const list = el('ul', 'price-list');
  for (const row of sorted) list.append(priceRowEl(row, row.shopId === p.hereShopId, baseline, low.has(row.shopId)));
  body.append(list);
  card.append(body);
  return card;
}

// ---------- dupes ----------

function dupePriceEl(d: Dupe, s: DupesState, auto: boolean, a: CardActions): HTMLElement {
  const prices = s.prices;
  const box = el('div', 'dupe-price');
  if (!(d.key in prices)) {
    if (auto || s.requested[d.key]) {
      box.append(el('span', 'spinner'), document.createTextNode('Checking prices…'));
    } else {
      box.append(button('Check price', () => a.checkDupePrice(d), 'linklike'));
    }
    return box;
  }
  const best = prices[d.key];
  if (!best || best.priceInr == null) {
    box.append(el('span', 'muted', 'Price not found'));
    return box;
  }
  box.append(document.createTextNode(`${formatInr(best.priceInr)} at `));
  box.append(best.url ? externalLink(best.shopName, best.url) : document.createTextNode(best.shopName));
  if (best.viaSearch) box.append(el('span', 'tag', 'via search'));
  return box;
}

function dupeEl(d: Dupe, s: DupesState, auto: boolean, a: CardActions): HTMLElement {
  const li = el('li', 'dupe');
  const main = button('', () => a.exploreDupe(d), 'dupe-main');
  main.title = d.reason ? `${d.reason}. Click to look this one up.` : 'Click to look this one up.';
  main.append(el('span', 'dupe-name', `${d.name} – ${d.brand}`));

  const sim = el('span', 'dupe-sim');
  const bar = el('span', 'bar');
  const fill = el('span', 'fill');
  fill.style.width = `${d.similarity}%`;
  bar.append(fill);
  sim.append(bar, el('span', 'pct', `${d.similarity}% similar`));
  main.append(sim);
  // Both marks mean "Fragrantica lists it". "Confirmed" is stronger: the AI named it as well.
  if (d.confirmed) main.append(el('span', 'tag ok', '✓ Confirmed by Fragrantica'));
  else if (d.onFragrantica) main.append(el('span', 'tag frag', "On Fragrantica's list"));

  li.append(main, dupePriceEl(d, s, auto, a));
  return li;
}

export function renderDupesCard(s: CardsState, a: CardActions): HTMLElement {
  const card = el('article', 'card dupes-card');
  card.append(el('h2', undefined, 'Dupes'));
  const d = s.dupes;
  const body = el('div', 'card-body');

  if (d.status === 'loading') {
    body.append(loadingLine('Finding dupes…'));
  } else if (d.status === 'error') {
    const err = el('div', 'error');
    err.append(el('p', undefined, d.message ?? 'Something went wrong.'), button('Retry', a.retryDupes));
    body.append(err);
  } else if (d.result) {
    if (!d.result.trustedAvailable) {
      const why =
        d.result.trustedReason === 'not-on-page'
          ? "Fragrantica's \"This perfume reminds me of\" list wasn't on the page when you clicked (it may load only as you scroll to it). Scroll down to it and click the icon again. These are AI suggestions only."
          : "Fragrantica data wasn't available, so these are AI suggestions only.";
      body.append(el('p', 'muted', why));
    }
    if (d.result.few) body.append(el('p', 'muted', 'Few or no reliable dupes found'));
    const list = el('ul', 'dupe-list');
    d.result.dupes.forEach((dupe, i) => list.append(dupeEl(dupe, d, i < AUTO_PRICED_DUPES, a)));
    body.append(list);
  }
  card.append(body);
  return card;
}
