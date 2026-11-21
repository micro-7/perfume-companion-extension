// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Dupe, DupesResult, NotesCardData, Perfume, PriceRow } from '../shared/types';
import { PanelView } from './panel';

const perfume = { name: 'Sauvage', brand: 'Dior', concentration: 'Eau de Toilette' };
const full: NotesCardData = {
  top: ['Bergamot', 'Pepper'],
  heart: ['Lavender'],
  base: ['Ambroxan'],
  flat: [],
  description: 'Fresh, peppery, a bit woody.',
};

let root: HTMLElement;
let actions: {
  retry: Mock<() => void>;
  retryNotes: Mock<() => void>;
  retryDupes: Mock<() => void>;
  openOptions: Mock<() => void>;
  lookup: Mock<(p: Perfume) => void>;
  cancel: Mock<() => void>;
  checkDupePrice: Mock<(d: Dupe) => void>;
};
let view: PanelView;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  actions = {
    retry: vi.fn<() => void>(),
    retryNotes: vi.fn<() => void>(),
    retryDupes: vi.fn<() => void>(),
    openOptions: vi.fn<() => void>(),
    lookup: vi.fn<(p: Perfume) => void>(),
    cancel: vi.fn<() => void>(),
    checkDupePrice: vi.fn<(d: Dupe) => void>(),
  };
  view = new PanelView(root, actions);
});

const text = () => root.textContent ?? '';
const tierLabels = () => Array.from(root.querySelectorAll('.tier h3')).map((h) => h.textContent);

describe('PanelView', () => {
  it('shows a loading state when a lookup starts', () => {
    view.handle({ type: 'lookup:start' });
    expect(root.querySelector('.status .spinner')).not.toBeNull();
    expect(root.querySelector('.card')).toBeNull();
  });

  it('shows "No perfume detected on this page" and no cards', () => {
    view.handle({ type: 'lookup:start' });
    view.handle({ type: 'detect:none' });
    expect(text()).toContain('No perfume detected on this page');
    expect(root.querySelector('.card')).toBeNull();
  });

  it('tells the user the page cannot be read', () => {
    view.handle({ type: 'restricted' });
    expect(text()).toContain("This page can't be read");
  });

  it('shows a detection error with a working Retry button', () => {
    view.handle({ type: 'detect:error', message: 'No AI provider is reachable.' });
    expect(text()).toContain('No AI provider is reachable.');
    root.querySelector<HTMLButtonElement>('.status button')!.click();
    expect(actions.retry).toHaveBeenCalledOnce();
  });

  it('shows the Notes card heading with its own loading state before notes arrive', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: { amountInr: null, siteName: 'x' } });
    expect(root.querySelector('.card h2')!.textContent).toBe('Sauvage – Dior');
    expect(root.querySelector('.card .spinner')).not.toBeNull();
    expect(root.querySelector('.status')!.hasAttribute('hidden')).toBe(true);
  });

  it('renders the full note pyramid and the description', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: { amountInr: null, siteName: 'x' } });
    view.handle({ type: 'notes:done', notes: full });
    expect(tierLabels()).toEqual(['Top', 'Heart', 'Base']);
    expect(root.querySelector('.desc')!.textContent).toBe('Fresh, peppery, a bit woody.');
    expect(Array.from(root.querySelectorAll('.chip')).map((c) => c.textContent)).toEqual([
      'Bergamot',
      'Pepper',
      'Lavender',
      'Ambroxan',
    ]);
  });

  it('shows a single "Notes" group for a flat list', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: { amountInr: null, siteName: 'x' } });
    view.handle({ type: 'notes:done', notes: { top: [], heart: [], base: [], flat: ['Oud', 'Rose'], description: 'Rich.' } });
    expect(tierLabels()).toEqual(['Notes']);
  });

  it('leaves out a tier that is unknown', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: { amountInr: null, siteName: 'x' } });
    view.handle({ type: 'notes:done', notes: { ...full, base: [] } });
    expect(tierLabels()).toEqual(['Top', 'Heart']);
  });

  it('shows a notes error inside the card with Retry that only retries the notes', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: { amountInr: null, siteName: 'x' } });
    view.handle({ type: 'notes:error', message: 'Gemini is out of quota.' });
    expect(root.querySelector('.card')!.textContent).toContain('Gemini is out of quota.');
    root.querySelector<HTMLButtonElement>('.card button')!.click();
    expect(actions.retryNotes).toHaveBeenCalledOnce();
    expect(actions.retry).not.toHaveBeenCalled();
    expect(root.querySelector('.card .spinner')).not.toBeNull();
  });

  it('shows the local-model badge only after a fallback, and clears it on the next lookup', () => {
    const badge = () => root.querySelector<HTMLElement>('.badge')!;
    expect(badge().hidden).toBe(true);
    view.handle({ type: 'provider:fallback' });
    expect(badge().hidden).toBe(false);
    view.handle({ type: 'lookup:start' });
    expect(badge().hidden).toBe(true);
  });

  it('puts text from the page or model in as text, not HTML', () => {
    view.handle({ type: 'detect:done', perfume: { ...perfume, name: '<img src=x onerror=alert(1)>' }, currentPrice: { amountInr: null, siteName: 'x' } });
    expect(root.querySelector('.card img')).toBeNull();
  });

  it('opens the options page from the header', () => {
    root.querySelector<HTMLButtonElement>('header button')!.click();
    expect(actions.openOptions).toHaveBeenCalledOnce();
  });
});

