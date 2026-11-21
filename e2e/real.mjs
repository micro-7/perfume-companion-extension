// Real-world run: the built extension in Playwright's Chromium, using
//  - your real Gemini key (read from e2e/.gemini-key, never printed),
//  - your real shop list (src/config/shops.default.json),
//  - real product pages.
// It reports what happened rather than asserting exact prices, because real shops change.
//
//   npm run e2e:real                       # default page
//   REAL_URLS="https://...,https://..." npm run e2e:real

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = await import('playwright');

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-e2e');
const SHOTS = join(ROOT, 'docs', 'acceptance', 'screenshots');
const KEY = readFileSync(join(ROOT, 'e2e', '.gemini-key'), 'utf8').trim();
if (!KEY) throw new Error('Paste your Gemini key into e2e/.gemini-key first.');

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';
const RPM = Number(process.env.GEMINI_RPM ?? 10);
const TIMEOUT = Number(process.env.E2E_TIMEOUT_MS ?? 600_000);
const PAGES = (process.env.REAL_URLS ?? 'https://perfumepalace.in/products/christian-dior-sauvage-100ml-edt-for-men')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36';

console.log('Building test extension...');
execSync('npx vite build --mode e2e --outDir ../dist-e2e', { cwd: ROOT, stdio: 'ignore' });
const manifestPath = join(DIST, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions.push('<all_urls>');
manifest.permissions.push('tabs');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const shopInputs = JSON.parse(readFileSync(join(ROOT, 'src', 'config', 'shops.default.json'), 'utf8'));
const SHOPS = shopInputs.map((s) => {
  const domain = new URL(s.searchUrl.replace('{query}', 'q')).hostname.replace(/^www\./, '');
  return { id: domain, name: s.name, searchUrl: s.searchUrl, domain, directAccess: true };
});
const shopByHost = (host) => SHOPS.find((s) => host === s.domain || host.endsWith(`.${s.domain}`));

mkdirSync(SHOTS, { recursive: true });
const userDataDir = mkdtempSync(join(tmpdir(), 'pc-real-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 420, height: 1100 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `--user-agent=${UA}`],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await sw.evaluate(
  () => new Promise((done) => {
    const t = setInterval(async () => {
      if ((await chrome.storage.local.get('seeded')).seeded) { clearInterval(t); done(); }
    }, 50);
  }),
);

// What the extension fetched, as status codes only (no bodies, no keys).
const traffic = { gemini: [], shops: {} };
context.on('response', (res) => {
  const url = new URL(res.url());
  if (url.hostname === 'generativelanguage.googleapis.com') {
    traffic.gemini.push(res.status());
    return;
  }
  const shop = shopByHost(url.hostname);
  const req = res.request();
  if (shop && req.resourceType() === 'fetch' && (url.pathname.includes('search') || url.search.includes('s=') || url.search.includes('k=') || url.search.includes('q='))) {
    (traffic.shops[shop.name] ??= []).push(res.status());
  }
});

await sw.evaluate(
  async ({ settings, shops }) => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.storage.local.set({ settings, shops, seeded: true });
  },
  { settings: { geminiApiKey: KEY, geminiModel: MODEL, geminiRpm: RPM, ollamaUrl: 'http://127.0.0.1:9', ollamaModel: null }, shops: SHOPS },
);

const report = [];
for (const url of PAGES) {
  console.log(`\n=== ${url}`);
  traffic.gemini.length = 0;
  for (const k of Object.keys(traffic.shops)) delete traffic.shops[k];
  const started = Date.now();

  const page = await context.newPage();
  let title = '';
  try {
    await page.goto(url, { timeout: 45_000, waitUntil: 'domcontentloaded' });
    title = await page.title();
  } catch (e) {
    console.log(`could not open the page: ${e.message.split('\n')[0]}`);
    report.push({ url, error: 'page did not open' });
    await page.close();
    continue;
  }
  if (/just a moment|attention required|access denied|robot check/i.test(title)) {
    console.log(`SKIPPED: the site shows a bot check to this browser ("${title}")`);
    report.push({ url, skipped: `bot check: ${title}` });
    await page.close();
    continue;
  }

  await page.waitForTimeout(2000);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
  await sw.evaluate(async (id) => globalThis.__pcClick(await chrome.tabs.get(id)), tabId);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);

  let timedOut = false;
  try {
    await panel.waitForFunction(
      () =>
        (!!document.querySelector('.notes-card') && !!document.querySelector('.dupes-card') && !document.querySelector('.card .spinner')) ||
        (!!document.querySelector('.status') && !document.querySelector('.status').hidden && !document.querySelector('.status .spinner') && !/Getting ready/.test(document.querySelector('.status').textContent)),
      null,
      { timeout: TIMEOUT, polling: 500 },
    );
  } catch {
    timedOut = true;
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const tag = new URL(url).hostname.replace(/\W+/g, '-');
  await panel.screenshot({ path: join(SHOTS, `real-${tag}.png`), fullPage: true });

  const view = await panel.evaluate(() => {
    const t = (el) => el?.textContent?.trim() ?? '';
    return {
      status: (() => { const s = document.querySelector('.status'); return s && !s.hidden ? t(s) : ''; })(),
      heading: t(document.querySelector('.notes-card h2')),
      concentration: t(document.querySelector('.notes-card .sub')),
      notesError: t(document.querySelector('.notes-card .error')),
      description: t(document.querySelector('.desc')),
      tiers: Object.fromEntries([...document.querySelectorAll('.tier')].map((x) => [t(x.querySelector('h3')), [...x.querySelectorAll('.chip')].map((c) => t(c))])),
      badge: !document.querySelector('.badge')?.hidden,
      progress: t(document.querySelector('.prices-card .sub')),
      pricesNote: [...document.querySelectorAll('.prices-card .muted')].map(t).filter(Boolean),
      prices: [...document.querySelectorAll('.price-row')].map((r) => ({
        shop: t(r.querySelector('.price-main a, .price-main, .shop')).split(':')[0],
        text: t(r),
        href: r.querySelector('a')?.href ?? null,
        reason: r.title || '',
      })),
      dupesNote: [...document.querySelectorAll('.dupes-card .muted')].map(t).filter(Boolean),
      dupesError: t(document.querySelector('.dupes-card .error')),
      dupes: [...document.querySelectorAll('.dupe')].map((d) => ({
        name: t(d.querySelector('.dupe-name')),
        sim: t(d.querySelector('.pct')),
        confirmed: !!d.querySelector('.tag.ok'),
        price: t(d.querySelector('.dupe-price')),
        href: d.querySelector('.dupe-price a')?.href ?? null,
      })),
    };
  });

  const geminiCount = {};
  for (const s of traffic.gemini) geminiCount[s] = (geminiCount[s] ?? 0) + 1;
  const result = { url, title, seconds: secs, timedOut, view, geminiStatuses: geminiCount, shopFetchStatuses: { ...traffic.shops } };
  report.push(result);

  console.log(`took ${secs}s${timedOut ? ' (TIMED OUT waiting)' : ''} | Gemini responses: ${JSON.stringify(geminiCount)} | local-model badge: ${view.badge}`);
  if (view.status) console.log(`status: ${view.status}`);
  console.log(`detected: "${view.heading}" ${view.concentration ? `(${view.concentration})` : ''}`);
  console.log(`notes: ${view.notesError || `${JSON.stringify(view.tiers)}\n       "${view.description}"`}`);
  console.log(`prices (${view.progress}):`);
  for (const p of view.prices) console.log(`   - ${p.text.slice(0, 110)}${p.reason ? `\n        why: ${p.reason}` : ''}${p.href ? `\n        ${p.href.slice(0, 100)}` : ''}`);
  for (const n of view.pricesNote) console.log(`   note: ${n}`);
  console.log(`shop fetch statuses: ${JSON.stringify(traffic.shops)}`);
  console.log(`dupes${view.dupesError ? ` ERROR: ${view.dupesError}` : ''}:`);
  for (const d of view.dupes) console.log(`   - ${d.name} | ${d.sim}${d.confirmed ? ' | confirmed' : ''} | ${d.price}`);
  for (const n of view.dupesNote) console.log(`   note: ${n}`);

  await panel.close();
  await page.close();
}

await context.close();
rmSync(userDataDir, { recursive: true, force: true });
writeFileSync(join(ROOT, 'docs', 'acceptance', 'real-run.json'), JSON.stringify({ when: new Date().toISOString(), model: MODEL, rpm: RPM, report }, null, 2));
console.log('\nSaved docs/acceptance/real-run.json (statuses and results only, no key).');
