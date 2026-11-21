# Proposal

## Why

When browsing a perfume on any shop or review site, it takes many tabs to understand what it smells like, find trustworthy cheaper dupes, and find the cheapest place to buy it. Perfume Companion puts all three answers in one Chrome side panel, opened on demand from the toolbar, with every price shown in Indian rupees (₹).

## What Changes

This is a new project with no existing code. The change creates a Chrome Manifest V3 extension with:

- A toolbar action that opens a side panel on the current tab. The extension does nothing until the icon is clicked: no content script runs, no network calls are made and no UI appears (FR1).
- Site-independent perfume detection. The extension reads the visible text of the active page and sends it to an LLM, which returns the perfume's name, brand, notes and, if the page shows one, its current price. If no perfume is found, the panel says so clearly (FR2).
- A **Notes card** with top, heart and base notes and a 1–3 sentence plain-English description of the scent (FR3).
- A **Dupes card** listing the ranked dupes (originally 2–5; after real use, every perfume on Fragrantica's carousel plus the AI's picks, up to 30, with prices for the best 8 and a "Check price" button for the rest). Candidates come from LLM suggestions and from trusted-site data (Fragrantica's "similar perfumes"). They are merged, cross-checked and ranked. Each dupe shows a similarity indicator and its best price, and clicking a dupe runs the full lookup for that perfume (FR4).
- A **Prices card** that compares the perfume's price across the user's shop list. Prices are sorted cheapest first, each links to the shop's product page, and each shows how much it saves against the current site's price. Each shop's search page is fetched from the user's browser and the LLM extracts the price. When a shop blocks the request, Gemini's Google Search grounding is used instead (FR5).
- An **options page** where the user manages the shop list (about 10 shops), enters their Gemini API key and picks the Ollama model. Settings are kept in `chrome.storage` and survive browser restarts (FR6).
- An LLM provider layer that uses the Gemini API (free tier, with the user's own key). When the free-tier quota runs out, it switches automatically to a local Ollama model. The Gemini API key is never stored in the codebase.

Out of scope for v1: opening automatically when a page loads, searching the whole web for prices, accounts, sync, and multi-user features.

## Capabilities

### New Capabilities
- `panel-activation`: Toolbar-triggered side panel lifecycle. Covers staying idle until clicked, opening the panel, the loading state and the panel close behaviour (FR1).
- `perfume-detection`: Extracts page text and identifies the perfume (name, brand, notes, current site price) through the LLM on any site. Also covers the "no perfume detected" state (FR2).
- `notes-card`: Shows top, heart and base notes and a short plain-English scent description (FR3).
- `dupe-suggestions`: Gathers dupe candidates from the LLM and trusted sites, then merges, cross-checks and ranks them. Shows them with similarity and best price, and lets the user click a dupe to run a new lookup (FR4).
- `price-comparison`: Looks up prices across the configured shops. Covers fetching, LLM price extraction, the grounding fallback, sorting cheapest first, shop links and savings against the current site's price (FR5).
- `shop-list-config`: Options page for adding and removing shops, with changes that persist (FR6).
- `llm-provider`: Gemini as the main LLM with the user's API key and automatic Ollama fallback when the quota runs out. Covers the API key and Ollama model settings and keeping secrets out of the codebase (from the Technical Notes, and used by FR2–FR5).

### Modified Capabilities
- None. The project has no existing specs.

## Impact

- **New codebase**: `manifest.json` (MV3, `sidePanel`, `activeTab`, `scripting` and `storage` permissions, with host permissions for shop sites, Gemini, Fragrantica and `localhost:11434`), a background service worker, an injected page-text extractor, the side panel UI and the options page.
- **External services**: Gemini API (`generativelanguage.googleapis.com`) on the free tier, a local Ollama server (`http://localhost:11434`, which must allow the extension's origin through `OLLAMA_ORIGINS`), the user-configured shop sites and Fragrantica.
- **Rate limits**: Each lookup makes several LLM calls (detection, notes, dupes, one price extraction per shop). Free-tier limits make the Ollama fallback and response caching important.
- **Distribution**: Built for personal use, loaded unpacked. It is kept ready for publishing (no secrets in code, minimal permissions), but publishing to the Chrome Web Store is not part of this change.