// ---------- Prices card ----------

const row = (shopName: string, priceInr: number, over: Partial<PriceRow> = {}): PriceRow => ({
  shopId: shopName.toLowerCase().replace(/ /g, ''),
  shopName,
  domain: `${shopName.toLowerCase().replace(/ /g, '')}.in`,
  status: 'found',
  priceInr,
  url: `https://${shopName.toLowerCase().replace(/ /g, '')}.in/p/sauvage`,
  ...over,
});
const here = (price: number | null = null, siteName = 'Amazon') => ({ amountInr: price, siteName });
const detectDone = (price: number | null = 20000, explore = false) =>
  view.handle({ type: 'detect:done', perfume, currentPrice: here(price), explore });
const addRow = (r: PriceRow) => view.handle({ type: 'prices:row', row: r });
const priceRows = () => Array.from(root.querySelectorAll('.price-row'));
const priceText = (i: number) => priceRows()[i]?.textContent ?? '';

describe('Prices card', () => {
  beforeEach(() => {
    detectDone();
    view.handle({ type: 'prices:start', total: 10, hereShopId: null });
  });

  it('shows its own loading state until the first row arrives', () => {
    expect(root.querySelector('.prices-card h2')!.textContent).toBe('Prices');
    expect(root.querySelector('.prices-card .spinner')).not.toBeNull();
  });

  it('keeps rows sorted cheapest first as they stream in, and shows the progress count', () => {
    addRow(row('Beta', 19200));
    addRow(row('Alpha', 16500));
    addRow(row('Gamma', 18000));
    view.handle({ type: 'prices:progress', done: 3, total: 10 });
    expect(priceRows().map((r) => r.querySelector('.price-main')!.textContent)).toEqual([
      'Alpha: ₹16,500',
      'Gamma: ₹18,000',
      'Beta: ₹19,200',
    ]);
    expect(root.querySelector('.prices-card .sub')!.textContent).toContain('3 of 10 shops checked');
  });

  it('shows the savings against the current site, e.g. "you save ₹2,000 compared with Amazon"', () => {
    addRow(row('Perfume Palace', 18000));
    expect(priceText(0)).toContain('Perfume Palace: ₹18,000');
    expect(priceText(0)).toContain('you save ₹2,000 compared with Amazon');
  });

  it('shows no savings for a shop that costs the same or more', () => {
    addRow(row('Same', 20000));
    addRow(row('Dearer', 21000));
    expect(root.querySelector('.save')).toBeNull();
  });

  it('opens each shop link in a new tab, pointing at the product page', () => {
    addRow(row('Alpha', 16500));
    const a = root.querySelector<HTMLAnchorElement>('.price-row a')!;
    expect(a.href).toBe('https://alpha.in/p/sauvage');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noreferrer');
  });

  it('puts rows without a price at the bottom, and explains "search unavailable"', () => {
    addRow(row('Missing', 0, { status: 'not-found', priceInr: undefined }));
    addRow(row('Blocked', 0, { status: 'search-unavailable', priceInr: undefined }));
    addRow(row('Alpha', 16500));
    expect(priceRows().map((r) => r.querySelector('.shop,a')!.textContent)).toEqual(['Alpha', 'Missing', 'Blocked']);
    expect(priceText(1)).toContain('Not found');
    expect(priceText(2)).toContain('Not found (search unavailable)');
  });

  it('marks results found through search, other variants and out-of-stock items', () => {
    addRow(row('Via', 18000, { viaSearch: true }));
    addRow(row('Small', 17000, { exactMatch: false, variant: '50 ml' }));
    addRow(row('Empty', 16000, { inStock: false }));
    const all = root.querySelector('.price-list')!.textContent!;
    expect(all).toContain('via search');
    expect(all).toContain('50 ml');
    expect(all).toContain('Out of stock');
  });

  it('marks the shop the user is on and uses its price when the page price is unknown', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: here(null, '') });
    view.handle({ type: 'prices:start', total: 2, hereShopId: 'amazon' });
    addRow(row('Amazon', 20000));
    addRow(row('Palace', 18000));
    const byShop = (name: string) => priceRows().find((r) => r.querySelector('.price-main')!.textContent!.startsWith(`${name}:`))!;
    expect(byShop('Amazon').textContent).toContain('You are here');
    expect(byShop('Amazon').querySelector('.save')).toBeNull(); // its own price is the baseline
    expect(byShop('Palace').textContent).toContain('you save ₹2,000 compared with Amazon');
  });

  it('says the current price could not be read when there is no baseline', () => {
    view.handle({ type: 'detect:done', perfume, currentPrice: here(null) });
    view.handle({ type: 'prices:start', total: 1, hereShopId: null });
    addRow(row('Alpha', 16500));
    expect(root.querySelector('.prices-card')!.textContent).toContain("current site's price couldn't be read");
    expect(root.querySelector('.save')).toBeNull();
  });

  it('puts an implausibly low price after the real ones, warns about it, and promises no saving for it', () => {
    for (const [n, p] of [['Decant', 850], ['Belvish', 8550], ['Network', 9500], ['Charm', 10500], ['Mom', 12600]] as const) addRow(row(n, p));
    const names = priceRows().map((r) => r.querySelector('.price-main')!.textContent!.split(':')[0]);
    expect(names).toEqual(['Belvish', 'Network', 'Charm', 'Mom', 'Decant']);
    const decant = priceRows()[4];
    expect(decant.textContent).toContain('Looks too low');
    expect(decant.querySelector('.save')).toBeNull(); // not "you save ₹19,150"
    expect(priceRows()[0].querySelector('.save')).not.toBeNull();
  });

  it('shows why a shop has no price right in the row, not only on hover', () => {
    addRow(row('Gone', 0, { status: 'search-unavailable', priceInr: undefined, reason: 'the shop page was blocked or empty; web search is unavailable' }));
    expect(priceRows()[0].querySelector('.reason')!.textContent).toBe('the shop page was blocked or empty; web search is unavailable');
  });

  it('shows why a shop has no price when you hover over it', () => {
    addRow(row('Gone', 0, { status: 'not-found', priceInr: undefined, reason: 'the perfume is not on the shop page; web search is unavailable' }));
    expect((priceRows()[0] as HTMLElement).title).toBe('the perfume is not on the shop page; web search is unavailable');
  });

  it('shows the empty-list state with a link to options', () => {
    view.handle({ type: 'prices:empty' });
    expect(root.querySelector('.prices-card')!.textContent).toContain('No shops configured');
    root.querySelector<HTMLButtonElement>('.prices-card button')!.click();
    expect(actions.openOptions).toHaveBeenCalledOnce();
  });

  it('replaces a shop row instead of duplicating it', () => {
    addRow(row('Alpha', 16500));
    addRow(row('Alpha', 15000));
    expect(priceRows()).toHaveLength(1);
    expect(priceText(0)).toContain('15,000');
  });
});

