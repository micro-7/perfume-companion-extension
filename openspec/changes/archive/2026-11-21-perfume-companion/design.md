# Design

## Context

This is a new project. The repository holds only the product spec (`Perfume Companion – Chrome Extension Spec.md`), and the OpenSpec scaffolding. See proposal.md for the motivation and specs/ for the behaviour requirements.

Constraints that shape the design:
- **Chrome Manifest V3.** The background is a service worker: it has no DOM and no `DOMParser`, and it can be stopped after about 30 seconds of inactivity. Side panels use the `chrome.sidePanel` API (Chrome 114+, and `sidePanel.open()` needs Chrome 116+).
- **Gemini free tier.** Requests per minute and per day are limited, and a single lookup can make many LLM calls. The Ollama fallback exists because of this limit.
- **Personal use first, but publishable.** There are no secrets in the code and permissions are kept to a minimum.
- **All prices are in ₹.**

## Goals / Non-Goals

**Goals:**
- Each phase (core panel → prices → dupes) can be built and tested on its own.
- Keep the LLM calls per lookup low enough to stay inside the free-tier limits most of the time.
- Keep the pure logic (merging, ranking, sorting, savings, validation, fallback rules) separate from Chrome APIs so it can be unit-tested.

**Non-Goals:**
- No UI framework. The UI is three cards and a form, so plain TypeScript and DOM code is enough.
- No headless or hidden-tab rendering of shop pages. Pages built by JavaScript fall back to grounded search instead.
- No Chrome Web Store packaging, listing or privacy policy in this change.

## Decisions

### D1. Toolchain: TypeScript, Vite, Vitest
TypeScript with a multi-entry Vite build that outputs `dist/` (background, side panel, options). The extension is loaded unpacked from `dist/`. Vitest runs unit tests on the pure modules.
- *Alternative considered:* plain JS with no build. It is simpler, but it gives up type safety on the LLM response shapes and makes sharing modules across entry points clumsy.
- *Alternative considered:* the CRXJS Vite plugin. It adds a dependency for convenience features (hot reload) that this project does not need.

### D2. Activation is only through `action.onClicked`, with a per-tab panel
The manifest declares **no `content_scripts`** and uses `activeTab` and `scripting` (FR1, so nothing runs before the click). The global side panel is disabled. On `chrome.action.onClicked`, the service worker:
1. calls `chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true })` and `chrome.sidePanel.open({ tabId })` straight away, because opening must happen inside the user gesture;
2. runs the page-text extractor with `chrome.scripting.executeScript({ target: { tabId }, func: extractPage })`. This works because `activeTab` was granted by the click;
3. if injection throws (on `chrome://` pages, the Web Store or the PDF viewer), sends a "page cannot be read" message to the panel.

`setPanelBehavior({ openPanelOnActionClick: true })` is not used, because then `onClicked` never fires and `activeTab` cannot be used to inject the script.

### D3. Page extraction is generic, not site-specific
`extractPage()` runs in the page and returns `{ url, title, text, jsonLd, meta }`; it must be self-contained, so the service worker does the trimming afterwards (`finalizePage`):
- `text` is `document.body.innerText` (capped at 200,000 characters in the page). The worker collapses whitespace and cuts it to about 15,000 characters, keeping the start (80%) and the end (20%);
- `jsonLd` is the parsed `<script type="application/ld+json">` blocks of type `Product`;
- `meta` holds the `og:title`, `og:site_name`, `product:price:amount` and `product:price:currency` tags.

These are standard web formats, not site layouts, so FR2's "no site-specific layouts" still holds. They make name and price detection much more reliable on retail sites.

### D4. The service worker orchestrates, and the panel connects through a Port
In line with the spec's technical notes, the service worker makes all network calls. The side panel opens a `chrome.runtime.connect({ name: 'lookup' })` Port, and the worker streams typed messages over it:
`detect:start | detect:done | detect:none | detect:error | notes:done | notes:error | dupes:list | dupes:price | prices:row | prices:progress | prices:done | provider:fallback`.

