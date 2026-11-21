// Phase 2 + 3 end-to-end checks (FR4 dupes, FR5 prices, FR6 shop list) in a real Chromium
// with the extension loaded.
//
//   npm run e2e:phase23
//
// Everything is local and deterministic:
//  - shops are fake sites on 127.0.0.1 (shop-a.test, shop-b.test ... resolve there),
//  - fragrantica.com resolves to this machine too, so the extension's fetch of it fails fast,
//  - Gemini is a scripted fake answering through Playwright's request interception
//    (service worker requests need PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1).
// The only live piece is the optional model run: E2E_LIVE=1 uses your local Ollama instead of the fake.

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = await import('playwright');

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-e2e');
const SHOTS = join(ROOT, 'docs', 'acceptance', 'screenshots');
const OLLAMA_TEST = process.env.E2E_OLLAMA_URL ?? 'http://127.0.0.1:11435';
const LIVE = process.env.E2E_LIVE === '1';
const ONLY = process.env.E2E_ONLY?.split(',');
const want = (g) => !ONLY || ONLY.includes(g);

const results = [];
function record(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- build ----------
console.log('Building test extension...');
execSync('npx vite build --mode e2e --outDir ../dist-e2e', { cwd: ROOT, stdio: 'ignore' });
const manifestPath = join(DIST, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions.push('<all_urls>'); // no real icon click here, so no activeTab grant
manifest.permissions.push('tabs');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---------- fake shops ----------
const euro = (n) => `₹${n.toLocaleString('en-IN')}`;
const SAUVAGE = {
  'shop-a.test': ['Dior Sauvage Eau de Toilette 100ml', 8750, '/products/dior-sauvage-edt-100ml'],
  'shop-b.test': ['Dior Sauvage EDT 100 ml', 9450, '/products/sauvage-edt'],
  'shop-c.test': ['Dior Sauvage Eau de Toilette Spray 100ml', 7999, '/p/sauvage-100'],
  'amazon.test': ['Dior Sauvage Eau de Toilette 100ml', 9200, '/dp/B0SAUVAGE'],
};
const CDNIM = {
  'shop-a.test': ['Armaf Club de Nuit Intense Man EDT 105ml', 2650, '/products/club-de-nuit-intense-man'],
  'shop-c.test': ['Armaf Club de Nuit Intense Man 105 ml', 2400, '/p/cdnim-105'],
  'amazon.test': ['Armaf Club de Nuit Intense Man Eau de Toilette', 2900, '/dp/B0CDNIM'],
};
const listingFor = (host, q) => (/club de nuit/i.test(q) ? CDNIM : /sauvage/i.test(q) ? SAUVAGE : {})[host];
const filler = '<p>' + 'Free shipping on all orders. Authentic products. Easy returns. '.repeat(8) + '</p>';

const hits = [];
function handle(req, res) {
  const host = (req.headers.host ?? '').split(':')[0];
  const url = new URL(req.url ?? '/', 'http://x');
  hits.push(`${host}${url.pathname}${url.searchParams.has('q') ? `?q=${url.searchParams.get('q')}` : ''}`);
  const send = (status, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };

  if (host === 'www.fragrantica.com' && url.pathname.includes('Long')) {
    const names = Array.from({ length: 14 }, (_, i) => `Perfume Number${i}`).map((n) => `<p>${n}</p>`).join('');
    return send(200, `<html><head><title>Sauvage Dior</title></head><body><h1>Sauvage Dior for men</h1><p>Perfume Encyclopedia.</p><section><h2>This perfume reminds me of</h2>${names}</section></body></html>`);
  }
  if (host === 'www.fragrantica.com' && url.pathname.includes('Lazy')) {
    // the row is added only after the visitor scrolls, like Fragrantica's carousel appears to be
    return send(200, `<html><head><title>Sauvage Dior</title></head><body><h1>Sauvage Dior for men</h1><p>Perfume Encyclopedia. Main accords: fresh spicy, amber, citrus.</p><div style="height:4000px">spacer</div><script>window.addEventListener('scroll', () => { if (!document.getElementById('sim') && window.scrollY > 300) { const s = document.createElement('section'); s.id = 'sim'; s.innerHTML = '<h2>This perfume reminds me of</h2><p>Club de Nuit Intense Man by Armaf</p><p>Y by Yves Saint Laurent</p><p>Bleu de Chanel Eau de Parfum</p>'; document.body.appendChild(s); } });</script></body></html>`);
  }
  if (host === 'www.fragrantica.com' && url.pathname.includes('NoList')) {
    // like a page whose "reminds me of" row has not loaded yet (it may appear only when scrolled to)
    return send(200, '<html><head><title>Sauvage Dior</title></head><body><h1>Sauvage Dior for men</h1><p>Perfume Encyclopedia. Main accords: fresh spicy, amber, citrus. Latest reviews follow below.</p></body></html>');
  }
  if (host === 'www.fragrantica.com') {
    return send(200, readFileSync(join(ROOT, 'e2e', 'fixtures', 'fragrantica-sauvage.html')));
  }
  if (url.pathname === '/search') {
    if (host === 'shop-d.test') {
      return send(403, '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate"></script></html>');
    }
    const q = url.searchParams.get('q') ?? '';
    const item = listingFor(host, q);
    const entry = item
      ? `<div class="item"><a href="${item[2]}">${item[0]}</a><span class="price">${euro(item[1])}</span></div>`
      : '<p>No products found for your search.</p>';
    return send(200, `<html><head><title>Search</title></head><body><h1>Search results for "${q}"</h1>${filler}${entry}${filler}</body></html>`);
  }
  if ((host === 'shop-a.test' || host === 'other.test') && url.pathname === '/products/eur-sauvage') {
    return send(200, `<html><head><title>Dior Sauvage 100ml</title></head><body><h1>CHRISTIAN DIOR SAUVAGE 100ML EAU DE TOILETTE FOR MEN</h1><p>€151.00</p><p>Tax included. Shipping calculated at checkout. ${'Description text. '.repeat(20)}</p></body></html>`);
  }
  const item = [SAUVAGE, CDNIM].map((m) => m[host]).find((p) => p?.[2] === url.pathname);
  if (item) {
    const [title, price] = item;
    const ld =
      host === 'amazon.test'
        ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: title, offers: { '@type': 'Offer', price: String(price), priceCurrency: 'INR' } })}</script>`
        : '';
    return send(200, `<html><head><title>${title}</title>${ld}</head><body><h1>${title}</h1><p>Sold by ${host}</p><p>Price ${euro(price)} inclusive of all taxes. ${'Description text. '.repeat(20)}</p></body></html>`);
  }
  if (url.pathname.startsWith('/products/') || url.pathname.startsWith('/p/') || url.pathname.startsWith('/dp/')) {
    return send(200, `<html><head><title>Product</title></head><body><h1>Dior Sauvage (via search)</h1><p>${host}</p></body></html>`);
  }
  return send(404, 'not found');
}
const server = createServer(handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const shopUrl = (host) => `http://${host}:${PORT}/search?q={query}`;
const SHOPS = [
  ['Shop A', 'shop-a.test'],
  ['Shop B', 'shop-b.test'],
  ['Shop C', 'shop-c.test'],
  ['Shop D', 'shop-d.test'],
  ['Shop E', 'shop-e.test'],
  ['Amazon', 'amazon.test'],
].map(([name, domain]) => ({ id: domain, name, searchUrl: shopUrl(domain), domain, directAccess: true }));

// ---------- scripted Gemini ----------
const gemini = {
  calls: [], // kinds, in order
  urls: [],
  headers: [],
  /** (kind, prompt, body) => undefined | { status, body } to override an answer. */
  override: () => undefined,
  /** Milliseconds to wait before answering, per kind (0 = answer at once). */
  delayMs: (_kind) => 0,
};

function kindOf(prompt, grounded) {
  if (prompt.startsWith('Is this page')) return 'detect';
  if (prompt.includes('Suggest up to 8')) return 'dupes';
  if (prompt.startsWith('Fragrantica page for')) return 'frag-page';
  if (grounded && prompt.includes('Find the fragrantica.com page')) return 'frag-search';
  if (prompt.includes('- description:')) return 'notes';
  if (prompt.includes('Below are search result pages')) return 'batch';
  if (prompt.includes('Search results page:')) return 'price';
  if (grounded && prompt.includes('on each of these')) return 'gbatch';
  if (grounded && prompt.includes('Find the current price of')) return 'gprice';
  return 'other';
}

const NOT_LISTED = { found: false, productTitle: '', priceInr: 0, url: '', inStock: false, variant: '', exactMatch: false };
const parseListing = (text) => {
  const m = /(.+?)\s*\[link: (\S+?)\]\s*₹([\d,]+)/.exec(text);
  return m
    ? { found: true, productTitle: m[1].trim(), priceInr: Number(m[3].replace(/,/g, '')), url: m[2], inStock: true, variant: '100 ml', exactMatch: true }
    : NOT_LISTED;
};
function answer(kind, prompt) {
  // Which perfume the request is about (the detect prompt is judged by the page text instead).
  // For a Fragrantica page read, the page text is in the prompt, so judge by its first line (the subject).
  const subject = kind === 'frag-page' ? prompt.split('\n')[0] : prompt;
  const isCdnim = kind !== 'detect' && /club de nuit/i.test(subject);
  switch (kind) {
    case 'detect': {
      const text = prompt.split('Page text:')[1] ?? '';
      if (/sauvage/i.test(text)) return { found: true, name: 'Sauvage', brand: 'Dior', concentration: 'Eau de Toilette', notes: { top: [], heart: [], base: [], flat: [] }, currentPrice: { amountInr: /€151/.test(text) ? 15500 : 0, siteName: '' } };
      if (/club de nuit/i.test(text)) return { found: true, name: 'Club de Nuit Intense Man', brand: 'Armaf', concentration: 'Eau de Toilette', notes: { top: [], heart: [], base: [], flat: [] }, currentPrice: { amountInr: 0, siteName: '' } };
      return { found: false, name: '', brand: '', concentration: '', notes: { top: [], heart: [], base: [], flat: [] }, currentPrice: { amountInr: 0, siteName: '' } };
    }
    case 'notes':
      return { top: ['Bergamot', 'Pepper'], heart: ['Lavender'], base: ['Ambroxan'], flat: [], description: 'Fresh and peppery, with a clean woody finish.' };
    case 'dupes':
      return isCdnim
        ? { dupes: [{ name: 'Aventus', brand: 'Creed', similarity: 82, reason: 'smoky pineapple' }, { name: 'Sauvage', brand: 'Dior', similarity: 70, reason: 'fresh' }] }
        : {
            dupes: [
              { name: 'Armaf Club de Nuit Intense Man', brand: 'Armaf', similarity: 85, reason: 'same fresh citrus opening' },
              { name: 'Sauvage Elixir', brand: 'Dior', similarity: 95, reason: 'flanker' },
              { name: 'Eros', brand: 'Versace', similarity: 60, reason: '' },
              { name: 'Y', brand: 'Yves Saint Laurent', similarity: 72, reason: '' },
            ],
          };
    case 'frag-search':
    case 'frag-page': {
      const longRow = kind === 'frag-page' ? [...new Set(prompt.match(/Perfume Number\d+/g) ?? [])] : [];
      if (longRow.length) return { pageUrl: '', similar: longRow.map((name) => ({ name, brand: 'Brand' })) };
      return isCdnim
        ? { pageUrl: 'https://www.fragrantica.com/perfume/Armaf/CDNIM-1.html', similar: [{ name: 'Aventus by Creed', brand: 'Creed' }] }
        : {
            pageUrl: 'https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html',
            similar: [
              { name: 'Club de Nuit Intense Man by Armaf', brand: 'Armaf' },
              { name: 'Y', brand: 'Yves Saint Laurent' },
              { name: 'Bleu de Chanel Eau de Parfum', brand: 'Chanel' },
            ],
          };
    }
    case 'price':
      return parseListing(prompt.split('Search results page:')[1] ?? '');
    case 'batch': {
      const sections = prompt.split('=== Shop: ').slice(1);
      return {
        results: sections.map((s) => ({ shop: /\((\S+?)\) ===/.exec(s)?.[1] ?? '', ...parseListing(s) })),
      };
    }
    case 'gprice':
      return /shop-d\.test/.test(prompt) && !isCdnim
        ? { found: true, productTitle: 'Dior Sauvage EDT', priceInr: 8100, url: `http://shop-d.test:${PORT}/products/sauvage-edt-100`, inStock: true, variant: '100 ml', exactMatch: true }
        : NOT_LISTED;
    case 'gbatch':
      return /shop-d\.test/.test(prompt) && isCdnim
        ? { results: [{ shop: 'shop-d.test', found: true, productTitle: 'Armaf Club de Nuit Intense Man 105ml', priceInr: 2500, url: `http://shop-d.test:${PORT}/products/cdnim`, inStock: true, variant: '105 ml', exactMatch: true }] }
        : { results: [] };
    default:
      return {};
  }
}

async function geminiRoute(route) {
  const req = route.request();
  const body = req.postDataJSON?.() ?? {};
  const prompt = body.contents?.[0]?.parts?.[0]?.text ?? '';
  const grounded = !!body.tools;
  const kind = kindOf(prompt, grounded);
  gemini.calls.push(kind);
  gemini.urls.push(req.url());
  gemini.headers.push(req.headers()['x-goog-api-key'] ?? '');
  const wait = gemini.delayMs(kind);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const over = gemini.override(kind, prompt, body);
  if (over) {
    return route.fulfill({ status: over.status, contentType: 'application/json', body: JSON.stringify(over.body) });
  }
  const text = JSON.stringify(answer(kind, prompt));
  const fenced = grounded ? '```json\n' + text + '\n```' : text;
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: fenced }] } }] }),
  });
}

