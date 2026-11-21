import {
  addShop,
  getShops,
  hasDirectAccess,
  originPatterns,
  removeShop,
  setDirectAccess,
  validateShop,
  type Shop,
} from '../shared/shops';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setResult(text: string, ok: boolean): void {
  const node = $('shop-result');
  node.textContent = text;
  node.className = ok ? 'ok' : 'err';
}

/** Asks Chrome for permission to read the shop's pages. Must be called straight from a click. */
async function requestAccess(shop: Pick<Shop, 'searchUrl'>): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: originPatterns(shop.searchUrl) });
  } catch {
    return false;
  }
}

async function render(): Promise<void> {
  const shops = await getShops();
  // Permission can be changed in Chrome's settings, so show the real state.
  const access = await Promise.all(shops.map((s) => hasDirectAccess(s)));
  const list = $('shop-list');
  list.replaceChildren();
  $('shop-empty').hidden = shops.length > 0;

  shops.forEach((shop, i) => {
    const li = document.createElement('li');
    li.className = 'shop-item';

    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = shop.name;
    const url = document.createElement('div');
    url.className = 'hint';
    url.textContent = shop.searchUrl;
    info.append(name, url);
    if (!access[i]) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Search only (no direct access)';
      info.append(tag);
    }

    const actions = document.createElement('div');
    actions.className = 'row';
    if (!access[i]) {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.textContent = 'Grant access';
      grant.addEventListener('click', async () => {
        const ok = await requestAccess(shop);
        await setDirectAccess(shop.id, ok);
        await render();
      });
      actions.append(grant);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await removeShop(shop.id);
      setResult(`Removed ${shop.name}.`, true);
      await render();
    });
    actions.append(remove);

    li.append(info, actions);
    list.append(li);
  });
}

export async function initShops(): Promise<void> {
  $('shop-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = { name: $<HTMLInputElement>('shop-name').value, searchUrl: $<HTMLInputElement>('shop-url').value };
    const error = validateShop(input, await getShops());
    if (error) {
      setResult(error, false);
      return;
    }
    // Ask first: Chrome only shows the permission prompt right after a click.
    const granted = await requestAccess(input);
    await addShop(input, granted);
    $<HTMLInputElement>('shop-name').value = '';
    $<HTMLInputElement>('shop-url').value = '';
    setResult(
      granted
        ? `Added ${input.name.trim()}.`
        : `Added ${input.name.trim()} without direct access. Its prices will come from web search only.`,
      true,
    );
    await render();
  });
  await render();
}