- The open Port and its regular messages keep the worker alive during a lookup.
- Each lookup has an `AbortController`. When the Port disconnects (the panel closes) or a new lookup starts, all its fetches are aborted (FR1, closing mid-lookup).
- A dupe click (FR4) sends `{ type: 'lookup', perfume: { name, brand } }` over the same Port, which skips detection.
- The panel keeps a history stack of finished results, so Back redraws from memory without a new lookup.

*Alternative considered:* running the orchestration in the side panel page. It has a DOM and its lifetime naturally matches the panel. It was rejected to keep to the spec's "service worker for API calls" note. If worker lifetime causes trouble, this is the fallback plan.

### D5. LLM provider layer with automatic fallback
One interface is used by every feature:
```ts
interface LlmRequest { task: string; system: string; prompt: string; schema: JsonSchema; grounding?: { site?: string } }
llm.generate<T>(req): Promise<{ data: T; provider: 'gemini' | 'ollama' }>
```
- **Gemini:** a REST `POST …/v1beta/models/{model}:generateContent?key=…` request with `generationConfig.responseMimeType = 'application/json'` and `responseSchema`. The model is set in options; the default is the current free-tier Flash model. For grounded requests the request sends `tools: [{ google_search: {} }]` and leaves out the response schema, because grounding and the response schema cannot always be combined. The prompt instead asks for a fenced JSON block, which is parsed from the text, and the grounding sources are kept.
- **Ollama:** `POST {ollamaUrl}/api/chat` with `stream: false` and `format: <json schema>`.
- **Fallback rule:** on HTTP 429 or a `RESOURCE_EXHAUSTED` status from Gemini, the provider reads `RetryInfo.retryDelay` (60 seconds if it is missing) and saves `geminiCooldownUntil` in `chrome.storage.session`, so the value survives worker restarts. It then retries the same request on Ollama. While the cooldown lasts, new requests go straight to Ollama. Other Gemini errors (400, 401 or 403 for a bad key, 5xx) are **not** quota errors. They are shown as errors, with one retry for 5xx, so a bad key is never hidden behind the fallback. The first time a request falls back, the panel receives a `provider:fallback` message and shows the "Using local model" indicator.
- **Busy or unreachable Gemini falls back too.** A Gemini 5xx is retried twice after waiting (2 s, then 6 s), because retrying at once does not help a busy model. If it still fails (or the 45 s timeout passes, or there is no connection), that one request is answered by Ollama. No cooldown is started for this, so a single busy moment does not move every later request to the slower local model. A rejected key (401/403) and an unreadable answer are not hidden behind the fallback.
- **Grounding is Gemini-only and has its own switch.** A grounded request fails fast with `SearchUnavailable` while Gemini is in cooldown, and also while web search alone has been refused. A 429 on a grounded request switches off only web search (for the retry time Gemini gave, else 30 minutes); it never starts the global cooldown, because on some free keys web search has no quota while ordinary answers work.
- **Default model:** `gemini-flash-lite-latest`. The plain `gemini-flash-latest` answered HTTP 503 for over a minute on a free key, and the older 2.5 models are closed to new keys.
- **Validation:** each response is checked with a small hand-written validator for its schema. An invalid response is retried once, then an error is reported (llm-provider spec).
- **Rate limiting:** a sliding-window queue in front of Gemini (at most 10 request starts in any 60 seconds by default, configurable) spaces out requests so a lookup does not hit 429 straight away. The concurrency limit is 4.

### D6. Choosing the Ollama model
`GET {ollamaUrl}/api/tags` lists the installed models. If the user has not picked one, the extension takes the first installed match from this priority list: `qwen3`, `gemma3`, `llama3.3`, `llama3.1`, `mistral-small`, `qwen2.5`, `llama3.2`, `mistral`. Within a family it prefers the largest `details.parameter_size` that is under 30B, because bigger models are too slow on a home PC. Otherwise it takes the largest installed model. The chosen model is shown on the options page. The extension origin `chrome-extension://<id>` must be listed in `OLLAMA_ORIGINS`. The options page shows the exact value to set using `chrome.runtime.id`.

