export interface Settings {
  geminiApiKey: string;
  geminiModel: string;
  /** Max Gemini requests per minute (kept under the free-tier limit). */
  geminiRpm: number;
  ollamaUrl: string;
  /** null = pick the best installed model automatically. */
  ollamaModel: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  geminiApiKey: '',
  // Fast, reliable alias. (The plain Flash alias was overloaded and often answered 503 on a free key.)
  geminiModel: 'gemini-flash-lite-latest',
  geminiRpm: 10,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: null,
};

const KEY = 'settings';

/**
 * The first default model. It was overloaded (HTTP 503 for over a minute) on a free key, and
 * saving the options page stored it as if it were a choice, so it is swapped for the current default.
 */
const RETIRED_DEFAULT_MODEL = 'gemini-flash-latest';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const settings = { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings> | undefined) ?? {}) };
  if (settings.geminiModel === RETIRED_DEFAULT_MODEL) settings.geminiModel = DEFAULT_SETTINGS.geminiModel;
  return settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Shows only the last 4 characters of a saved key. */
export function maskKey(key: string): string {
  if (!key) return '';
  const tail = key.slice(-4);
  return '•'.repeat(Math.max(4, Math.min(key.length - 4, 12))) + tail;
}

export function normalizeOllamaUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
