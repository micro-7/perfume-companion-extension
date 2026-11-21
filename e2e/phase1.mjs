// Phase 1 end-to-end checks (FR1-FR3) in a real Chromium with the extension loaded.
//
//   npm run e2e
//
// Needs an Ollama that allows extension origins. To avoid changing your normal Ollama setup,
// start a second one just for tests:
//   OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS="chrome-extension://*" ollama serve
// Then: E2E_OLLAMA_URL=http://127.0.0.1:11435 npm run e2e   (that is the default)
//
// Playwright cannot click an extension's toolbar icon, so this uses a test build (--mode e2e)
// that exposes the click handler, and opens the side panel page as a tab.

import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist-e2e');
const SHOTS = join(ROOT, 'docs', 'acceptance', 'screenshots');
const OLLAMA_TEST = process.env.E2E_OLLAMA_URL ?? 'http://127.0.0.1:11435';
const OLLAMA_DEFAULT = 'http://localhost:11434'; // the user's normal Ollama (OLLAMA_ORIGINS not set)
const LLM_TIMEOUT = Number(process.env.E2E_TIMEOUT_MS ?? 240_000);
const ONLY = process.env.E2E_ONLY?.split(',');

const results = [];
function record(id, name, pass, detail = '', skipped = false) {
  results.push({ id, name, pass, skipped, detail });
  const label = skipped ? 'SKIP' : pass ? 'PASS' : 'FAIL';
  console.log(`${label}  ${id}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
const want = (id) => !ONLY || ONLY.includes(id);

// ---------- build ----------
console.log('Building test extension...');
execSync('npx vite build --mode e2e --outDir ../dist-e2e', { cwd: ROOT, stdio: 'ignore' });
const manifestPath = join(DIST, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const shipped = structuredClone(manifest);
// No real click means no activeTab grant, so the test build gets host access and "tabs" instead.
manifest.host_permissions.push('<all_urls>');
manifest.permissions.push('tabs');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---------- fixture server ----------
const server = createServer((req, res) => {
  try {
    const name = (req.url ?? '/').replace(/^\//, '').replace(/[^a-z0-9.-]/gi, '');
    const body = readFileSync(join(ROOT, 'e2e', 'fixtures', name));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- browser ----------
const userDataDir = mkdtempSync(join(tmpdir(), 'pc-e2e-'));
mkdirSync(SHOTS, { recursive: true });

async function launch() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 400, height: 860 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, sw, extId: new URL(sw.url()).host };
}

let { context, sw, extId } = await launch();
const consoleErrors = [];
context.on('weberror', (e) => consoleErrors.push(String(e.error())));

const setSettings = (s) =>
  sw.evaluate(async (s) => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.storage.local.set({ settings: s });
  }, s);
const settings = (over = {}) => ({
  geminiApiKey: '',
  geminiModel: 'gemini-flash-lite-latest',
  geminiRpm: 10,
  ollamaUrl: OLLAMA_TEST,
  ollamaModel: null,
  ...over,
});

async function tabIdOf(page) {
  const url = page.url();
  return sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, url);
}

/** Simulates the toolbar click on `page` and opens that tab's side panel. */
async function clickIcon(page) {
  const tabId = await tabIdOf(page);
  if (tabId == null) throw new Error(`no tab for ${page.url()}`);
  await sw.evaluate(async (tabId) => globalThis.__pcClick(await chrome.tabs.get(tabId)), tabId);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
  return panel;
}

/** Waits until the panel shows a final state. */
async function outcome(panel, timeout = LLM_TIMEOUT) {
  await panel.waitForFunction(
    () => {
      const status = document.querySelector('.status');
      const statusShown = status && !status.hidden && !status.querySelector('.spinner');
      const notesDone = document.querySelector('.notes-body') || document.querySelector('.card .error');
      const lost = status && !status.hidden && /Getting ready/.test(status.textContent);
      return (statusShown && !lost) || notesDone;
    },
    null,
    { timeout, polling: 250 },
  );
  return panel.evaluate(() => ({
    status: (() => {
      const s = document.querySelector('.status');
      return s && !s.hidden ? s.textContent.trim() : '';
    })(),
    heading: document.querySelector('.card h2')?.textContent ?? '',
    sub: document.querySelector('.card .sub')?.textContent ?? '',
    tiers: Object.fromEntries(
      [...document.querySelectorAll('.tier')].map((t) => [
        t.querySelector('h3').textContent,
        [...t.querySelectorAll('.chip')].map((c) => c.textContent),
      ]),
    ),
    description: document.querySelector('.desc')?.textContent ?? '',
    cardError: document.querySelector('.card .error')?.textContent ?? '',
    badge: !document.querySelector('.badge')?.hidden,
    cards: document.querySelectorAll('.card').length,
  }));
}

const sentences = (t) => t.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').trim();

try {
  // ---------- FR1: nothing happens before the click ----------
  if (want('FR1-idle')) {
    const pages = [];
    for (const f of ['fragrantica-sauvage.html', 'amazon-sauvage.html', 'nykaa-bleu.html', 'news-article.html']) {
      const p = await context.newPage();
      await p.goto(`${BASE}/${f}`);
      pages.push(p);
    }
    await new Promise((r) => setTimeout(r, 2000));
    const swRequests = await sw.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
    const panelOpen = context.pages().some((p) => p.url().includes('sidepanel.html'));
    const noContentScripts = !shipped.content_scripts;
    record(
      'FR1-idle',
      'No network requests, no UI and no content scripts before the icon is clicked',
      swRequests.length === 0 && !panelOpen && noContentScripts,
      `service worker requests: ${swRequests.length}, panel open: ${panelOpen}, content_scripts in manifest: ${!noContentScripts}`,
    );
    for (const p of pages) await p.close();
  }

  // ---------- FR1: restricted page ----------
  if (want('FR1-restricted')) {
    await setSettings(settings());
    const p = await context.newPage();
    await p.goto('chrome://version');
    const panel = await clickIcon(p);
    const o = await outcome(panel, 15_000);
    await panel.screenshot({ path: join(SHOTS, 'restricted.png') });
    record('FR1-restricted', 'chrome:// page shows "can\'t be read"', /can't be read/.test(o.status), o.status);
    await panel.close();
    await p.close();
  }

  // ---------- Errors are explained ----------
  if (want('LLM-origin')) {
    await setSettings(settings({ ollamaUrl: OLLAMA_DEFAULT }));
    const p = await context.newPage();
    await p.goto(`${BASE}/amazon-sauvage.html`);
    const panel = await clickIcon(p);
    const o = await outcome(panel, 30_000);
    await panel.screenshot({ path: join(SHOTS, 'error-ollama-origins.png') });
    record(
      'LLM-origin',
      'Ollama 403 tells the user to set OLLAMA_ORIGINS with the exact origin, with Retry',
      o.status.includes('OLLAMA_ORIGINS') && o.status.includes(`chrome-extension://${extId}`) && o.status.includes('Retry'),
      o.status,
    );
    await panel.close();
    await p.close();
  }

  if (want('LLM-badkey')) {
    await setSettings(settings({ geminiApiKey: 'not-a-real-key-e2e-0000' }));
    const p = await context.newPage();
    await p.goto(`${BASE}/amazon-sauvage.html`);
    const panel = await clickIcon(p);
    const o = await outcome(panel, 30_000);
    await panel.screenshot({ path: join(SHOTS, 'error-bad-key.png') });
    record(
      'LLM-badkey',
      'A rejected Gemini key is reported, not hidden behind the Ollama fallback',
      /rejected the API key/.test(o.status) && !o.badge,
      o.status,
    );
    await panel.close();
    await p.close();
  }

  // ---------- FR2 + FR3 on three sites, via the local model ----------
  const cases = [
    { id: 'FR2-fragrantica', file: 'fragrantica-sauvage.html', name: 'Sauvage', brand: 'Dior', expectTiers: true },
    { id: 'FR2-amazon', file: 'amazon-sauvage.html', name: 'Sauvage', brand: 'Dior' },
    { id: 'FR2-nykaa', file: 'nykaa-bleu.html', name: 'Bleu de Chanel', brand: 'Chanel' },
  ];
  for (const c of cases) {
    if (!want(c.id)) continue;
    await setSettings(settings());
    const p = await context.newPage();
    await p.goto(`${BASE}/${c.file}`);
    const started = Date.now();
    const panel = await clickIcon(p);
    let o;
    try {
      o = await outcome(panel);
    } catch (e) {
      record(c.id, `${c.brand} ${c.name} detected`, false, `timed out: ${e.message.split('\n')[0]}`);
      await panel.close();
      await p.close();
      continue;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    await panel.screenshot({ path: join(SHOTS, `${c.id}.png`), fullPage: true });

    const heading = norm(o.heading);
    const nameOk = heading.includes(norm(c.name)) || norm(c.name).includes(heading.split(' ')[0] ?? '#');
    const brandOk = heading.includes(norm(c.brand));
    record(
      c.id,
      `${c.brand} ${c.name}: name and brand detected`,
      nameOk && brandOk,
      `heading "${o.heading}"${o.sub ? ` (${o.sub})` : ''}, ${secs}s${o.status ? `, status: ${o.status}` : ''}`,
    );

    const n = sentences(o.description);
    const tierNames = Object.keys(o.tiers);
    const allNotes = Object.values(o.tiers).flat().map(norm);
    const INCI = ['alcohol', 'aqua', 'water', 'parfum', 'limonene', 'linalool', 'coumarin', 'citral'];
    const noIngredients = !allNotes.some((x) => INCI.some((i) => x === i || x.startsWith(`${i} `)));
    const tiersOk =
      noIngredients &&
      (c.expectTiers ? ['Top', 'Heart', 'Base'].every((t) => tierNames.includes(t)) : tierNames.length > 0);
    record(
      c.id.replace('FR2', 'FR3'),
      `Notes card: ${c.expectTiers ? 'Top/Heart/Base from the page' : 'notes (no ingredient names)'} and a 1-3 sentence description`,
      !o.cardError && n >= 1 && n <= 3 && tiersOk,
      o.cardError ||
        `${n} sentence(s): "${o.description}" | tiers: ${tierNames.map((t) => `${t}=[${o.tiers[t].join(', ')}]`).join(' ')}`,
    );
    if (c.expectTiers) {
      const top = (o.tiers.Top ?? []).map(norm);
      record(
        'FR3-page-notes-first',
        'Notes listed on the page are used as-is (Fragrantica top notes)',
        top.some((t) => t.includes('bergamot')) && top.some((t) => t.includes('pepper')),
        `Top = [${(o.tiers.Top ?? []).join(', ')}]`,
      );
    }
    record(`${c.id}-badge`, '"Using local model" badge shown when Ollama answered', o.badge, '');
    await panel.close();
    await p.close();
  }

  // ---------- FR2: not a perfume ----------
  if (want('FR2-none')) {
    await setSettings(settings());
    const p = await context.newPage();
    await p.goto(`${BASE}/news-article.html`);
    const panel = await clickIcon(p);
    const o = await outcome(panel);
    await panel.screenshot({ path: join(SHOTS, 'no-perfume.png') });
    record(
      'FR2-none',
      'A news article shows "No perfume detected on this page" and no cards',
      o.status.includes('No perfume detected on this page') && o.cards === 0,
      o.status || `heading "${o.heading}"`,
    );
    await panel.close();
    await p.close();
  }

  // ---------- Real site (best effort) ----------
  if (want('FR2-real-fragrantica')) {
    await setSettings(settings());
    const p = await context.newPage();
    let loaded = true;
    try {
      await p.goto('https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html', { timeout: 30_000 });
    } catch {
      loaded = false;
    }
    const title = loaded ? await p.title() : '';
    if (!loaded || /just a moment|attention required|access denied/i.test(title)) {
      record('FR2-real-fragrantica', 'Real fragrantica.com page', true, `site blocked the headless browser ("${title}")`, true);
    } else {
      const panel = await clickIcon(p);
      const o = await outcome(panel).catch(() => null);
      if (o) await panel.screenshot({ path: join(SHOTS, 'real-fragrantica.png'), fullPage: true });
      const h = norm(o?.heading ?? '');
      record('FR2-real-fragrantica', 'Real fragrantica.com: Sauvage by Dior detected', h.includes('sauvage') && h.includes('dior'), `heading "${o?.heading}"`);
      await panel.close();
    }
    await p.close();
  }

  // ---------- FR1: closing the panel mid-lookup ----------
  if (want('FR1-close')) {
    await setSettings(settings());
    const before = consoleErrors.length;
    const p = await context.newPage();
    await p.goto(`${BASE}/nykaa-bleu.html`);
    const panel = await clickIcon(p);
    await panel.waitForSelector('.status .spinner', { timeout: 10_000 });
    await panel.close();
    await new Promise((r) => setTimeout(r, 3000));
    record('FR1-close', 'Closing the panel mid-lookup raises no errors', consoleErrors.length === before, consoleErrors.slice(before).join(' | '));
    await p.close();
  }

  // ---------- Options page + persistence across a browser restart ----------
  if (want('OPT')) {
    await setSettings(settings({ ollamaUrl: OLLAMA_TEST }));
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await opt.fill('#key-input', 'e2e-fake-key-WXYZ');
    await opt.click('#save');
    await opt.waitForSelector('#save-result.ok');
    await opt.reload();
    const mask = await opt.textContent('#key-mask');
    const inputHidden = await opt.locator('#key-entry').isHidden();
    record('OPT-mask', 'Saved key is masked, only the last 4 characters visible', mask.endsWith('WXYZ') && !mask.includes('e2e') && inputHidden, `shown as "${mask}"`);

    await opt.click('#ollama-test');
    await opt.waitForFunction(() => !/Testing/.test(document.querySelector('#ollama-result').textContent));
    const ok = await opt.textContent('#ollama-result');
    const models = await opt.$$eval('#ollama-model option', (os) => os.map((o) => o.textContent));
    await opt.screenshot({ path: join(SHOTS, 'options.png'), fullPage: true });
    record('OPT-test-ok', 'Test connection reports the model count and lists models', /Connected\. \d+ model/.test(ok) && models.length > 1, `${ok} | dropdown: ${models.join(', ')}`);
    record('OPT-auto-local', 'Auto-pick chooses a local model, not the cloud one', /Auto \(picked: (?!.*cloud)/.test(models[0]), models[0]);

    await opt.fill('#ollama-url', OLLAMA_DEFAULT);
    await opt.click('#ollama-test');
    await opt.waitForFunction(() => !/Testing/.test(document.querySelector('#ollama-result').textContent));
    const blocked = await opt.textContent('#ollama-result');
    record('OPT-test-origin', 'Test connection explains a blocked origin', blocked.includes('OLLAMA_ORIGINS') && blocked.includes(extId), blocked);

    await opt.fill('#ollama-url', 'http://127.0.0.1:9');
    await opt.click('#ollama-test');
    await opt.waitForFunction(() => !/Testing/.test(document.querySelector('#ollama-result').textContent));
    const down = await opt.textContent('#ollama-result');
    record('OPT-test-down', 'Test connection explains Ollama not running', /Could not reach Ollama/.test(down), down);
    await opt.close();

    // Restart the browser with the same profile.
    await context.close();
    ({ context, sw, extId } = await launch());
    const kept = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.geminiApiKey);
    record('OPT-persist', 'Settings survive a browser restart', kept === 'e2e-fake-key-WXYZ', `key after restart: ${kept ? 'present' : 'missing'}`);
  }
} finally {
  await context.close().catch(() => undefined);
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
writeFileSync(join(ROOT, 'docs', 'acceptance', 'phase-1-e2e.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed.length ? 1 : 0);