### D7. Price lookup pipeline (FR5)
For each shop and each perfume:
1. **Build the query:** `"{brand} {name} {concentration?}"`, URL-encoded into the shop's `searchUrl` in place of `{query}`.
2. **Fetch directly** from the service worker (`credentials: 'include'`, 10 s timeout), only if the shop's origin permission is granted.
3. **Reduce the HTML** with regex and a tokenizer, because the worker has no DOM. This removes `script`, `style`, `svg` and `noscript`, keeps JSON-LD, and keeps text plus `<a href>` pairs, all cut to about 8,000 characters. A result is **"unusable"** if the status is not 2xx, a bot-check marker is found (`captcha`, `cf-chl`, `Access Denied`), or the reduced text is under 300 characters.
4. **Extract with the LLM:** it returns `{ found, productTitle, priceInr, url, inStock, variant, exactMatch }`. Relative URLs are resolved against the shop's origin, and a result is rejected if `url` is not on the shop's domain.
5. **Fallback:** if the page is unusable or permission was denied, a grounded Gemini request limited to the shop's domain asks for the price and product URL. The row is marked `viaSearch`.
6. Each finished row is sent to the panel as `prices:row`. The panel keeps the list sorted with a pure `sortRows()` (found rows by price ascending, then rows that were not found). Savings come from a pure `savings(currentPrice, rowPrice)`. Prices are formatted with `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })`.
7. **Current-site baseline:** the detected price, from JSON-LD or meta tags first and the LLM second. If the current URL's domain matches a configured shop, that row is marked "You are here", and the savings text names the baseline after that shop's configured name (for example "compared with Amazon") instead of the site name the model read from the page.

### D8. Dupe pipeline (FR4)
Two sources run in parallel:
- **LLM:** asked for up to 8 dupes as `{ name, brand, similarity: 0–100, reason }`, excluding the original perfume and its flankers.
- **Fragrantica:** if the current page is on Fragrantica, the page's own text is used: the whole page text (`fullText`, up to 150,000 characters), not the cut-down copy sent for detection. The text is checked for the heading "This perfume reminds me of" first; if it is missing the LLM is not asked at all (see "Fragrantica list" below). Otherwise a grounded request limited to `fragrantica.com` finds the perfume's page URL, which is fetched directly. The section is extracted by the LLM as an ordered list of up to 30 entries (`FRAGRANTICA_DEPTH`). If the fetch is blocked, the grounded answer itself supplies the list.

**Merging** uses a pure `normalizeKey(brand, name)`: lowercase, accents removed, "by X" and concentration words (EDT, EDP, parfum, extrait, intense only when it is a suffix) removed, punctuation stripped. Two entries merge when their brands match and the token-set similarity of their names is at least 0.85. Before comparing, clearly redundant masculine tags are removed from names: "man" and "men" anywhere, and the phrases "pour homme", "for him/men/man" and "pour lui" (so "Club de Nuit Urban Man Elixir" equals "Club De Nuit Urban Elixir"). A bare "Homme" stays (L'Homme Idéal is not L'Idéal) and feminine tags stay ("... Woman" is not "... Man").

