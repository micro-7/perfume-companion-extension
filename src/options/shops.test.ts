// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeStorageMock } from '../test/helpers';
import { getShops } from '../shared/shops';
import { initShops } from './shops';

const PAGE = `
  <ul id="shop-list"></ul><p id="shop-empty" hidden></p>
  <form id="shop-form">
    <input id="shop-name" /><input id="shop-url" />
    <button type="submit" id="shop-add"></button><span id="shop-result"></span>
  </form>`;

let granted = true;
let contains = true;
const request = vi.fn(async () => granted);

beforeEach(async () => {
  installChromeStorageMock();
  (globalThis as unknown as { chrome: { permissions: unknown } }).chrome.permissions = {
    request,
    contains: vi.fn(async () => contains),
  };
  granted = true;
  contains = true;
  request.mockClear();
  document.body.innerHTML = PAGE;
  await initShops();
});

const input = (id: string, v: string) => ((document.getElementById(id) as HTMLInputElement).value = v);
const result = () => document.getElementById('shop-result')!;
const items = () => Array.from(document.querySelectorAll('.shop-item'));
const submit = async () => {
  document.getElementById('shop-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
};
const add = async (name: string, url: string) => {
  input('shop-name', name);
  input('shop-url', url);
  await submit();
};

describe('options: shop list', () => {
  it('shows "No shops yet" for an empty list', () => {
    expect(document.getElementById('shop-empty')!.hidden).toBe(false);
    expect(items()).toHaveLength(0);
  });

  it('adds a valid shop, asks Chrome for access to its site, and saves it with direct access', async () => {
    await add('Perfume Palace', 'https://perfumepalace.in/search?q={query}');
    expect(request).toHaveBeenCalledWith({ origins: ['https://*.perfumepalace.in/*'] });
    expect(items()).toHaveLength(1);
    expect(items()[0].textContent).toContain('Perfume Palace');
    expect(result().className).toBe('ok');
    expect((await getShops())[0].directAccess).toBe(true);
    expect((document.getElementById('shop-name') as HTMLInputElement).value).toBe(''); // form is cleared
  });

  it('when access is denied the shop is still saved, labelled "search only", with a Grant access button', async () => {
    granted = false;
    contains = false;
    await add('Perfume Palace', 'https://perfumepalace.in/search?q={query}');
    expect((await getShops())[0].directAccess).toBe(false);
    expect(result().textContent).toContain('web search only');
    expect(items()[0].textContent).toContain('Search only');
    expect(Array.from(items()[0].querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Grant access', 'Remove']);
  });

  it('Grant access asks again and updates the shop when allowed', async () => {
    granted = false;
    contains = false;
    await add('Perfume Palace', 'https://perfumepalace.in/search?q={query}');
    granted = true;
    contains = true;
    items()[0].querySelector<HTMLButtonElement>('button')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect((await getShops())[0].directAccess).toBe(true);
    expect(items()[0].textContent).not.toContain('Search only');
  });

  it.each([
    ['no name', '', 'https://shop.in/s?q={query}', /name/i],
    ['no {query}', 'Shop', 'https://shop.in/search', /\{query\}/],
    ['not https', 'Shop', 'http://shop.in/s?q={query}', /https/],
    ['not an address', 'Shop', 'shop.in', /https/],
  ])('rejects %s with an inline error and saves nothing', async (_n, name, url, message) => {
    await add(name, url);
    expect(result().textContent).toMatch(message);
    expect(result().className).toBe('err');
    expect(await getShops()).toEqual([]);
    expect(request).not.toHaveBeenCalled(); // no permission prompt for an invalid shop
  });

  it('rejects a second shop on the same domain', async () => {
    await add('Nykaa', 'https://www.nykaa.com/search?q={query}');
    await add('Nykaa again', 'https://nykaa.com/s?q={query}');
    expect(result().textContent).toMatch(/already/);
    expect(items()).toHaveLength(1);
  });

  it('removes a shop', async () => {
    await add('Nykaa', 'https://www.nykaa.com/search?q={query}');
    await add('Palace', 'https://perfumepalace.in/s?q={query}');
    const removeButtons = items()[0].querySelectorAll('button');
    removeButtons[removeButtons.length - 1].click();
    await new Promise((r) => setTimeout(r, 20));
    expect((await getShops()).map((s) => s.name)).toEqual(['Palace']);
    expect(items()).toHaveLength(1);
  });
});
