# Real-world run: real Gemini key, your 12 real shops, real product pages

Run with `npm run e2e:real` (reads `e2e/.gemini-key`, which is git-ignored; the key is never printed or written to any report). The extension runs in Playwright's Chromium, so this is a close but not exact stand-in for your own Chrome: it has no cookies, and the toolbar click is simulated. Raw statuses are in `real-run.json`; screenshots are in `screenshots/real-*.png`.

## Result on the real Perfume Palace page (Dior Sauvage EDT 100 ml), final run

- **Detection:** "Sauvage – Christian Dior", Eau De Toilette. Correct.
- **Notes:** a Top / Heart / Base pyramid and a plain-English 2-sentence description.
- **Prices: 11 of 12 shops** returned a real price, sorted cheapest first, each linking to a real product page: Belvish ₹8,550, Perfume Network ₹9,500, Perfume Addiction ₹9,799, AAR ₹9,999 (out of stock), Friday Charm ₹10,500, Fragstalk ₹11,500, **Perfume Palace ₹12,400 (You are here)**, MOM ₹12,500, Nykaa ₹14,900, Splash ₹17,200, Amazon ₹17,900. Savings are correct by hand (₹12,400 − ₹8,550 = ₹3,850).
- **Scentira: not found.** Its search shows decants and sample sets, not the full bottle, so this is probably correct.
- **Dupes:** 5 AI-suggested dupes (Club de Nuit Urban Man Elixir, Ventana, Asad, Aqua Dubai, Fakhar Black), 4 with a real shop price.
- A second lookup on the Friday Charm page: the same results, "You are here" moved to Friday Charm (₹13,000), savings recalculated against it.
- About 130 s for a full first lookup at 10 requests per minute; cached lookups take seconds.

## What the real run found and what was fixed

The same lookup with my scripted test shops passed everything, but the real world did not. In order:

| Problem found | Fix |
|---|---|
| The default model `gemini-flash-latest` was overloaded: HTTP 503 after up to 79 s. | Default is now `gemini-flash-lite-latest` (about 1 s). Older saved settings are switched over automatically. |
| Every Gemini call could hang for over a minute. | 45 s timeout. |
| 8 of 25 calls were 503s and the immediate single retry did not help. | Two retries that wait first (2 s, 6 s). Down to 1–6 per lookup, all recovered. If a request still fails, **that request is answered by Ollama instead of showing an error** (no cooldown, so one busy moment does not move later requests; a rejected key is still shown). Browser-tested: Gemini answering 503 to the notes request gave 3 tries, then notes from Ollama with the "Using local model" badge. |
| Web search (Google Search grounding) is refused with 429 on **every** model for this key. That also sent every other request to the local model for a minute. | Web search now has its own separate "off for a while" switch; normal answers stay on Gemini. |
| Search results pages are huge (0.2–1.7 MB) and the model was shown only the first 8,000 characters, which is menus. 3 of 6 shops showed no products at all. | The model now sees only the product cards that name the perfume, plus their price lines. On Perfume Palace the real listing was at character 27,000 of 30,000. |
| Searching "Christian Dior Sauvage Eau De Toilette" returned nothing on some shops ("Christian" and "Eau De Toilette" are not in their titles). | The shop search uses brand and name only ("Dior Sauvage"). |
| A ₹850 decant price showed as the cheapest, with "you save ₹11,550". | The model is told to ignore samples and decants; a listing must name the perfume and its brand (this also drops look-alikes such as "Al Bait Al Dimashqi … Sauvage"); a price under 40% of the median is shown last with a warning and no savings. |
| The page you are on showed "not found" for its own shop. | Its own price and link come straight from the page. |
| Rows without a price said only "not found". | Hover a row to see the reason ("the perfume is not on the shop page; web search is unavailable"). |
| A flat note list from a page hid the pyramid Gemini knew. | If the pyramid agrees with the page's list, the pyramid is shown. |
| Your key (53 characters, not starting with `AIza`) is a newer format the secret check did not know. | The check now also catches `AQ.`-style keys. |