// ---------- browser ----------
const userDataDir = mkdtempSync(join(tmpdir(), 'pc-e2e23-'));
mkdirSync(SHOTS, { recursive: true });

async function launch() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 400, height: 1000 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1, MAP www.fragrantica.com 127.0.0.1',
    ],
  });
  if (!LIVE) await context.route('https://generativelanguage.googleapis.com/**', geminiRoute);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // The extension seeds its default shop list when it is installed. Let that finish first,
  // so it cannot land in the middle of a test that sets up its own shops.
  await sw.evaluate(
    () =>
      new Promise((done) => {
        const t = setInterval(async () => {
          if ((await chrome.storage.local.get('seeded')).seeded) {
            clearInterval(t);
            done();
          }
        }, 50);
      }),
  );
  return { context, sw, extId: new URL(sw.url()).host };
}
let { context, sw, extId } = await launch();

const baseSettings = {
  geminiApiKey: LIVE ? '' : 'fake-key-e2e-0000',
  geminiModel: 'gemini-flash-lite-latest',
  geminiRpm: 600,
  ollamaUrl: OLLAMA_TEST,
  ollamaModel: null,
};
const setStorage = (settings, shops) =>
  sw.evaluate(
    async ({ settings, shops }) => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.storage.local.set({ settings, shops, seeded: true });
    },
    { settings, shops },
  );

