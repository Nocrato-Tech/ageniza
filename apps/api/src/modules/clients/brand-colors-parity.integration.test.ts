import { BrandColorSchema, BrandStudySectionSchema, BrandStudySectionUpdateRequestSchema } from '@ageniza/contracts';
import { describe, expect, it } from 'vitest';

import { queryAsOwner } from '../auth/test-support/harness.js';

// Issue #476. The CHECK on `client_brand_sections.colors` is `app_private.brand_colors_valid`, a SQL
// copy of `BrandColorSchema` and of the 24-item limit of the write contract. Nothing but this file
// ties the two together: a case here carries its expected verdict as a literal and both sides must
// agree with it, so tightening or loosening one side alone turns a case red.
const verdictOfDatabase = async (colors: unknown): Promise<boolean> => {
  const [row] = await queryAsOwner<{ valid: boolean }>('select app_private.brand_colors_valid($1::jsonb) as valid', [JSON.stringify(colors)]);
  return row!.valid;
};

const COLOR = { name: 'Vermelho terracota', hex: '#B4472F' };

const ELEMENTS: readonly { readonly label: string; readonly element: unknown; readonly expected: boolean }[] = [
  { label: 'upper-case hex', element: COLOR, expected: true },
  { label: 'lower-case hex', element: { name: 'Creme', hex: '#f3e3c3' }, expected: true },
  { label: 'empty name', element: { name: '', hex: '#000000' }, expected: true },
  { label: 'whitespace-only name', element: { name: '   ', hex: '#000000' }, expected: true },
  { label: 'accented name and emoji', element: { name: 'Café com leite ☕', hex: '#6F4E37' }, expected: true },
  { label: 'a surrogate pair at the start of the name', element: { name: '😀 alegre', hex: '#6F4E37' }, expected: true },
  { label: 'a surrogate pair at the end of the name', element: { name: 'alegre 😀', hex: '#6F4E37' }, expected: true },
  { label: 'NBSP in the name', element: { name: 'com nbsp', hex: '#6F4E37' }, expected: true },
  { label: 'C1 control and line separator in the name', element: { name: 'a\u0080b c', hex: '#6F4E37' }, expected: true },
  { label: 'name of 60 bytes', element: { name: 'a'.repeat(60), hex: '#112233' }, expected: true },
  { label: 'name of 61 bytes', element: { name: 'a'.repeat(61), hex: '#112233' }, expected: false },
  { label: '30 two-byte characters', element: { name: 'é'.repeat(30), hex: '#112233' }, expected: true },
  { label: '31 two-byte characters', element: { name: 'é'.repeat(31), hex: '#112233' }, expected: false },
  { label: '20 three-byte characters', element: { name: '€'.repeat(20), hex: '#112233' }, expected: true },
  { label: '21 three-byte characters', element: { name: '€'.repeat(21), hex: '#112233' }, expected: false },
  { label: '15 four-byte characters', element: { name: '😀'.repeat(15), hex: '#112233' }, expected: true },
  { label: '16 four-byte characters', element: { name: '😀'.repeat(16), hex: '#112233' }, expected: false },
  { label: 'SOH in the name', element: { name: 'a\u0001b', hex: '#112233' }, expected: false },
  { label: 'tab in the name', element: { name: 'a\tb', hex: '#112233' }, expected: false },
  { label: 'line feed in the name', element: { name: 'a\nb', hex: '#112233' }, expected: false },
  { label: 'carriage return in the name', element: { name: 'a\rb', hex: '#112233' }, expected: false },
  { label: 'unit separator in the name', element: { name: 'a\u001fb', hex: '#112233' }, expected: false },
  { label: 'DEL in the name', element: { name: 'a\u007fb', hex: '#112233' }, expected: false },
  { label: 'hex without the hash', element: { name: 'Vermelho', hex: 'B4472F' }, expected: false },
  { label: 'hex of three digits', element: { name: 'Vermelho', hex: '#B47' }, expected: false },
  { label: 'hex of five digits', element: { name: 'Vermelho', hex: '#B4472' }, expected: false },
  { label: 'hex of seven digits', element: { name: 'Vermelho', hex: '#B4472FF' }, expected: false },
  { label: 'hex with a non-hex digit', element: { name: 'Vermelho', hex: '#B4472G' }, expected: false },
  { label: 'hex with a trailing line feed', element: { name: 'Vermelho', hex: '#B4472F\n' }, expected: false },
  { label: 'hex with a leading space', element: { name: 'Vermelho', hex: ' #B4472F' }, expected: false },
  { label: 'hex with a full-width digit', element: { name: 'Vermelho', hex: '#B4472Ｆ' }, expected: false },
  { label: 'named color instead of hex', element: { name: 'Vermelho', hex: 'red' }, expected: false },
  { label: 'null hex', element: { name: 'Vermelho', hex: null }, expected: false },
  { label: 'numeric hex', element: { name: 'Vermelho', hex: 11814703 }, expected: false },
  { label: 'null name', element: { name: null, hex: '#B4472F' }, expected: false },
  { label: 'numeric name', element: { name: 7, hex: '#B4472F' }, expected: false },
  { label: 'missing hex', element: { name: 'Vermelho' }, expected: false },
  { label: 'missing name', element: { hex: '#B4472F' }, expected: false },
  { label: 'empty object', element: {}, expected: false },
  { label: 'extra key', element: { ...COLOR, extra: 1 }, expected: false },
  { label: 'the format the seed used to write', element: { nome: 'Vermelho terracota', codigoHexadecimal: '#B4472F' }, expected: false },
  { label: 'upper-case key', element: { name: 'Vermelho', Hex: '#B4472F' }, expected: false },
  { label: 'null element', element: null, expected: false },
  { label: 'string element', element: '#B4472F', expected: false },
  { label: 'nested array element', element: [COLOR], expected: false }
];