// ---------- Losing the connection mid-lookup ----------

describe('lookup in progress (so a lost connection can be recovered)', () => {
  it('is not in progress before anything starts', () => {
    expect(view.inProgress()).toBe(false);
  });

  it('is in progress from the start of a lookup until every card has finished', () => {
    view.handle({ type: 'lookup:start' });
    expect(view.inProgress()).toBe(true); // reading the page
    detectDone();
    expect(view.inProgress()).toBe(true); // cards loading
    view.handle({ type: 'notes:done', notes: full });
    view.handle({ type: 'prices:start', total: 1, hereShopId: null });
    addRow(row('Alpha', 16500));
    view.handle({ type: 'prices:progress', done: 1, total: 1 });
    expect(view.inProgress()).toBe(true); // dupes still loading
    dupeList([]);
    expect(view.inProgress()).toBe(false);
  });

  it('is not in progress after a page with no perfume, an unreadable page or a detection error', () => {
    for (const msg of [{ type: 'detect:none' }, { type: 'restricted' }, { type: 'detect:error', message: 'x' }] as const) {
      view.handle({ type: 'lookup:start' });
      view.handle(msg);
      expect(view.inProgress()).toBe(false);
    }
  });

  it('shows "Reconnecting" with a spinner while it tries again', () => {
    view.showReconnecting();
    expect(root.querySelector('.status .spinner')).not.toBeNull();
    expect(root.querySelector('.status')!.textContent).toMatch(/Reconnecting/);
  });

  it('after giving up, shows a "Try again" button instead of an endless spinner', () => {
    const again = vi.fn();
    view.showConnectionLost(again);
    expect(root.querySelector('.status .spinner')).toBeNull();
    const btn = root.querySelector<HTMLButtonElement>('.status button')!;
    expect(btn.textContent).toBe('Try again');
    btn.click();
    expect(again).toHaveBeenCalledOnce();
  });

  it('keeps the results already on screen while reconnecting', () => {
    detectDone();
    view.handle({ type: 'notes:done', notes: full });
    view.showReconnecting();
    expect(root.querySelector('.desc')!.textContent).toBe('Fresh, peppery, a bit woody.');
  });
});

