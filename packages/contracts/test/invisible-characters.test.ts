import { describe, expect, it } from 'vitest';

import {
  ContentCaptionSchema,
  ContentTitleSchema,
  CreateMediaFolderRequestSchema,
  MediaFolderNameSchema,
  StorySceneGuidanceSchema,
  StorySceneTextSchema,
  hasInvisibleCharacters
} from '../src/index.js';

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
  { label: 'the text of a story scene', accepts: (value) => StorySceneTextSchema.safeParse(`Cena ${value}`).success },
  { label: 'the guidance of a story scene', accepts: (value) => StorySceneGuidanceSchema.safeParse(`Dica ${value}`).success },
  { label: 'the title of a content', accepts: (value) => ContentTitleSchema.safeParse(`Post ${value}`).success },
  { label: 'the caption of a content', accepts: (value) => ContentCaptionSchema.safeParse(`Legenda ${value}`).success }
];

// The emoji sequences of UTS #51 that a phone writes. Each is accepted only whole: the matrix after the list breaks every one of them.
const MAN = 0x1f468;
const WOMAN = 0x1f469;
const GIRL = 0x1f467;
const LAPTOP = 0x1f4bb;
const THUMBS_UP = 0x1f44d;
const POINTING_UP = 0x261d;
const TONE = 0x1f3fd;
const ZWJ = 0x200d;
const KEYCAP = 0x20e3;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const ENGLAND = [BLACK_FLAG, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, CANCEL_TAG];

const SEQUENCES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['a family (ZWJ between three pictographs)', [MAN, ZWJ, WOMAN, ZWJ, GIRL]],
  ['a profession with a skin tone before the ZWJ', [WOMAN, TONE, ZWJ, LAPTOP]],
  ['a couple with a heart (the heart carries the selector 16)', [WOMAN, ZWJ, 0x2764, SELECTOR_16, ZWJ, MAN]],
  ['the rainbow flag (a flag with the selector 16, then ZWJ)', [0x1f3f3, SELECTOR_16, ZWJ, 0x1f308]],
  ['the keycap one with the selector 16', [0x31, SELECTOR_16, KEYCAP]],
  ['the keycap one without the selector 16', [0x31, KEYCAP]],
  ['the keycap number sign', [0x23, SELECTOR_16, KEYCAP]],
  ['the keycap asterisk', [0x2a, SELECTOR_16, KEYCAP]],
  ['the keycap zero', [0x30, KEYCAP]],
  ['the flag of England (a subdivision tag sequence)', ENGLAND],
  ['a skin tone after a base', [THUMBS_UP, TONE]],
  ['a skin tone after a base that is written with the selector 16 before it', [POINTING_UP, SELECTOR_16, TONE]],
  ['a skin tone followed by the selector 16', [THUMBS_UP, TONE, SELECTOR_16]],
  ['the selector 16 after a pictograph', [0x2764, SELECTOR_16]]
];