## What does not work on this key, and what it means

**Google Search grounding is unavailable.** Every model tried (about 10, including the 3.x ones) refuses it with "quota exceeded". On the free tier it may need billing enabled in the Google AI project; check the quota page in AI Studio (the error links to it). Until then:
- A shop that blocks direct fetching shows **"Not found (search unavailable)"** instead of a "via search" price. In this run no shop needed it, because all 12 answered the direct fetch with HTTP 200, Amazon and Nykaa included.
- **Fragrantica data is only used when you are on a Fragrantica page.** From any other page, finding the Fragrantica page needs web search, so the Dupes card says "Fragrantica data wasn't available" and shows AI suggestions only (as in this run).
- Both fallbacks are covered by unit tests and the scripted browser suite; they have never run against real Gemini search.

**Still never exercised for real:** Fragrantica itself (Cloudflare blocks my headless browser; your own Chrome should be fine), and Amazon.in as the page you are on.

## For you to check in your own Chrome
- Open a Fragrantica Sauvage page and click the icon. The dupe list should come from that page's "This perfume reminds me of" section, with "Confirmed by Fragrantica" marks.
- Open Amazon.in's Sauvage page and click the icon.
- Add your 12 shops (see the README), allow access to each, and compare a few prices with the shop sites.

## Regression re-run: 2026-11-21 (task 11.2, automated part)
`npm test`: 312 tests pass (23 files). `npm run build` (typecheck, build, no-secrets check): passes. `npm run e2e:phase23`: 38/38 pass; the Ollama fallback group was skipped because no test Ollama was running on port 11435. The real-Gemini run above covers "Gemini working"; the "Gemini forced into cooldown" repeat is covered by unit tests and the scripted suite, not by a fresh full run.

## Found in the user's own Chrome (first real use), and fixed

The first run in a real Chrome showed three problems that the automated runs could not:

| What the user saw | Cause | Fix |
|---|---|---|
| "Connection lost", prices stuck at "10 of 12 shops checked", dupes stuck on "Checking prices…" | Chrome stops an extension's background worker after about 30 s without activity. The rate limiter waits up to 60 s between batches, so the worker was stopped mid-lookup and everything it was doing was lost. Playwright keeps the worker alive, so no earlier test could see it. | While a lookup runs, the worker makes an extension API call every 20 s (`keepAlive.ts`). If the worker is stopped anyway, the panel says "Reconnecting", reconnects and runs the lookup again from the cache; after 3 failed tries it shows a **Try again** button instead of a spinner. Browser-tested by stopping the worker mid-lookup. |
| "Perfume Palace: ₹15,500, You are here", and every saving measured against it | Perfume Palace showed **€151.00** in that browser (shops switch currency by location). The AI converted it to ₹15,500. | A price the AI reports must be written on the page in rupees; otherwise it is dropped. Applies to the page you are on, to every shop price, and to dupe prices. Browser-tested with an EUR page. |
| Amazon, Nykaa and Scentira empty with no explanation | The reason only showed on hover. | The reason is written under the row. |

Also seen in the screenshots: 2 of the 12 shops (Friday Charm, Perfume Network) were missing from the list. They were still waiting for their turn when the worker was stopped.

**Known limitation (not fixed):** the extension compares prices without knowing the size of the bottle on the page you are on. Amazon's page `B000RO0NOW` shows ₹17,900 for a Sauvage EDT of unknown size, so "you save ₹9,350 compared with Amazon" may compare a larger bottle with 100 ml prices. Choose a 100 ml listing as the page you compare against, and check sizes before trusting a saving.

## Confirmed from the user's own Chrome (screenshots, Friday Charm page)

