# Future scope

Known limitations of v1 (2026-11-21), each with a possible next step. None of these is a bug: they are where v1 stops.

## Prices

### Blocked shops show "search unavailable"
Shops that block the extension's request (Nykaa) and shops whose own search does not list the perfume (Scentira) can only be priced through Gemini's Google Search tool, which the current free key cannot use.
- **Next step:** use a key with Google Search quota (billing on the AI Studio project), or read those shops a different way, e.g. opening the shop page in a background tab so it loads like a normal visit.

### Bottle size is not compared
The extension does not know the bottle size of the page you are on, so a 60 ml price elsewhere can look like a saving against a 100 ml page (e.g. Amazon's ₹17,900 listing may be a larger size than a shop's ₹9,500 one). Rows that are clearly a different size or concentration carry a tag, but this is not complete.
- **Next step:** read the size from the current page, prefer the same size at each shop, and show the price per ml.

### Some shops show prices in other currencies
Perfume Palace can show EUR depending on location. Such prices are never converted (an invented ₹ figure would make savings wrong); the row says the price was not written in rupees.
- **Next step:** if needed, a fixed, clearly labelled conversion, or a setting to force the Indian storefront.

## AI usage

### Free daily Gemini limit
One lookup makes a few dozen requests: detection, notes, dupes, one per shop, and one shop search per automatically priced dupe. A heavy day uses up the free limit, and the panel then shows "Using local model".
- **Done so far:** only the best 4 dupes are priced automatically (was 8); prices are cached for 12 hours.
- **Next step:** read several shops in one request, cache prices longer, or price dupes only on request.

### The local model is a weaker backup
A small Ollama model is slower and makes mistakes: the whole shop title as the name, the brand repeated as the name, a perfume from the sidebar, a wrong page price, "no perfume" on the first try. Code now catches these (checks against the page title and address, a second try, the Fragrantica address as the last resort), but it cannot make a 4B model as good as Gemini. Bigger models are too slow on a 4 GB laptop GPU.
- **Next step:** for well-known sites, read the name and price straight from the page structure instead of asking the model (Fragrantica already falls back to its address).

### Fragrantica's list only on Fragrantica pages
On other sites, reading Fragrantica's "This perfume reminds me of" list needs Google Search, so dupes there come from the AI alone.
- **Next step:** comes with a key that has Google Search quota, or by fetching the Fragrantica page directly when its address can be worked out.

## Dupes

### Similarity for Fragrantica-only dupes is an estimate
Fragrantica gives no similarity score, so a dupe only on its list gets 80% for first place, 2 points less for each place after it, never below 40%.
- **Next step:** use Fragrantica's vote counts if they can be read reliably.

### Ranking weights were tuned by eye
The weights (+15 for being on Fragrantica's list, up to +10 for a high place, +10 when both sources agree) and the 0.85 name-match threshold were set from a few real pages.
- **Next step:** tune them on more perfumes once there is more real use.

## Publishing

The extension is built for personal use but kept ready to publish: no key in the code, keys in browser storage.
- **Next step for the Chrome Web Store:** a privacy policy (page text goes to Gemini or the local model), store listing and screenshots, a review of the optional `https://*/*` permission request, and an icon set.