const tabIdOf = (page) => sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, page.url());

async function clickIcon(page) {
  const tabId = await tabIdOf(page);
  await sw.evaluate(async (id) => globalThis.__pcClick(await chrome.tabs.get(id)), tabId);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
  return panel;
}

const IDLE_TIMEOUT = Number(process.env.E2E_TIMEOUT_MS ?? (LIVE ? 600_000 : 30_000));
/** Waits until every card has finished loading (or failed). */
async function waitIdle(panel, timeout = IDLE_TIMEOUT) {
  try {
    await panel.waitForFunction(
      () => !!document.querySelector('.notes-card') && !!document.querySelector('.dupes-card') && !document.querySelector('.card .spinner'),
      null,
      { timeout, polling: 200 },
    );
  } catch (e) {
    const text = await panel.evaluate(() => document.body.innerText).catch(() => '(panel gone)');
    console.log(`--- panel still busy after ${timeout} ms ---\n${text}\nAI calls so far: ${gemini.calls.join(', ')}\n---`);
    throw e;
  }
}

const readPrices = (panel) =>
  panel.$$eval('.price-row', (rows) =>
    rows.map((r) => ({
      shop: (r.querySelector('.price-main')?.textContent ?? r.querySelector('.shop')?.textContent ?? '').split(':')[0],
      text: r.textContent,
      href: r.querySelector('a')?.href ?? null,
      save: r.querySelector('.save')?.textContent ?? '',
      tags: [...r.querySelectorAll('.tag')].map((t) => t.textContent),
    })),
  );
const readDupes = (panel) =>
  panel.$$eval('.dupe', (items) =>
    items.map((d) => ({
      name: d.querySelector('.dupe-name')?.textContent ?? '',
      sim: d.querySelector('.pct')?.textContent ?? '',
      confirmed: !!d.querySelector('.tag.ok'),
      onList: !!d.querySelector('.tag.frag'),
      price: d.querySelector('.dupe-price')?.textContent ?? '',
      href: d.querySelector('.dupe-price a')?.href ?? null,
    })),
  );
const heading = (panel) => panel.$eval('.notes-card h2', (h) => h.textContent);

async function openProduct(path = '/dp/B0SAUVAGE', host = 'amazon.test') {
  const p = await context.newPage();
  await p.goto(`http://${host}:${PORT}${path}`);
  return p;
}

