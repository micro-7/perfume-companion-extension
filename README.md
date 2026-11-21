# Perfume Companion

A personal Chrome extension (Manifest V3). Click the toolbar icon on any perfume page and a side panel shows the perfume's notes in plain English, cheaper dupes, and the best ₹ prices across your own list of shops.

The product summary is [Perfume Companion – Chrome Extension Spec.md](Perfume%20Companion%20–%20Chrome%20Extension%20Spec.md). The detailed requirements are in `openspec/specs/`, and the finished plan (proposal, design, tasks) is in `openspec/changes/archive/2026-11-21-perfume-companion/`.

## Build

```
npm install
npm run build      # typecheck + build into dist/ + secret check
npm test           # unit tests
npm run dev        # rebuild on every change
```

## Load it in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `dist/` folder.
3. After each rebuild, click the reload arrow on the extension's card.

## Set up the AI

The extension uses Gemini first and switches to a local Ollama model when the Gemini free limit runs out, and for any single request that Gemini still fails after waiting and retrying (repeated 503 "high demand" errors, a 45 s timeout, no connection). A rejected API key is shown as an error, not hidden behind the fallback.

**Gemini (main)**
1. Get a free key at <https://aistudio.google.com/apikey>.
2. Open the extension's **Options** page and paste the key. It is stored only in this browser (`chrome.storage.local`); it is never in the code. **Replace key** swaps it; **Remove key** deletes it at once (the extension then uses only the local model).
3. The default model is `gemini-flash-lite-latest` (fast and reliable on a free key). The plain `gemini-flash-latest` was often overloaded, `gemini-3.5-flash` answers but is too slow (requests run past the 45 s limit, so it ends up on the local model anyway), and the older 2.5 models are closed to new keys. If a model starts failing, `node e2e/gemini-models.mjs` shows what your key can use.
4. **Daily limit.** A free key allows only so many requests per model per day, and one lookup makes many (each shop, and each automatically priced dupe, is a request). When the limit is used up, the panel shows **Using local model** until it resets (about once a day).
5. **Web search is optional.** The "via search" fallback for blocked shops and the Fragrantica lookup from non-Fragrantica pages use Gemini's Google Search tool, which some free keys cannot use at all. Without it everything else still works; those two features degrade (a blocked shop shows "Not found (search unavailable)", and dupes come from the AI alone unless you are on a Fragrantica page).

**Ollama (backup)**
1. Install Ollama and pull a model, for example `ollama pull qwen3:8b`.
2. Let the extension talk to Ollama. The Options page shows the exact value for your install, which looks like `chrome-extension://<extension-id>`. Set it as the `OLLAMA_ORIGINS` environment variable and restart Ollama.
   - Windows (PowerShell): `setx OLLAMA_ORIGINS "chrome-extension://<extension-id>"`, then quit Ollama from the tray and start it again.
   - macOS/Linux: `OLLAMA_ORIGINS="chrome-extension://<extension-id>" ollama serve`
3. In Options, press **Test connection**. It lists the installed models; leave the model on **Auto** or choose one.

The extension ID changes if you move the folder you loaded, so update `OLLAMA_ORIGINS` if that happens.

A local model is slower and less exact than Gemini. The extension checks its answers: the perfume must be the one named in the page title or address (not one from a sidebar or ad), a whole shop title is cut down to the perfume's name, and on Fragrantica the address is used if the model keeps getting it wrong. Pick a model that fits your graphics card: on a 4 GB laptop GPU, `qwen3.5:4b` or `qwen3:8b` work; much larger models (e.g. 27b) run mostly on the CPU and are very slow. Don't run a second Ollama server at the same time, as two servers loading models onto a small GPU fail with "HTTP 500".

## Set up your shops

Prices are compared across **your** shop list (about 10 shops), nowhere else.

