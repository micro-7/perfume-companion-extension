import { describe, expect, it } from 'vitest';
import { isIngredientName, withoutIngredients } from './ingredients';

describe('ingredient filter', () => {
  it('recognises INCI ingredient names, including "Parfum (Fragrance)" and CI colour codes', () => {
    for (const n of ['Alcohol', 'Parfum (Fragrance)', 'Aqua (Water)', 'Limonene', 'Linalool', 'CI 42090', 'Alcohol Denat.']) {
      expect(isIngredientName(n)).toBe(true);
    }
  });

  it('does not treat real scent notes as ingredients', () => {
    for (const n of ['Bergamot', 'Ambroxan', 'Pink Pepper', 'Lavender', 'Cedar', 'Sea Notes', 'Labdanum']) {
      expect(isIngredientName(n)).toBe(false);
    }
  });

  it('drops a list that is mostly ingredients (the Nykaa case)', () => {
    const nykaa = ['Alcohol', 'Parfum (Fragrance)', 'Aqua (Water)', 'Limonene', 'Linalool', 'Coumarin', 'Citral'];
    expect(withoutIngredients(nykaa)).toEqual([]);
  });

  it('keeps real notes and removes a stray ingredient from a notes list', () => {
    expect(withoutIngredients(['Bergamot', 'Pepper', 'Lavender', 'Linalool'])).toEqual(['Bergamot', 'Pepper', 'Lavender']);
  });
});
