import { hasInvisibleCharacters } from '@ageniza/contracts';

/** The edge puts the visitor's city here when "Add visitor location headers" is on; nothing else ever names a city. */
export const SESSION_CITY_HEADER = 'cf-ipcity';

/** The column keeps 1 to 80 characters (migration 20261112000100). */
export const SESSION_CITY_MAX_CHARACTERS = 80;

/** A city of 80 characters is 320 bytes at the most, and a header longer than that is not one: it is refused before it is read. */
const MAX_HEADER_CHARACTERS = 4 * SESSION_CITY_MAX_CHARACTERS;

// Control characters (C0, DEL, C1), a lone surrogate, the line and paragraph separators, and the replacement character that a failed decoding leaves.
const CONTROL_OR_BROKEN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\uFFFD]/u;
const BEYOND_LATIN_1 = /[\u0100-\u{10FFFF}]/u;

// `ignoreBOM` keeps a leading byte-order mark in the text, where the invisible-character check refuses it: by default the decoder drops it.
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Node reads a header as Latin-1, so the UTF-8 bytes of "São Paulo" arrive as "SÃ£o Paulo". A value made only of Latin-1 characters
 * that is valid UTF-8 as bytes is read back as UTF-8; anything else (plain ASCII, a Latin-1 sender, text that is not from the wire)
 * is kept as it came.
 */
const decodeHeaderValue = (value: string): string => {
  if (BEYOND_LATIN_1.test(value)) return value;
  try {
    return UTF8_STRICT.decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
};

/**
 * The city to keep on a new session, or `null`. The value comes from a header any client can send when the edge does not
 * overwrite it, so it is treated as text of a person who may be hostile: at most 80 characters once its spaces are trimmed, with no
 * control character, bidirectional override or invisible character, and a value that is none of that is dropped whole, never repaired.
 * It never throws: the sign-in that asks for it must not fail because of a city.
 */
export const cleanSessionCity = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > MAX_HEADER_CHARACTERS) return null;
  try {
    const decoded = decodeHeaderValue(value);
    // Judged before the trim, which would otherwise hide a tab, a line break or a byte-order mark at either end.
    if (CONTROL_OR_BROKEN.test(decoded) || hasInvisibleCharacters(decoded)) return null;
    const city = decoded.trim();
    if (city === '' || [...city].length > SESSION_CITY_MAX_CHARACTERS) return null;
    return city;
  } catch {
    return null;
  }
};
