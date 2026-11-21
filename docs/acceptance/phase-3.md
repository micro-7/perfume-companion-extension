# Phase 3 acceptance (FR4 dupes)

## Automated run: 2026-11-21

Unit tests (`npm test`): all pass. Browser run (`npm run e2e:phase23`, group FR4): all pass. Screenshots: `screenshots/phase3-dupes.png`, `phase3-explore.png`. Setup is the same as in [phase-2.md](phase-2.md) (fake shops, scripted Gemini, a fake Fragrantica).

| Check | Result |
|---|---|
| The Dupes card shows ranked dupes (the limit of 5 was lifted later, see the update below) | PASS (4 at the time) |
| The AI's "Armaf Club de Nuit Intense Man" and Fragrantica's "Club de Nuit Intense Man by Armaf" become one entry, shown as "Club de Nuit Intense Man – Armaf" (brand once) | PASS |
| The dupe found by both sources ranks first and carries the "Confirmed by Fragrantica" mark; others do not | PASS |
| The flanker "Sauvage Elixir" is removed | PASS |
| Each dupe shows a similarity indicator (85%, 72%, 60%, 60%) | PASS |
| Each dupe shows its best price with a link: ₹2,400 at Shop C beats Shop D ₹2,500 (via search) and Shop A ₹2,650 | PASS |
| A dupe no shop lists shows "Price not found" | PASS |
| Dupe prices cost one batch call per dupe, not one per shop | PASS |
| Clicking a dupe runs the full lookup for it (Notes, Prices, Dupes) with "← Back to Sauvage" | PASS |
| While exploring, savings are measured against the most expensive shop ("you save ₹500 compared with Amazon") | PASS |
| Prices already found for the dupe are reused from the cache, including the "via search" one | PASS |
| **Back** shows the original perfume with its prices, dupes and savings, with **zero** new AI calls or shop searches | PASS |
| On a Fragrantica page the list is read from the page itself (no web search for it) | PASS |
| Without Fragrantica data the card still shows AI dupes and says "Fragrantica data wasn't available" | PASS |
| A failing dupe lookup shows an error and **Retry** in the Dupes card only; Notes and Prices still work; Retry fills it | PASS |

**Bug found by this work and fixed:** a dupe was shown as "Armaf Club de Nuit Intense Man – **Armaf**" (brand twice), because the AI's spelling included the brand. Names are now cleaned (leading brand and trailing "by Brand" removed; "Bleu de Chanel" keeps its brand word). Clicking a dupe now also searches with the clean name.

**Related bug caught earlier by a unit test:** stripping the brand anywhere in a name turned "Bleu de Chanel" into "bleu de", which could merge it with unrelated perfumes. The brand is only removed at the start of a name or after "by".

## Still to check by hand (needs your real setup)
- [ ] **Task 9.2.** With your Gemini key, open Dior Sauvage on **fragrantica.com** and click the icon. The dupe list should match the page's "This perfume reminds me of" section. Then open it on **Amazon.in**: the extension finds the Fragrantica page through web search. If Fragrantica blocks that, the card says "Fragrantica data wasn't available" and shows AI suggestions only.
- [ ] **Task 11.1.** For Dior Sauvage on Fragrantica and on Amazon.in, the Dupes card lists the dupes (the whole carousel, see the update below) with prices for the best 4 and a **Check price** button for the rest. Click one; the full lookup runs; **Back** returns to the original.

## Judgement calls worth a look
- The dupe ranking weights (the AI's similarity, +15 when Fragrantica agrees, a small bonus for an early Fragrantica position) and the 0.85 name-match threshold were first guesses; they were retuned once after the real Fragrantica page (see the update below). Tune them again if the order looks wrong.
- The AI is asked for dupes "sold in India". It can still suggest things you cannot buy; those simply show "Price not found".

## Update after real use (supersedes parts of the table above)

The browser run above used scripted shops and a scripted Fragrantica. Real use changed FR4; the details are in [real-world.md](real-world.md) and the spec:
- The Dupes card no longer stops at 5: it lists everything from Fragrantica's carousel plus the AI's picks, up to 30. The best 4 are priced automatically; the rest have a **Check price** button.
- The Fragrantica list is read from the page only (names not on the page are dropped), the page is scrolled briefly to load the row, and a missing row is reported instead of being filled from memory.
- Merging ignores "Man" / "Pour Homme" tags, so "Club De Nuit Urban Elixir" and "Club de Nuit Urban Man Elixir" are one confirmed entry.
- Task 12.9 (re-check the real Fragrantica page with the final build, including **Check price** and **Back**) is still to be done in the user's own Chrome.

## Amazon.in and idle worker (user's Chrome, final build, 2026-11-21)

- On the Amazon.in page the Dupes card listed AI suggestions with prices (all priced automatically, because the AI gave fewer than 8) and said "Fragrantica data wasn't available, so these are AI suggestions only" (Fragrantica's list cannot be read away from Fragrantica with this key). Pass.
- Clicking a dupe opens that dupe and Back returns to the original, including after the background worker had been idle for about a minute (the bug where the click showed the original page is fixed). Pass.
- "Check price" on a dupe past the best 8 was confirmed earlier on the Fragrantica page (Ejaazi ₹1,599; Aqua Dubai "Price not found"). Task 11.1 ticked.

## Update (2026-11-21): 4 dupes priced automatically instead of 8

The user's free Gemini key ran out of its daily limit, because each priced dupe means searching all 12 shops. Automatic pricing was lowered from 8 to 4 dupes (`AUTO_PRICED_DUPES`), which roughly halves the requests per lookup. The other dupes keep the **Check price** button. Earlier lines in this file that say "best 8" describe the earlier setting.