- The side panel opens on the right when the toolbar icon is clicked (first half of task 4.1).
- Detection and notes correct: "Sauvage – Christian Dior", Eau de Toilette, Top/Heart/Base notes and a 2-sentence description.
- "12 of 12 shops checked": the lookup finished. No "Connection lost" and nothing stuck, so the worker-stopped fix works in real Chrome.
- Prices sorted cheapest first; Friday Charm marked "You are here" at ₹13,000; every saving is right by hand (13,000 − 8,550 = 4,450; − 9,500 = 3,500; − 9,799 = 3,201; − 9,999 = 3,001; − 11,500 = 1,500; − 12,500 = 500).
- Amazon, Nykaa and Scentira are empty and now say why ("the shop page was blocked or empty" for Nykaa; "the perfume is not on the shop page" for the other two).
- Dupes: 5 dupes with similarity, 4 of them with a real shop price and one "Price not found"; none stuck on "Checking prices…". "Fragrantica data wasn't available" is shown, as expected on this key.
- Perfume Palace shows ₹15,500 and "Out of stock" in this browser, while its own product page shows €151.00 there: that shop's prices depend on the visitor's country, so treat its row with care.

Still to confirm in real Chrome: the "can't be read" message on `chrome://settings`, Chrome's real access prompt being declined (6.3), links opening the right product, Fragrantica (9.2) and click-a-dupe then Back (11.1), Amazon.in as the current page, and the Ollama-only run (11.2).

## Also confirmed by the user in Chrome

- **Task 4.1 complete:** the panel opens on the right when the icon is clicked, and on `chrome://settings` it says "This page can't be read. Open a perfume page on a website and click the icon again." (screenshot).
- **Shop links:** clicking a shop's name in the Prices card opens that shop's own Sauvage page (reported by the user from the Friday Charm page).

## Confirmed from the user's Chrome on the real Fragrantica page (Sauvage Dior, fragrantica.com)

- Heading "Sauvage – Dior"; notes taken from the page (Top: Calabrian bergamot, Pepper; Heart: Sichuan Pepper, Lavender, Pink Pepper, Vetiver, Patchouli, Geranium, elemi; Base: Ambroxan, Cedar, Labdanum) and a 2-sentence description.
- "12 of 12 shops checked"; the card says "The current site's price couldn't be read, so savings aren't shown", which is right because Fragrantica is not a shop. Prices sorted cheapest first.
- Dupes card shows **no** "Fragrantica data wasn't available" note, so the Fragrantica list was read from the page. Dupes: Bleu de Chanel (70%, no price), Club de Nuit Urban Man Elixir (92%, ₹3,585 Belvish), Kuro – Ajmal (90%, ₹1,999 MOM), Modest Une – Afnan (89%, ₹2,800 Perfume Network), Y Eau de Parfum – YSL (60%, ₹6,900 Friday Charm).
- No dupe carries "Confirmed by Fragrantica": the AI's picks and Fragrantica's picks did not overlap this time.
- The 70% and 60% on Bleu de Chanel and Y come from their position on Fragrantica's list (70 minus 5 per place), not from a similarity score Fragrantica gives; they are estimates.

Still to do: compare the dupes with the page's "This perfume reminds me of" section (9.2), click a dupe then Back (11.1), Amazon.in as the current page (5.3, 8.3), the declined Chrome access prompt (6.3), Ollama only (11.2).

## Task 9.2 on the real Fragrantica page: it did NOT match, and what was done

Compared with the page's own "This perfume reminds me of" row (a long carousel: Prada Luna Rossa Carbon, Dior Sauvage Eau de Parfum, Armaf Club De Nuit Urban Elixir, Dior Sauvage Very Cool Spray, Armaf Ventana Pour Homme, Dior Sauvage Parfum, ... Zara Aromatic Future, Ajmal Kuro, Davidoff Cool Water Parfum, Toskovat Inexcusable Evil, French Avenue Zenith Blue ...), the panel's dupes did not follow it. The first non-Dior perfume (Luna Rossa Carbon) was missing, and the two entries that carried a Fragrantica-style position (Bleu de Chanel first, Y third) were not at those places on the page. Most likely the row was not in the page text when the icon was clicked (it seems to load only when scrolled to), and the AI then filled the list from memory. Nothing warned the user.

