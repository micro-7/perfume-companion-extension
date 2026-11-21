# Tasks

Three phases, each buildable and testable on its own:
- **Phase 1 (groups 1–5):** FR1–FR3, the core panel with detection and notes.
- **Phase 2 (groups 6–8):** FR5 and FR6, prices and the shop list.
- **Phase 3 (groups 9–11):** FR4, dupes.

The design reference for each group is in brackets.

## 1. Phase 1 · Project scaffold [D1, D2, D10]

- [x] 1.1 Set up `package.json` with TypeScript, Vite, Vitest and `@types/chrome`, plus the scripts `build`, `dev` (watch build) and `test`. Verify: `npm install` and `npm test` (with no tests yet) both exit 0.
- [x] 1.2 Configure a multi-entry Vite build (`src/background/index.ts`, `src/sidepanel/index.html`, `src/options/index.html`) that writes to `dist/`, copies `manifest.json` and the icons, and set up `tsconfig.json` in strict mode. Verify: `npm run build` produces `dist/manifest.json`, `dist/sidepanel.html`, `dist/options.html` and the background bundle.
- [x] 1.3 Write `manifest.json` (MV3) following D10: `sidePanel`, `activeTab`, `scripting` and `storage` permissions, host permissions for Gemini, Fragrantica and Ollama on localhost, `optional_host_permissions: ["https://*/*"]`, an `action` with an icon, an `options_page`, and **no** `content_scripts`. Verify: "Load unpacked" on `dist/` succeeds with no errors on `chrome://extensions`.
- [x] 1.4 Add a `.gitignore` (`node_modules`, `dist`) and a `README.md` covering setup, build, load unpacked, getting a Gemini key, and setting `OLLAMA_ORIGINS`. Add a `scripts/check-no-secrets` step (grep for `AIza` in `src/` and `dist/`) to `npm run build`. Verify: the build fails if a test string `AIza…` is placed in `src/`, and passes once it is removed.

## 2. Phase 1 · LLM provider layer [D5, D6, spec: llm-provider]

- [x] 2.1 Create a typed settings store (`src/shared/settings.ts`) over `chrome.storage.local` with defaults (`ollamaUrl = http://localhost:11434`, `geminiRpm = 10`). Verify: unit tests with a mocked `chrome.storage` cover reading defaults and saving values.
- [x] 2.2 Write the Gemini client: `generateContent` with `responseSchema`, plus the grounded mode (`google_search` tool, JSON parsed from a fenced block, sources kept). Sort errors into `QuotaExceeded` (429 or `RESOURCE_EXHAUSTED`, with `retryDelay` read), `AuthError`, `ServerError` and `BadResponse`. Verify: unit tests with mocked `fetch` cover each error type and the parsing of grounded responses.
- [x] 2.3 Write the Ollama client (`/api/chat` with `format: schema` and `stream: false`, and `/api/tags`). Turn a 403 into an `OriginNotAllowed` error that carries the exact `chrome-extension://<id>` origin. Verify: unit tests with mocked `fetch` cover success, 403 and the connection refused case.
- [x] 2.4 Write the model auto-selection in `pickOllamaModel(tags)` using the D6 priority list and size rule. Verify: unit tests cover a priority match, choosing within a family by `parameter_size`, the "largest model" fallback and an empty list.
- [x] 2.5 Write `llm.generate()`, which routes requests to Gemini or Ollama: it sets the cooldown in `chrome.storage.session` on a quota error and retries on Ollama, sends straight to Ollama while the cooldown lasts or when there is no key, fails grounded requests fast with `SearchUnavailable` during the cooldown, does not fall back for auth or 5xx errors, retries once on an invalid response, and emits a fallback event. Verify: unit tests cover every scenario in the llm-provider spec.
- [x] 2.6 Add a Gemini rate-limit queue (sliding window of `geminiRpm` starts per minute, concurrency of 4). Verify: a unit test with fake timers shows that of 12 requests at 10 per minute, the last 2 start after the 60 s mark.
- [x] 2.7 Write the small validators for JSON response shapes (`src/shared/validate.ts`) used by every task. Verify: unit tests accept valid shapes and reject missing or wrong-typed fields.

## 3. Phase 1 · Options page: AI settings [spec: llm-provider]

- [x] 3.1 Build `options.html` with a Gemini section: masked API key input (only the last 4 characters shown once saved), model ID and requests per minute. Verify manually: save a key, reload the page, and the key shows masked. Restart Chrome and the key is still there.
- [x] 3.2 Add an Ollama section: URL, "Test connection" (shows the model count or the specific error), a dropdown of installed models with an "Auto (picked: X)" option, and the `OLLAMA_ORIGINS` help text showing `chrome-extension://${chrome.runtime.id}`. Verify manually with Ollama running, with it stopped, and with the origin not allowed. Each case shows the right message.

