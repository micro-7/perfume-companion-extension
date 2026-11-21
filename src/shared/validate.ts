import { BadResponseError } from '../llm/errors';

export type JsonSchema = Record<string, unknown>;

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function requireObject(x: unknown, what: string): Record<string, unknown> {
  if (!isObject(x)) throw new BadResponseError(`${what}: expected a JSON object`);
  return x;
}

export function requireBoolean(o: Record<string, unknown>, key: string): boolean {
  if (typeof o[key] !== 'boolean') throw new BadResponseError(`"${key}" must be a boolean`);
  return o[key] as boolean;
}

export function requireString(o: Record<string, unknown>, key: string): string {
  if (typeof o[key] !== 'string') throw new BadResponseError(`"${key}" must be a string`);
  return (o[key] as string).trim();
}

/** Optional string: missing/null becomes "". A wrong type is an error. */
export function optionalString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new BadResponseError(`"${key}" must be a string`);
  return v.trim();
}

/** Optional number: missing/null/0 becomes null. A wrong type is an error. */
export function optionalNumber(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadResponseError(`"${key}" must be a number`);
  return v > 0 ? v : null;
}

/** Optional string array: missing/null becomes []. Trims and de-duplicates. */
export function stringArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new BadResponseError(`"${key}" must be an array of strings`);
  }
  return [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
}
