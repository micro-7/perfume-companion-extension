import { describeError, LlmError } from '../llm/errors';
import { ollamaCheckAccess, ollamaTags, type OllamaModelInfo } from '../llm/ollama';
import { pickOllamaModel } from '../llm/pickModel';
import { getSettings, maskKey, normalizeOllamaUrl, saveSettings } from '../shared/settings';
import { initShops } from './shops';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const origin = `chrome-extension://${chrome.runtime.id}`;
let savedKey = '';
let installed: OllamaModelInfo[] = [];

function setResult(node: HTMLElement, text: string, ok: boolean): void {
  node.textContent = text;
  node.className = ok ? 'ok' : 'err';
}

function showKeyState(): void {
  const hasKey = !!savedKey;
  $('key-saved').hidden = !hasKey;
  $('key-entry').hidden = hasKey;
  $('key-mask').textContent = maskKey(savedKey);
}

function fillModelList(selected: string | null): void {
  const select = $<HTMLSelectElement>('ollama-model');
  const auto = pickOllamaModel(installed);
  select.replaceChildren();
  const autoOpt = new Option(auto ? `Auto (picked: ${auto})` : 'Auto (no models found yet)', '');
  select.append(autoOpt);
  for (const m of installed) select.append(new Option(m.name, m.name));
  // Keep a previously chosen model visible even if Ollama is not running right now.
  if (selected && !installed.some((m) => m.name === selected)) select.append(new Option(`${selected} (not found)`, selected));
  select.value = selected ?? '';
  $('ollama-picked').textContent = auto ? `Auto-select would use: ${auto}` : '';
}

async function testOllama(): Promise<void> {
  const result = $('ollama-result');
  setResult(result, 'Testing…', true);
  try {
    const base = { baseUrl: normalizeOllamaUrl($<HTMLInputElement>('ollama-url').value), origin };
    installed = await ollamaTags(base);
    const chosen = $<HTMLSelectElement>('ollama-model').value || null;
    const probe = chosen ?? pickOllamaModel(installed) ?? installed[0]?.name;
    if (probe) await ollamaCheckAccess(base, probe);
    fillModelList(chosen);
    setResult(result, `Connected. ${installed.length} model${installed.length === 1 ? '' : 's'} found.`, true);
  } catch (e) {
    setResult(result, e instanceof LlmError ? describeError(e) : 'Could not connect.', false);
  }
}

async function save(): Promise<void> {
  const typedKey = $<HTMLInputElement>('key-input').value.trim();
  const rpm = Math.max(1, Math.min(60, parseInt($<HTMLInputElement>('gemini-rpm').value, 10) || 10));
  const next = await saveSettings({
    geminiApiKey: typedKey || savedKey,
    geminiModel: $<HTMLInputElement>('gemini-model').value.trim() || 'gemini-flash-lite-latest',
    geminiRpm: rpm,
    ollamaUrl: normalizeOllamaUrl($<HTMLInputElement>('ollama-url').value) || 'http://localhost:11434',
    ollamaModel: $<HTMLSelectElement>('ollama-model').value || null,
  });
  savedKey = next.geminiApiKey;
  $<HTMLInputElement>('key-input').value = '';
  showKeyState();
  setResult($('save-result'), 'Saved.', true);
}

/** Deletes the saved key at once (no Save needed). Without a key the extension uses the local model. */
async function removeKey(): Promise<void> {
  await saveSettings({ geminiApiKey: '' });
  savedKey = '';
  $<HTMLInputElement>('key-input').value = '';
  showKeyState();
  setResult($('save-result'), 'Key removed. Notes, dupes and prices will use the local model until you add a key again.', true);
}

async function init(): Promise<void> {
  $('origin').textContent = origin;
  $('build').textContent = `Version ${chrome.runtime.getManifest().version}, built ${__BUILD_TIME__}`;
  const s = await getSettings();
  savedKey = s.geminiApiKey;
  $<HTMLInputElement>('gemini-model').value = s.geminiModel;
  $<HTMLInputElement>('gemini-rpm').value = String(s.geminiRpm);
  $<HTMLInputElement>('ollama-url').value = s.ollamaUrl;
  showKeyState();
  fillModelList(s.ollamaModel);

  $('key-replace').addEventListener('click', () => {
    $('key-saved').hidden = true;
    $('key-entry').hidden = false;
    $<HTMLInputElement>('key-input').focus();
  });
  $('key-remove').addEventListener('click', () => void removeKey());
  $('ollama-test').addEventListener('click', () => void testOllama());
  $('save').addEventListener('click', () => void save());

  void initShops();

  // Load the installed model list quietly so the dropdown is useful straight away.
  try {
    installed = await ollamaTags({ baseUrl: s.ollamaUrl, origin });
    fillModelList(s.ollamaModel);
  } catch {
    // Ollama may not be running; "Test connection" explains why.
  }
}

void init();