## 4. Phase 1 · Activation, side panel and detection [D2, D3, D4, specs: panel-activation, perfume-detection]

- [x] 4.1 Write the service worker's `action.onClicked` handler: enable and open the per-tab side panel inside the user gesture, then inject `extractPage`. Turn injection failures into a `restricted` message. Disable the global panel on install. Verify manually: the panel opens on click, and `chrome://settings` shows "This page can't be read".
- [x] 4.2 Write `extractPage()` (innerText with collapsed whitespace, cut to 15,000 characters, `Product` JSON-LD and the og/product meta tags). Keep the cutting and JSON-LD selection as pure helpers. Verify: unit tests on the helpers using sample HTML/JSON-LD fixtures.
- [x] 4.3 Set up the Port protocol (`src/shared/messages.ts` message types), the lookup orchestrator with an `AbortController` per lookup, a cancel when the Port disconnects, and replacing the running lookup on a new click. Verify: a unit test of the orchestrator with fake ports shows that disconnecting aborts any pending work.
- [x] 4.4 Write the detection task (prompt plus schema `{ found, name, brand, concentration, notes{top,heart,base,flat}, currentPrice{amountInr, siteName} }`). JSON-LD and meta prices take priority over the LLM price. A missing name or brand is treated as not found. Verify: unit tests for result handling (found, not found, price priority) with a mocked `llm`.
- [x] 4.5 Build the side panel shell: the loading state, "No perfume detected on this page", the detection error with Retry, a slot for each card with its own loading state, and the "Using local model" indicator. Verify manually: each state renders, and closing the panel mid-lookup leaves no errors in the console.
- [x] 4.6 Check that the extension stays idle: browse 5 perfume pages without clicking, and confirm that the service worker DevTools Network tab shows no requests and no panel appears. Record the result in `docs/acceptance/phase-1.md`.

## 5. Phase 1 · Notes card [spec: notes-card]

- [x] 5.1 Write the notes task. It uses the notes found on the page and fills missing tiers from the LLM. It returns `{ top[], heart[], base[], flat[], description }` and enforces 1–3 sentences (retries once if the count is wrong). Cache the result for 30 days under `cache:notes:<perfumeKey>`. Verify: unit tests cover merging page and LLM notes, the sentence-count check and a cache hit.
- [x] 5.2 Render the Notes card: a "Name – Brand" heading, Top, Heart and Base groups (leaving out empty tiers, with a single "Notes" group for flat lists), the description, and an error with Retry that does not affect the other cards. Verify: unit tests for the DOM render with fixtures (full pyramid, flat list, missing tier).
- [x] 5.3 **Phase 1 acceptance:** on perfume pages from Fragrantica, Amazon.in and one more site (Sephora or Nykaa), the correct name and brand are detected and the Notes card renders with a 1–3 sentence description. A non-perfume page shows the "no perfume" message. With an invalid or used-up Gemini key and Ollama running, the notes still render with the "Using local model" indicator. Record the results in `docs/acceptance/phase-1.md`.

## 6. Phase 2 · Shop list configuration [D9, D10, D11, spec: shop-list-config]

- [x] 6.1 Write the shop store (`src/shared/shops.ts`) with `validateShop()`: requires a name, a valid https URL, the `{query}` placeholder, and a domain not already in the list. It also has add and remove operations on `chrome.storage.local`. Verify: unit tests for each validation rule and for persistence through mocked storage.
- [x] 6.2 Add seeding from `src/config/shops.default.json` the first time the worker starts, controlled by the `seeded` flag. Seeded shops start with `directAccess: false`. Verify: unit tests show that a first run seeds the list and a second run does not overwrite edits.
- [x] 6.3 Add the shop section to the options page: list, add form with inline errors, remove button, `chrome.permissions.request` for the shop's origin on add (denied means it is saved as "search only"), and a "Grant access" button for shops without access. Verify manually: add, reject an invalid entry, deny and grant permission, remove.
- [x] 6.4 Check persistence: add two shops and remove one, fully quit and restart Chrome, and confirm the list is unchanged. Record the result in `docs/acceptance/phase-2.md`.

## 7. Phase 2 · Price pipeline [D7, spec: price-comparison]

