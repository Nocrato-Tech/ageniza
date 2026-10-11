import { describe, expect, it } from 'vitest';

import { CreateMediaFolderRequestSchema, MediaFolderNameSchema, StorySceneTextSchema, hasInvisibleCharacters } from '../src/index.js';

// One rule for every free text a person reads (issue #531 for the folder names, #258 for the story scripts): what renders as
// nothing, or as a space, and is not a control or a separator. The edges live here, once. Each contract that takes such a text is
// run through the same matrix below, so a change in the helper turns every one of them red, and a contract that stopped using it
// would stop agreeing with the helper. Code points are spelled as numbers so the invisible characters stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

const HEART = 0x2764;
const SELECTOR_16 = 0xfe0f;

const INVISIBLE: ReadonlyArray<readonly [string, number]> = [
  ['combining grapheme joiner U+034F (Mn)', 0x034f],
  ['variation selector-1 U+FE00', 0xfe00],
  ['variation selector-15 U+FE0E (text presentation)', 0xfe0e],
  ['variation selector-16 U+FE0F after a letter', 0xfe0f],
  ['supplementary variation selector U+E0100 (VS17)', 0xe0100],
  ['the last supplementary variation selector U+E01EF', 0xe01ef],
  ['Mongolian free variation selector U+180B', 0x180b],
  ['Mongolian free variation selector three U+180D', 0x180d],
  ['Mongolian free variation selector four U+180F', 0x180f],
  ['Khmer inherent vowel U+17B4', 0x17b4],
  ['Khmer inherent vowel U+17B5', 0x17b5],
  ['Braille pattern blank U+2800 (renders as a space)', 0x2800],
  ['musical null notehead U+1D159 (drawn as a space)', 0x1d159],
  ['Hangul filler U+3164', 0x3164],
  ['Hangul half-width filler U+FFA0', 0xffa0],
  ['language tag U+E0001', 0xe0001],
  ['soft hyphen U+00AD', 0x00ad],
  ['zero-width joiner U+200D', 0x200d],
  ['zero-width non-joiner U+200C', 0x200c]
];

/** After a pictograph the selector 16 is the only one let through, and only once. */
const AFTER_A_PICTOGRAPH_REFUSED: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['the selector 16 twice', [HEART, SELECTOR_16, SELECTOR_16]],
  ['the text selector 15 (U+FE0E)', [HEART, 0xfe0e]],
  ['variation selector-1 (U+FE00)', [HEART, 0xfe00]],
  ['the selector right before 16 (U+FE0D)', [HEART, 0xfe0d]],
  ['variation selector-17 (U+E0100)', [HEART, 0xe0100]],
  ['the last selector (U+E01EF)', [HEART, 0xe01ef]],
  ['the selector 16 and then another one (U+FE00)', [HEART, SELECTOR_16, 0xfe00]],
  ['the selector 16 and then the grapheme joiner (U+034F)', [HEART, SELECTOR_16, 0x034f]],
  ['the grapheme joiner and then the selector 16', [HEART, 0x034f, SELECTOR_16]],
  ['a tag character (U+E0020)', [HEART, 0xe0020]]
];

interface Contract {
  readonly label: string;
  readonly accepts: (value: string) => boolean;
}

const CONTRACTS: readonly Contract[] = [
  { label: 'the folder name', accepts: (value) => MediaFolderNameSchema.safeParse(`Pasta ${value}`).success },
  { label: 'the body of the create-folder request', accepts: (value) => CreateMediaFolderRequestSchema.safeParse({ name: `Pasta ${value}` }).success },
  { label: 'the text of a story scene', accepts: (value) => StorySceneTextSchema.safeParse(`Cena ${value}`).success }
];

describe('hasInvisibleCharacters', () => {
  it.each(INVISIBLE)('refuses %s between letters, at the start and at the end', (_label, codePoint) => {
    expect(hasInvisibleCharacters(`Ima${text(codePoint)}gens`)).toBe(true);
    expect(hasInvisibleCharacters(`${text(codePoint)}Imagens`)).toBe(true);
    expect(hasInvisibleCharacters(`Imagens${text(codePoint)}`)).toBe(true);
  });

  it('lets the selector 16 through right after a pictograph, once, and nothing else', () => {
    expect(hasInvisibleCharacters(text(HEART, SELECTOR_16))).toBe(false);
    expect(hasInvisibleCharacters(`Favoritos ${text(HEART, SELECTOR_16)}`)).toBe(false);
    expect(hasInvisibleCharacters(`${text(HEART, SELECTOR_16)}${text(HEART, SELECTOR_16)}`)).toBe(false);
    expect(hasInvisibleCharacters(`Favoritos${text(SELECTOR_16)}`)).toBe(true);
    expect(hasInvisibleCharacters(text(SELECTOR_16))).toBe(true);
  });

  it.each(AFTER_A_PICTOGRAPH_REFUSED)('refuses, right after a pictograph, %s', (_label, codePoints) => {
    expect(hasInvisibleCharacters(`Favoritos ${text(...codePoints)}`)).toBe(true);
  });

  it('accepts the plain text of a name: accents, hyphens, digits and an emoji without a selector', () => {
    for (const name of ['Imagens', 'Ensaio fotográfico', 'a-c', 'Abril 2026', 'Pasta ✨ com emoji', '']) {
      expect({ name, hidden: hasInvisibleCharacters(name) }).toEqual({ name, hidden: false });
    }
  });
});

describe.each(CONTRACTS)('$label runs the same matrix as the helper', ({ accepts }) => {
  it.each(INVISIBLE)('refuses %s between letters, at the start and at the end', (_label, codePoint) => {
    for (const value of [`a${text(codePoint)}b`, `${text(codePoint)}ab`, `ab${text(codePoint)}`]) {
      expect({ value, accepted: accepts(value) }).toEqual({ value, accepted: false });
    }
  });

  it.each(AFTER_A_PICTOGRAPH_REFUSED)('refuses, right after a pictograph, %s', (_label, codePoints) => {
    expect(accepts(text(...codePoints))).toBe(false);
  });

  it('keeps the selector 16 that writes an emoji, once, right after a pictograph', () => {
    expect(accepts(text(HEART, SELECTOR_16))).toBe(true);
    expect(accepts(`${text(HEART, SELECTOR_16)} ${text(HEART, SELECTOR_16)}`)).toBe(true);
    expect(accepts(text(SELECTOR_16))).toBe(false);
  });

  it('still accepts a plain text', () => {
    for (const value of ['Imagens', 'a-c', 'Abril 2026', 'com acento: ação', '✨']) {
      expect({ value, accepted: accepts(value) }).toEqual({ value, accepted: true });
    }
  });
});
