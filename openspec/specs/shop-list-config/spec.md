# shop-list-config Specification

## Purpose
Lets the user decide which shops the extension compares prices across. Shops are added and removed on an options page, and the list persists across browser restarts (FR6).

## Requirements

### Requirement: Options page lists configured shops
The extension SHALL provide an options page, reachable from the extension's details and from a link in the side panel. The page SHALL list every configured shop with its name and search URL pattern.

#### Scenario: Open options
- **WHEN** the user opens the extension's options page
- **THEN** it shows the current shop list, each entry with its name and search URL pattern

### Requirement: User can add a shop
The user SHALL be able to add a shop by giving a display name and a search URL pattern that contains the `{query}` placeholder (for example `https://www.example.in/search?q={query}`). The extension SHALL reject an entry with a missing name, an invalid URL, no `{query}` placeholder, or the same domain as an existing shop.

#### Scenario: Valid shop added
- **WHEN** the user adds "Perfume Palace" with pattern `https://perfumepalace.in/search?q={query}`
- **THEN** the shop appears in the list and is used in the next price lookup

#### Scenario: Invalid pattern rejected
- **WHEN** the user tries to add a shop whose URL has no `{query}` placeholder
- **THEN** the shop is not saved and an inline error explains that `{query}` is required

#### Scenario: Duplicate domain rejected
- **WHEN** the user adds a shop whose domain is already in the list
- **THEN** the shop is not saved and an inline error says the shop already exists

### Requirement: Adding a shop requests access to its site
When a shop is added, the extension SHALL ask Chrome for host permission for that shop's domain. If the user denies it, the shop SHALL still be saved, and its lookups SHALL use the grounded search fallback only.

#### Scenario: Permission granted
- **WHEN** the user adds a shop and accepts Chrome's permission prompt
- **THEN** that shop's search pages are fetched directly during price lookups

#### Scenario: Permission denied
- **WHEN** the user denies the permission prompt
- **THEN** the shop is saved with a "search only" label, and its prices come only from the grounded search fallback

### Requirement: User can remove a shop
The user SHALL be able to remove any shop from the list. Removed shops SHALL NOT be used in later price lookups.

#### Scenario: Shop removed
- **WHEN** the user removes "Perfume Palace"
- **THEN** it disappears from the list and does not appear in later Prices or dupe-price results

### Requirement: Shop list persists across restarts
Changes to the shop list SHALL be saved to extension storage straight away and SHALL still be there after the browser is closed and reopened.

#### Scenario: Survives a browser restart
- **WHEN** the user adds two shops, removes one, then fully quits and restarts Chrome
- **THEN** the options page shows the updated list, and price lookups use it

### Requirement: Shop list can be seeded from a config file
The extension SHALL support a bundled default shop list file. This file SHALL be used only when no shop list has been saved yet, so the user can provide their roughly 10 shops at build time.

#### Scenario: First run with seed file
- **WHEN** the extension is installed for the first time and the bundled defaults file lists shops
- **THEN** those shops appear in the options page and are saved to storage

#### Scenario: Seed does not overwrite user edits
- **WHEN** the user has already edited the shop list and the extension is reloaded or updated
- **THEN** the saved list is kept, and the defaults file does not overwrite it
