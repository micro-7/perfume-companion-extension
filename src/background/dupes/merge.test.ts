import { describe, expect, it } from 'vitest';
import {
  cleanName,
  isFlanker,
  MAX_DUPES,
  isSamePerfume,
  mergeCandidates,
  normalizeKey,
  normalizeName,
  rankDupes,
  tokenSetSimilarity,
  type Candidate,
} from './merge';

const sauvage = { name: 'Sauvage', brand: 'Dior', concentration: 'Eau de Toilette' };
const llm = (name: string, brand: string, similarity = 80, reason = ''): Candidate => ({ name, brand, source: 'llm', similarity, reason });
const frag = (name: string, brand: string, position: number): Candidate => ({ name, brand, source: 'fragrantica', position });

describe('normalizing names', () => {
  it('drops the brand, "by X", concentration words, accents and punctuation', () => {
    expect(normalizeName('Club de Nuit Intense Man by Armaf', 'Armaf')).toBe('club de nuit intense'); // the masculine tag is not part of the name
    expect(normalizeName('Bleu de Chanel Eau de Parfum', 'Chanel')).toBe('bleu de chanel');
    expect(normalizeName('Armaf Club de Nuit Intense Man', 'Armaf')).toBe('club de nuit intense');
    expect(normalizeName("L'Homme Idéal EDT", 'Guerlain')).toBe('l homme ideal');
  });

  it('keeps a brand that is part of the perfume name, so "Bleu de Chanel" does not shrink to "bleu de"', () => {
    expect(normalizeName('Bleu de Chanel', 'Chanel')).toBe('bleu de chanel');
    expect(isSamePerfume({ name: 'Bleu de Chanel', brand: 'Chanel' }, { name: 'Bleu de Parfum Nuit', brand: 'Chanel' })).toBe(false);
  });

  it('builds the same key for the same perfume written differently', () => {
    expect(normalizeKey('Armaf', 'Club de Nuit Intense Man')).toBe(normalizeKey('ARMAF', 'Club de Nuit Intense Man EDT'));
  });

  it('measures shared words regardless of order', () => {
    expect(tokenSetSimilarity('a b c', 'c b a')).toBe(1);
    expect(tokenSetSimilarity('a b c d', 'a b')).toBe(0.5);
    expect(tokenSetSimilarity('', 'a')).toBe(0);
  });
});

describe('cleanName', () => {
  it('removes a leading brand and a trailing "by Brand"', () => {
    expect(cleanName('Armaf Club de Nuit Intense Man', 'Armaf')).toBe('Club de Nuit Intense Man');
    expect(cleanName('Club de Nuit Intense Man by Armaf', 'Armaf')).toBe('Club de Nuit Intense Man');
    expect(cleanName('armaf club de nuit', 'Armaf')).toBe('club de nuit');
  });

  it('keeps a brand inside the name, and a "by" that is not the brand', () => {
    expect(cleanName('Bleu de Chanel', 'Chanel')).toBe('Bleu de Chanel');
    expect(cleanName('Kiss by Me', 'Armaf')).toBe('Kiss by Me');
  });

  it('never returns an empty name', () => {
    expect(cleanName('Armaf', 'Armaf')).toBe('Armaf');
  });

  it('shows cleaned names in the ranked list, so a dupe is not displayed as "Armaf Club... – Armaf"', () => {
    const r = rankDupes(sauvage, [llm('Armaf Club de Nuit Intense Man', 'Armaf', 85), frag('Club de Nuit Intense Man by Armaf', '', 0)], true);
    expect(r.dupes).toHaveLength(1);
    expect(r.dupes[0]).toMatchObject({ name: 'Club de Nuit Intense Man', brand: 'Armaf', confirmed: true });
  });
});

