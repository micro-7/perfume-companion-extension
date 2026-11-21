# panel-activation Specification

## Purpose
Controls when the extension becomes active. It stays idle until the user clicks the toolbar icon, then opens a side panel on the current tab and shows a loading state while the lookup runs (FR1).

## Requirements

### Requirement: Idle until the toolbar icon is clicked
The extension SHALL NOT inject scripts, read page content, make network requests or show UI on any page until the user clicks the extension's toolbar icon on that tab.

#### Scenario: Browsing without clicking the icon
- **WHEN** the user loads and browses perfume product pages without clicking the toolbar icon
- **THEN** no side panel or other extension UI appears
- **AND** the extension makes no network requests, which can be checked in the service worker's DevTools Network tab

#### Scenario: Page load does not trigger activation
- **WHEN** a new page finishes loading in a tab where the icon has not been clicked
- **THEN** the extension does not open the side panel and does not read the page

### Requirement: Clicking the icon opens the side panel
When the user clicks the toolbar icon, the extension SHALL open its side panel on the right side of the current tab's window and start a lookup for the active page.

#### Scenario: Icon click opens the panel
- **WHEN** the user clicks the toolbar icon on any web page
- **THEN** the side panel opens on the right of the current tab
- **AND** a lookup for the active page starts

#### Scenario: Clicking the icon again while the panel is open
- **WHEN** the side panel is already open and the user clicks the toolbar icon again on a different page
- **THEN** the extension starts a new lookup for the page that is now active

### Requirement: Loading state while the lookup runs
The side panel SHALL show a loading state from the moment it opens until the perfume is identified or detection fails. Each card SHALL show its own loading state until its data arrives.

#### Scenario: Loading indicator on open
- **WHEN** the side panel opens and the lookup has not finished
- **THEN** the panel shows a visible loading indicator instead of empty or stale content

#### Scenario: Cards fill in independently
- **WHEN** the Notes data arrives before the Dupes and Prices data
- **THEN** the Notes card shows its content while the Dupes and Prices cards keep showing loading indicators

### Requirement: Restricted pages are handled
When the icon is clicked on a page the extension cannot read, such as `chrome://` pages, the Chrome Web Store or the browser's PDF viewer, the panel SHALL show a message saying that this page cannot be read.

#### Scenario: Icon clicked on a browser-internal page
- **WHEN** the user clicks the toolbar icon on a `chrome://settings` page
- **THEN** the side panel opens and shows a message that this page cannot be read
- **AND** no LLM request is sent

### Requirement: User can close the panel
The user SHALL be able to close the side panel at any time with Chrome's own side panel close control. Closing it SHALL stop any results from still being shown for that lookup.

#### Scenario: Closing mid-lookup
- **WHEN** the user closes the side panel while a lookup is still running
- **THEN** the panel closes and no further UI from that lookup appears

### Requirement: A lookup survives the background worker being stopped
Chrome stops an extension's background worker after about 30 seconds of inactivity. While a lookup runs, the extension SHALL keep the worker active. If the worker is stopped anyway, the panel SHALL say it is reconnecting, reconnect, and run the lookup again from the saved results. After 3 failed attempts it SHALL show a "Try again" button instead of a loading indicator.

#### Scenario: Worker stopped mid-lookup
- **WHEN** the background worker is stopped while the cards are still loading
- **THEN** the panel shows "Reconnecting", reconnects, and finishes with all shops and dupes shown and nothing left loading

#### Scenario: Reconnecting keeps failing
- **WHEN** 3 reconnect attempts fail
- **THEN** the panel shows "Try again" and no endless loading indicator
