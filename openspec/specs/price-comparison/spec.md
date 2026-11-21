# price-comparison Specification

## Purpose
Finds the cheapest place to buy a perfume. It compares its ₹ price across the user's configured shop list, sorts the results cheapest first with links, and shows the savings against the site the user is on (FR5).

## Requirements

### Requirement: Prices are looked up only in the configured shops
The price lookup SHALL search only the shops in the user's shop list. It SHALL NOT search the wider web for other sellers.

#### Scenario: Only configured shops appear
- **WHEN** the shop list contains 10 shops and a lookup runs
- **THEN** every price row in the Prices card belongs to one of those 10 shops

#### Scenario: Empty shop list
- **WHEN** the shop list is empty
- **THEN** the Prices card shows "No shops configured" with a link to the options page, and no price requests are sent

### Requirement: Shop search page is fetched from the user's browser
For each configured shop, the extension SHALL fetch that shop's search results page for the perfume from the user's browser. It SHALL ask the LLM to extract the matching product's ₹ price, its product page URL and an in-stock flag.

#### Scenario: Price extracted from a shop's search page
- **WHEN** a shop's search page for "Dior Sauvage EDT 100ml" lists the product at ₹9,800
- **THEN** that shop's row shows ₹9,800 with a link to the product page taken from the search results

#### Scenario: Wrong product variant is not matched
- **WHEN** a shop's search results include only a different size or concentration than the detected perfume
- **THEN** the row labels the variant it found (for example "50ml") instead of presenting it as an exact match

### Requirement: Grounded search fallback for blocked shops
If a shop's search page cannot be fetched or gives no usable content (blocked, bot-check, error or empty), the extension SHALL fall back to Gemini with Google Search grounding, limited to that shop's domain, to find the price and product URL. Results from the fallback SHALL be marked as "via search".

#### Scenario: Shop blocks the request
- **WHEN** a shop answers the fetch with a bot-check or a 403 error
- **THEN** that shop's price is looked up through grounded search on that shop's domain, and the row is marked "via search"

#### Scenario: Fallback also fails
- **WHEN** both the direct fetch and the grounded search fail to find a price for a shop
- **THEN** the shop is listed at the bottom as "Not found" with no price and no savings

### Requirement: Prices sorted cheapest first with shop links
The Prices card SHALL list shops with a found price in order from lowest to highest ₹ price. Each row SHALL show the shop name, the price formatted in Indian rupees (for example ₹18,000) and a link that opens that shop's product page in a new tab.

#### Scenario: Sorted correctly
- **WHEN** prices of ₹18,000, ₹16,500 and ₹19,200 are found at three shops
- **THEN** the rows appear in the order ₹16,500, ₹18,000, ₹19,200

#### Scenario: Link opens the right product
- **WHEN** the user clicks a shop's row link
- **THEN** a new tab opens on that shop's product page for the perfume, not its home page

### Requirement: Savings against the current site
When the current site's price is known, each cheaper row SHALL show the savings, worked out as the current site's price minus the row's price, together with the current site's name. For example: "Perfume Palace: ₹18,000, you save ₹2,000 compared with Amazon". Rows that cost the same or more SHALL NOT show savings.

#### Scenario: Savings calculated correctly
- **WHEN** the current site is Amazon at ₹20,000 and Perfume Palace lists the perfume at ₹18,000
- **THEN** the Perfume Palace row reads "₹18,000, you save ₹2,000 compared with Amazon"

#### Scenario: More expensive shop
- **WHEN** a shop lists the perfume at ₹21,000 and the current site's price is ₹20,000
- **THEN** that row shows its price with no savings text

#### Scenario: Current site price unknown
- **WHEN** detection did not find a price on the current page
- **THEN** the rows show their prices without savings, and the card says the current site's price could not be read

#### Scenario: Current site is in the shop list
- **WHEN** the current site is also one of the configured shops
- **THEN** its row is marked "You are here" and is used as the savings baseline

### Requirement: Price results stream in per shop
Each shop's row SHALL appear as soon as that shop's lookup finishes. The list SHALL be re-sorted each time a row is added, and a progress count SHALL show while lookups are still running (for example "6 of 10 shops checked").

#### Scenario: Partial results
- **WHEN** 6 of 10 shop lookups have finished
- **THEN** the card shows those 6 results in sorted order and the text "6 of 10 shops checked"

### Requirement: Shops are searched by brand and name only
The extension SHALL type only the perfume's brand and name into a shop's search, without the concentration, and without a leading "Christian" in a brand such as "Christian Dior". Shops match on every word, so extra words make real listings disappear.

#### Scenario: Short search words
- **WHEN** the perfume is "Christian Dior Sauvage Eau De Toilette"
- **THEN** each shop is searched for "Dior Sauvage", and the AI picks the right size and concentration from the results

### Requirement: Only the product listings on a long results page are read
A shop's results page can be hundreds of kilobytes of menus, filters and look-alike products. The extension SHALL give the AI only the product cards that name the perfume, with their price lines, in page order, rather than the top of the page.

#### Scenario: Listing far down the page
- **WHEN** the real listing starts at character 27,000 of a results page, behind menus and look-alikes
- **THEN** it is still included in what the AI reads

### Requirement: A price must be written on the page in rupees
A price taken from a shop's page SHALL be used only if that amount is written on the page and the page mentions rupees. Otherwise it SHALL be dropped, because the AI can convert another currency into a rupee figure that no shop shows.

#### Scenario: Page shows euros
- **WHEN** a shop's page shows "€151.00" and the AI answers 15,500
- **THEN** 15,500 is not shown as a price, and the row says the price was not written on the page in rupees

### Requirement: Look-alikes, samples and implausibly low prices are not shown as the price
A listing SHALL be accepted only if its title contains the perfume's name and its title or link contains the brand. The AI SHALL be told to ignore samples, decants, testers and sizes under 30 ml. A price below 40% of the median of at least four prices SHALL be shown after the real prices with a warning and without a savings figure.

#### Scenario: Look-alike borrowing the name
- **WHEN** the only match is "Al Bait Al Dimashqi Bergamot Pepper Sauvage Eau de Parfum" for Dior Sauvage
- **THEN** the shop shows no price and the reason says it is a different brand

#### Scenario: Decant price among bottle prices
- **WHEN** one shop lists ₹850 and the others ₹8,550 to ₹14,900
- **THEN** the ₹850 row is shown last with a "looks too low" warning and no "you save" text

### Requirement: The shop the user is on uses its own page's price
When the current page belongs to a shop in the list and its price was read from the page, that shop's row SHALL use the page's price and link without a lookup, and SHALL be marked "You are here". Savings text SHALL name the baseline by the shop's configured name.

#### Scenario: On one of the listed shops
- **WHEN** the user is on Friday Charm's Sauvage page showing Rs. 13,000
- **THEN** Friday Charm's row reads ₹13,000, "You are here", and other rows read "you save ₹X compared with Friday Charm"

### Requirement: A shop without a price says why
A row for a shop with no price SHALL show the reason on its own line, such as "the shop page was blocked or empty", "the perfume is not on the shop page" or "web search is unavailable".

#### Scenario: Blocked shop
- **WHEN** a shop answers the search with a bot check and web search is unavailable
- **THEN** its row reads "Not found (search unavailable)" with the reason underneath