const colorList = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `Cor ${index}`, hex: '#112233' }));

const ARRAYS: readonly { readonly label: string; readonly value: unknown; readonly expected: boolean }[] = [
  { label: 'empty array', value: [], expected: true },
  { label: 'one valid color', value: [COLOR], expected: true },
  { label: '24 colors', value: colorList(24), expected: true },
  { label: '25 colors', value: colorList(25), expected: false },
  { label: 'a valid color followed by an invalid one', value: [COLOR, { nome: 'x' }], expected: false },
  { label: 'an invalid color followed by a valid one', value: [{ nome: 'x' }, COLOR], expected: false },
  { label: 'a single object', value: COLOR, expected: false },
  { label: 'a string', value: '#B4472F', expected: false },
  { label: 'a number', value: 7, expected: false },
  { label: 'a boolean', value: true, expected: false },
  { label: 'JSON null', value: null, expected: false }
];

describe('brand colors: the contract and the database agree (#476)', () => {
  it.each(ELEMENTS)('one color, $label', async ({ element, expected }) => {
    expect(BrandColorSchema.safeParse(element).success, 'BrandColorSchema').toBe(expected);
    expect(await verdictOfDatabase([element]), 'brand_colors_valid').toBe(expected);
  });

  it.each(ARRAYS)('the list, $label', async ({ value, expected }) => {
    expect(BrandStudySectionUpdateRequestSchema.safeParse({ colors: value }).success, 'write contract').toBe(expected);
    expect(await verdictOfDatabase(value), 'brand_colors_valid').toBe(expected);
  });

  it('never stores what the read contract would refuse: every list the database accepts parses as a response', async () => {
    let accepted = 0;
    for (const value of [...ELEMENTS.map(({ element }) => [element]), ...ARRAYS.map(({ value }) => value)]) {
      if (!(await verdictOfDatabase(value))) continue;
      accepted += 1;
      const read = BrandStudySectionSchema.safeParse({ key: 'colors', body: null, colors: value, archetype: null, updatedBy: null, updatedAt: null });
      expect(read.success, JSON.stringify(value).slice(0, 80)).toBe(true);
    }
    expect(accepted).toBeGreaterThan(10);
  });

  it('refuses a NUL in the name on both sides: jsonb cannot hold it, and the contract rejects it', async () => {
    const element = { name: 'a\u0000b', hex: '#112233' };
    expect(BrandColorSchema.safeParse(element).success).toBe(false);
    await expect(verdictOfDatabase([element])).rejects.toMatchObject({ code: '22P05' });
  });

  // JSON.stringify keeps a lone surrogate as a \udXXX escape, which jsonb refuses with 22P02 before the
  // CHECK runs, so only the contract can answer it with a 400 (#484). A well-formed pair is not lone.
  it.each([
    ['a lone high surrogate', 'x\ud800'],
    ['a lone low surrogate', 'x\udc00'],
    ['a high surrogate followed by a letter', '\ud83dx'],
    ['a low surrogate at the start', '\ude00x'],
    ['a pair written in reverse order', '\ude00\ud83d'],
    ['a high surrogate before a whole pair', '\ud83d😀'],
    ['a low surrogate after a whole pair', '😀\ude00'],
    ['a lone surrogate in a name that otherwise fits the limit', `${'a'.repeat(50)}\ud800`]
  ])('refuses %s in the name on both sides: the contract rejects it and jsonb cannot hold it', async (_label, name) => {
    const element = { name, hex: '#112233' };
    expect(BrandColorSchema.safeParse(element).success, 'BrandColorSchema').toBe(false);
    expect(BrandStudySectionUpdateRequestSchema.safeParse({ colors: [element] }).success, 'write contract').toBe(false);
    await expect(verdictOfDatabase([element])).rejects.toMatchObject({ code: '22P02' });
  });
});
