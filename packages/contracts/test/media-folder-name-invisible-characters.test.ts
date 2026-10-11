import { describe, expect, it } from 'vitest';

import { CreateMediaFolderRequestSchema, MediaFolderNameSchema } from '../src/index.js';

// Issue #531, item 2. The display-name rule refuses `\p{Cf}` and nothing more, so "Imagens" plus a code point that
// renders as nothing is a second folder that looks like the default one. Code points are spelled as numbers so the
// invisible characters stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);
const withMiddle = (middle: string): string => `Ima${middle}gens`;

const INVISIBLE_IN_A_FOLDER_NAME: ReadonlyArray<readonly [string, number]> = [
  ['combining grapheme joiner U+034F (Mn)', 0x034f],
  ['variation selector-1 U+FE00', 0xfe00],
  ['variation selector-15 U+FE0E (text presentation)', 0xfe0e],
  ['variation selector-16 U+FE0F after a letter', 0xfe0f],
  ['supplementary variation selector U+E0100', 0xe0100],
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

describe('MediaFolderNameSchema invisible characters (#531)', () => {
  it.each(INVISIBLE_IN_A_FOLDER_NAME)('refuses %s between letters, at the start and at the end', (_label, codePoint) => {
    for (const name of [withMiddle(text(codePoint)), `${text(codePoint)}Imagens`, `Imagens${text(codePoint)}`]) {
      expect({ name, accepted: MediaFolderNameSchema.safeParse(name).success }).toEqual({ name, accepted: false });
    }
  });

  it('refuses them in the body of the route as well, where the name is a folder of the client', () => {
    expect(CreateMediaFolderRequestSchema.safeParse({ name: withMiddle(text(0x034f)) }).success).toBe(false);
  });

  it('keeps the selector 16 that writes an emoji: only right after a pictograph, and once', () => {
    const heart = text(0x2764);
    const selector = text(0xfe0f);

    expect(MediaFolderNameSchema.parse(`Favoritos ${heart}${selector}`)).toBe(`Favoritos ${heart}${selector}`);
    expect(MediaFolderNameSchema.safeParse(`Favoritos ${heart}${selector}${selector}`).success).toBe(false);
    expect(MediaFolderNameSchema.safeParse(`Favoritos ${heart}${text(0xfe0e)}`).success).toBe(false);
    expect(MediaFolderNameSchema.safeParse(`Favoritos ${heart}${selector}${text(0x034f)}`).success).toBe(false);
    expect(MediaFolderNameSchema.safeParse(`Favoritos${selector}`).success).toBe(false);
  });

  it('still accepts the names the folders already had: accents, hyphens, digits and an emoji without selector', () => {
    for (const name of ['Imagens', 'Ensaio fotográfico', 'a-c', 'Abril 2026', 'Pasta ✨ com emoji']) {
      expect({ name, accepted: MediaFolderNameSchema.safeParse(name).success }).toEqual({ name, accepted: true });
    }
  });
});
