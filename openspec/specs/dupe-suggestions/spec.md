# dupe-suggestions Specification

## Purpose
Finds cheaper alternatives the user can trust. It combines LLM suggestions with data from trusted sites, ranks the results, shows each dupe's best price, and lets the user click a dupe to run a full lookup for it (FR4).

## Requirements

### Requirement: Dupe candidates come from two sources
The extension SHALL collect dupe candidates from two sources: the LLM, which suggests up to 8 dupes for the detected perfume, and trusted-site data, which is Fragrantica's "This perfume reminds me of" list for that perfume.

#### Scenario: Both sources return candidates
- **WHEN** dupes are looked up for Dior Sauvage and both sources respond
- **THEN** candidates from both the LLM and Fragrantica go into the merge step

#### Scenario: Trusted site is unreachable
- **WHEN** Fragrantica's list cannot be used (the page is blocked, web search is unavailable, or the perfume is not found)
- **THEN** dupes are still produced from the LLM source alone, and the card says that trusted-site data was not available

### Requirement: Fragrantica's list is read from the page and checked against it
When the user is on a Fragrantica page, the extension SHALL read the "This perfume reminds me of" list from that page, in the page's order, up to 30 entries. It SHALL NOT show a perfume as Fragrantica's if its name is not written in the page text.

#### Scenario: List read in the page's order
- **WHEN** the user clicks the icon on Fragrantica's Sauvage page whose row starts with Prada Luna Rossa Carbon, Dior Sauvage Eau de Parfum and Armaf Club De Nuit Urban Elixir
- **THEN** the first non-Dior entry of the Dupes card is Luna Rossa Carbon, and Dior's own versions are not listed

#### Scenario: Row that loads only when scrolled to
- **WHEN** the row is not yet in the page when the icon is clicked
- **THEN** the extension scrolls down briefly, for up to about 5 seconds, until the row appears, reads it, and scrolls the page back to where the user had it

#### Scenario: Row never appears
- **WHEN** the row is not in the page text even after scrolling
- **THEN** the card says Fragrantica's list was not on the page and asks the user to scroll to it and click the icon again, and the AI is not asked to read it

#### Scenario: A perfume the AI added from memory
- **WHEN** the AI reads the page and returns a name that is not written in the page text
- **THEN** that name is dropped and is not shown as coming from Fragrantica

### Requirement: Candidates are merged, cross-checked and ranked
The extension SHALL merge candidates that name the same perfume into one entry, rank a dupe named by both sources above a single-source dupe of similar similarity, and remove the original perfume and any flanker of it. Redundant tags such as "Man" or "Pour Homme" SHALL NOT make two names differ.

#### Scenario: Different spellings are merged
- **WHEN** Fragrantica lists "Club De Nuit Urban Elixir" and the AI suggests "Club de Nuit Urban Man Elixir"
- **THEN** one entry appears, marked as confirmed by Fragrantica

#### Scenario: Different perfumes stay apart
- **WHEN** candidates include "Sauvage" and "Sauvage Elixir", or the men's and women's versions of one perfume
- **THEN** they are not merged

#### Scenario: Confirmed dupes rank higher
- **WHEN** dupe A is named by both sources and dupe B by only one, with the same similarity
- **THEN** dupe A is ranked above dupe B

#### Scenario: Original perfume is excluded
- **WHEN** a source lists the detected perfume itself, or a flanker such as "Sauvage Elixir" for "Sauvage"
- **THEN** it does not appear in the dupes list

### Requirement: Dupes card lists every dupe, best first
The Dupes card SHALL list all dupes that survive merging, best first, up to 30, so that the whole Fragrantica carousel is represented. Each SHALL show its name, brand and a similarity indicator. A dupe on Fragrantica's list SHALL carry a mark: "Confirmed by Fragrantica" if the AI also named it, otherwise "On Fragrantica's list". A similarity for a Fragrantica-only entry is an estimate from its place in the list.

#### Scenario: The whole carousel is shown
- **WHEN** Fragrantica's row holds 18 perfumes, 3 of them Dior's own versions
- **THEN** the card lists 15 dupes plus any extra the AI suggested, not just 5

