import type { OllamaModelInfo } from './ollama';

/** Preferred model families, best first. */
export const MODEL_PRIORITY = [
  'qwen3.5',
  'qwen3',
  'gemma3',
  'llama3.3',
  'llama3.1',
  'mistral-small',
  'qwen2.5',
  'llama3.2',
  'mistral',
];

/** Models above this size are too slow on a typical home PC. */
const MAX_PREFERRED_B = 30;

/** "7.6B" -> 7.6, "270M" -> 0.27, anything else -> 0. */
export function parseParamSize(size: string | undefined): number {
  const m = /^([\d.]+)\s*([BMK])$/i.exec((size ?? '').trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'B' ? n : unit === 'M' ? n / 1000 : n / 1_000_000;
}

function family(name: string): string {
  const base = name.split(':')[0].toLowerCase();
  return base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
}

/** Ollama "cloud" models run on ollama.com, not on this PC. */
export function isCloudModel(m: OllamaModelInfo): boolean {
  return !!m.remote_host || /[:-]cloud$/i.test(m.name);
}

/**
 * Picks the best installed local model, or null if there is none.
 * Cloud models are never auto-picked (the user can still choose one in Options).
 */
export function pickOllamaModel(all: OllamaModelInfo[]): string | null {
  const models = all.filter((m) => !isCloudModel(m));
  if (models.length === 0) return null;
  const size = (m: OllamaModelInfo) => parseParamSize(m.details?.parameter_size);

  for (const fam of MODEL_PRIORITY) {
    const inFamily = models.filter((m) => family(m.name) === fam);
    if (inFamily.length === 0) continue;
    const fitting = inFamily.filter((m) => size(m) <= MAX_PREFERRED_B);
    const pool = fitting.length ? fitting : inFamily;
    // Largest that fits; if everything is too big, the smallest one.
    const sorted = [...pool].sort((a, b) => (fitting.length ? size(b) - size(a) : size(a) - size(b)));
    return sorted[0].name;
  }
  return [...models].sort((a, b) => size(b) - size(a))[0].name;
}
