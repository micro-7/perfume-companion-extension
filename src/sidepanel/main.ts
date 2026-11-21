import { PORT_NAME, type ClientMessage, type ServerMessage } from '../shared/messages';
import { PanelView } from './panel';

const root = document.getElementById('app')!;
let port: chrome.runtime.Port | null = null;
let tabId: number | null = null;
/** Automatic reconnects since the last finished lookup. */
let attempts = 0;
const MAX_AUTO_RECONNECTS = 3;

/**
 * Sends to the worker. If the connection is gone (Chrome stopped the idle worker), reconnect.
 * A click on a dupe or "Check price" is sent on the new connection as it is: asking the worker to
 * "resume" would run the page lookup again and the click would be lost. Other messages reconnect
 * with `resume`, which runs the whole lookup again from cache.
 */
function post(msg: ClientMessage): void {
  if (port) {
    port.postMessage(msg);
    return;
  }
  const direct = msg.type === 'lookup' || msg.type === 'dupe:price';
  void connect(!direct, direct ? msg : undefined);
}

const view = new PanelView(root, {
  retry: () => post({ type: 'retry' }),
  retryNotes: () => post({ type: 'retry:notes' }),
  retryDupes: () => post({ type: 'retry:dupes' }),
  lookup: (perfume) => post({ type: 'lookup', perfume }),
  cancel: () => port?.postMessage({ type: 'cancel' }),
  checkDupePrice: (d) => post({ type: 'dupe:price', dupe: { key: d.key, name: d.name, brand: d.brand } }),
  openOptions: () => void chrome.runtime.openOptionsPage(),
});

view.showMessage('Getting ready…');

function onLost(): void {
  port = null;
  if (!view.inProgress()) return; // nothing was running; the results on screen are complete
  if (attempts < MAX_AUTO_RECONNECTS) {
    attempts++;
    view.showReconnecting();
    setTimeout(() => void connect(true), 700 * attempts);
  } else {
    view.showConnectionLost(() => {
      attempts = 0;
      void connect(true);
    });
  }
}

/**
 * Connects to the background worker. Chrome stops that worker when it has been idle for a while,
 * which closes this connection; `resume` asks the new worker to run the lookup for this tab again.
 */
async function connect(resume = false, thenSend?: ClientMessage): Promise<void> {
  // The panel was opened for one tab; that tab is the active tab of this window.
  // The e2e build opens the panel as a normal tab, so it passes the tab id in the URL.
  const testTabId =
    import.meta.env.MODE === 'e2e' ? Number(new URLSearchParams(location.search).get('tabId')) || null : null;
  tabId ??= testTabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  if (tabId == null) {
    view.showMessage("Couldn't find the current tab. Click the toolbar icon again.");
    return;
  }
  const p = chrome.runtime.connect({ name: PORT_NAME });
  port = p;
  p.onMessage.addListener((msg: ServerMessage) => {
    view.handle(msg);
    if (!view.inProgress()) attempts = 0; // a lookup finished: later failures start counting afresh
  });
  p.onDisconnect.addListener(() => {
    if (port === p) onLost();
  });
  p.postMessage({ type: 'ready', tabId, resume } satisfies ClientMessage);
  if (thenSend) p.postMessage(thenSend);
}

void connect();