/** What each sequence above becomes when it is broken: the same characters out of place. */
const BROKEN: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['a ZWJ between two letters', [0x61, ZWJ, 0x62]],
  ['a ZWJ alone', [ZWJ]],
  ['a ZWJ at the end of a family', [MAN, ZWJ, WOMAN, ZWJ]],
  ['a ZWJ at the start of a family', [ZWJ, MAN, ZWJ, WOMAN]],
  ['two ZWJ in a row between pictographs', [MAN, ZWJ, ZWJ, WOMAN]],
  ['a ZWJ between a pictograph and a letter', [MAN, ZWJ, 0x61]],
  ['a ZWJ between a letter and a pictograph', [0x61, ZWJ, MAN]],
  ['a ZWJ between a pictograph and a space', [MAN, ZWJ, 0x20, WOMAN]],
  ['a ZWJ before a skin tone that has no base', [TONE, ZWJ, LAPTOP]],
  ['a ZWNJ where the family has the ZWJ', [MAN, 0x200c, WOMAN]],
  ['a family cut by the grapheme joiner', [MAN, 0x034f, ZWJ, WOMAN]],
  ['a family with a zero-width space inside', [MAN, ZWJ, 0x200b, WOMAN]],
  ['a family with a bidi override inside', [MAN, ZWJ, 0x202e, WOMAN]],
  ['a family with the musical null notehead inside', [MAN, ZWJ, 0x1d159, WOMAN]],
  ['a family with the selector 16 twice', [MAN, SELECTOR_16, SELECTOR_16, ZWJ, WOMAN]],
  ['a family with the text selector 15 inside', [MAN, 0xfe0e, ZWJ, WOMAN]],
  ['the keycap alone', [KEYCAP]],
  ['the keycap after a letter', [0x61, KEYCAP]],
  ['the keycap after a space', [0x20, KEYCAP]],
  ['the keycap twice', [0x31, SELECTOR_16, KEYCAP, KEYCAP]],
  ['the keycap with the selector 16 twice', [0x31, SELECTOR_16, SELECTOR_16, KEYCAP]],
  ['the keycap with the text selector 15', [0x31, 0xfe0e, KEYCAP]],
  ['the keycap with a ZWJ inside', [0x31, ZWJ, KEYCAP]],
  ['a digit with the selector 16 and no keycap', [0x31, SELECTOR_16]],
  ['the keycap after a pictograph', [0x2764, KEYCAP]],
  ['the flag of England without the cancel tag', ENGLAND.slice(0, -1)],
  ['the flag of England without the black flag', ENGLAND.slice(1)],
  ['the cancel tag alone', [CANCEL_TAG]],
  ['a tag letter alone', [0xe0067]],
  ['the black flag and the cancel tag, with no letter between', [BLACK_FLAG, CANCEL_TAG]],
  ['the flag of England and then one more tag letter', [...ENGLAND, 0xe0067]],
  ['the flag of England and then a second cancel tag', [...ENGLAND, CANCEL_TAG]],
  ['a subdivision whose black flag is another pictograph', [0x1f600, ...ENGLAND.slice(1)]],
  ['a subdivision with the tag space inside', [BLACK_FLAG, 0xe0020, 0xe0067, CANCEL_TAG]],
  ['a subdivision with a tag digit inside', [BLACK_FLAG, 0xe0067, 0xe0031, CANCEL_TAG]],
  ['a subdivision with the language tag inside',[BLACK_FLAG, 0xe0001, 0xe0067, CANCEL_TAG]],
  ['a subdivision between letters, cut in the middle by a letter', [BLACK_FLAG, 0xe0067, 0x61, 0xe0062, CANCEL_TAG]],
  ['a skin tone alone', [TONE]],
  ['a skin tone after a letter', [0x61, TONE]],
  ['a skin tone after a pictograph that takes none', [0x2764, TONE]],
  ['a skin tone twice', [THUMBS_UP, TONE, TONE]],
  ['a skin tone with the selector 16 twice', [THUMBS_UP, TONE, SELECTOR_16, SELECTOR_16]],
  ['a skin tone with the text selector 15 after it', [THUMBS_UP, TONE, 0xfe0e]],
  ['a skin tone with the text selector 15 before it', [THUMBS_UP, 0xfe0e, TONE]],
  ['a skin tone and then a second one with the selector 16', [THUMBS_UP, SELECTOR_16, TONE, SELECTOR_16, TONE]],
  // Taking the pictograph out must not join the digit to the keycap: a rule that reads a text twice would see "1" and U+20E3 side by side.
  ['a keycap mark split from its digit by a pictograph', [0x31, 0x2764, KEYCAP]],
  ['a keycap mark split from its digit by a family', [0x31, MAN, ZWJ, WOMAN, KEYCAP]]
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

const around = (codePoints: readonly number[]): string => `Cena ${text(...codePoints)} fim`;