// ---------- Dupes card ----------

const dupe = (name: string, brand: string, similarity: number, over: Partial<Dupe> = {}): Dupe => ({
  key: `${brand}|${name}`.toLowerCase(),
  name,
  brand,
  similarity,
  confirmed: false,
  onFragrantica: false,
  reason: '',
  ...over,
});
const cni = dupe('Club de Nuit Intense Man', 'Armaf', 85, { confirmed: true });
const eros = dupe('Eros', 'Versace', 60);
const dupeList = (dupes: Dupe[], over: Partial<DupesResult> = {}) =>
  view.handle({ type: 'dupes:list', result: { dupes, trustedAvailable: true, few: dupes.length < 2, ...over } });
const dupeItems = () => Array.from(root.querySelectorAll('.dupe'));

describe('Dupes card', () => {
  beforeEach(() => {
    detectDone();
  });

  it('shows its own loading state', () => {
    expect(root.querySelector('.dupes-card h2')!.textContent).toBe('Dupes');
    expect(root.querySelector('.dupes-card .spinner')).not.toBeNull();
  });

  it('lists ranked dupes with name, brand, similarity and the Fragrantica mark', () => {
    dupeList([cni, eros]);
    expect(dupeItems()).toHaveLength(2);
    expect(dupeItems()[0].querySelector('.dupe-name')!.textContent).toBe('Club de Nuit Intense Man – Armaf');
    expect(dupeItems()[0].textContent).toContain('85% similar');
    expect(dupeItems()[0].textContent).toContain('Confirmed by Fragrantica');
    expect(dupeItems()[1].textContent).not.toContain('Confirmed');
    expect(dupeItems()[0].querySelector<HTMLElement>('.fill')!.style.width).toBe('85%');
  });

  it("marks every dupe that is on Fragrantica's list: Confirmed when the AI named it too, otherwise 'On Fragrantica's list'", () => {
    const both = dupe('Kuro', 'Ajmal', 92, { confirmed: true, onFragrantica: true });
    const onlyFragrantica = dupe('Luna Rossa Carbon', 'Prada', 80, { onFragrantica: true });
    const onlyAi = dupe('Asad', 'Lattafa', 90);
    dupeList([both, onlyFragrantica, onlyAi]);
    const text = (i: number) => dupeItems()[i].textContent ?? '';
    expect(text(0)).toContain('Confirmed by Fragrantica');
    expect(text(0)).not.toContain("On Fragrantica's list");
    expect(text(1)).toContain("On Fragrantica's list");
    expect(text(1)).not.toContain('Confirmed');
    expect(text(2)).not.toContain('Fragrantica'); // the AI alone: no mark
  });

  it('shows a price-loading indicator per dupe, then the best price with a link, or "Price not found"', () => {
    dupeList([cni, eros]);
    expect(dupeItems()[0].querySelector('.dupe-price .spinner')).not.toBeNull();

    view.handle({ type: 'dupes:price', key: cni.key, best: row('Beta', 2100) });
    view.handle({ type: 'dupes:price', key: eros.key, best: null });
    expect(dupeItems()[0].querySelector('.dupe-price')!.textContent).toContain('₹2,100 at Beta');
    expect(dupeItems()[0].querySelector<HTMLAnchorElement>('.dupe-price a')!.href).toBe('https://beta.in/p/sauvage');
    expect(dupeItems()[1].querySelector('.dupe-price')!.textContent).toBe('Price not found');
  });

  it('says when Fragrantica data was not available, and when there are few dupes', () => {
    dupeList([cni], { trustedAvailable: false });
    const text = root.querySelector('.dupes-card')!.textContent!;
    expect(text).toContain("Fragrantica data wasn't available");
    expect(text).toContain('Few or no reliable dupes found');
    expect(dupeItems()).toHaveLength(1);
  });

  it("when Fragrantica's list was not on the page, says so and tells the user what to do", () => {
    dupeList([eros], { trustedAvailable: false, trustedReason: 'not-on-page' });
    const text = root.querySelector('.dupes-card')!.textContent!;
    expect(text).toContain("wasn't on the page when you clicked");
    expect(text).toContain('Scroll down');
    expect(text).not.toContain("Fragrantica data wasn't available");
  });

  it('shows an error inside the card with a Retry that only retries the dupes', () => {
    view.handle({ type: 'dupes:error', message: 'AI is down.' });
    expect(root.querySelector('.dupes-card')!.textContent).toContain('AI is down.');
    root.querySelector<HTMLButtonElement>('.dupes-card button')!.click();
    expect(actions.retryDupes).toHaveBeenCalledOnce();
    expect(actions.retry).not.toHaveBeenCalled();
    expect(root.querySelector('.dupes-card .spinner')).not.toBeNull();
  });

  it('clicking a dupe asks for the full lookup of that perfume', () => {
    dupeList([cni, eros]);
    dupeItems()[0].querySelector<HTMLButtonElement>('.dupe-main')!.click();
    expect(actions.lookup).toHaveBeenCalledWith({ name: 'Club de Nuit Intense Man', brand: 'Armaf', concentration: '' });
  });
});

