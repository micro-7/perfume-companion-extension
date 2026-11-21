/**
 * How many dupes get their price looked up automatically (the best-ranked ones). Pricing a dupe
 * means searching every shop for it, so doing that for a whole Fragrantica carousel (dozens of
 * perfumes) would take many minutes and use up the free Gemini limit. The rest show a
 * "Check price" button that looks up just that one. (4: each lookup then uses roughly half the
 * Gemini requests that 8 did, which matters on a free key with a daily limit.)
 */
export const AUTO_PRICED_DUPES = 4;