- [x] 7.1 Write the pure helpers: `buildSearchUrl(shop, perfume)`, `reduceHtml(html)` (removes script, style, svg and noscript, keeps JSON-LD and text/link pairs, cuts to about 8,000 characters), `isUnusable(status, reduced)` (checks status, bot-check markers and minimum length), and `resolveProductUrl(url, shop)` (rejects other domains). Verify: unit tests with saved HTML fixtures, including a Cloudflare challenge page.
- [x] 7.2 Write the per-shop direct fetch (10 s timeout, abort signal, only for shops with `directAccess`) and the LLM extraction task `{ found, productTitle, priceInr, url, inStock, variant, exactMatch }`. Verify: unit tests with mocked `fetch` and `llm` show that a correct row is produced and an off-domain URL is rejected.
- [x] 7.3 Write the grounded-search fallback for unusable or search-only shops. It limits the search to the shop's domain, marks the row `viaSearch`, turns `SearchUnavailable` into "Not found (search unavailable)", and treats a double failure as "Not found". Verify: unit tests cover each branch.
- [x] 7.4 Write the price orchestrator: run all shops at once through the queue, emit `prices:row` and `prices:progress`, cache found rows for 12 hours under `cache:price:<perfumeKey>:<shopId>`, and do not cache "search unavailable" rows. Return "No shops configured" for an empty list. Verify: unit tests with a 3-shop mock check the order of events, the progress counts and cache behaviour.
- [x] 7.5 Write `sortRows()` (found rows by price ascending, then not-found rows), `savings(baseline, price)` (positive only), `formatInr()` using `en-IN` (`₹18,000`), and detection of the "You are here" shop by domain. Verify: unit tests cover the spec examples (₹20,000 vs ₹18,000 → save ₹2,000, an equal price, a higher price, an unknown baseline, and the current site being in the list).

## 8. Phase 2 · Prices card [spec: price-comparison]

- [x] 8.1 Render the Prices card: rows re-sorted as they stream in, "X of N shops checked", each row showing shop name, ₹ price, variant label when it is not an exact match, the "via search" mark, savings text such as "you save ₹2,000 compared with Amazon", "You are here", links that open in a new tab, a note when the current price is unknown, and an empty-list state with a link to options. Verify: unit tests for the DOM render with streamed row fixtures.
- [x] 8.2 Connect the price lookup to start in parallel with the notes lookup after detection. Verify manually: the Notes and Prices cards fill in independently.
- [x] 8.3 **Phase 2 acceptance:** with the user's 10 shops configured, look up Dior Sauvage EDT on Amazon.in. Check that the rows are sorted correctly, that every link opens the right product page, that the savings match a hand calculation. The "via search" fallback was verified only with the scripted browser tests and unit tests, not live: the user's Gemini key has no Google Search quota (user decision, 2026-11-21: accepted; recheck later with a key that has it). Record the results in `docs/acceptance/phase-2.md`.

## 9. Phase 3 · Dupe sources and ranking [D8, spec: dupe-suggestions]

- [x] 9.1 Write the LLM dupe task: up to 8 dupes as `{ name, brand, similarity, reason }`, excluding the original perfume and its flankers. Verify: unit tests with a mocked `llm` check validation and the exclusion instruction being passed.
- [x] 9.2 Write the Fragrantica source: use the current page if it is on Fragrantica, otherwise find the page through grounded search limited to `fragrantica.com`, fetch it, and extract the ordered "reminds me of" list with the LLM. Fall back to the grounded answer, then to unavailable. Verify: unit tests cover each branch with fixtures. A manual check confirms the list for Dior Sauvage matches Fragrantica.
- [x] 9.3 Write `normalizeKey()`, the token-set similarity, `mergeCandidates()` (merging at 0.85 or above), `isFlanker()`, `rankDupes()` (the D8 score formula) and the cap on the number shown (5 at first, 30 after real use) with the fewer-than-2 message. Verify: unit tests cover the "Club de Nuit Intense Man – Armaf" merge example, ranking of cross-confirmed dupes, flanker exclusion and the limit edge cases.
- [x] 9.4 Write the dupes orchestrator: run both sources in parallel, merge and rank, emit `dupes:list`, and cache the list for 30 days. Verify: unit tests check the order of events and the case where only the LLM source responds.

## 10. Phase 3 · Dupes card and exploration [D4, D8, spec: dupe-suggestions]

