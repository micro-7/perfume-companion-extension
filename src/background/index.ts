import { createLlm } from '../llm';
import { PORT_NAME, type ClientMessage } from '../shared/messages';
import { extractPage, finalizePage } from '../shared/page';
import { getSettings } from '../shared/settings';
import { getShops, hasDirectAccess, seedShopsIfNeeded, type ShopInput } from '../shared/shops';
import defaultShops from '../config/shops.default.json';
import { createKeepAlive } from './keepAlive';
import { LookupSession, type PageResult } from './session';

/** Writes the bundled default shop list the first time only (never over the user's edits). */
let seeding: Promise<boolean> | null = null;
function ensureSeeded(): Promise<boolean> {
  seeding ??= seedShopsIfNeeded(defaultShops as ShopInput[]);
  return seeding;
}
chrome.runtime.onInstalled.addListener(() => void ensureSeeded());

// This worker only registers listeners. Nothing runs, and no page is read,
// until the user clicks the toolbar icon (FR1).

const COOLDOWN_KEY = 'geminiCooldownUntil';
const GROUNDING_COOLDOWN_KEY = 'geminiGroundingCooldownUntil';

const llm = createLlm({
  getSettings,
  getCooldownUntil: async () => {
    const r = await chrome.storage.session.get(COOLDOWN_KEY);
    return (r[COOLDOWN_KEY] as number | undefined) ?? 0;
  },
  setCooldownUntil: (t) => chrome.storage.session.set({ [COOLDOWN_KEY]: t }),
  getGroundingCooldownUntil: async () => {
    const r = await chrome.storage.session.get(GROUNDING_COOLDOWN_KEY);
    return (r[GROUNDING_COOLDOWN_KEY] as number | undefined) ?? 0;
  },
  setGroundingCooldownUntil: (t) => chrome.storage.session.set({ [GROUNDING_COOLDOWN_KEY]: t }),
  origin: `chrome-extension://${chrome.runtime.id}`,
});

/** Sessions of panels that are already connected, by tab. */
const sessions = new Map<number, LookupSession>();
/** Page captures waiting for the panel to connect after a click. */
const pending = new Map<number, Promise<PageResult>>();

async function capturePage(tab: chrome.tabs.Tab): Promise<PageResult> {
  // Only ordinary web pages can be read; this also skips chrome:// pages and the Web Store.
  if (tab.id == null || !tab.url || !/^https?:/i.test(tab.url)) return { ok: false };
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    if (!injection?.result) return { ok: false };
    return { ok: true, page: finalizePage(injection.result) };
  } catch {
    return { ok: false };
  }
}

function handleActionClick(tab: chrome.tabs.Tab): void {
  if (tab.id == null) return;
  const tabId = tab.id;

  // Opening the panel must happen inside the click, so these two calls are not awaited.
  chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true }).catch(() => undefined);
  chrome.sidePanel.open({ tabId }).catch(() => undefined);

  const page = capturePage(tab);
  const session = sessions.get(tabId);
  if (session) void session.start(page);
  else pending.set(tabId, page);
}

chrome.action.onClicked.addListener(handleActionClick);

// End-to-end tests cannot click the toolbar icon, so the test build exposes the handler.
// This branch is removed from the normal build.
if (import.meta.env.MODE === 'e2e') {
  (globalThis as unknown as { __pcClick: typeof handleActionClick }).__pcClick = handleActionClick;
}

// Chrome stops an extension's background worker after about 30 seconds without activity, and a
// lookup can wait longer than that. While any lookup runs, an extension API call every 20 seconds
// counts as activity and keeps the worker (and the lookup) alive. See keepAlive.ts.
const keepAlive = createKeepAlive(() => void chrome.runtime.getPlatformInfo().catch(() => undefined));
const setBusy = keepAlive.setBusy;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let session: LookupSession | null = null;
  let tabId: number | null = null;

  port.onMessage.addListener((msg: ClientMessage) => {
    if (msg.type === 'ready') {
      tabId = msg.tabId;
      session = new LookupSession({
        onBusy: setBusy,
        generate: llm.generate,
        getShops: async () => {
          await ensureSeeded();
          return getShops();
        },
        hasAccess: hasDirectAccess,
        send: (m) => {
          try {
            port.postMessage(m);
          } catch {
            // the panel closed; the disconnect handler cancels the lookup
          }
        },
      });
      sessions.set(tabId, session);
      const page = pending.get(tabId);
      if (page) {
        pending.delete(tabId);
        void session.start(page);
      } else if (msg.resume) {
        // The panel reconnected after the worker was stopped. Everything already found is cached,
        // so running the lookup again for this tab is quick.
        const resumed = session;
        void chrome.tabs
          .get(msg.tabId)
          .then((tab) => resumed.start(capturePage(tab)))
          .catch(() => undefined);
      }
    } else if (msg.type === 'retry') {
      void session?.retry();
    } else if (msg.type === 'retry:notes') {
      void session?.retryNotes();
    } else if (msg.type === 'retry:dupes') {
      void session?.retryDupes();
    } else if (msg.type === 'dupe:price') {
      void session?.priceDupe(msg.dupe);
    } else if (msg.type === 'lookup') {
      void session?.explore(msg.perfume);
    } else if (msg.type === 'cancel') {
      session?.cancel();
    }
  });

  port.onDisconnect.addListener(() => {
    session?.cancel();
    if (tabId != null && sessions.get(tabId) === session) sessions.delete(tabId);
  });
});