// ---------- Many dupes: automatic prices for the top 8, "Check price" for the rest ----------

describe('a long dupe list (the whole carousel)', () => {
  const many = Array.from({ length: 12 }, (_, i) => dupe(`Perfume ${i}`, `Brand ${i}`, 90 - i));
  const priceOf = (i: number) => dupeItems()[i].querySelector('.dupe-price')!;

  beforeEach(() => {
    detectDone();
    dupeList(many);
  });

  it('shows every dupe', () => {
    expect(dupeItems()).toHaveLength(12);
  });

  it('prices the first 4 automatically (spinner) and offers "Check price" on the rest', () => {
    for (let i = 0; i < 4; i++) expect(priceOf(i).querySelector('.spinner')).not.toBeNull();
    for (let i = 4; i < 12; i++) {
      expect(priceOf(i).querySelector('.spinner')).toBeNull();
      expect(priceOf(i).querySelector('button')!.textContent).toBe('Check price');
    }
  });

  it('clicking "Check price" asks for just that dupe and shows a spinner until its price arrives', () => {
    priceOf(9).querySelector<HTMLButtonElement>('button')!.click();
    expect(actions.checkDupePrice).toHaveBeenCalledOnce();
    expect(actions.checkDupePrice.mock.calls[0][0]).toMatchObject({ name: 'Perfume 9' });
    expect(priceOf(9).querySelector('.spinner')).not.toBeNull();
    expect(priceOf(10).querySelector('button')).not.toBeNull(); // the others are untouched

    view.handle({ type: 'dupes:price', key: many[9].key, best: row('Beta', 2100) });
    expect(priceOf(9).textContent).toContain('₹2,100 at Beta');
  });

  it('shows "Price not found" for a dupe that was checked and has no price', () => {
    priceOf(8).querySelector<HTMLButtonElement>('button')!.click();
    view.handle({ type: 'dupes:price', key: many[8].key, best: null });
    expect(priceOf(8).textContent).toBe('Price not found');
  });

  it('the lookup counts as finished once the automatically priced dupes are in, even with unpriced ones below', () => {
    view.handle({ type: 'notes:done', notes: full });
    view.handle({ type: 'prices:start', total: 1, hereShopId: null });
    addRow(row('Alpha', 16500));
    view.handle({ type: 'prices:progress', done: 1, total: 1 });
    expect(view.inProgress()).toBe(true); // the top 8 are still being priced
    for (let i = 0; i < 8; i++) view.handle({ type: 'dupes:price', key: many[i].key, best: null });
    expect(view.inProgress()).toBe(false); // dupes 9-12 are waiting for a click, not for the lookup
  });

  it('a requested dupe keeps the lookup open until its price arrives', () => {
    view.handle({ type: 'notes:done', notes: full });
    view.handle({ type: 'prices:start', total: 1, hereShopId: null });
    addRow(row('Alpha', 16500));
    view.handle({ type: 'prices:progress', done: 1, total: 1 });
    for (let i = 0; i < 8; i++) view.handle({ type: 'dupes:price', key: many[i].key, best: null });
    priceOf(10).querySelector<HTMLButtonElement>('button')!.click();
    expect(view.inProgress()).toBe(true);
    view.handle({ type: 'dupes:price', key: many[10].key, best: null });
    expect(view.inProgress()).toBe(false);
  });
});