- **In the browser:** open **Options > Shops**. For each shop give a name and the address of its search page, with `{query}` where the search words go, for example `https://www.nykaa.com/search/result/?q={query}`. To find it, search for anything on the shop and copy the address, then replace your search words with `{query}`. Chrome asks to allow access to that shop's site. If you say no, the shop is kept with a "Search only" label and its prices come from Gemini's web search instead (use **Grant access** later to change your mind).
- **Bundled list:** `src/config/shops.default.json` already holds 12 shops (Perfume Palace, Friday Charm, Perfume Addiction, Perfume Network, AAR Fragrances, Scentira, Splash Fragrance, Belvish, Fragstalk, MOM Perfumes, Amazon.in, Nykaa), with search addresses checked against the live sites. They are loaded the first time the extension runs, never over edits you made later. Seeded shops start as "Search only"; press **Grant access** in Options for each one to let the extension read the shop's pages directly (without it, only web search can price that shop, and web search needs a Gemini key with that feature enabled).
- **Already installed?** The list is only loaded once. To load it into an existing install without losing your key: open `chrome://extensions`, click **Inspect views: service worker** on the extension, and run `chrome.storage.local.remove('seeded')` in its console; then reload the extension. Shops you already have are kept, and new ones are added.

All prices are in rupees (₹).

## Using it

Open a perfume page (Fragrantica, Amazon, Sephora, Nykaa, ...) and click the toolbar icon. Nothing runs, and nothing is sent anywhere, until you click.

The panel shows three cards, each filling in as soon as its data arrives:
- **Notes**: top, heart and base notes with a short plain-English description of the scent.
- **Prices**: your shops, cheapest first, each linking to the product page, with how much you save compared with the site you are on.
- **Dupes**: cheaper alternatives, best first, with a similarity score and their best price. On a Fragrantica page the whole "This perfume reminds me of" carousel is listed (Dior's own versions left out), plus the AI's extra picks, up to 30. The best 4 are priced automatically; the rest show **Check price**, which looks up just that one (pricing means searching every shop, so it is not done for all of them at once). Every dupe taken from Fragrantica's list carries a mark: "✓ Confirmed by Fragrantica" when the AI named it too, otherwise "On Fragrantica's list". A dupe with no mark came from the AI alone. Click a dupe to run the full lookup for it, and use **Back** to return.

On a Fragrantica page the extension may scroll the page down for a moment to load the carousel, then puts it back where you were. If the list still isn't there, the Dupes card says so; scroll to the row yourself and click the icon again.

## If something looks wrong

- **Which build is loaded?** Open the extension's Options and read the line at the bottom ("Version 0.1.0, built <date time>"). After `npm run build`, click the **reload arrow** on `chrome://extensions`. Do not click Remove: that wipes your Gemini key, shops and site access.
- **Old results showing?** Dupe lists and prices are saved under a version, so a new build never reuses what an older build saved. Notes and dupe lists written by the local Ollama model are never saved.
- **"Connection lost"?** Chrome stops the extension's background worker when it is idle. The extension keeps it awake during a lookup and reconnects by itself if it is stopped; after 3 failed tries it shows a **Try again** button.
- **A shop shows no price?** The reason is written under it (blocked page, perfume not listed, price not written in rupees, web search unavailable). If nearly every shop shows no price, check the perfume name at the top of the Notes card: a wrong name means every shop was searched for the wrong thing.
- **"Using local model" although a key is set?** Gemini's free daily limit for that model is probably used up (or Gemini is overloaded). `node e2e/gemini-models.mjs` shows each model's state; a 429 "RESOURCE_EXHAUSTED" answer means wait for the daily reset.

## Tests

```
npm test              # unit tests
npm run e2e           # browser tests of the notes card (needs a test Ollama, see the file header)
npm run e2e:phase23   # browser tests of prices, shops and dupes (fully offline, nothing to set up)
npm run e2e:real      # real Gemini key + your real shops + a real product page (see below)
```

`npm run e2e:real` reads your Gemini key from `e2e/.gemini-key` (one line, git-ignored), runs a full lookup on real shop pages and prints what happened. It uses real Gemini quota (a few dozen requests per fresh lookup), so running it often eats into the free daily limit. `node e2e/gemini-models.mjs` lists the models your key can use and tests each. Findings so far are in [docs/acceptance/real-world.md](docs/acceptance/real-world.md).

The browser tests load the built extension into Playwright's Chromium (`npx playwright install chromium` once). They use a test-only build that exposes the toolbar click, because Playwright cannot click a toolbar icon; the normal `dist/` build does not contain it. Results are written to `docs/acceptance/`.

## Secrets

`npm run build` fails if something that looks like a Google API key is found in `src/`, `public/` or `dist/`.