describe('isSamePerfume', () => {
  it('matches spelling differences with the same brand', () => {
    expect(isSamePerfume({ name: 'Club de Nuit Intense Man', brand: 'Armaf' }, { name: 'Club de Nuit Intense Man by Armaf', brand: 'Armaf' })).toBe(true);
  });

  it('does not match different perfumes or different brands', () => {
    expect(isSamePerfume({ name: 'Club de Nuit Intense Man', brand: 'Armaf' }, { name: 'Club de Nuit Milestone', brand: 'Armaf' })).toBe(false);
    expect(isSamePerfume({ name: 'Eros', brand: 'Versace' }, { name: 'Eros', brand: 'Armaf' })).toBe(false);
  });
});

describe('mergeCandidates', () => {
  it('merges the AI and Fragrantica spellings of the same perfume into one entry', () => {
    const merged = mergeCandidates([llm('Armaf Club de Nuit Intense Man', 'Armaf', 85), frag('Club de Nuit Intense Man by Armaf', 'Armaf', 0)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].llmSimilarity).toBe(85);
    expect(merged[0].fragranticaPosition).toBe(0);
  });

  it('works out the brand from "by X" when a source left it out', () => {
    const merged = mergeCandidates([frag('Club de Nuit Intense Man by Armaf', '', 1)]);
    expect(merged[0]).toMatchObject({ name: 'Club de Nuit Intense Man', brand: 'Armaf' });
  });

  it('drops entries without a name or brand', () => {
    expect(mergeCandidates([llm('', 'X'), llm('Y', '')])).toEqual([]);
  });

  it('keeps the highest AI similarity when the AI lists the same perfume twice', () => {
    const merged = mergeCandidates([llm('Eros', 'Versace', 60), llm('Eros EDT', 'Versace', 90)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].llmSimilarity).toBe(90);
  });
});