// ---------- Explore and Back ----------

/** Fills every card for the current perfume, so the lookup counts as complete. */
function finishLookup(dupes: Dupe[] = [cni, eros]) {
  view.handle({ type: 'notes:done', notes: full });
  view.handle({ type: 'prices:start', total: 1, hereShopId: null });
  addRow(row('Alpha', 16500));
  view.handle({ type: 'prices:progress', done: 1, total: 1 });
  dupeList(dupes);
  for (const d of dupes) view.handle({ type: 'dupes:price', key: d.key, best: null });
}

describe('exploring a dupe and going back', () => {
  const armaf = { name: 'Club de Nuit Intense Man', brand: 'Armaf', concentration: '' };
  const clickDupe = () => root.querySelector<HTMLButtonElement>('.dupe-main')!.click();
  const backButton = () => root.querySelector<HTMLButtonElement>('.back-bar button');

  function explore() {
    detectDone(20000);
    finishLookup();
    clickDupe();
    view.handle({ type: 'lookup:start' });
    view.handle({ type: 'detect:done', perfume: armaf, currentPrice: here(null, ''), explore: true });
  }

  it('shows a Back button naming the earlier perfume, and the dupe results', () => {
    explore();
    expect(root.querySelector('.notes-card h2')!.textContent).toBe('Club de Nuit Intense Man – Armaf');
    expect(root.querySelector('.back-bar')!.hasAttribute('hidden')).toBe(false);
    expect(backButton()!.textContent).toContain('Sauvage');
  });

  it('has no Back button on a normal page lookup', () => {
    detectDone();
    expect(root.querySelector('.back-bar')!.hasAttribute('hidden')).toBe(true);
  });

  it('Back redraws a finished lookup from memory, with no new request', () => {
    explore();
    actions.lookup.mockClear();
    backButton()!.click();

    expect(root.querySelector('.notes-card h2')!.textContent).toBe('Sauvage – Dior');
    expect(root.querySelector('.desc')!.textContent).toBe('Fresh, peppery, a bit woody.');
    expect(dupeItems()).toHaveLength(2);
    expect(priceRows()).toHaveLength(1);
    expect(actions.lookup).not.toHaveBeenCalled(); // nothing is looked up again
    expect(actions.cancel).toHaveBeenCalled(); // but the dupe's lookup is stopped
    expect(root.querySelector('.back-bar')!.hasAttribute('hidden')).toBe(true);
  });

  it('Back keeps the original savings against the current site', () => {
    explore();
    backButton()!.click();
    expect(priceText(0)).toContain('you save ₹3,500 compared with Amazon');
  });

  it('Back can go through several levels', () => {
    explore();
    view.handle({ type: 'notes:done', notes: full });
    view.handle({ type: 'prices:start', total: 1, hereShopId: null });
    addRow(row('Alpha', 2100));
    view.handle({ type: 'prices:progress', done: 1, total: 1 });
    dupeList([eros]);
    view.handle({ type: 'dupes:price', key: eros.key, best: null });

    dupeItems()[0].querySelector<HTMLButtonElement>('.dupe-main')!.click();
    view.handle({ type: 'lookup:start' });
    view.handle({ type: 'detect:done', perfume: { name: 'Eros', brand: 'Versace', concentration: '' }, currentPrice: here(null, ''), explore: true });
    expect(backButton()!.textContent).toContain('Club de Nuit');

    backButton()!.click();
    expect(root.querySelector('.notes-card h2')!.textContent).toBe('Club de Nuit Intense Man – Armaf');
    expect(backButton()!.textContent).toContain('Sauvage');
  });

  it('a page lookup from the toolbar icon clears the history', () => {
    explore();
    view.handle({ type: 'lookup:start' }); // not started from a dupe click
    expect(root.querySelector('.back-bar')!.hasAttribute('hidden')).toBe(true);
  });

  it('while exploring, savings are measured against the most expensive shop price', () => {
    detectDone(20000);
    finishLookup();
    clickDupe();
    view.handle({ type: 'lookup:start' });
    view.handle({ type: 'detect:done', perfume: armaf, currentPrice: here(null, ''), explore: true });
    view.handle({ type: 'prices:start', total: 2, hereShopId: null });
    addRow(row('Dear', 2650));
    addRow(row('Cheap', 2100));
    expect(root.querySelector('.prices-card')!.textContent).toContain('most expensive shop (Dear)');
    expect(priceRows().find((r) => r.textContent!.includes('Cheap'))!.textContent).toContain('you save ₹550 compared with Dear');
  });

  it('Back to a lookup that was cut short runs it again, keeping its current-site price', () => {
    detectDone(20000);
    view.handle({ type: 'notes:done', notes: full });
    dupeList([cni]); // the dupe's price and the shop prices are still loading
    clickDupe();
    view.handle({ type: 'lookup:start' });
    view.handle({ type: 'detect:done', perfume: armaf, currentPrice: here(null, ''), explore: true });

    actions.lookup.mockClear();
    backButton()!.click();
    expect(actions.lookup).toHaveBeenCalledWith(perfume); // the original perfume again

    // The worker answers like any dupe lookup (no page price), but the panel remembers Amazon's.
    view.handle({ type: 'lookup:start' });
    view.handle({ type: 'detect:done', perfume, currentPrice: here(null, ''), explore: true });
    view.handle({ type: 'prices:start', total: 1, hereShopId: null });
    addRow(row('Palace', 18000));
    expect(root.querySelector('.notes-card h2')!.textContent).toBe('Sauvage – Dior');
    expect(priceText(0)).toContain('you save ₹2,000 compared with Amazon');
    expect(root.querySelector('.back-bar')!.hasAttribute('hidden')).toBe(true);
  });
});
