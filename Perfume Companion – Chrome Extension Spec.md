# Perfume Companion – Chrome Extension Spec

## Overview

A personal Chrome extension (Manifest V3) that, when the user clicks its toolbar icon on any perfume product page, opens a side panel showing: the perfume's notes in plain English, ranked dupes, and the best prices across a user-defined list of shops. Built for personal use first; may be published to the Chrome Web Store later.

Status (2026-11-21): v1 is built and tested. The detailed, up-to-date requirements are in `openspec/specs/`; this file is the product summary.

## Goals

- Understand a perfume's notes quickly, in simple language.
- Find cheaper dupes I can trust.
- Find the cheapest place to buy the perfume I'm viewing, and its dupes.

## Non-goals (v1)

- Auto-opening on page load.
- Searching the entire web for prices (only the configured shop list).
- Accounts, sync, or multi-user features.

## Functional Requirements

### FR1 – Activation

- The extension stays idle until the user clicks the toolbar icon.
- Clicking the icon opens a side panel on the right of the current tab.
- **Acceptance:** No network calls or UI appear until the icon is clicked.

### FR2 – Perfume detection (any site)

- Works on any website (e.g. Fragrantica, Amazon, Sephora, others).
- The extension reads the page text and sends it to an LLM, which extracts the perfume name, brand, and notes (if present).
- Does not depend on site-specific page layouts.
- When the local model answers, its answer is checked against the page: the perfume must be the one named in the page title or address (not one from a sidebar or ad), a whole shop title is cut down to the perfume's name, and on Fragrantica the address is used if the model keeps getting it wrong.
- **Acceptance:** On a perfume page from at least 3 different sites, the correct name and brand are identified.
- If no perfume is detected, the panel shows a clear message.

### FR3 – Notes card

- Shows top, heart and base notes where available.
- Includes a short plain-English description of how the perfume smells (e.g. "fresh, peppery, a bit woody").
- **Acceptance:** Notes card renders with a description of 1–3 sentences.

### FR4 – Dupes card

- Dupe suggestions come from two sources: LLM suggestions and trusted-site data (e.g. Fragrantica's similar perfumes).
- Results from both sources are combined, cross-checked and ranked into a single best list.
- All dupes found are listed, best first, up to 30. On a Fragrantica page this is the whole "This perfume reminds me of" carousel (the original's own versions left out) plus the AI's extra picks.
- Each dupe shows its name, brand and a similarity indicator. A dupe from Fragrantica's list is marked "Confirmed by Fragrantica" when the AI named it too, otherwise "On Fragrantica's list".
- The best 4 dupes get their best price from the shop list automatically; the others have a "Check price" button that looks up just that one (each price lookup searches every shop, so this keeps the free Gemini limit in check).
- Clicking a dupe runs the full lookup for that perfume; Back returns to the original.
- **Acceptance:** Shows ranked dupes (a "few or no reliable dupes" message when fewer than 2 are found), the best 4 with a price where available and the rest priced on request.

### FR5 – Prices card

- Compares the price of the perfume being viewed across the configured shop list (12 shops, provided by the user).
- Sorted cheapest first, with a link to each shop's product page.
- Shows savings against the current site's price (e.g. "Perfume Palace: 18,000, you save 2,000 compared with Amazon"). If the current site's price can't be read, savings are not shown; when exploring a dupe, savings are compared with the most expensive shop.
- A shop without a price says why (blocked page, perfume not listed, web search unavailable). A price far below the others (probably a sample or decant) is flagged instead of being counted as the cheapest.
- **Acceptance:** Prices are sorted correctly, links open the right product, and savings are calculated correctly.

### FR6 – Shop list configuration

- The user can manage the list of shops (add or remove sites) in an options page.
- Adding a shop asks Chrome for access to its site. If refused, the shop is kept as "Search only" and can be granted access later.
- **Acceptance:** Changes persist across browser restarts.

## User Flow

1. The user is on a perfume product page (e.g. Dior Sauvage on Amazon).
2. The user clicks the extension icon, and the side panel opens with a loading state.
3. The extension extracts the page content and identifies the perfume using the LLM.
4. Notes, dupes and price lookups run in parallel.
5. The panel shows three cards: Notes, Dupes and Prices (cheapest first, with savings).
6. The user can click a dupe to explore it (and Back to return), follow a shop link, or close the panel.

## Technical Notes

- Chrome Manifest V3: side panel API; the page text is read only when the icon is clicked (`activeTab` + `scripting`, no content script); a background service worker makes the API calls and is kept awake during a lookup.
- LLM: Gemini API (free tier) via the user's API key, default model `gemini-flash-lite-latest`. Fallback: switch automatically to a local Ollama model on the user's PC (best available local model, configurable in options) when the Gemini free-tier limit is exhausted, and also when Gemini stays busy or times out after retries. A rejected key is shown as an error, not hidden behind the fallback. Ollama must allow the extension's origin (OLLAMA\_ORIGINS).
- Notes and dupe lists written by the local model are shown but never saved, so a Gemini answer replaces them next time. Prices are saved for 12 hours.
- Store the API key and shop list in chrome.storage. The options page can replace or remove the key.
- Keep the API key out of the codebase, so the extension is ready to publish later (the build fails if a key-like string is found).

## Decisions and Open Items

- Shop list (decided): 12 shops, bundled in `src/config/shops.default.json` and editable in the options page: Perfume Palace, Friday Charm, Perfume Addiction, Perfume Network, AAR Fragrances, Scentira, Splash Fragrance, Belvish, Fragstalk, MOM Perfumes, Amazon.in, Nykaa.
- Price fetching (decided): the extension fetches each shop's search page from the user's browser, Gemini extracts the price from the HTML, and Gemini's Google Search grounding is the fallback when a shop blocks the request.
- Google Search grounding (known limit): the current free key has no quota for it, so blocked shops (e.g. Nykaa) show "Not found (search unavailable)", and Fragrantica's list is read only when the user is on a Fragrantica page. Everything else works without it.
- LLM (decided): Gemini API, free tier. The free daily limit is per model; when it runs out the extension uses the local model until it resets.
- Dupes (decided): whole Fragrantica carousel listed, up to 30; best 4 priced automatically.
- Currency (decided): all prices in Indian rupees (₹).
