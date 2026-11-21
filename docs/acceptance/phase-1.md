# Phase 1 acceptance (FR1 to FR3)

## Automated run: 2026-11-21

`npm test`: 102 unit tests pass. `npm run e2e`: 22 checks pass, 1 skipped. Full output in `phase-1-e2e.json`; screenshots in `screenshots/`.

The e2e run loads the built extension into Playwright's Chromium (headless) and uses a local Ollama (`qwen3.5:4b`) with no Gemini key, on local copies of a Fragrantica page, an Amazon.in listing, a Nykaa listing and a news article. Playwright cannot click a toolbar icon, so a test-only build (`--mode e2e`) exposes the click handler and opens the panel page as a tab. That test build also gets `<all_urls>` and `tabs` permissions, because there is no real click to grant `activeTab`. The normal `dist/` build contains neither.

| Check | Result |
|---|---|
| FR1: no requests, no UI, no content scripts before the click | PASS (0 service worker requests) |
| FR1: `chrome://` page shows "This page can't be read" | PASS |
| FR1: closing the panel mid-lookup raises no errors | PASS |
| FR2: Fragrantica page shows "Sauvage – Dior" | PASS (about 25 s on the local model) |
| FR2: Amazon.in page shows "Sauvage – Dior" | PASS (about 22 s) |
| FR2: Nykaa page shows "Bleu De Chanel – CHANEL" | PASS (about 16 s) |
| FR2: news article shows "No perfume detected on this page" | PASS |
| FR2: real fragrantica.com | SKIP: Cloudflare blocks headless browsers |
| FR3: Top, Heart and Base taken from the page, with a 1–3 sentence description | PASS |
| FR3: no ingredient names (Alcohol, Aqua, Limonene...) shown as notes | PASS (fixed in this run) |
| Fallback: "Using local model" badge shown | PASS |
| Ollama 403 explains `OLLAMA_ORIGINS` with the exact origin | PASS |
| A wrong Gemini key is reported, not hidden by the fallback | PASS |
| Options: key masked, Test connection (OK, blocked, not running), auto-pick skips cloud models | PASS |
| Options: settings survive a browser restart | PASS |

**Bugs found and fixed by this run:**
1. Thinking models such as qwen3.5 took more than 2 minutes per request. The extension now sends `think: false`, which brings it to about 1 s.
2. Auto-pick chose the `:cloud` model, which sends page text to ollama.com. Cloud models are now never auto-picked.
3. The key input stayed visible after saving, because CSS overrode `hidden`.
4. "Test connection" said "Connected" while lookups were blocked by `OLLAMA_ORIGINS`. It now checks with a POST request, the same way lookups do.
5. The Nykaa "Ingredients" list (Alcohol, Aqua, Limonene...) was shown as notes. The detection prompt now says to ignore it, and an ingredient filter removes such names in code.

**Known limitation (not a code bug):** with no notes on the page, the 4B local model fills them from memory and gets them wrong. For Sauvage EDT it listed pineapple, jasmine and saffron; for Bleu de Chanel it listed vague categories like "oceanic, woody". Gemini should do much better. Note that notes are cached for 30 days, including answers from the local model.

## Still to check by hand (real Chrome)
- [ ] Load unpacked `dist/` in your own Chrome. Click the toolbar icon on a perfume page: the **side panel** opens on the right (task 4.1; Playwright cannot click the icon).
- [ ] With your **Gemini key**, look up perfumes on 3 **real** sites (for example Fragrantica, Amazon.in, Nykaa). Name and brand should be right, and the notes should be accurate (task 5.3).
- [ ] Optional: with Ollama allowed (`OLLAMA_ORIGINS`) and Gemini out of quota, notes still appear with the "Using local model" badge.

## Re-running
```
# in one terminal: a test-only Ollama that allows extension origins (your normal one is not touched)
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS="chrome-extension://*" ollama serve
# in another
npm run e2e
```

## Real sites in the user's Chrome (final build, 2026-11-21)

| Page | Result |
|---|---|
| Fragrantica, Dior Sauvage | Correct name and brand, notes and description (earlier run). |
| Amazon.in, B000RO0NOW | "Sauvage - Dior", Eau de Toilette, notes (earlier run). |
| Friday Charm, "Christian Dior Sauvage Eau De Parfum For Men" | "Sauvage - Christian Dior", Eau de Parfum, 2-sentence description, top/heart/base notes. |
| Perfume Addiction, "Christian Dior Sauvage EDT 100ml" | "Sauvage - Christian Dior", Eau de Toilette, description and notes. |
| Sephora India, "Dior Sauvage Eau de Parfum 100ml" | "Sauvage - Dior", Eau de Parfum, 3-sentence description and notes. Savings are compared with the page's lowest listed price (₹14,200). |
| wikipedia.org (not a perfume page) | "No perfume detected on this page". |
| chrome://settings | "This page can't be read" (earlier run). |
| nykaa.com | Not testable: Nykaa's security system (Akamai) answers "Access Denied" to the user's browser, so there is no page to read. Replaced by Friday Charm, Perfume Addiction and Sephora India above. |


## Local model only (user's Chrome, Gemini key removed, qwen3.5:4b, 2026-11-21)

On amazon.in/dp/B000RO0NOW: the Notes card rendered with the "Using local model" badge, dupes listed, and the shops that could not be read showed "Not found (search unavailable)" with the reason. Slips of the small model seen in this run (whole title as the name, wrong current price ₹298, "no perfume" on the first try, "- " before dupe names) were then handled in code (see task 12.12); Gemini answers are unchanged.