- [x] 10.1 Write batch-mode price extraction for dupes, reusing 7.1–7.3. It sends one LLM call per dupe with all the reduced shop pages and emits `dupes:price` with the cheapest row. Verify: unit tests show one extraction call per dupe and the cheapest row being chosen.
- [x] 10.2 Render the Dupes card: ranked entries with name, brand, a similarity indicator, a "confirmed by Fragrantica" mark, a price-loading indicator per dupe, then "₹X at Shop" with a link or "Price not found", the trusted-site unavailable note, and the few-dupes message. Verify: unit tests for the DOM render with fixtures.
- [x] 10.3 Add click-to-explore: send `lookup` with `{ name, brand }` over the Port, skip detection, push the current result onto the history stack, add a Back button that redraws from memory, and base the savings on the highest shop price while exploring. Verify: unit tests cover the history stack and the dupe savings baseline. A manual check confirms clicking a dupe and then Back makes no new requests.

## 11. Phase 3 · End-to-end acceptance

- [x] 11.1 **Phase 3 acceptance:** for Dior Sauvage on Fragrantica and on Amazon.in, the Dupes card lists the ranked dupes (the whole carousel, up to 30) with prices for the best 8 and a "Check price" button for the rest. Clicking one runs the full lookup and Back returns to the original. Record the results in `docs/acceptance/phase-3.md`.
- [x] 11.2 Full regression: run `npm test` and `npm run build` (including the no-secrets check). Repeat the Phase 1 and Phase 2 acceptance checks once with Gemini working and once with Gemini forced into cooldown (Ollama only, grounded rows showing "search unavailable"). Verify: all tests pass, and the acceptance documents are updated.

## 12. Changes made after real use (real Gemini key, the user's 12 shops, real Chrome)

- [x] 12.1 Keep the background worker alive while a lookup runs (`keepAlive.ts`, a ping every 20 s) and let the panel reconnect and resume (up to 3 tries, then "Try again"). Verify: `keepAlive.test.ts`, panel tests, and a browser test that stops the worker mid-lookup and sees all 6 shops and the dupes arrive.
- [x] 12.2 Accept a price only if it is written on the page in rupees (current page, each shop, dupes); use the shop's own page price when the user is on that shop. Verify: unit tests, and a browser test with a page showing EUR 151.00 where the AI answers 15,500.
- [x] 12.3 Search shops by brand and name only; give the AI only the product cards that name the perfume; reject look-alikes, samples and implausibly low prices; show a reason on every empty row. Verify: unit tests with real shop pages, and the real run (11 of 12 shops priced).
- [x] 12.4 Gemini: default `gemini-flash-lite-latest`, 45 s timeout, two retries after waiting, fall back to Ollama after repeated server errors, separate switch-off for refused web search. Verify: unit tests, browser test (503 to notes then answered by Ollama), real calls.
- [x] 12.5 Read Fragrantica's "This perfume reminds me of" list from the page itself: whole page text, heading check, drop names not on the page, scroll to load the row and scroll back, depth 30. Verify: unit tests and browser tests (row present, missing, loaded only on scroll). Real Fragrantica page: row loads and "Confirmed by Fragrantica" shows (user screenshots).
- [x] 12.6 Show every dupe up to 30 with tag-insensitive merging and the new weights; price the best 8 automatically and offer "Check price" for the rest. Verify: unit tests and a browser test with a 14-perfume row (17 listed, 9 buttons, one click prices one dupe).
- [x] 12.7 Version the saved-data keys (`CACHE_FORMAT`) and show the build time on the Options page. Verify: unit tests that old keys are ignored; build stamp matches the PC clock.
- [x] 12.8 Update specs, design, README and acceptance notes for all of the above. Verify: `openspec validate perfume-companion --strict`.
- [x] 12.9 Re-check the real Fragrantica page with the final build: the Dupes card lists the carousel's perfumes (Luna Rossa Carbon first among non-Dior), "Check price" works on a later dupe, and Back returns to the original. Needs the user's own Chrome.

## Workflow follow-up

- Fill in the user's ~10 shops in `src/config/shops.default.json` or through the options page during Phase 2.
- Archive the change with `openspec archive perfume-companion` after all three phases pass acceptance.
- [x] 12.10 A click on a dupe or "Check price" after Chrome stopped the idle worker is sent on the new connection (it used to run the original page's lookup again and lose the click; "Check price" also did nothing after Back)
- [x] 12.11 Options: add a "Remove key" button for the saved Gemini key (it was replace-only; saving an empty box kept the old key)
- [x] 12.12 Local-model slips found in real use (Amazon.in): the whole title used as the perfume name (so no shop found it), a wrong current price (₹298), "no perfume" on the first try, and "- " before dupe names. Tidied/checked in code for the local model only; Gemini answers unchanged (384 unit tests, browser suites 22/22 and 62/62)