Fixed:
- The AI is told to copy names exactly and to return nothing if the section is not in the text.
- Any name not found in the page text is dropped (a one-letter name such as YSL's "Y" is checked as a word of its own).
- If the heading is not in the page text, the AI is not asked at all; the Dupes card says "Fragrantica's 'This perfume reminds me of' list wasn't on the page when you clicked ... Scroll down to it and click the icon again. These are AI suggestions only."
- The whole page text (up to 150,000 characters) is used, not the cut-down copy used for detection.
- On Fragrantica only, if the row is missing the extension scrolls down briefly (up to about 5 seconds) until it appears, then returns the page to where the user had it.
- Also fixed on the way: the helper that finds a section far down a long page started from the top when the text had no line breaks.

Browser-tested with Fragrantica-like pages: row present, row missing, and a row that appears only on scroll (loaded, read, page scrolled back to the top). Not yet tested on the real site: the user should click the icon again on the real Fragrantica page (rebuilt and reloaded extension) and compare with the carousel.

Seen in the user's Chrome after clicking a dupe: "← Back to Sauvage" appears, the dupe gets its own notes and prices, and savings are measured against the most expensive shop ("Savings are compared with the most expensive shop (Perfume Palace)"). Clicking Back is still to be confirmed.

## Why the Fragrantica dupes did not change after the fix (cache), and the build stamp

A later screenshot of the real Fragrantica page showed exactly the same dupes as before the fix (Bleu de Chanel first at 70%, Y last at 60%). Two possible reasons: the rebuilt extension had not been reloaded, or the old dupe list was served from the cache (dupe lists are kept for 30 days, and the list made before the fix could contain perfumes the AI remembered instead of the page's own row).

Fixed: dupe lists and price rows are now saved under a versioned key (`CACHE_FORMAT = 'v2'`), so anything saved by an older build is never found again and the lookup is made afresh. Price rows saved before the "price must be on the page" check could have held converted prices, so they are covered too. The Options page now ends with "Version 0.1.0, built <date time>" (local time), so it is clear which build Chrome has loaded.

## Dupes: from "5 at most" to the whole carousel

After the Fragrantica list was read correctly (Luna Rossa Carbon first, "Confirmed by Fragrantica" shown), the user noted that the carousel holds dozens of perfumes while the card showed 5 and had dropped Kuro. Causes found: only the first 10 entries were read, the position-based estimate (70% minus 5 per place) let the AI's picks outrank everything beyond the first few, and "Club De Nuit Urban Elixir" / "Club de Nuit Urban Man Elixir" stayed two entries (5 of 6 words shared, under the 0.85 limit) so neither got the confirmed mark and both took a slot.

Changed: depth 30; estimate 80% minus 2 per place (never below 40%); `+15` for being on the list, up to `+10` for a high place, `+10` more when both sources name it; masculine tags ignored when comparing; up to 30 dupes shown; the best 8 priced automatically and a **Check price** button for the rest (pricing one dupe searches every shop, so pricing about 25 at once would take minutes and use the free Gemini quota). Cached lists and prices from older builds are ignored (`CACHE_FORMAT` v3).

## Confirmed in the user's Chrome on the real Fragrantica page (final build)

- The Dupes card lists the carousel's perfumes in the page's order (Prada Luna Rossa Carbon first among the non-Dior ones, then Club De Nuit Urban Elixir, Ventana Pour Homme, Office For Men, ...), with Kuro and Modest Une also present. **Task 9.2 ticked.**
- "✓ Confirmed by Fragrantica" shows on Club de Nuit Urban Man Elixir, Kuro and Modest Une (merged with the AI's picks).
- **Click a dupe, then Back returns to the original: works** (user report). Task 11.1 also names Amazon.in, so it stays open until that half is done.
- User point: Luna Rossa Carbon and Ventana Pour Homme are on Fragrantica's list yet showed no mark, because "Confirmed" meant "the AI and Fragrantica both named it". Now every dupe on Fragrantica's list carries a mark: "Confirmed by Fragrantica" (both) or "On Fragrantica's list" (Fragrantica only); a dupe with no mark came from the AI alone.