describe('hasInvisibleCharacters and the emoji sequences (#539)', () => {
  it.each(SEQUENCES)('accepts %s whole, alone, between words, twice in a row and after a line break', (_label, codePoints) => {
    const sequence = text(...codePoints);
    for (const value of [sequence, around(codePoints), `${sequence}${sequence}`, `${sequence} ${sequence}`, `a\n${sequence}`]) {
      expect({ value, hidden: hasInvisibleCharacters(value) }).toEqual({ value, hidden: false });
    }
  });

  it.each(SEQUENCES)('refuses %s when a joiner, a keycap or a tag comes right before or after it', (_label, codePoints) => {
    for (const extra of [[ZWJ], [KEYCAP], [CANCEL_TAG], [0xe0067], [SELECTOR_16, SELECTOR_16]]) {
      for (const value of [text(...codePoints, ...extra), text(...extra, ...codePoints)]) {
        expect({ value, hidden: hasInvisibleCharacters(value) }).toEqual({ value, hidden: true });
      }
    }
  });

  it.each(BROKEN)('refuses %s', (_label, codePoints) => {
    for (const value of [text(...codePoints), around(codePoints), `Ima${text(...codePoints)}gens`]) {
      expect({ value, hidden: hasInvisibleCharacters(value) }).toEqual({ value, hidden: true });
    }
  });

  it('does not let a broken sequence be completed by the one next to it', () => {
    expect(hasInvisibleCharacters(text(MAN, ZWJ) + text(WOMAN))).toBe(false);
    expect(hasInvisibleCharacters(text(MAN, ZWJ) + 'x' + text(WOMAN))).toBe(true);
    expect(hasInvisibleCharacters(text(MAN, ZWJ) + ' ' + text(WOMAN))).toBe(true);
    expect(hasInvisibleCharacters(text(0x31, SELECTOR_16) + text(KEYCAP))).toBe(false);
    expect(hasInvisibleCharacters(text(0x31, SELECTOR_16) + 'x' + text(KEYCAP))).toBe(true);
    expect(hasInvisibleCharacters(text(...ENGLAND.slice(0, 4)) + 'x' + text(...ENGLAND.slice(4)))).toBe(true);
  });

  it('keeps refusing the invisible characters that are not part of an emoji, next to a sequence', () => {
    const family = text(MAN, ZWJ, WOMAN);
    for (const [label, codePoint] of INVISIBLE) {
      // The selector 16 right after the woman is the one written by a phone, so it is only wrong where no pictograph comes before it.
      const values = codePoint === SELECTOR_16
        ? [`${text(codePoint)}${family}`, `${family} ${text(codePoint)}`]
        : [`${family}${text(codePoint)}`, `${text(codePoint)}${family}`, `${family} ${text(codePoint)}${family}`];
      for (const value of values) {
        expect({ label, value, hidden: hasInvisibleCharacters(value) }).toEqual({ label, value, hidden: true });
      }
    }
  });
});

describe.each(CONTRACTS)('$label and the emoji sequences (#539)', ({ accepts }) => {
  it.each(SEQUENCES)('accepts %s whole', (_label, codePoints) => {
    expect(accepts(text(...codePoints))).toBe(true);
    expect(accepts(around(codePoints))).toBe(true);
  });

  it.each(BROKEN)('refuses %s', (_label, codePoints) => {
    expect(accepts(text(...codePoints))).toBe(false);
    expect(accepts(around(codePoints))).toBe(false);
  });
});

describe('a folder name made only of an emoji sequence (#539)', () => {
  it.each([
    ['a family', [MAN, ZWJ, WOMAN, ZWJ, GIRL]],
    ['the flag of England', ENGLAND],
    ['a thumbs up with a skin tone', [THUMBS_UP, TONE]]
  ] as const)('refuses %s: a name needs a letter or a number', (_label, codePoints) => {
    expect(MediaFolderNameSchema.safeParse(text(...codePoints)).success).toBe(false);
    expect(MediaFolderNameSchema.safeParse(`Time ${text(...codePoints)}`).success).toBe(true);
  });
});
