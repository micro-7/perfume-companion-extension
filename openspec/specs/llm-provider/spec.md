# llm-provider Specification

## Purpose
Provides the AI behind detection, notes, dupes and price extraction. It uses the Gemini API with the user's own key and switches automatically to a local Ollama model when Gemini's free-tier quota runs out. Secrets are kept out of the codebase.

## Requirements

### Requirement: Gemini API key is user-provided and stored locally
The Gemini API key SHALL be entered by the user on the options page and stored only in extension storage on the user's device. No API key SHALL appear in the source code, the bundled files or the build output.

#### Scenario: Key saved
- **WHEN** the user enters a Gemini API key on the options page and saves it
- **THEN** the key is kept in extension storage and later lookups use it

#### Scenario: Codebase contains no key
- **WHEN** the repository and the built extension package are searched for Gemini key patterns (`AIza`)
- **THEN** no match is found

#### Scenario: Key is masked
- **WHEN** the options page shows a saved key
- **THEN** the key is masked, with only its last 4 characters visible

### Requirement: Gemini is the primary provider
All LLM requests SHALL go to the Gemini API first when a Gemini key is configured.

#### Scenario: Normal request
- **WHEN** a Gemini key is configured and Gemini's quota is not used up
- **THEN** detection, notes, dupes and price-extraction requests are answered by Gemini

### Requirement: Automatic fallback to Ollama when the quota runs out
When Gemini rejects a request because a rate or quota limit is exhausted (HTTP 429 or a quota error), the extension SHALL retry that request on the configured local Ollama model without asking the user. Gemini SHALL then be skipped until its cooldown ends (by default, until the time Gemini returns, or 60 seconds).

#### Scenario: Quota exhausted mid-lookup
- **WHEN** Gemini returns HTTP 429 for the notes request
- **THEN** the notes request is retried on Ollama, the Notes card still renders, and the panel shows a small "Using local model" indicator

#### Scenario: Cooldown ends
- **WHEN** the Gemini cooldown has ended
- **THEN** the next request goes to Gemini again

#### Scenario: No Gemini key
- **WHEN** no Gemini key is configured but Ollama is reachable
- **THEN** all requests go to Ollama

### Requirement: Automatic fallback to Ollama when Gemini is busy or unreachable
When a Gemini request still fails with a server error, a timeout or a connection failure after waiting and retrying, the extension SHALL answer that request with the local Ollama model instead of showing an error. It SHALL NOT do this for a rejected API key or an unreadable answer.

#### Scenario: Gemini keeps answering 503
- **WHEN** Gemini answers HTTP 503 ("high demand") to a request and to its retries, which wait 2 s and then 6 s
- **THEN** the request is answered by Ollama and the panel shows the "Using local model" indicator

#### Scenario: One busy moment does not move later requests
- **WHEN** a request fell back to Ollama because Gemini was busy and Gemini then recovers
- **THEN** the next request goes to Gemini again, without waiting for a cooldown

#### Scenario: Gemini cannot be reached or takes too long
- **WHEN** a Gemini request cannot connect, or gets no answer within 45 seconds
- **THEN** it is answered by Ollama

#### Scenario: A bad key is still shown
- **WHEN** Gemini rejects the API key
- **THEN** the panel shows an error about the key and does not use Ollama

#### Scenario: Both are unavailable
- **WHEN** Gemini is busy and Ollama is not reachable
- **THEN** the panel says Gemini is busy or not reachable and that Ollama is not reachable, and does not call it a quota problem

### Requirement: A refused web search does not affect ordinary answers
Google Search grounding has its own quota, which some free keys do not have at all. When it is refused, the extension SHALL stop sending web-search requests for a while and keep sending ordinary requests to Gemini.

#### Scenario: Web search refused, answers continue on Gemini
- **WHEN** Gemini refuses a web-search request with a quota error
- **THEN** later web-search requests fail fast as "search unavailable" until the time Gemini gave (30 minutes if none), while notes, dupes and price extraction keep using Gemini

### Requirement: Grounded search has no Ollama equivalent
Requests that need Google Search grounding (the blocked-shop price fallback) SHALL NOT be sent to Ollama. While Gemini is unavailable, those shops SHALL be reported as "Not found (search unavailable)".

#### Scenario: Grounding needed during cooldown
- **WHEN** a shop blocks direct fetching while Gemini is in cooldown
- **THEN** that shop's row reads "Not found (search unavailable)" and no grounded request is sent to Ollama

### Requirement: Ollama model is configurable
The options page SHALL let the user set the Ollama server URL (default `http://localhost:11434`) and choose a model from the models installed on that server. If the user has not chosen one, the extension SHALL pick the best available installed model by a documented default order.

#### Scenario: Model list loaded
- **WHEN** the user opens the options page and Ollama is running
- **THEN** a dropdown lists the installed Ollama models

#### Scenario: Auto-selected model
- **WHEN** no model has been chosen and Ollama has several models installed
- **THEN** the extension uses the highest-priority installed model from its default order, and the options page shows which one it picked

### Requirement: Ollama connectivity guidance
If Ollama cannot be reached, or it rejects the extension's origin with HTTP 403, the options page and any error the panel shows SHALL explain how to fix it, including setting `OLLAMA_ORIGINS` to allow `chrome-extension://<extension-id>`.

#### Scenario: Origin not allowed
- **WHEN** Ollama returns 403 to a request from the extension
- **THEN** the message tells the user to set `OLLAMA_ORIGINS` to include the extension's origin and restart Ollama, and shows the exact origin value

#### Scenario: Test connection
- **WHEN** the user clicks "Test connection" for Ollama on the options page
- **THEN** the page shows either success with the number of models found, or the specific failure reason

### Requirement: Structured responses are validated
Every LLM response SHALL be parsed as JSON and checked against the shape that request expects. An invalid response SHALL be retried once. If it is still invalid, the extension SHALL report an error for that card.

#### Scenario: Malformed response
- **WHEN** the model returns text that is not valid JSON for the detection request
- **THEN** the request is retried once, and if it fails again the panel shows a detection error with Retry

### Requirement: Default model and request limits
The default Gemini model SHALL be `gemini-flash-lite-latest`, and an older saved default (`gemini-flash-latest`) SHALL be replaced by it. A Gemini request SHALL give up after 45 seconds. A Gemini server error SHALL be retried twice after waiting 2 and then 6 seconds, but a request that timed out SHALL NOT be retried.

#### Scenario: Old default model saved
- **WHEN** the saved model is `gemini-flash-latest`
- **THEN** `gemini-flash-lite-latest` is used

#### Scenario: Hung request
- **WHEN** Gemini does not answer within 45 seconds
- **THEN** the request ends and is answered by Ollama, without further retries

### Requirement: The saved Gemini key can be removed
The options page SHALL show a "Remove key" button next to a saved key. Pressing it SHALL delete the key at once, without pressing Save, and from then on the extension SHALL use the local model only.

#### Scenario: Remove the key
- **WHEN** the user presses "Remove key"
- **THEN** the saved key is deleted, the empty key box is shown, and it stays empty after the page is reloaded

#### Scenario: Saving an empty box keeps the key
- **WHEN** the user presses "Replace key", leaves the box empty and presses Save
- **THEN** the existing key is kept (removing is done only with "Remove key")
