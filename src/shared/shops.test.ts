import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeStorageMock } from '../test/helpers';
import {
  addShop,
  getShops,
  originPatterns,
  removeShop,
  seedShopsIfNeeded,
  setDirectAccess,
  validateShop,
  type Shop,
} from './shops';

const palace = { name: 'Perfume Palace', searchUrl: 'https://perfumepalace.in/search?q={query}' };

describe('validateShop', () => {
  const existing: Shop[] = [
    { id: 'nykaa.com', name: 'Nykaa', searchUrl: 'https://www.nykaa.com/search?q={query}', domain: 'nykaa.com', directAccess: true },
  ];

  it('accepts a valid shop', () => {
    expect(validateShop(palace, existing)).toBeNull();
  });

  it('requires a name', () => {
    expect(validateShop({ ...palace, name: '  ' }, existing)).toMatch(/name/);
  });

  it('requires a full https address', () => {
    expect(validateShop({ ...palace, searchUrl: 'perfumepalace.in/search?q={query}' }, existing)).toMatch(/https/);
    expect(validateShop({ ...palace, searchUrl: 'http://perfumepalace.in/search?q={query}' }, existing)).toMatch(/https/);
  });

  it('requires the {query} placeholder', () => {
    expect(validateShop({ ...palace, searchUrl: 'https://perfumepalace.in/search' }, existing)).toMatch(/\{query\}/);
  });

  it('rejects a domain that is already in the list, with or without www', () => {
    expect(validateShop({ name: 'Nykaa 2', searchUrl: 'https://nykaa.com/s?q={query}' }, existing)).toMatch(/already/);
  });
});

describe('shop store', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });

  it('adds, updates and removes shops in storage', async () => {
    await addShop(palace, true);
    await addShop({ name: 'Nykaa', searchUrl: 'https://www.nykaa.com/search/result/?q={query}' }, false);
    expect((await getShops()).map((s) => s.domain)).toEqual(['perfumepalace.in', 'nykaa.com']);

    await setDirectAccess('nykaa.com', true);
    expect((await getShops())[1].directAccess).toBe(true);

    await removeShop('perfumepalace.in');
    expect((await getShops()).map((s) => s.name)).toEqual(['Nykaa']);
  });

  it('refuses to add an invalid shop', async () => {
    await expect(addShop({ name: 'X', searchUrl: 'https://x.in/' }, true)).rejects.toThrow(/\{query\}/);
    expect(await getShops()).toEqual([]);
  });

  it('seeds the default shops on the first run only, without direct access', async () => {
    expect(await seedShopsIfNeeded([palace])).toBe(true);
    const seeded = await getShops();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].directAccess).toBe(false);

    await removeShop('perfumepalace.in');
    expect(await seedShopsIfNeeded([palace])).toBe(false);
    expect(await getShops()).toEqual([]);
  });

  it('when seeding runs again on an existing list, it adds only the new shops and keeps the rest', async () => {
    // the user already has two shops (one of them also in the defaults file), then clears the "seeded" flag
    await addShop({ name: 'My Own Shop', searchUrl: 'https://myshop.in/s?q={query}' }, true);
    await addShop(palace, true);
    await chrome.storage.local.remove('seeded');

    const nykaa = { name: 'Nykaa', searchUrl: 'https://www.nykaa.com/search/result/?q={query}' };
    expect(await seedShopsIfNeeded([palace, nykaa])).toBe(true);

    const shops = await getShops();
    expect(shops.map((s) => s.domain)).toEqual(['myshop.in', 'perfumepalace.in', 'nykaa.com']);
    expect(shops[1].directAccess).toBe(true); // an existing shop is untouched, not reset to "search only"
    expect(shops[2].directAccess).toBe(false); // the new one starts as "search only"
  });

  it('skips invalid entries in the defaults file', async () => {
    await seedShopsIfNeeded([palace, { name: '', searchUrl: 'nope' }]);
    expect(await getShops()).toHaveLength(1);
  });
});

describe('originPatterns', () => {
  it('uses one pattern that covers the host with and without www', () => {
    expect(originPatterns('https://www.nykaa.com/search?q={query}')).toEqual(['https://*.nykaa.com/*']);
    expect(originPatterns('https://perfumepalace.in/s?q={query}')).toEqual(['https://*.perfumepalace.in/*']);
  });
});