try {
  // =====================================================================
  // Options: the saved Gemini key can be removed (it used to be replace-only)
  // =====================================================================
  if (want('FR6')) {
    await setStorage(baseSettings, []);
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    const maskShown = await opt.isVisible('#key-saved');
    await opt.click('#key-remove');
    await opt.waitForFunction(() => !document.querySelector('#key-entry')?.hidden, null, { timeout: 5000 });
    const stored = await sw.evaluate(async () => Object.values(await chrome.storage.local.get(null)).find((v) => v && typeof v === 'object' && 'geminiApiKey' in v)?.geminiApiKey);
    await opt.reload();
    const afterReload = await opt.isVisible('#key-entry');
    record('FR6-remove-key', 'Remove key deletes the saved Gemini key at once (and it stays gone after reload)', maskShown && stored === '' && afterReload, `mask shown before: ${maskShown}, stored key: "${stored}", empty entry box after reload: ${afterReload}`);
    await opt.close();
  }

  // =====================================================================
  // FR6 - shop list on the options page
  // =====================================================================
  if (want('FR6')) {
    await setStorage(baseSettings, []);
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    const result = () => opt.textContent('#shop-result');
    const names = () => opt.$$eval('.shop-item strong', (n) => n.map((x) => x.textContent));
    const add = async (name, url) => {
      await opt.fill('#shop-name', name);
      await opt.fill('#shop-url', url);
      await opt.click('#shop-add');
      await opt.waitForFunction(() => document.querySelector('#shop-result')?.textContent, null, { timeout: 5000 });
      await opt.waitForTimeout(150);
    };

    await opt.waitForSelector('#shop-empty:not([hidden])');
    record('FR6-empty', 'Options shows an empty shop list at first', (await names()).length === 0);

    await add('Perfume Palace', 'https://www.perfumepalace.in/search?q={query}');
    record('FR6-add', 'A valid shop is added and shown', eq(await names(), ['Perfume Palace']) && /Added/.test(await result()), await result());
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('shops')).shops);
    record('FR6-add-stored', 'It is saved with its domain and direct access', stored[0]?.domain === 'perfumepalace.in' && stored[0]?.directAccess === true, JSON.stringify(stored[0]));

    for (const [id, name, url, re] of [
      ['FR6-no-query', 'Bad', 'https://bad.in/search', /\{query\}/],
      ['FR6-http', 'Bad', 'http://bad.in/s?q={query}', /https/],
      ['FR6-no-name', '', 'https://bad.in/s?q={query}', /name/i],
      ['FR6-duplicate', 'Palace again', 'https://perfumepalace.in/s?q={query}', /already/],
    ]) {
      await add(name, url);
      const msg = await result();
      const cls = await opt.getAttribute('#shop-result', 'class');
      record(id, `Rejected with an inline error (${id.replace('FR6-', '')})`, re.test(msg) && cls === 'err' && (await names()).length === 1, msg);
    }
    await opt.screenshot({ path: join(SHOTS, 'options-shops.png'), fullPage: true });

    await add('Nykaa', 'https://www.nykaa.com/search/result/?q={query}');
    await add('Tata CLiQ', 'https://www.tatacliq.com/search/?searchCategory=all&text={query}');
    await opt.click('.shop-item:has(strong:text-is("Nykaa")) button:has-text("Remove")');
    await opt.waitForTimeout(200);
    record('FR6-remove', 'A shop is removed', eq(await names(), ['Perfume Palace', 'Tata CLiQ']), (await names()).join(', '));
    await opt.close();

    // fully restart the browser with the same profile
    await context.close();
    ({ context, sw, extId } = await launch());
    const opt2 = await context.newPage();
    await opt2.goto(`chrome-extension://${extId}/options.html`);
    await opt2.waitForSelector('.shop-item');
    const after = await opt2.$$eval('.shop-item strong', (n) => n.map((x) => x.textContent));
    record('FR6-persist', 'The list is unchanged after a full browser restart', eq(after, ['Perfume Palace', 'Tata CLiQ']), after.join(', '));
    await opt2.close();
  }

  // =====================================================================
  // FR5 - prices
  // =====================================================================
  if (want('FR5')) {
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    gemini.urls.length = 0;
    gemini.headers.length = 0;
    hits.length = 0;
    const page = await openProduct();
    const panel = await clickIcon(page);
    await waitIdle(panel);
    await panel.screenshot({ path: join(SHOTS, 'phase2-prices.png'), fullPage: true });

    const rows = await readPrices(panel);
    const found = rows.filter((r) => /₹\d/.test(r.text));
    const prices = found.map((r) => Number(/₹([\d,]+)/.exec(r.text)[1].replace(/,/g, '')));
    record('FR5-sorted', 'Prices are sorted cheapest first', eq(prices, [...prices].sort((a, b) => a - b)) && prices.length === 5, `${rows.map((r) => r.shop).join(' > ')} | ${prices.join(', ')}`);
    record('FR5-expected', 'The right shops and prices are shown', eq(found.map((r) => r.shop), ['Shop C', 'Shop D', 'Shop A', 'Amazon', 'Shop B']) && eq(prices, [7999, 8100, 8750, 9200, 9450]), found.map((r) => `${r.shop} ${r.text.slice(0, 40)}`).join(' | '));
    record('FR5-bottom', 'A shop that does not list the perfume is "Not found" at the bottom', rows.at(-1)?.shop === 'Shop E' && /Not found/.test(rows.at(-1).text), rows.at(-1)?.text);

    const save = (shop) => rows.find((r) => r.shop === shop)?.save ?? '';
    record(
      'FR5-savings',
      'Savings against the current site (₹9,200) are calculated correctly',
      save('Shop C') === 'you save ₹1,201 compared with Amazon' &&
        save('Shop D') === 'you save ₹1,100 compared with Amazon' &&
        save('Shop A') === 'you save ₹450 compared with Amazon' &&
        save('Amazon') === '' &&
        save('Shop B') === '',
      `C="${save('Shop C')}" D="${save('Shop D')}" A="${save('Shop A')}" Amazon="${save('Amazon')}" B="${save('Shop B')}"`,
    );
    record('FR5-here', 'The shop the user is on is marked "You are here"', rows.find((r) => r.shop === 'Amazon')?.tags.includes('You are here') === true);
    record('FR5-via-search', 'A blocked shop is filled by web search and marked "via search"', rows.find((r) => r.shop === 'Shop D')?.tags.includes('via search') === true && rows.find((r) => r.shop === 'Shop A')?.tags.includes('via search') === false, `Shop D tags: ${rows.find((r) => r.shop === 'Shop D')?.tags}`);
    record('FR5-progress', 'The card ends with "6 of 6 shops checked"', /6 of 6 shops checked/.test(await panel.textContent('.prices-card .sub')), await panel.textContent('.prices-card .sub'));

    // the links open the right product pages
    const linkChecks = [];
    for (const shop of ['Shop C', 'Shop A', 'Amazon']) {
      const row = panel.locator('.price-row', { has: panel.locator(`a:text-is("${shop}")`) });
      const [popup] = await Promise.all([context.waitForEvent('page'), row.locator('a').click()]);
      await popup.waitForLoadState();
      const h1 = await popup.textContent('h1');
      const sold = await popup.textContent('body');
      linkChecks.push({ shop, h1, ok: /Sauvage/.test(h1) && new RegExp(shop === 'Amazon' ? 'amazon.test' : `shop-${shop.slice(-1).toLowerCase()}.test`).test(sold) });
      await popup.close();
    }
    record('FR5-links', 'Each link opens that shop\'s product page for the perfume', linkChecks.every((c) => c.ok), linkChecks.map((c) => `${c.shop}: "${c.h1}"`).join(' | '));

    record('FR5-key-private', 'The API key is sent in a header, never in the URL', gemini.headers.every((h) => h === 'fake-key-e2e-0000') && gemini.urls.every((u) => !u.includes('fake-key')) && gemini.calls.length > 0, `${gemini.calls.length} Gemini calls`);
    const shopFetches = hits.filter((h) => h.includes('/search'));
    const sauvageSearches = shopFetches.filter((h) => /sauvage/i.test(h));
    const searchedHosts = [...new Set(sauvageSearches.map((h) => h.split('/')[0]))].sort();
    record('FR5-only-shops', 'Only the configured shops were searched, each for the perfume, except the shop you are on (its price comes from the page)', eq(searchedHosts, ['shop-a.test', 'shop-b.test', 'shop-c.test', 'shop-d.test', 'shop-e.test']) && shopFetches.every((h) => /^(shop-[a-e]|amazon)\.test\/search/.test(h)), `${sauvageSearches.length} searches for Sauvage on ${searchedHosts.join(', ')}`);

    // Found prices are cached: looking up again only searches the shop that had no result.
    // (A different URL, so this is a separate tab from the first one.)
    hits.length = 0;
    const page2 = await openProduct('/dp/B0SAUVAGE?again=1');
    const panel2 = await clickIcon(page2);
    await waitIdle(panel2);
    const repeat = hits.filter((h) => h.includes('/search') && /sauvage/i.test(h)).map((h) => h.split('/')[0]);
    record('FR5-cache', 'A second lookup reuses cached prices (only the shop with no result is searched again)', eq(repeat, ['shop-e.test']), `searched again: ${repeat.join(', ') || 'none'}`);
    await panel2.close();
    await page2.close();

    // Empty shop list
    await setStorage(baseSettings, []);
    const page3 = await openProduct('/dp/B0SAUVAGE?empty=1');
    const panel3 = await clickIcon(page3);
    await waitIdle(panel3);
    const emptyText = await panel3.textContent('.prices-card');
    await panel3.screenshot({ path: join(SHOTS, 'phase2-no-shops.png'), fullPage: true });
    record('FR5-empty', 'An empty shop list shows "No shops configured" with a link to Options', /No shops configured/.test(emptyText) && (await panel3.locator('.prices-card button').count()) === 1, emptyText);
    await panel3.close();
    await page3.close();
    await panel.close();
    await page.close();
  }

  // =====================================================================
  // FR4 - dupes, explore, back
  // =====================================================================
  if (want('FR4')) {
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    hits.length = 0;
    const page = await openProduct();
    const panel = await clickIcon(page);
    await waitIdle(panel);
    await panel.screenshot({ path: join(SHOTS, 'phase3-dupes.png'), fullPage: true });

    const dupes = await readDupes(panel);
    record('FR4-count', 'The Dupes card shows 2 to 5 ranked dupes', dupes.length >= 2 && dupes.length <= 5, dupes.map((d) => d.name).join(' > '));
    record('FR4-order', 'The dupe confirmed by both sources ranks first; the flanker "Sauvage Elixir" is removed; the two spellings of Club de Nuit are merged into one entry with the brand shown once', eq(dupes.map((d) => d.name), ['Club de Nuit Intense Man – Armaf', 'Y – Yves Saint Laurent', 'Bleu de Chanel Eau de Parfum – Chanel', 'Eros – Versace']), dupes.map((d) => d.name).join(' > '));
    record('FR4-confirmed', 'Dupes found by both the AI and Fragrantica are marked, others are not', eq(dupes.map((d) => d.confirmed), [true, true, false, false]) || dupes[0].confirmed && !dupes[3].confirmed, dupes.map((d) => `${d.name.split(' –')[0]}:${d.confirmed}`).join(', '));
    record('FR4-on-fragrantica-mark', "A dupe that is only on Fragrantica's list (Bleu de Chanel) says so; an AI-only one (Eros) has no Fragrantica mark", dupes[2]?.onList === true && !dupes[2].confirmed && !dupes[3].onList && !dupes[3].confirmed, dupes.map((d) => `${d.name.split(' –')[0]}: ${d.confirmed ? 'confirmed' : d.onList ? 'on list' : 'no mark'}`).join(' | '));
    record('FR4-similarity', 'Each dupe shows a similarity indicator', dupes.every((d) => /^\d+% similar$/.test(d.sim)), dupes.map((d) => d.sim).join(', '));
    record('FR4-price-best', 'A dupe shows its best price from the shop list, with a link (Shop C ₹2,400 beats Shop D ₹2,500 and Shop A ₹2,650)', /₹2,400 at Shop C/.test(dupes[0].price) && /shop-c\.test.*\/p\/cdnim-105/.test(dupes[0].href ?? ''), `${dupes[0].price} -> ${dupes[0].href}`);
    record('FR4-price-missing', '"Price not found" for a dupe no shop lists', /Price not found/.test(dupes[3].price) && /Price not found/.test(dupes[1].price), dupes.map((d) => d.price).join(' | '));
    const count = (kind) => gemini.calls.filter((c) => c === kind).length;
    // 4 dupes x 6 shops = 24 lookups, done with one batch call and one search call per dupe.
    record('FR4-batch', 'Dupe prices use one batch call per dupe (not one per shop)', count('batch') === 4 && count('gbatch') <= 4 && count('price') === 4, `dupes=4 batch=${count('batch')} gbatch=${count('gbatch')} | Sauvage prices: direct=${count('price')} (4 usable shop pages; the shop you are on needs no lookup) search=${count('gprice')} (blocked or not listed)`);

    // Explore a dupe
    await panel.click('.dupe-main');
    await panel.waitForFunction(() => document.querySelector('.notes-card h2')?.textContent.includes('Club de Nuit'));
    await waitIdle(panel);
    await panel.screenshot({ path: join(SHOTS, 'phase3-explore.png'), fullPage: true });

    const exploreHeading = await heading(panel);
    const backText = await panel.textContent('.back-bar button');
    const exploreRows = await readPrices(panel);
    const exploreDupes = await readDupes(panel);
    record('FR4-explore', 'Clicking a dupe runs the full lookup for it, with a Back button', exploreHeading === 'Club de Nuit Intense Man – Armaf' && /Back to Sauvage/.test(backText) && exploreRows.length > 0 && exploreDupes.length >= 1, `${exploreHeading} | ${backText} | ${exploreRows.length} price rows | dupes: ${exploreDupes.map((d) => d.name).join(', ')}`);
    const cheapestExplore = exploreRows.find((r) => /₹\d/.test(r.text));
    const explorePrices = exploreRows.filter((r) => /₹\d/.test(r.text)).map((r) => Number(/₹([\d,]+)/.exec(r.text)[1].replace(/,/g, '')));
    record('FR4-explore-prices', 'The dupe\'s own prices are shown, cheapest first (₹2,400 at Shop C, ₹2,500 via search at Shop D, ₹2,650, ₹2,900)', cheapestExplore?.shop === 'Shop C' && eq(explorePrices, [2400, 2500, 2650, 2900]), exploreRows.map((r) => `${r.shop} ${/₹[\d,]+/.exec(r.text)?.[0] ?? '-'}`).join(' | '));
    record('FR4-explore-savings', 'Without a current site, savings are measured against the most expensive shop price (Amazon ₹2,900)', /most expensive shop \(Amazon\)/.test(await panel.textContent('.prices-card')) && cheapestExplore?.save === 'you save ₹500 compared with Amazon', `${cheapestExplore?.save} | ${(await panel.textContent('.prices-card .muted')) ?? ''}`);

    // Back: redrawn from memory, no new requests
    const geminiBefore = gemini.calls.length;
    const hitsBefore = hits.length;
    await panel.click('.back-bar button');
    await panel.waitForFunction(() => document.querySelector('.notes-card h2')?.textContent === 'Sauvage – Dior');
    await panel.waitForTimeout(1500);
    const backRows = await readPrices(panel);
    const backDupes = await readDupes(panel);
    record('FR4-back', 'Back shows the original perfume again, with its prices, dupes and savings', (await heading(panel)) === 'Sauvage – Dior' && backRows.length === 6 && backDupes.length === 4 && /you save ₹1,201/.test(backRows[0].save), `${await heading(panel)} | ${backRows.length} rows | ${backDupes.length} dupes | ${backRows[0].save}`);
    record('FR4-back-no-requests', 'Back makes no new requests (no AI calls, no shop searches)', gemini.calls.length === geminiBefore && hits.length === hitsBefore, `AI calls ${geminiBefore}->${gemini.calls.length}, shop hits ${hitsBefore}->${hits.length}`);
    record('FR4-back-hidden', 'The Back button is gone once back at the start', await panel.locator('.back-bar').isHidden());
    await panel.close();
    await page.close();

    // The same perfume from a Fragrantica page: dupes come from the page itself.
    // (Fresh storage, otherwise the dupe list from the lookup above is simply reused from the cache.)
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    const frPage = await context.newPage();
    await frPage.goto(`http://www.fragrantica.com:${PORT}/perfume/Dior/Sauvage-31861.html`);
    const frPanel = await clickIcon(frPage);
    await waitIdle(frPanel);
    const frDupes = await readDupes(frPanel);
    record('FR4-fragrantica-page', 'On a Fragrantica page the list is read from the page (no web search for it)', frDupes.length >= 2 && gemini.calls.includes('frag-page') && !gemini.calls.includes('frag-search') && /Club de Nuit/.test(frDupes[0].name), `${frDupes.map((d) => d.name).join(' > ')} | calls: ${[...new Set(gemini.calls)].join(', ')}`);
    await frPanel.close();
    await frPage.close();

    // A Fragrantica page whose list has not loaded: say so, never show guesses as Fragrantica's
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    const noListPage = await context.newPage();
    await noListPage.goto(`http://www.fragrantica.com:${PORT}/perfume/Dior/NoList.html`);
    const noListPanel = await clickIcon(noListPage);
    await waitIdle(noListPanel);
    const noListDupes = await readDupes(noListPanel);
    const noListNote = await noListPanel.textContent('.dupes-card');
    record('FR4-list-not-loaded', 'On a Fragrantica page whose list has not loaded, the card says so and asks the user to scroll', /wasn.t on the page when you clicked/.test(noListNote) && /Scroll down/.test(noListNote), noListNote.replace(/\s+/g, ' ').slice(0, 160));
    record('FR4-no-guesses', 'No dupe is marked as confirmed by Fragrantica, and the AI was not asked to read a list that is not there', noListDupes.length >= 2 && noListDupes.every((d) => !d.confirmed) && !gemini.calls.includes('frag-page'), `${noListDupes.length} AI dupes, calls: ${[...new Set(gemini.calls)].join(', ')}`);
    await noListPanel.close();
    await noListPage.close();

    // A long row (like the real carousel): every perfume is listed, the first 4 are priced, the rest wait for a click
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    const longPage = await context.newPage();
    await longPage.goto(`http://www.fragrantica.com:${PORT}/perfume/Dior/Long.html`);
    const longPanel = await clickIcon(longPage);
    await waitIdle(longPanel);
    const longDupes = await readDupes(longPanel);
    const checkButtons = () => longPanel.locator('.dupe-price button:has-text("Check price")');
    const buttonsBefore = await checkButtons().count();
    const shownBefore = longDupes.length;
    await checkButtons().first().click();
    await longPanel.waitForFunction(() => !document.querySelector('.card .spinner'), null, { timeout: 30_000 });
    const buttonsAfter = await checkButtons().count();
    const longAfter = await readDupes(longPanel);
    await longPanel.screenshot({ path: join(SHOTS, 'phase3-long-list.png'), fullPage: true });
    record('FR4-long-list', 'Every perfume of a long Fragrantica row is listed (not cut to 5)', shownBefore >= 14, `${shownBefore} dupes shown`);
    record('FR4-auto-4', 'Only the first 4 are priced automatically; the rest offer "Check price"', buttonsBefore === shownBefore - 4 && longDupes.slice(0, 4).every((d) => !/Check price/.test(d.price)), `${buttonsBefore} "Check price" buttons for ${shownBefore} dupes`);
    record('FR4-check-price', 'Clicking "Check price" prices just that dupe (button gone, an answer shown)', buttonsAfter === buttonsBefore - 1 && !/Check price|Checking/.test(longAfter[4].price), `buttons ${buttonsBefore} -> ${buttonsAfter}; dupe 5 now says: ${longAfter[4].price}`);
    await longPanel.close();
    await longPage.close();

    // The row appears only when scrolled to: the extension scrolls there itself, reads it, and scrolls back
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    const lazyPage = await context.newPage();
    await lazyPage.goto(`http://www.fragrantica.com:${PORT}/perfume/Dior/Lazy.html`);
    const rowBefore = await lazyPage.evaluate(() => /This perfume reminds me of/.test(document.body.innerText));
    const lazyPanel = await clickIcon(lazyPage);
    await waitIdle(lazyPanel);
    const lazyDupes = await readDupes(lazyPanel);
    const lazyNote = await lazyPanel.textContent('.dupes-card');
    const scrollAfter = await lazyPage.evaluate(() => Math.round(window.scrollY));
    record('FR4-lazy-row', 'A row that appears only on scroll is loaded by the extension and read (confirmed dupe first)', !rowBefore && lazyDupes[0]?.name === 'Club de Nuit Intense Man – Armaf' && lazyDupes[0]?.confirmed && gemini.calls.includes('frag-page') && !/wasn.t on the page/.test(lazyNote), `row on page before: ${rowBefore}, first confirmed: ${lazyDupes[0]?.confirmed}, frag-page asked: ${gemini.calls.includes('frag-page')}, note shows not-on-page: ${/wasn.t on the page/.test(lazyNote)}, dupes: ${lazyDupes.map((d) => `${d.name}${d.confirmed ? ' [confirmed]' : ''}`).join(' > ')}, AI calls: ${[...new Set(gemini.calls)].join(',')}`);
    record('FR4-lazy-scroll-back', 'The page is scrolled back to where the user had it (top)', scrollAfter === 0, `scrollY after: ${scrollAfter}`);
    await lazyPanel.close();
    await lazyPage.close();

    // Fragrantica unavailable: AI-only list with a note
    await setStorage(baseSettings, SHOPS);
    gemini.override = (kind) => (kind === 'frag-search' ? { status: 200, body: { candidates: [{ content: { parts: [{ text: '```json\n{"pageUrl":"","similar":[]}\n```' }] } }] } } : undefined);
    const p2 = await openProduct();
    const panel2 = await clickIcon(p2);
    await waitIdle(panel2);
    const aiOnly = await readDupes(panel2);
    record('FR4-ai-only', 'Without Fragrantica data the card still lists AI dupes and says so', aiOnly.length >= 2 && /Fragrantica data wasn't available/.test(await panel2.textContent('.dupes-card')) && aiOnly.every((d) => !d.confirmed), `${aiOnly.map((d) => d.name).join(' > ')}`);
    await panel2.close();
    await p2.close();
    gemini.override = () => undefined;

    // The AI source failing: error with Retry in the Dupes card only
    await setStorage(baseSettings, SHOPS);
    let failDupes = true;
    gemini.override = (kind) => (kind === 'dupes' && failDupes ? { status: 400, body: { error: { message: 'bad request' } } } : undefined);
    const p3 = await openProduct();
    const panel3 = await clickIcon(p3);
    await waitIdle(panel3);
    const errText = await panel3.textContent('.dupes-card');
    const notesOk = (await panel3.locator('.notes-body').count()) === 1;
    const pricesOk = (await panel3.locator('.price-row').count()) > 0;
    record('FR4-error-isolated', 'A failing dupe lookup shows an error with Retry while Notes and Prices still work', /could not read|problem|Try again|wrong/i.test(errText) && /Retry/.test(errText) && notesOk && pricesOk, errText.replace(/\s+/g, ' ').slice(0, 120));
    failDupes = false;
    await panel3.click('.dupes-card button:has-text("Retry")');
    await waitIdle(panel3);
    record('FR4-retry', 'Retry fills the Dupes card without redoing the other cards', (await readDupes(panel3)).length >= 2 && (await panel3.locator('.dupes-card .error').count()) === 0);
    await panel3.close();
    await p3.close();
    gemini.override = () => undefined;
  }

  // =====================================================================
  // Gemini busy: the request falls back to the local model instead of an error
  // =====================================================================
  if (want('FALLBACK') && !LIVE) {
    const ollamaUp = await fetch(`${OLLAMA_TEST}/api/tags`).then((r) => r.ok).catch(() => false);
    if (!ollamaUp) {
      console.log(`SKIPPED FALLBACK: no Ollama at ${OLLAMA_TEST} (start it as described in e2e/phase1.mjs)`);
    } else {
      await setStorage(baseSettings, []);
      gemini.calls.length = 0;
      // Gemini answers "high demand" to every notes request, however often it is retried.
      gemini.override = (kind) => (kind === 'notes' ? { status: 503, body: { error: { status: 'UNAVAILABLE', message: 'high demand' } } } : undefined);
      const page = await openProduct();
      const panel = await clickIcon(page);
      await waitIdle(panel, 180_000);
      const notesTries = gemini.calls.filter((c) => c === 'notes').length;
      const notesShown = (await panel.locator('.notes-body .desc').count()) === 1;
      const notesError = await panel.locator('.notes-card .error').count();
      const badge = await panel.locator('.badge').isVisible();
      const dupesOnGemini = gemini.calls.includes('dupes') && (await panel.locator('.dupe').count()) >= 2;
      await panel.screenshot({ path: join(SHOTS, 'fallback-busy.png'), fullPage: true });
      record('FALLBACK-busy', 'Gemini answering 503 to the notes request: tried 3 times, then answered by Ollama (no error)', notesTries === 3 && notesShown && notesError === 0, `Gemini notes attempts: ${notesTries}, notes shown: ${notesShown}, error cards: ${notesError}`);
      record('FALLBACK-badge', 'The "Using local model" badge appears', badge);
      record('FALLBACK-others', 'Other cards are not moved to the local model by one busy request (dupes still came from Gemini)', dupesOnGemini, `Gemini calls: ${[...new Set(gemini.calls)].join(', ')}`);
      await panel.close();
      await page.close();
      gemini.override = () => undefined;
    }
  }

  // =====================================================================
  // A page that shows another currency (Perfume Palace showed EUR 151.00): no invented rupee price
  // =====================================================================
  if (want('CURRENCY') && !LIVE) {
    await setStorage(baseSettings, SHOPS);
    const page = await openProduct('/products/eur-sauvage', 'shop-a.test');
    const panel = await clickIcon(page);
    await waitIdle(panel);
    const rows = await readPrices(panel);
    const hereRow = rows.find((r) => r.shop === 'Shop A');
    const invented = rows.some((r) => /15,500/.test(r.text));
    const saves = rows.filter((r) => r.save).length;
    const note = await panel.textContent('.prices-card');
    await panel.screenshot({ path: join(SHOTS, 'currency-eur.png'), fullPage: true });
    record('CURRENCY-no-invented', "The AI's converted figure (15,500, from EUR 151) is not shown as a price anywhere", !invented, `rows: ${rows.map((r) => `${r.shop} ${/₹[\d,]+/.exec(r.text)?.[0] ?? '-'}`).join(' | ')}`);
    const saveOf = (shop) => rows.find((r) => r.shop === shop)?.save ?? '';
    record('CURRENCY-honest-savings', "Savings use the shop's own real price (Shop A, 8,750) as the baseline, never the invented one", saveOf('Shop C') === 'you save ₹751 compared with Shop A' && saveOf('Shop D') === 'you save ₹650 compared with Shop A', `C="${saveOf('Shop C')}" D="${saveOf('Shop D')}"`);
    record('CURRENCY-shop-still-priced', 'The shop you are on is still priced from its own search page, in rupees', !!hereRow && /₹8,750/.test(hereRow.text), hereRow?.text.slice(0, 60));
    await panel.close();
    await page.close();
  }

  if (want('CURRENCY') && !LIVE) {
    await setStorage(baseSettings, SHOPS);
    const page = await openProduct('/products/eur-sauvage', 'other.test');
    const panel = await clickIcon(page);
    await waitIdle(panel);
    const rows = await readPrices(panel);
    const note = await panel.textContent('.prices-card');
    record('CURRENCY-no-baseline', "On a page that shows euros and is not one of your shops: no savings, and the card says the page's price could not be read", rows.every((r) => !r.save) && /couldn.t be read/.test(note), `${rows.filter((r) => r.save).length} rows with savings`);
    await panel.close();
    await page.close();
  }

  // =====================================================================
  // Chrome stops the background worker in the middle of a lookup (it does so after ~30 s idle).
  // Playwright normally holds the worker alive, so this forces it with the DevTools protocol.
  // =====================================================================
  if (want('WORKER') && !LIVE) {
    await setStorage(baseSettings, SHOPS);
    gemini.calls.length = 0;
    // Slow the prices and dupes down so the lookup is still running when the worker is stopped.
    gemini.delayMs = (kind) => (['price', 'gprice', 'batch', 'gbatch', 'dupes'].includes(kind) ? 2500 : 0);
    const page = await openProduct('/dp/B0SAUVAGE?worker=1');
    const panel = await clickIcon(page);
    await panel.waitForSelector('.notes-card', { timeout: 30_000 }); // detection is done, the rest is under way
    const spinnersBefore = await panel.locator('.card .spinner').count();

    // Watch the panel's status line from before the stop, so the short "Reconnecting" message is not missed.
    let sawReconnecting = false;
    const watcher = setInterval(async () => {
      const t = await panel.evaluate(() => document.querySelector('.status')?.textContent ?? '').catch(() => '');
      if (/Reconnecting/.test(t)) sawReconnecting = true;
    }, 50);

    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers'); // what Chrome does to an idle worker
    record('WORKER-premise', 'The worker was stopped while a lookup was still running (cards were still loading)', spinnersBefore > 0, `cards still loading when stopped: ${spinnersBefore}`);

    await waitIdle(panel, 120_000);
    clearInterval(watcher);
    sw = context.serviceWorkers().at(-1) ?? (await context.waitForEvent('serviceworker'));
    gemini.delayMs = () => 0;

    const rows = await readPrices(panel);
    const dupes = await readDupes(panel);
    const statusText = await panel.evaluate(() => {
      const s = document.querySelector('.status');
      return s && !s.hidden ? s.textContent.trim() : '';
    });
    await panel.screenshot({ path: join(SHOTS, 'worker-restart.png'), fullPage: true });
    record('WORKER-recovered', 'The panel reconnects by itself and finishes the lookup: all 6 shops and the dupes are there', rows.length === 6 && dupes.length >= 2 && !/Lost the connection|could not reconnect/.test(statusText), `${rows.length} price rows, ${dupes.length} dupes, status text: "${statusText}"`);
    record('WORKER-reconnecting', 'It said "Reconnecting" while it did so (it did not freeze on a spinner)', sawReconnecting);
    record('WORKER-resumed', 'The lookup was run again for the same page after reconnecting', gemini.calls.filter((c) => c === 'detect').length >= 2, `detection requests: ${gemini.calls.filter((c) => c === 'detect').length}`);
    record('WORKER-no-spinner', 'Nothing is left spinning', (await panel.locator('.card .spinner').count()) === 0);
    await panel.close();
    await page.close();
  }

  // =====================================================================
  // The worker is stopped AFTER the results are complete (user reading them), then a dupe is clicked.
  // The click must open that dupe, not run the page lookup again; "Check price" must also still work.
  // =====================================================================
  if (want('WORKER') && !LIVE) {
    await setStorage(baseSettings, SHOPS);
    gemini.delayMs = () => 0;
    const page = await openProduct('/dp/B0SAUVAGE?worker=2');
    const panel = await clickIcon(page);
    await waitIdle(panel, 120_000);
    const before = await panel.locator('.notes-card h2').innerText();
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await panel.waitForTimeout(1500);
    const target = panel.locator('.dupe-main').first();
    const targetName = (await target.locator('.dupe-name').innerText()).split(' – ')[0];
    await target.click();
    await panel.waitForFunction((n) => (document.querySelector('.notes-card h2')?.textContent ?? '').startsWith(n), targetName, { timeout: 60_000 });
    await waitIdle(panel, 120_000);
    const after = await panel.locator('.notes-card h2').innerText();
    record('WORKER-click-after-stop', 'After the worker was stopped, clicking a dupe opens that dupe (not the original page again)', after.startsWith(targetName) && !after.includes(before.split(' – ')[0]), `was "${before}", clicked "${targetName}", now "${after}"`);
    record('WORKER-click-back', 'Back then returns to the original', await panel.locator('.back-bar button').count() === 1 && (await panel.locator('.back-bar button').innerText()).includes(before.split(' – ')[0]));
    await panel.locator('.back-bar button').click();
    await panel.waitForFunction((n) => (document.querySelector('.notes-card h2')?.textContent ?? '') === n, before, { timeout: 30_000 });
    await cdp.send('ServiceWorker.stopAllWorkers');
    await panel.waitForTimeout(1500);
    const check = panel.locator('.dupe-price button', { hasText: 'Check price' }).first();
    if (await check.count()) {
      await check.click();
      await waitIdle(panel, 60_000);
      record('WORKER-check-price-after-stop', 'Check price answers after the worker was stopped (no spinner left)', (await panel.locator('.dupe-price .spinner').count()) === 0);
    } else {
      record('WORKER-check-price-after-stop', 'Check price answers after the worker was stopped', true, 'SKIPPED: fewer than 9 dupes in this fixture');
    }
    await panel.close();
    await page.close();
  }

  // =====================================================================
  // Optional: the real local model on the price pages
  // =====================================================================
  if (LIVE && want('LIVE')) {
    await setStorage({ ...baseSettings, geminiApiKey: '' }, SHOPS.filter((s) => ['shop-a.test', 'shop-b.test', 'shop-c.test'].includes(s.domain)));
    const page = await openProduct();
    const panel = await clickIcon(page);
    await waitIdle(panel, 900_000);
    const rows = await readPrices(panel);
    const found = rows.filter((r) => /₹\d/.test(r.text));
    const prices = found.map((r) => Number(/₹([\d,]+)/.exec(r.text)[1].replace(/,/g, '')));
    await panel.screenshot({ path: join(SHOTS, 'phase2-live-model.png'), fullPage: true });
    record('LIVE-prices', 'Real local model: prices read from the fake shop pages, sorted, with product links', found.length >= 2 && eq(prices, [...prices].sort((a, b) => a - b)) && found.every((r) => r.href), `${found.map((r) => `${r.shop} ${/₹[\d,]+/.exec(r.text)[0]}`).join(' | ')}`);
    await panel.close();
    await page.close();
  }
} finally {
  await context.close().catch(() => undefined);
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
writeFileSync(join(ROOT, 'docs', 'acceptance', 'phase-2-3-e2e.json'), JSON.stringify({ when: new Date().toISOString(), live: LIVE, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
