# perfume-detection Specification

## Purpose
Identifies which perfume the user is viewing on any website. It reads the page's text and asks the LLM for the perfume's name, brand, notes and current price, without relying on any site's page layout (FR2).

## Requirements

### Requirement: Page text is extracted on activation
On activation, the extension SHALL read the visible text content and the URL of the active tab and use them as the input for detection. It SHALL NOT rely on site-specific selectors or page layouts.

#### Scenario: Text extracted from an arbitrary site
- **WHEN** the icon is clicked on a perfume product page of a site with no special handling in the extension
- **THEN** the page's visible text and URL are captured and sent for detection

#### Scenario: Very long pages are limited
- **WHEN** the page's visible text is longer than the configured character limit
- **THEN** the text is cut down to that limit, keeping the start of the page and the parts most likely to describe the product, before it is sent to the LLM

### Requirement: LLM identifies the perfume
The extension SHALL send the extracted text to the LLM provider and get back a structured result. The result SHALL contain: whether a perfume was found, the perfume name, the brand, the concentration if stated, the notes if present on the page, and the current site's price in ₹ if shown.

#### Scenario: Perfume identified on Fragrantica
- **WHEN** the icon is clicked on the Fragrantica page for Dior Sauvage
- **THEN** the detected name is "Sauvage" and the brand is "Dior"

#### Scenario: Perfume identified on a retail site
- **WHEN** the icon is clicked on an Amazon.in product page for Dior Sauvage EDT
- **THEN** the detected name is "Sauvage", the brand is "Dior", and the current site price is the ₹ price shown on the page

#### Scenario: Correct across at least three different sites
- **WHEN** detection is tested on perfume product pages from at least 3 different sites (for example Fragrantica, Amazon and Sephora or Nykaa)
- **THEN** the correct name and brand are identified on every one of them

#### Scenario: Notes missing from the page
- **WHEN** the page names a perfume but lists no notes
- **THEN** the perfume is still detected and the notes are left empty for the Notes card to fill in

### Requirement: No perfume detected message
If the LLM reports that no perfume is on the page, or the detection result has no name or no brand, the panel SHALL show a clear "No perfume detected on this page" message. It SHALL NOT show the Notes, Dupes or Prices cards.

#### Scenario: Non-perfume page
- **WHEN** the icon is clicked on a news article that is not about a perfume
- **THEN** the panel shows "No perfume detected on this page"
- **AND** no notes, dupe or price lookups are started

### Requirement: Detection drives the parallel lookups
After a perfume is detected, the extension SHALL start the notes, dupes and price lookups at the same time, all using the same detected perfume.

#### Scenario: Lookups start together
- **WHEN** a perfume is detected
- **THEN** the notes, dupes and prices lookups all start without waiting for each other

### Requirement: Detection errors are reported
If detection fails because no LLM provider is available, the request fails or the response cannot be parsed, the panel SHALL show an error message that explains what went wrong and offers a Retry action.

#### Scenario: LLM unavailable
- **WHEN** both Gemini and Ollama are unavailable during detection
- **THEN** the panel shows an error saying no AI provider is reachable, with a Retry button

### Requirement: The current site's price must be written on the page
A price for the current page SHALL come from the page's own data in rupees, or from the AI only if that amount is written on the page in rupees. A page that shows another currency SHALL give no price, so that no savings are measured against an invented figure.

#### Scenario: Page shows euros
- **WHEN** the page shows "€151.00" and the AI answers 15,500
- **THEN** the current price is unknown, no "you save" figures are shown against it, and the Prices card says the current site's price could not be read

### Requirement: A shop title is reduced to the perfume's name
The extension SHALL reduce a whole shop title to the perfume's name, dropping the brand, a bracketed word, "Spray", "For Men", sizes and "Eau de Toilette" (which becomes the concentration). A name that is already clean SHALL be left as it is.

#### Scenario: A shop title becomes a name shops can find
- **WHEN** the model returns "Christian Dior Sauvage Eau de Toilette Spray For Men (Citrus)" for brand "Christian Dior"
- **THEN** the perfume is "Sauvage" with concentration "Eau de Toilette", and the shops are searched with "Dior Sauvage"

#### Scenario: Clean names are not changed
- **WHEN** the name is "Sauvage Parfum", "Eau Sauvage" or "Ventana Pour Homme"
- **THEN** it stays exactly as it is

### Requirement: The local model's page price and "no perfume" answers are checked
When the local model answers, the extension SHALL NOT use a page price that the page shows rarely when another price is shown at least 3 times and 3 times as often, and SHALL ask once more when it says "no perfume" about a page with a rupee price and a buy button. Gemini answers SHALL be used as they are, with no extra request.

#### Scenario: Another product's price on the page
- **WHEN** the local model gives ₹298 for a page that shows ₹17,900 five times and ₹298 once
- **THEN** the page price used for savings is ₹17,900

#### Scenario: Second try on a shop page
- **WHEN** the local model says "not a perfume" for a page with a rupee price and an "Add to cart" button
- **THEN** it is asked once more, and the second answer is used

#### Scenario: Gemini and non-shop pages are not retried
- **WHEN** Gemini says "not a perfume", or the page has no price and buy button
- **THEN** no second request is made

### Requirement: The local model's perfume must be the one named by the page
When the local model answers, the extension SHALL accept the perfume only if its name is in the page title or address, and SHALL otherwise ask once more, pointing out the title and address. If the answer is still not the page's perfume, it SHALL use the perfume named in a Fragrantica address, or report that no perfume was detected.

#### Scenario: Local model names a perfume from the sidebar
- **WHEN** the user is on fragrantica.com/perfume/Dior/Sauvage-31861.html and the local model answers "Cool Water by YVIDOFF" twice
- **THEN** the panel shows Sauvage by Dior, read from the address

#### Scenario: A wrong perfume is not shown
- **WHEN** a shop page's title names Sauvage and the local model answers "Cool Water" twice
- **THEN** the panel says no perfume was detected

### Requirement: The extra check never makes things worse
If the extra request fails, the first answer SHALL stand, as it would have without the check. Gemini answers SHALL be used as they are, with no extra request.

#### Scenario: The extra request fails
- **WHEN** the second request returns an error from Ollama
- **THEN** no error is shown for it; the first answer (or, on Fragrantica, the address) is used

#### Scenario: Gemini is unchanged
- **WHEN** Gemini answers, whatever the perfume
- **THEN** its answer is used and no second request is made

### Requirement: A brand repeated as the name is not a perfume name
The local model's answer SHALL NOT be accepted when the perfume's "name" is only the brand again, and on a Fragrantica perfume page SHALL be accepted only if the name contains, or is part of, the name in the address.

#### Scenario: Brand given as the name
- **WHEN** the user is on fragrantica.com/perfume/Maison-Martin-Margiela/Up-At-Dawn-120743.html and the local model answers name "Maison Martin Margiela" for brand "Maison Martin Margiela"
- **THEN** the panel shows "Up At Dawn" by Maison Martin Margiela, read from the address
