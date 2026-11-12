import { describe, expect, it } from 'vitest';

import { cleanSessionCity, SESSION_CITY_HEADER, SESSION_CITY_MAX_CHARACTERS } from './session-city.js';

// What Node hands the code for a header: the bytes of the request read as Latin-1. A city typed in UTF-8 ("São Paulo") arrives as
// "SÃ£o Paulo", and this is that form, so the table is judged on what the wire gives and not on what a test can type.
const onTheWire = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');

const NBSP = String.fromCodePoint(0xa0);

describe('the header the city comes from', () => {
  it('is the one the edge sets, and its length is the column\'s', () => {
    expect(SESSION_CITY_HEADER).toBe('cf-ipcity');
    expect(SESSION_CITY_MAX_CHARACTERS).toBe(80);
  });
});

describe('cleanSessionCity keeps a plain city', () => {
  it.each([
    ['plain ASCII', 'Campinas', 'Campinas'],
    ['UTF-8 on the wire (what the edge sends)', onTheWire('São Paulo'), 'São Paulo'],
    ['UTF-8 on the wire, another accent', onTheWire('Brasília'), 'Brasília'],
    ['UTF-8 on the wire, a letter outside Latin-1', onTheWire('Tōkyō'), 'Tōkyō'],
    ['a single Latin-1 byte (a sender that is not UTF-8)', 'Zürich', 'Zürich'],
    ['text that did not come from the wire at all', 'Tōkyō', 'Tōkyō'],
    ['trimmed at both ends', '  Santos  ', 'Santos'],
    ['a header of exactly 320 characters, the ceiling, whose name is short', `${' '.repeat(317)}Rio`, 'Rio'],
    ['text with the first character past Latin-1', 'Āgra', 'Āgra'],
    ['trimmed of a no-break space', `${NBSP}Santos${NBSP}`, 'Santos'],
    ['an inner space', 'Rio de Janeiro', 'Rio de Janeiro'],
    ['exactly 80 characters', 'a'.repeat(80), 'a'.repeat(80)],
    ['80 two-byte characters, 160 on the wire', onTheWire('ã'.repeat(80)), 'ã'.repeat(80)],
    ['80 astral characters, counted as code points', onTheWire('😀'.repeat(80)), '😀'.repeat(80)]
  ])('%s', (_label, input, expected) => {
    expect(cleanSessionCity(input)).toBe(expected);
  });
});

describe('cleanSessionCity drops what is not a plain city, whole and without repair', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 42],
    ['a list (a repeated header)', ['Santos', 'Recife']],
    ['an empty text', ''],
    ['only white space', ' \t '],
    ['only no-break spaces', `${NBSP}${NBSP}`],
    ['81 characters', 'a'.repeat(81)],
    ['81 two-byte characters', onTheWire('ã'.repeat(81))],
    ['81 astral characters', onTheWire('😀'.repeat(81))],
    ['just over the header ceiling (321)', 'a'.repeat(321)],
    ['10 000 characters', 'a'.repeat(10_000)],
    ['a short name behind 400 spaces: a header over 320 characters is refused before it is trimmed', `${' '.repeat(400)}Rio`],
    ['a header of 321 characters, the first over the ceiling, though the name in it is short', `${' '.repeat(318)}Rio`],
    ['10 000 characters that look like a city at the start', `São Paulo${'x'.repeat(9_990)}`],
    ['a lone high surrogate', 'Sao\uD800Paulo'],
    ['a lone low surrogate', 'Sao\uDC00Paulo'],
    ['a replacement character typed in', onTheWire(`Sao${String.fromCodePoint(0xfffd)}Paulo`)],
    ['a line separator', onTheWire(`Sao${String.fromCodePoint(0x2028)}Paulo`)],
    ['a paragraph separator', onTheWire(`Sao${String.fromCodePoint(0x2029)}Paulo`)]
  ])('%s', (_label, input) => {
    expect(cleanSessionCity(input)).toBeNull();
  });

  // Both extremes of each range and a character inside it (checklist item 54), as raw Latin-1 and as UTF-8 on the wire: C0 is U+0000 to U+001F,
  // DEL is U+007F and C1 is U+0080 to U+009F.
  const CONTROLS = [0x00, 0x01, 0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f];

  it.each(CONTROLS)('a control character, code point %i, anywhere in it', (code) => {
    const control = String.fromCodePoint(code);
    for (const city of [`Sao${control}Paulo`, `${control}Sao Paulo`, `Sao Paulo${control}`, control]) {
      expect(cleanSessionCity(city), JSON.stringify(city)).toBeNull();
      expect(cleanSessionCity(onTheWire(city)), JSON.stringify(onTheWire(city))).toBeNull();
    }
  });

  it.each([0x20, 0x7e, 0xa0])('keeps the neighbours of the control ranges inside a name: code point %i', (code) => {
    const neighbour = String.fromCodePoint(code);
    expect(cleanSessionCity(`Sao${neighbour}Paulo`)).toBe(`Sao${neighbour}Paulo`);
  });

  // Bidirectional controls: the marks, the embeddings and overrides, and the isolates. One of them reorders what is written around it.
  const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

  it.each(BIDI)('a bidirectional control, code point %i, anywhere in it', (code) => {
    const control = String.fromCodePoint(code);
    for (const city of [`Sao${control}Paulo`, `${control}Sao Paulo`, `Sao Paulo${control}`]) {
      expect(cleanSessionCity(onTheWire(city)), JSON.stringify(city)).toBeNull();
    }
  });

  // What draws as nothing: the zero-width characters, the soft hyphen, the joiner, the filler, the variation selector and the Braille blank.
  it.each([0x00ad, 0x034f, 0x200b, 0x200c, 0x2060, 0x2800, 0x3164, 0xfe0f, 0xfeff])('an invisible character, code point %i, anywhere in it: the byte-order mark at the start included', (code) => {
    const invisible = String.fromCodePoint(code);
    for (const city of [`Sao${invisible}Paulo`, `${invisible}Sao Paulo`, `Sao Paulo${invisible}`]) {
      expect(cleanSessionCity(onTheWire(city)), JSON.stringify(city)).toBeNull();
    }
  });

  it('never throws, whatever it is given', () => {
    for (const hostile of ['\u0000'.repeat(1_000), '\uD800'.repeat(50), '%00', '<script>alert(1)</script>'.repeat(20), `${'ã'.repeat(100)}\u0001`]) {
      expect(() => cleanSessionCity(hostile)).not.toThrow();
    }
  });

  it('does not treat markup as anything but text: it is kept, and the screen renders text', () => {
    expect(cleanSessionCity('<b>Rio</b>')).toBe('<b>Rio</b>');
  });
});
