import { describe, expect, it } from 'vitest';

import { ClientNameSchema, DisplayNameSchema, createDisplayNameSchema } from '../src/index.js';

// Issue #427 (review of #426). The unique index of an active client name folds case and runs of
// `[[:space:]]` and nothing else, so every character that renders as nothing (or as a space) and is
// not already refused by the shared display-name rule forges a homonym of an active name. The rule
// lives in `ClientNameSchema` only: a person has no unique index, and `createDisplayNameSchema` is
// the owner's decision of 2026-10-08 to leave alone.

/** Code points are spelled as numbers so the invisible characters stay visible in this file. */
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

const WITH_SUFFIX = (middle: string): string => `Ca${middle}fe Central`;

/** One entry per class of the review: the code point and why it forges a lookalike. */
const INVISIBLE_IN_A_CLIENT_NAME: ReadonlyArray<readonly [string, number]> = [
  ['combining grapheme joiner U+034F (Mn)', 0x034f],
  ['variation selector-1 U+FE00', 0xfe00],
  ['variation selector-15 U+FE0E (text presentation)', 0xfe0e],
  ['variation selector-16 U+FE0F after a letter', 0xfe0f],
  ['supplementary variation selector U+E0100', 0xe0100],
  ['the last supplementary variation selector U+E01EF', 0xe01ef],
  ['Mongolian free variation selector U+180B', 0x180b],
  ['Mongolian free variation selector three U+180D', 0x180d],
  ['Mongolian vowel separator U+180E', 0x180e],
  ['Khmer inherent vowel U+17B4', 0x17b4],
  ['Khmer inherent vowel U+17B5', 0x17b5],
  ['Braille pattern blank U+2800 (renders as a space)', 0x2800],
  ['language tag U+E0001', 0xe0001],
  ['tag space U+E0020', 0xe0020],
  ['soft hyphen U+00AD', 0x00ad],
  ['Arabic letter mark U+061C', 0x061c],
  ['Hangul filler U+3164', 0x3164]
];

