# notes-card Specification

## Purpose
Helps the user understand quickly how a perfume smells. It shows the perfume's top, heart and base notes and a short plain-English description of the scent (FR3).

## Requirements

### Requirement: Notes card shows the note pyramid
The Notes card SHALL show the detected perfume's top, heart and base notes as separate groups. Notes found on the page SHALL be used first. Notes missing from the page SHALL be filled in from the LLM's knowledge of the perfume.

#### Scenario: Full pyramid available
- **WHEN** a perfume with known top, heart and base notes is detected
- **THEN** the Notes card shows three labelled groups, Top, Heart and Base, each listing its notes

#### Scenario: Only a flat note list exists
- **WHEN** the perfume's notes are known only as a single list with no top, heart or base split
- **THEN** the Notes card shows them as one "Notes" group instead of guessing the tiers

#### Scenario: A tier is unknown
- **WHEN** a tier's notes are not known (for example, no base notes)
- **THEN** that tier is left out, rather than shown empty or with made-up notes

### Requirement: Plain-English scent description
The Notes card SHALL include a description of how the perfume smells, written in plain, non-technical English and 1 to 3 sentences long (for example "Fresh and peppery, drying down to a soft woody base.").

#### Scenario: Description length
- **WHEN** the Notes card renders for any detected perfume
- **THEN** it includes a description of at least 1 and at most 3 sentences

#### Scenario: Description avoids jargon
- **WHEN** the description is generated
- **THEN** it describes the scent in everyday words (for example fresh, sweet, woody, spicy) and not as a list of note names

### Requirement: Notes card heading identifies the perfume
The Notes card SHALL show the detected perfume's name and brand as its heading, so the user can confirm the right perfume was found.

#### Scenario: Heading shown
- **WHEN** Dior Sauvage is detected
- **THEN** the Notes card heading reads "Sauvage – Dior"

### Requirement: Notes card error state
If the notes cannot be produced, the Notes card SHALL show an error message with a Retry action. The other cards SHALL keep working.

#### Scenario: Notes lookup fails
- **WHEN** the notes request fails while the dupes and prices requests succeed
- **THEN** the Notes card shows an error with Retry, and the Dupes and Prices cards show their results as normal

### Requirement: A page's flat note list gives way to a matching pyramid
When a page lists notes without top, heart and base tiers and the AI's pyramid contains at least half of the page's notes, the card SHALL show the pyramid. Otherwise it SHALL keep the page's list as one group.

#### Scenario: Page lists notes flat, AI knows the pyramid
- **WHEN** the page lists "Ambrox, Elemi resin, Calabrian bergamot, Patchouli, ..." and the AI's pyramid contains most of them
- **THEN** the card shows Top, Heart and Base groups

### Requirement: Notes written with the local model are not stored
Notes that the local Ollama model helped write SHALL be shown but SHALL NOT be saved for later, so a Gemini answer replaces them as soon as one is available. Notes from Gemini are saved for 30 days.

#### Scenario: Local model notes
- **WHEN** the notes come from Ollama
- **THEN** they are shown, and the next lookup of that perfume asks again
