// Product pages often list cosmetic ingredients (INCI names) such as "Alcohol, Aqua, Limonene".
// These are not scent notes and must never appear on the Notes card.

const INGREDIENT_WORDS = [
  'alcohol',
  'alcohol denat',
  'aqua',
  'water',
  'eau',
  'parfum',
  'fragrance',
  'parfum fragrance',
  'limonene',
  'linalool',
  'coumarin',
  'citral',
  'geraniol',
  'citronellol',
  'eugenol',
  'isoeugenol',
  'farnesol',
  'benzyl alcohol',
  'benzyl benzoate',
  'benzyl salicylate',
  'benzyl cinnamate',
  'hydroxycitronellal',
  'alpha isomethyl ionone',
  'butylphenyl methylpropional',
  'hexyl cinnamal',
  'amyl cinnamal',
  'cinnamal',
  'cinnamyl alcohol',
  'anise alcohol',
  'evernia prunastri extract',
  'evernia furfuracea extract',
  'bht',
  'butylated hydroxytoluene',
  'ethylhexyl methoxycinnamate',
  'ethylhexyl salicylate',
  'butyl methoxydibenzoylmethane',
  'benzophenone 3',
  'tocopherol',
  'propylene glycol',
  'dipropylene glycol',
  'glycerin',
  'disodium edta',
  'trisodium edta',
  'tetrasodium edta',
  'ci 42090',
  'ci 19140',
  'ci 14700',
  'ci 17200',
  'ci 60730',
];

const SET = new Set(INGREDIENT_WORDS);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ') // "Parfum (Fragrance)" -> "parfum"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isIngredientName(note: string): boolean {
  const n = norm(note);
  return SET.has(n) || /^ci \d{5}$/.test(n);
}

/** Removes ingredient names. If most of a list is ingredients, the whole list is treated as an ingredient list. */
export function withoutIngredients(notes: string[]): string[] {
  if (notes.length === 0) return notes;
  const kept = notes.filter((n) => !isIngredientName(n));
  const removed = notes.length - kept.length;
  return removed / notes.length >= 0.5 ? [] : kept;
}
