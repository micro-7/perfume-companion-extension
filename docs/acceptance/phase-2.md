# Phase 2 acceptance (FR5 prices, FR6 shop list)

## Automated run: 2026-11-21

Unit tests (`npm test`): all pass. Browser run (`npm run e2e:phase23`, group FR5 and FR6): all pass. Raw results are in `phase-2-3-e2e.json`; screenshots in `screenshots/` (`phase2-prices.png`, `phase2-no-shops.png`, `options-shops.png`).

**How it was tested.** The extension is loaded into Playwright's Chromium. Six fake shops (`shop-a.test` ... `amazon.test`) run on this machine, one of them behind a Cloudflare-style block page, one that does not stock the perfume, and one that is the page the user is "on". Gemini is a scripted fake (Playwright answers the extension's requests), so the results do not depend on a model's mood. Playwright cannot click the toolbar icon, so the test build exposes the click handler; the shipped `dist/` does not contain it.

| Check | Result |
|---|---|
| FR5: prices sorted cheapest first (₹7,999, ₹8,100, ₹8,750, ₹9,200, ₹9,450) | PASS |
| FR5: a shop without the perfume is "Not found", at the bottom | PASS |
| FR5: savings against the page price ₹9,200 are exact (₹1,201, ₹1,100, ₹450); none for equal or dearer shops | PASS |
| FR5: the shop the user is on is marked "You are here" and named as the baseline ("compared with Amazon") | PASS |
| FR5: a blocked shop is filled by web search and marked "via search" | PASS in the scripted browser tests; not checked live (see below) |
| FR5: progress ends at "6 of 6 shops checked" | PASS |
| FR5: each link opens that shop's product page for the perfume (clicked and checked) | PASS |
| FR5: only the configured shops are searched, each for this perfume | PASS |
| FR5: a second lookup reuses cached prices (only the shop with no result is searched again) | PASS |
| FR5: the Gemini key travels in a header, never in a URL | PASS |
| FR5: an empty shop list shows "No shops configured" with a link to Options | PASS |
| FR6: add a shop; saved with its domain; shown in the list | PASS |
| FR6: rejected with an inline error: no `{query}`, `http://`, no name, same domain twice | PASS |
| FR6: remove a shop | PASS |
| FR6: add two, remove one, quit and restart the browser: the list is unchanged | PASS |
| FR6: access granted / denied, "Grant access" (simulated permission in a unit test) | PASS |

**Bugs found by this work and fixed**
1. The savings text said "compared with amazon.test" (the host name). It now uses the name you gave that shop.
2. A harness slip, worth knowing: the extension seeds its default shop list when installed; a test that wrote its own shops in the same instant could be overwritten by that seeding. Real use cannot hit this window, but the tests now wait for seeding to finish.

**Real model check** (`E2E_LIVE=1 npm run e2e:phase23`, your local `qwen3.5:4b`, no Gemini): it read prices from three fake shop pages correctly (Shop C ₹7,999, Shop A ₹8,750, Shop B ₹9,450), sorted, with product links. This is the first evidence that a small model copes with the extraction prompt; real shop pages are messier than these.

## Still to check by hand (needs your real setup)
- [ ] **Task 8.3.** Add your real ~10 shops (Options > Shops, or `src/config/shops.default.json` before building). Open Dior Sauvage EDT on Amazon.in and click the icon. Check: the rows are sorted, every link opens the right product, the savings match a hand calculation, and a shop that blocks direct fetching is filled in with "via search". This needs your Gemini key.
- [ ] **Task 6.3, the real permission prompt.** In Options, add a shop and look at Chrome's "allow access to this site" prompt. Allow it once and deny it once; denying should keep the shop with a "Search only" label and offer **Grant access**. (The headless test build already holds all-site access, so it cannot show this prompt.)

## What to expect with real shops
- Many Indian shop search pages are built by JavaScript or sit behind bot checks. The extension detects an empty or blocked page and falls back to Gemini's web search for that shop. Those rows say "via search" and can be a little less exact than a direct read.
- If the shop's search page lists several sizes, the row shows the variant it picked (for example "50 ml") whenever it is not an exact match.

## Amazon.in as the current page (user's Chrome, final build, 2026-11-21)

Page: amazon.in/dp/B000RO0NOW (Christian Dior Sauvage EDT, ₹17,900).
- The Amazon row says "You are here" with ₹17,900, the price on the page. Pass.
- Savings match a hand calculation against Amazon's ₹17,900: MOM Perfumes ₹12,600 saves ₹5,300; Perfume Palace ₹15,500 saves ₹2,400; Splash Fragrance ₹17,200 saves ₹700; the top row ₹11,500 saves ₹6,400. Pass.
- Shops with no price say why on their own line (Nykaa "the shop page was blocked or empty; web search is unavailable"; Scentira "the perfume is not on the shop page"). Pass.
- Not met: the "via search" fallback for a blocked shop. The user's Gemini key has no Google Search access, so those rows show "Not found (search unavailable)". Task 8.3 stays open for that reason.

## Shops section in Options (user's Chrome, final build, 2026-11-21)

Add a Test Shop (https://www.example.com/search?q={query}), block Chrome's permission prompt: saved as "Search only (no direct access)" with a Grant access button. An invalid entry shows an error and adds nothing. Grant access removes the tag. Remove deletes the shop. All behaved as specified. Task 6.3 ticked.

## Decision on "via search" (2026-11-21)

The user's Gemini key has no Google Search (grounding) quota: every grounded request answers 429 RESOURCE_EXHAUSTED while ordinary requests work. So blocked shops (Nykaa) and shops whose search page does not list the perfume (Scentira) show "Not found (search unavailable)" with the reason, and the "via search" fallback could not be seen live. The user accepted this and task 8.3 was closed on that basis. To check it live later: use a Gemini key whose project allows Google Search grounding, then look up a perfume and confirm Nykaa and Scentira rows are filled and tagged "via search".