describe('ClientNameSchema invisible characters (#427)', () => {
  it.each(INVISIBLE_IN_A_CLIENT_NAME)('refuses %s between letters', (_label, codePoint) => {
    expect(ClientNameSchema.safeParse(WITH_SUFFIX(text(codePoint))).success).toBe(false);
  });

  it.each(INVISIBLE_IN_A_CLIENT_NAME)('refuses %s at the start and at the end', (_label, codePoint) => {
    expect(ClientNameSchema.safeParse(`${text(codePoint)}Padaria Central`).success).toBe(false);
    expect(ClientNameSchema.safeParse(`Padaria Central${text(codePoint)}`).success).toBe(false);
  });

  it('refuses a name made of a Braille blank and a word, which would render as a plain space', () => {
    expect(ClientNameSchema.safeParse(`Cafe${text(0x2800)}Central`).success).toBe(false);
  });

  // The owner's decision of 2026-10-08 (#436): a client name takes no emoji. The four names below
  // are the ones of the review of #431; each pair forges a homonym with its plain twin.
  const heart = text(0x2764);
  const house = text(0x1f3e0);

  it('refuses a pictograph, with or without the selector 16, and a ZWJ next to one', () => {
    for (const name of [
      `Café ${heart}${text(0xfe0f)}`,
      `Casa ${house}`,
      `Casa ${house}${text(0xfe0f)}`,
      `Cafe ${heart}${text(0x200d)}Central`,
      `Amor ${heart}${text(0xfe0f)} Doce`,
      `Familia ${text(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467)}`,
      `Fogo ${text(0x2764, 0xfe0f, 0x200d, 0x1f525)}`
    ]) {
      expect(ClientNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('refuses a pictograph on its own, which no other rule would catch', () => {
    // No selector, no joiner: only the pictograph rule can refuse these.
    for (const name of [`Casa ${house}`, `Amor ${heart} Doce`, `${text(0x1f600)} Padaria`, `Padaria ${text(0x2b50)}`]) {
      expect(ClientNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('refuses the selector 16 on its own, after a pictograph or after anything else', () => {
    expect(ClientNameSchema.safeParse(`Cafe${text(0xfe0f)} Central`).success).toBe(false);
    expect(ClientNameSchema.safeParse(`Cafe 1${text(0xfe0f)}`).success).toBe(false);
    expect(ClientNameSchema.safeParse(`Amor ${text(0x2764, 0xfe0f, 0xfe0f)}`).success).toBe(false);
    expect(ClientNameSchema.safeParse(`Amor ${text(0x2764)} ${text(0xfe0f)}Doce`).success).toBe(false);
  });

  // The owner's exception of 2026-10-08 (#436): the copyright, registered and trademark signs are
  // pictographic for Unicode but common in a company name, so they stay. Everything else does not.
  const MARK_SIGNS: ReadonlyArray<readonly [string, number]> = [['copyright', 0x00a9], ['registered', 0x00ae], ['trademark', 0x2122]];

  it.each(MARK_SIGNS)('keeps the %s sign in a client name, at the start, in the middle and at the end', (_label, codePoint) => {
    const sign = text(codePoint);
    for (const name of [`${sign} Studio`, `Marca${sign}`, `Marca ${sign} Central`]) {
      expect(ClientNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('keeps the names of the owner decision', () => {
    for (const name of [`Nike${text(0x00ae)}`, `Marca${text(0x2122)}`, `${text(0x00a9)} Studio`]) {
      const parsed = ClientNameSchema.safeParse(name);
      expect(parsed.success, name).toBe(true);
      expect(parsed.data).toBe(name);
    }
  });

  it.each(MARK_SIGNS)('refuses the selector 16 after the %s sign, which would forge a homonym of the plain name', (_label, codePoint) => {
    expect(ClientNameSchema.safeParse(`Nike${text(codePoint, 0xfe0f)}`).success).toBe(false);
    expect(ClientNameSchema.safeParse(`Nike${text(codePoint, 0xfe0f)} Studio`).success).toBe(false);
  });

  it.each(MARK_SIGNS)('refuses a joiner beside the %s sign, which would forge a homonym of the plain name', (_label, codePoint) => {
    for (const joiner of [0x200c, 0x200d]) {
      expect(ClientNameSchema.safeParse(`Nike${text(codePoint, joiner)}Studio`).success, `after ${joiner.toString(16)}`).toBe(false);
      expect(ClientNameSchema.safeParse(`Nike${text(joiner, codePoint)} Studio`).success, `before ${joiner.toString(16)}`).toBe(false);
    }
  });

  it.each(MARK_SIGNS)('refuses a joiner that only a combining mark separates from the %s sign (#440)', (_label, codePoint) => {
    for (const joiner of [0x200c, 0x200d]) {
      expect(ClientNameSchema.safeParse(`Nike${text(codePoint, 0x0301, joiner)}Studio`).success, `after one mark, ${joiner.toString(16)}`).toBe(false);
      expect(ClientNameSchema.safeParse(`Nike${text(codePoint, 0x0301, 0x0302, joiner)}Studio`).success, `after two marks, ${joiner.toString(16)}`).toBe(false);
      expect(ClientNameSchema.safeParse(`Nike${text(joiner, 0x0301, codePoint)} Studio`).success, `before, ${joiner.toString(16)}`).toBe(false);
    }
  });

  it('refuses the combining keycap, with or without the selector 16, since "1" + U+20E3 is an emoji', () => {
    for (const name of [`Mesa 1${text(0x20e3)}`, `Mesa 1${text(0xfe0f, 0x20e3)}`, `Mesa #${text(0x20e3)}`, `${text(0x20e3)}Mesa`]) {
      expect(ClientNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  // Not `Extended_Pictographic`, but they draw as an emoji, and the owner decided "no emoji".
  it('refuses a flag and every regional indicator on its own', () => {
    expect(ClientNameSchema.safeParse(`Loja ${text(0x1f1e7, 0x1f1f7)}`).success).toBe(false);
    for (let codePoint = 0x1f1e6; codePoint <= 0x1f1ff; codePoint += 1) {
      expect(ClientNameSchema.safeParse(`Loja ${text(codePoint)}`).success, codePoint.toString(16)).toBe(false);
    }
  });

  it('refuses every skin tone modifier, alone or after an emoji', () => {
    for (let codePoint = 0x1f3fb; codePoint <= 0x1f3ff; codePoint += 1) {
      expect(ClientNameSchema.safeParse(`Loja ${text(codePoint)}`).success, codePoint.toString(16)).toBe(false);
      expect(ClientNameSchema.safeParse(`Loja ${text(0x1f44d, codePoint)}`).success, codePoint.toString(16)).toBe(false);
    }
  });

  it('still refuses the other pictographic symbols', () => {
    for (const codePoint of [0x2605, 0x2714, 0x2764, 0x203c, 0x2139]) {
      expect(ClientNameSchema.safeParse(`Nota ${text(codePoint)}`).success, codePoint.toString(16)).toBe(false);
    }
  });

  it('keeps a name with no emoji and the text that is not pictographic', () => {
    for (const name of ['Cafe Central', 'Café Central 24h', 'Padaria & Cia', 'Ana-Maria #1']) {
      expect(ClientNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('keeps the persian ZWNJ and the combining marks that are not default-ignorable', () => {
    expect(ClientNameSchema.safeParse(`${text(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645)} Cafe`).success).toBe(true);
    expect(ClientNameSchema.safeParse(`Cafe${text(0x0301)} Central`).success).toBe(true);
  });

  it('refuses a joiner between Latin letters even after a mark that does not compose (the lookbehind keeps its marks)', () => {
    // NFC cannot compose "q" with U+0301, so the mark is still there when the joiner is looked at.
    expect(ClientNameSchema.safeParse(`q${text(0x0301, 0x200d)}x Central`).success).toBe(false);
    expect(ClientNameSchema.safeParse(`q${text(0x0301, 0x0302, 0x200c)}x Central`).success).toBe(false);
    // With no mark the plain case is refused as before.
    expect(ClientNameSchema.safeParse(`q${text(0x200d)}x Central`).success).toBe(false);
    // A joiner that follows a non-Latin letter is not the Latin lookalike.
    expect(ClientNameSchema.safeParse(`${text(0x645, 0x200c)}x Central`).success).toBe(true);
  });
});

describe('createDisplayNameSchema keeps the owner decision of 2026-10-08 (#427, #436)', () => {
  it('still accepts, for a person, the characters a client name now refuses', () => {
    for (const name of [`Ana ${text(0x2764, 0xfe0f)} Maria`, `Ana ${text(0x1f3e0)} Maria`, `Familia ${text(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467)}`]) {
      expect(DisplayNameSchema.safeParse(name).success, name).toBe(true);
      expect(createDisplayNameSchema(80).safeParse(name).success, name).toBe(true);
      expect(ClientNameSchema.safeParse(name).success, name).toBe(false);
    }
    for (const codePoint of [0x034f, 0xfe00, 0xfe0e, 0xe0100, 0x180b, 0x17b4, 0x2800]) {
      const name = `Ana${text(codePoint)}Maria`;
      expect(DisplayNameSchema.safeParse(name).success, codePoint.toString(16)).toBe(true);
      expect(createDisplayNameSchema(80).safeParse(name).success, codePoint.toString(16)).toBe(true);
      expect(ClientNameSchema.safeParse(name).success, codePoint.toString(16)).toBe(false);
    }
  });
});
