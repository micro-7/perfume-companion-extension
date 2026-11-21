import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeStorageMock } from '../test/helpers';
import { DEFAULT_SETTINGS, getSettings, maskKey, normalizeOllamaUrl, saveSettings } from './settings';

describe('settings', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });

  it('returns defaults when nothing is saved', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.ollamaUrl).toBe('http://localhost:11434');
    expect(DEFAULT_SETTINGS.geminiRpm).toBe(10);
  });

  it('saves a partial update and keeps the rest', async () => {
    await saveSettings({ geminiApiKey: 'abc123456789' });
    await saveSettings({ ollamaModel: 'qwen3:8b' });
    const s = await getSettings();
    expect(s.geminiApiKey).toBe('abc123456789');
    expect(s.ollamaModel).toBe('qwen3:8b');
    expect(s.geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);
  });

  it('replaces the retired default model that older saves stored, but keeps any other chosen model', async () => {
    await saveSettings({ geminiModel: 'gemini-flash-latest' });
    expect((await getSettings()).geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);
    await saveSettings({ geminiModel: 'gemini-3.5-flash' });
    expect((await getSettings()).geminiModel).toBe('gemini-3.5-flash');
  });

  it('masks a key so only the last 4 characters show', () => {
    const masked = maskKey('secret-key-ABCD');
    expect(masked.endsWith('ABCD')).toBe(true);
    expect(masked).not.toContain('secret');
    expect(maskKey('')).toBe('');
  });

  it('removes trailing slashes from the Ollama address', () => {
    expect(normalizeOllamaUrl(' http://localhost:11434// ')).toBe('http://localhost:11434');
  });
});
