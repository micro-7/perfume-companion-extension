# Loose ends

Small housekeeping items left after v1 was finished (2026-11-21). None of them affects how the extension works.

## 1. The project is not in git

All the work lives only in this folder: no history, no backup. A `.gitignore` already keeps out `e2e/.gemini-key`, `node_modules/`, `dist/` and `dist-e2e/`.

**To do:** `git init`, make a first commit, and optionally push to a private GitHub repository.

## 2. `e2e/.gemini-key` holds the Gemini key in plain text

Only `npm run e2e:real` reads it. It is git-ignored, but it is still a copy of the key on disk.

**To do:** delete it if the real-key test is not needed any more. To run that test again later, put the key back in the file (one line).

## 3. `docs/acceptance/real-run.json` is from a degraded run

The last real-key run (2026-11-21) happened after the day's free Gemini limit was nearly used up: 10 answers, 8 "quota exceeded", 8 "busy". Six shops still got prices; the rest show "No AI provider is reachable". The written findings in [acceptance/real-world.md](acceptance/real-world.md) are correct; only this file is a poor example.

**To do:** after the daily limit resets, run `npm run e2e:real` once to replace it with a clean run.

## 4. "Via search" has never been seen working live

The fallback for blocked shops (Nykaa) and for perfumes a shop's own search misses (Scentira) uses Gemini's Google Search tool. The current key has no quota for it, so it was verified only in the scripted browser tests and unit tests (task 8.3 was closed on that basis).

**To do:** if a key with Google Search quota becomes available, paste it in Options, look up Dior Sauvage, and check that the Nykaa and Scentira rows are filled and tagged "via search".

## 5. Gemini model choice

`gemini-flash-lite-latest` is the default and the right choice, but its free daily limit can run out on a heavy day of testing. `gemini-3.5-flash` has its own limit but is too slow for the extension (simple requests take 10–26 s; real ones pass the 45 s limit).

**To do:** nothing now. If Google changes its models, run `node e2e/gemini-models.mjs` to see what the key can use.