#### Scenario: Every dupe from Fragrantica's list is marked
- **WHEN** Kuro is named by both the AI and Fragrantica, Luna Rossa Carbon only by Fragrantica, and Asad only by the AI
- **THEN** Kuro shows "Confirmed by Fragrantica", Luna Rossa Carbon shows "On Fragrantica's list", and Asad shows no Fragrantica mark

#### Scenario: An AI suggestion that is on Fragrantica's list is marked even if the list reading missed it
- **WHEN** the AI suggests "Asad - Lattafa" and its full name and brand are written in Fragrantica's list text on the page, but the list reading did not return it
- **THEN** the dupe is treated as on Fragrantica's list and carries a Fragrantica mark

#### Scenario: Fragrantica-only entries get an estimated similarity
- **WHEN** a dupe comes only from Fragrantica
- **THEN** its similarity is 80% for the first place, 2 points less for each place after it, and never below 40%

#### Scenario: Fewer than 2 dupes found
- **WHEN** fewer than 2 dupe candidates survive merging
- **THEN** the card shows any dupe it found together with the message "Few or no reliable dupes found"

### Requirement: Prices for the best dupes are looked up automatically, the rest on request
Each dupe's price is its lowest ₹ price across the shop list. The extension SHALL look this up automatically for the 4 best-ranked dupes. Every other dupe SHALL show a "Check price" button that looks up just that dupe. A dupe with no price SHALL show "Price not found".

#### Scenario: Price found for a dupe
- **WHEN** the price lookup finds a dupe at ₹2,400 at Shop A and ₹2,100 at Shop B
- **THEN** the dupe shows "₹2,100 at Shop B" with a link to that shop's product page

#### Scenario: Only the best 4 are priced at once
- **WHEN** the card lists 17 dupes
- **THEN** the first 4 show a loading indicator and then a price or "Price not found", and the other 13 show a "Check price" button

#### Scenario: Check price on one dupe
- **WHEN** the user clicks "Check price" on the 12th dupe
- **THEN** only that dupe is looked up, it shows a loading indicator until its price arrives, and nothing else is cancelled

#### Scenario: Prices fill in after the dupe list
- **WHEN** the dupe list is ready but its prices are still loading
- **THEN** the dupe entries are shown straight away, each with its own loading indicator or button

### Requirement: Clicking a dupe runs the full lookup
Clicking a dupe SHALL run the full lookup (Notes, Dupes and Prices) for that dupe perfume in the same panel, using the dupe's name and brand instead of page detection. The panel SHALL offer a Back action to return to the previous perfume.

#### Scenario: Explore a dupe
- **WHEN** the user clicks the dupe "Club de Nuit Intense Man – Armaf"
- **THEN** the panel shows Notes, Dupes and Prices for that perfume

#### Scenario: Clicking a dupe after Chrome stopped the background worker
- **WHEN** the results are on screen, Chrome has stopped the idle background worker, and the user clicks a dupe or "Check price"
- **THEN** the panel reconnects and that click is carried out (the dupe opens, or its price is looked up); it does not run the original page's lookup again and the click is not lost

#### Scenario: Return to the original perfume
- **WHEN** the user clicks Back after exploring a dupe whose lookup had finished
- **THEN** the panel shows the previous perfume's results again without running the lookup again

#### Scenario: Savings when exploring a dupe
- **WHEN** a dupe is being explored
- **THEN** the Prices card compares savings against the most expensive shop price found, because there is no current-site price

### Requirement: Dupe lists written with the local model are not stored
A dupe list that the local Ollama model helped write SHALL be shown but SHALL NOT be saved for later, so that a Gemini list replaces it as soon as one is available. Lists from Gemini are saved for 30 days. Lists saved by older versions of the extension SHALL NOT be reused.

#### Scenario: Local model list is not kept
- **WHEN** a dupe list comes from Ollama
- **THEN** it is shown, and the next lookup of that perfume asks again

#### Scenario: Old saved list is ignored
- **WHEN** a dupe list saved by an older version is in storage
- **THEN** it is not used and the list is looked up afresh

### Requirement: Dupe names are shown without list marks
A dupe name that starts with a list dash or bullet ("- Asad") SHALL be shown without it.

#### Scenario: Leading dash
- **WHEN** the AI returns "- Asad" for Lattafa
- **THEN** the dupe is shown as "Asad - Lattafa"
