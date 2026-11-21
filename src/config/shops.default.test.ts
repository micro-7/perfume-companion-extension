import { describe, expect, it } from 'vitest';
import { makeShop, validateShop, type Shop } from '../shared/shops';
import defaults from './shops.default.json';

describe('bundled default shop list', () => {
  it('every shop is valid, with no duplicate domains', () => {
    const accepted: Shop[] = [];
    for (const d of defaults) {
      expect(validateShop(d, accepted), d.name).toBeNull();
      accepted.push(makeShop(d, false));
    }
    expect(accepted).toHaveLength(defaults.length);
  });

  it('every search address is https and has the {query} placeholder', () => {
    for (const d of defaults) {
      expect(d.searchUrl.startsWith('https://'), d.name).toBe(true);
      expect(d.searchUrl.split('{query}'), d.name).toHaveLength(2);
    }
  });
});
