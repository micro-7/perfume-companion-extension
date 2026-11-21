import { describe, expect, it } from 'vitest';
import { parseParamSize, pickOllamaModel } from './pickModel';

const m = (name: string, size?: string) => ({ name, details: size ? { parameter_size: size } : undefined });

describe('pickOllamaModel', () => {
  it('returns null when nothing is installed', () => {
    expect(pickOllamaModel([])).toBeNull();
  });

  it('prefers the higher-priority family', () => {
    expect(pickOllamaModel([m('llama3.2:3b', '3B'), m('qwen3:8b', '8B'), m('mistral:7b', '7B')])).toBe('qwen3:8b');
  });

  it('picks the largest size in a family that is still under 30B', () => {
    const models = [m('qwen3:4b', '4B'), m('qwen3:14b', '14B'), m('qwen3:32b', '32B')];
    expect(pickOllamaModel(models)).toBe('qwen3:14b');
  });

  it('uses the smallest one if every size in the family is too big', () => {
    expect(pickOllamaModel([m('qwen3:72b', '72B'), m('qwen3:32b', '32B')])).toBe('qwen3:32b');
  });

  it('falls back to the largest installed model when no family matches', () => {
    expect(pickOllamaModel([m('phi4:latest', '14B'), m('tinyllama:1b', '1.1B')])).toBe('phi4:latest');
  });

  it('ignores a registry prefix when matching the family', () => {
    expect(pickOllamaModel([m('library/gemma3:12b', '12B'), m('mistral:7b', '7B')])).toBe('library/gemma3:12b');
  });

  it('never auto-picks a cloud model, even when it is the largest', () => {
    const models = [
      { name: 'deepseek-v4.1-flash:cloud', remote_host: 'https://ollama.com', details: { parameter_size: '763B' } },
      m('qwen3.5:4b', '4.2B'),
      m('llama3.2:latest', '3.2B'),
    ];
    expect(pickOllamaModel(models)).toBe('qwen3.5:4b');
    expect(pickOllamaModel([m('big-model-cloud', '500B'), m('phi4:latest', '14B')])).toBe('phi4:latest');
    expect(pickOllamaModel([{ name: 'x:cloud', remote_host: 'https://ollama.com' }])).toBeNull();
  });

  it('parses parameter sizes', () => {
    expect(parseParamSize('7.6B')).toBeCloseTo(7.6);
    expect(parseParamSize('270M')).toBeCloseTo(0.27);
    expect(parseParamSize('lots')).toBe(0);
    expect(parseParamSize(undefined)).toBe(0);
  });
});