describe('the real Fragrantica carousel (user screenshots)', () => {
  it('"Club De Nuit Urban Elixir" (Fragrantica) and "Club de Nuit Urban Man Elixir" (the AI) are one perfume, so it is confirmed and takes one slot', () => {
    const r = rankDupes(sauvage, [llm('Club de Nuit Urban Man Elixir', 'Armaf', 88), frag('Club De Nuit Urban Elixir', 'Armaf', 2)], true);
    expect(r.dupes).toHaveLength(1);
    expect(r.dupes[0]).toMatchObject({ confirmed: true, similarity: 88 });
  });

  it('"Ventana Pour Homme" and "Ventana" are one perfume', () => {
    expect(isSamePerfume({ name: 'Ventana Pour Homme', brand: 'Armaf' }, { name: 'Ventana', brand: 'Armaf' })).toBe(true);
  });

  it("but flankers and the women's version are different perfumes and stay apart", () => {
    expect(isSamePerfume({ name: 'Sauvage', brand: 'Dior' }, { name: 'Sauvage Elixir', brand: 'Dior' })).toBe(false);
    expect(isSamePerfume({ name: 'Club de Nuit Intense Man', brand: 'Armaf' }, { name: 'Club de Nuit Intense Woman', brand: 'Armaf' })).toBe(false);
    expect(isSamePerfume({ name: 'Club de Nuit Intense Man', brand: 'Armaf' }, { name: 'Club de Nuit Urban Man Elixir', brand: 'Armaf' })).toBe(false);
  });

  it('only clearly redundant tags are ignored: Pour Homme and For Men yes, the Homme in LHomme Ideal no', () => {
    expect(normalizeName('Ventana Pour Homme', 'Armaf')).toBe('ventana');
    expect(normalizeName('Dylan Blue For Men', 'Versace')).toBe('dylan blue');
    expect(normalizeName("L'Homme Ideal", 'Guerlain')).toBe('l homme ideal');
    expect(isSamePerfume({ name: "L'Homme Ideal", brand: 'Guerlain' }, { name: "L'Ideal", brand: 'Guerlain' })).toBe(false);
  });

  // The carousel in the order shown on the page, with Dior's own flankers among them
  const carousel = [
    ['Luna Rossa Carbon Eau de Toilette', 'Prada'], ['Sauvage Eau de Parfum', 'Dior'], ['Club De Nuit Urban Elixir', 'Armaf'],
    ['Sauvage Very Cool Spray', 'Dior'], ['Ventana Pour Homme', 'Armaf'], ['Sauvage Parfum', 'Dior'],
    ['Office For Men', 'Fragrance One'], ['Salvo', 'Maison Alhambra'], ['Quasar Brave', 'O Boticario'], ['Hunter Intense', 'Armaf'],
    ['Versace Pour Homme Dylan Blue', 'Versace'], ['Modest Pour Homme Une', 'Afnan'], ['Biografia Assinatura', 'Natura'],
    ['The Icon', 'Antonio Banderas'], ['Extreme Story', 'La Rive'], ['Aromatic Future', 'Zara'], ['Kuro', 'Ajmal'], ['Cool Water Parfum', 'Davidoff'],
  ].map(([name, brand], i) => frag(name, brand, i));

  it("the whole carousel is ranked in page order, Dior's own versions removed", () => {
    const r = rankDupes(sauvage, carousel, true);
    // every perfume on the carousel is there (the 3 Dior ones removed): 15 of the 18, in the order Fragrantica gives
    expect(r.dupes).toHaveLength(15);
    expect(r.dupes.slice(0, 3).map((d) => d.name)).toEqual(['Luna Rossa Carbon Eau de Toilette', 'Club De Nuit Urban Elixir', 'Ventana Pour Homme']);
    expect(r.dupes.map((d) => d.name)).toContain('Kuro');
    expect(r.dupes.map((d) => d.name)).toContain('Cool Water Parfum');
    expect(r.dupes.some((d) => d.brand === 'Dior')).toBe(false);
  });

  it("a carousel entry far along (Kuro, position 16) can still reach the card when it is also the AI's pick", () => {
    const r = rankDupes(sauvage, [...carousel, llm('Kuro', 'Ajmal', 90), llm('Asad', 'Lattafa', 90)], true);
    const names = r.dupes.map((d) => d.name);
    expect(names).toContain('Kuro');
    expect(r.dupes.find((d) => d.name === 'Kuro')?.confirmed).toBe(true);
  });

  it('a confirmed dupe always ranks above one only the AI knows, at the same similarity', () => {
    const r = rankDupes(sauvage, [llm('Only AI', 'X', 90), llm('Both', 'Y', 90), frag('Both', 'Y', 12)], true);
    expect(r.dupes.map((d) => d.name)).toEqual(['Both', 'Only AI']);
  });
});

describe('which dupes are marked as on Fragrantica', () => {
  it('is true for a Fragrantica-only entry and for one both sources name, false for an AI-only one', () => {
    const r = rankDupes(sauvage, [llm('Both', 'B1', 85), frag('Both', 'B1', 3), frag('Only Fragrantica', 'B2', 1), llm('Only AI', 'B3', 90)], true);
    const by = (name: string) => r.dupes.find((d) => d.name === name)!;
    expect(by('Both')).toMatchObject({ confirmed: true, onFragrantica: true });
    expect(by('Only Fragrantica')).toMatchObject({ confirmed: false, onFragrantica: true });
    expect(by('Only AI')).toMatchObject({ confirmed: false, onFragrantica: false });
  });
});

describe('isFlanker', () => {
  it('recognises the original perfume and its flankers from the same brand', () => {
    expect(isFlanker({ name: 'Sauvage', brand: 'Dior' }, sauvage)).toBe(true);
    expect(isFlanker({ name: 'Sauvage Elixir', brand: 'Dior' }, sauvage)).toBe(true);
    expect(isFlanker({ name: 'Dior Sauvage Eau de Parfum', brand: 'Christian Dior' }, sauvage)).toBe(true);
  });

  it('does not remove other perfumes, or same-named ones from another brand', () => {
    expect(isFlanker({ name: 'Dior Homme', brand: 'Dior' }, sauvage)).toBe(false);
    expect(isFlanker({ name: 'Sauvage', brand: 'Some Clone House' }, sauvage)).toBe(false);
  });
});