**Ranking:** an entry on Fragrantica's list scores `base + 15 + max(0, 10 − position)`, plus `10` more when the AI named it too, so a confirmed dupe beats a single-source one. `base` is the AI's similarity, or for a Fragrantica-only entry `max(40, 80 − 2×position)` (an estimate: Fragrantica publishes no score, its list is ordered by votes). Flankers (same brand, name contains the original's name) are removed. Each dupe records `confirmed` (both sources) and `onFragrantica` (on the list at all); the card shows "Confirmed by Fragrantica" or "On Fragrantica's list". Up to 30 dupes are shown (`MAX_DUPES`), so the whole carousel (about 20–25 perfumes) is represented; if fewer than 2 remain the "few or no reliable dupes" message is shown.

**Dupe prices** use the D7 pipeline, but **in batch mode**: the reduced pages from all shops for one dupe go into a single LLM extraction call that returns one row per shop. Only the cheapest row is shown on the dupe card. Pricing one dupe still means one search page per shop, so only the best-ranked `AUTO_PRICED_DUPES` (8) are priced automatically; the others show a "Check price" button that sends `dupe:price` to the worker and prices that one dupe (using the lookup's context, without cancelling anything). A lookup counts as finished when the automatically priced dupes, and any the user asked for, have their prices.

**Savings while exploring a dupe** (no current-site price) are worked out against the highest shop price found (dupe-suggestions spec).

**Names:** a dupe's name is cleaned for display and for the lookup: a leading brand ("Armaf Club de Nuit") and a trailing "by Brand" are removed, but a brand inside the name ("Bleu de Chanel") is kept. For the same reason `normalizeName` only strips a *leading* brand.

**Explore and Back:** the side panel keeps the history (a stack of finished results). Clicking a dupe sends `lookup` over the Port and the worker runs the cards for that perfume with no page. Back redraws a finished result from memory with no requests. If the earlier lookup had not finished when the dupe was clicked, Back runs it again and keeps its current-site price for the savings text.

### D9. Storage layout
`chrome.storage.local` holds:
- `settings: { geminiApiKey, geminiModel, geminiRpm, ollamaUrl, ollamaModel | null }`;
- `shops: Array<{ id, name, searchUrl, domain, directAccess: boolean }>`;
- `seeded: true`;
- `cache:<kind>:<perfumeKey>[:<shopId>]`, with each entry as `{ value, expires }`.

Cache lifetimes are notes and dupe lists 30 days, prices 12 hours, and detection is not cached. `chrome.storage.session` holds `geminiCooldownUntil`. `chrome.storage.sync` is not used: sync is out of scope, and the API key should not leave the device.

### D10. Permissions
- **`permissions`:** `sidePanel`, `activeTab`, `scripting`, `storage`.
- **`host_permissions`:** `https://generativelanguage.googleapis.com/*`, `https://www.fragrantica.com/*`, `http://localhost:11434/*`, `http://127.0.0.1:11434/*`.
- **`optional_host_permissions`:** `https://*/*`. Each shop's origin is requested with `chrome.permissions.request` from the options page, when the shop is added (a user gesture). For shops loaded from the seed file, the options page shows a "Grant access" button.

Keeping shop origins optional, instead of using a blanket `<all_urls>` grant, makes Web Store review easier later.

### D11. Seed shop list
`src/config/shops.default.json` is bundled into the build. The first time the worker starts with no `seeded` flag, it writes the file's shops into storage and sets `seeded`. Seeded shops start with `directAccess: false` until access is granted.

### D12. Phasing and testability
- **Phase 1 (FR1–FR3):** scaffold, the LLM layer, the options page (API key and Ollama sections only), activation, detection and the Notes card. The Dupes and Prices cards are not rendered yet.
- **Phase 2 (FR5, FR6):** the shop section of the options page, permissions, seeding, the price pipeline and the Prices card.
- **Phase 3 (FR4):** the dupe sources, merging and ranking, batch dupe prices (reusing the Phase 2 pipeline), click-to-explore and Back.

Each phase ends with unit tests for its pure modules and a manual acceptance checklist taken from the spec scenarios.

## Risks / Trade-offs

- **[Free-tier quota is used up quickly: about 3 + N + 5 + grounded calls per lookup]** → Rate-limit queue, batch extraction for dupe prices, caching (D9), and the automatic Ollama fallback. The Gemini model is configurable, so a Flash-Lite model with a higher daily limit can be chosen.
- **[Shop search pages are built with JavaScript or protected by bots, so the fetched HTML has no prices]** → The "unusable" check sends these shops to grounded search. Rows are marked "via search" so the user knows the price may be less fresh.
- **[Grounded search is not available while Gemini is in cooldown]** → Shown clearly as "Not found (search unavailable)" (llm-provider spec). Price results are not cached for these rows, so a later lookup tries again.
- **[Fragrantica blocks automated fetches (Cloudflare)]** → Fall back to the grounded answer. Then fall back to dupes from the LLM only, with a note on the card (dupe-suggestions spec).
- **[LLM makes up dupes or prices]** → Cross-checking against Fragrantica, a mark for dupes confirmed by both sources, rejecting product URLs that are not on the shop's domain, and the `exactMatch` and variant labels.
- **[The service worker is stopped mid-lookup]** → The Port and its regular messages keep it alive. Cached partial results mean a Retry only redoes the missing pieces. D4 records the fallback plan (orchestrate in the panel).
- **[Unpacked extension ID changes if the folder moves, which breaks `OLLAMA_ORIGINS`]** → The options page always shows the current origin. A fixed `key` can optionally be added to the manifest to pin the ID.
- **[A detected perfume or variant is wrong, for example EDT vs EDP or the wrong size]** → Concentration is part of detection and of the search query. Price rows label the variant they found instead of claiming an exact match.

## Migration Plan

This is a new project, so there is nothing to migrate. To deploy, run `npm run build`, open `chrome://extensions` and use "Load unpacked" on `dist/`. To roll back, load the previous `dist/` build. Data kept in storage is ignored by older builds unless they use the same keys.

## Open Questions

- The exact default Gemini model ID. It should be the latest free-tier Flash model when Phase 1 starts. It is configurable either way.
- The user's list of about 10 shops and their search URL patterns. They go into the seed file or the options page during Phase 2.
- Whether the token-set similarity threshold of 0.85 and the ranking weights need further tuning. They were adjusted once after the real Fragrantica page showed the carousel under-represented (see "Changes made after real use").

## Changes made after real use

Running the extension against the user's real shops, a real Gemini key and the real Fragrantica page exposed problems that the scripted test shops could not. The design changed as follows (the specs describe the resulting behaviour):

- **Worker lifetime.** Chrome stops an idle MV3 worker after about 30 s, and the rate limiter can wait 60 s, so lookups were lost mid-way ("Connection lost", cards stuck loading). `keepAlive.ts` makes an extension API call every 20 s while any lookup runs. If the worker is stopped anyway, the panel reconnects (up to 3 times, then a "Try again" button) and sends `ready` with `resume: true`; the worker captures the tab again and runs the lookup from the saved results.
- **Prices must be on the page.** A price the AI gives (for the current page, for each shop, for dupes) is used only if that amount is written in the page text and the text mentions rupees (`priceAppearsInText`). The AI had converted "€151.00" into ₹15,500. The shop's own row, when the user is on that shop, is built from the page's price and link with no lookup.
- **Shop pages.** The search uses brand and name only (`searchTerms`), because shops match on every word. Results pages are huge, so `focusOnProduct` keeps only the cards that name the perfume with their price lines. The extraction prompt ignores samples, decants and look-alikes; a listing must contain the name and, in its title or link, the brand; prices below 40% of the median are shown last with a warning. Every empty row carries a `reason`, shown under it.
- **Gemini.** Default model `gemini-flash-lite-latest`; a 45 s request timeout (not retried); two retries after 2 s and 6 s for 5xx; a request that still fails falls back to Ollama (no cooldown). Google Search grounding has its own switch-off so a refused search no longer sends ordinary requests to Ollama.
- **Fragrantica list.** The row appears to load only on scroll, and when it was missing the AI filled the list from memory. Now: the whole page text is used; if the heading is absent the AI is not asked and the card says so; names not found in the page text are dropped; on Fragrantica only, `extractPage` (now async) scrolls down in steps of one screen, at most 20 times, until the row appears, then restores the scroll position. The list is read to depth 30, weighted as above, with tag-insensitive merging.
- **Caches.** Dupe lists and price rows are stored under a versioned key (`CACHE_FORMAT`, now `v5`; AI suggestions written in the list text but missed by its reading are also treated as on the list, `alsoInSection`), so entries made by older logic are never reused. Notes and dupe lists written with Ollama are not stored at all.
- **Diagnostics.** The Options page shows "Version, built <local time>" so it is clear which build Chrome has loaded.
