import { describe, expect, it } from 'vitest';
import { BadResponseError } from '../llm/errors';
import {
  optionalNumber,
  optionalString,
  requireBoolean,
  requireObject,
  requireString,
  stringArray,
} from './validate';

describe('validators', () => {
  it('accepts an object and rejects other values', () => {
    expect(requireObject({ a: 1 }, 'x')).toEqual({ a: 1 });
    for (const bad of [null, [], 'str', 3]) expect(() => requireObject(bad, 'x')).toThrow(BadResponseError);
  });

  it('requires a boolean and a string with the right type', () => {
    expect(requireBoolean({ found: true }, 'found')).toBe(true);
    expect(() => requireBoolean({ found: 'yes' }, 'found')).toThrow(BadResponseError);
    expect(requireString({ s: ' hi ' }, 's')).toBe('hi');
    expect(() => requireString({}, 's')).toThrow(BadResponseError);
  });

  it('treats missing optional strings as empty and rejects wrong types', () => {
    expect(optionalString({}, 'a')).toBe('');
    expect(optionalString({ a: null }, 'a')).toBe('');
    expect(() => optionalString({ a: 5 }, 'a')).toThrow(BadResponseError);
  });

  it('reads optional numbers, treating 0 as unknown', () => {
    expect(optionalNumber({ n: 1299 }, 'n')).toBe(1299);
    expect(optionalNumber({ n: 0 }, 'n')).toBeNull();
    expect(optionalNumber({}, 'n')).toBeNull();
    expect(() => optionalNumber({ n: '12' }, 'n')).toThrow(BadResponseError);
  });

  it('cleans string arrays and rejects non-strings', () => {
    expect(stringArray({ a: [' Lemon ', 'Lemon', '', 'Pepper'] }, 'a')).toEqual(['Lemon', 'Pepper']);
    expect(stringArray({}, 'a')).toEqual([]);
    expect(() => stringArray({ a: [1] }, 'a')).toThrow(BadResponseError);
    expect(() => stringArray({ a: 'x' }, 'a')).toThrow(BadResponseError);
  });
});