describe('rankDupes', () => {
  it('ranks a dupe confirmed by both sources above a one-source dupe with the same similarity', () => {
    const r = rankDupes(sauvage, [llm('B Perfume', 'Brand B', 80), llm('A Perfume', 'Brand A', 80), frag('A Perfume', 'Brand A', 2)], true);
    expect(r.dupes.map((d) => d.name)).toEqual(['A Perfume', 'B Perfume']);
    expect(r.dupes[0].confirmed).toBe(true);
    expect(r.dupes[1].confirmed).toBe(false);
  });

  it('ranks by similarity when the same sources apply', () => {
    const r = rankDupes(sauvage, [llm('Low', 'X', 50), llm('High', 'Y', 90), llm('Mid', 'Z', 70)], false);
    expect(r.dupes.map((d) => d.name)).toEqual(['High', 'Mid', 'Low']);
  });

  it('gives an earlier Fragrantica position a higher rank', () => {
    const r = rankDupes(sauvage, [frag('Third', 'X', 2), frag('First', 'Y', 0), frag('Second', 'Z', 1)], true);
    expect(r.dupes.map((d) => d.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('gives Fragrantica-only entries a similarity of 80 minus 2 per position, never below 40', () => {
    const r = rankDupes(sauvage, [frag('A', 'X', 0), frag('B', 'Y', 2), frag('C', 'Z', 40)], true);
    expect(r.dupes.map((d) => d.similarity)).toEqual([80, 76, 40]);
  });

  it('removes the original and its flankers', () => {
    const r = rankDupes(sauvage, [llm('Sauvage Elixir', 'Dior', 95), frag('Sauvage', 'Dior', 0), llm('Club de Nuit Intense Man', 'Armaf', 85), llm('Eros', 'Versace', 60)], true);
    expect(r.dupes.map((d) => d.name)).toEqual(['Club de Nuit Intense Man', 'Eros']);
  });

  it('shows every dupe up to a high cap of 30 (the carousel is about 20-25 long), best first', () => {
    const many = Array.from({ length: 45 }, (_, i) => llm(`P${i}`, `B${i}`, 95 - i));
    const r = rankDupes(sauvage, many, false);
    expect(MAX_DUPES).toBe(30);
    expect(r.dupes).toHaveLength(30);
    expect(r.dupes[0].name).toBe('P0');
    expect(r.few).toBe(false);
    const nine = rankDupes(sauvage, many.slice(0, 9), false);
    expect(nine.dupes).toHaveLength(9); // no longer cut to 5
  });

  it('flags "few" below 2 dupes', () => {
    expect(rankDupes(sauvage, [llm('Only', 'One', 80)], false).few).toBe(true);
    expect(rankDupes(sauvage, [], false)).toMatchObject({ dupes: [], few: true });
    expect(rankDupes(sauvage, [llm('A', 'X'), llm('B', 'Y')], false).few).toBe(false);
  });

  it('records whether Fragrantica data was available and clamps similarity to 0-100', () => {
    const r = rankDupes(sauvage, [llm('A', 'X', 250)], false);
    expect(r.trustedAvailable).toBe(false);
    expect(r.dupes[0].similarity).toBe(100);
  });

  it('gives every dupe a stable key that matches its normalized name', () => {
    const r = rankDupes(sauvage, [llm('Club de Nuit Intense Man by Armaf', 'Armaf', 80)], false);
    expect(r.dupes[0].key).toBe(normalizeKey('Armaf', 'Club de Nuit Intense Man'));
  });
});

describe('names with a list dash from a small model', () => {
  it('drops the leading dash or bullet', () => {
    expect(cleanName('- Asad', 'Lattafa')).toBe('Asad');
    expect(cleanName('• Men - The One', 'Zara')).toBe('Men - The One');
  });
});
