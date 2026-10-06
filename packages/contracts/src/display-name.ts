import { z } from 'zod';

/** Longest accepted display name for the profile. `specs/colaboradores.md` requires a limit but
 * fixes no number; 120 is the choice recorded in `docs/business/decisions.md` (2026-09-30, pending
 * validation). Flows with their own limit build their own schema through `createDisplayNameSchema`. */
export const DISPLAY_NAME_MAX_LENGTH = 120;

/**
 * Characters that must never reach a display name, regardless of what a screen does with it:
 *
 * - `\p{Cc}` control characters -- a NUL byte is rejected by PostgreSQL (22021) and would surface
 *   as a 500; ESC and friends can drive terminal/log injection.
 * - Every `\p{Cf}` format character **except the two joiners** -- this covers the bidi overrides
 *   (U+202A-U+202E, U+2066-U+2069), the zero-width space, the word joiner and the BOM, so a name
 *   cannot render as something other than what is stored ("Ana RLO admin" showing as "Ana nimda").
 *   ZWNJ (U+200C) and ZWJ (U+200D) are exempt here and checked separately below: they are
 *   legitimate in Persian names, in Indic virama sequences and in emoji families, and they never
 *   reorder text.
 * - `\p{Zl}`/`\p{Zp}` line and paragraph separators -- they break a single-line name.
 * - The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0): unlike the format characters above they
 *   are category `Lo` (letters), so they would slip past both the category check and a "has a
 *   letter" rule while rendering as nothing.
 */
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]|(?![\u200C\u200D])\p{Cf}/u;

/**
 * The two joiners are only meaningful, and only accepted, between characters a joiner legitimately
 * binds: letters, combining marks (an Indic virama precedes the ZWJ in a conjunct) and pictographs
 * (an emoji family). A joiner at the start, at the end or next to anything else is still an
 * invisible character that can make a name look empty or drift from what is stored.
 */
const JOINER_OUTSIDE_NAME_CHARACTERS = /(?<![\p{L}\p{M}\p{Extended_Pictographic}])[\u200C\u200D]|[\u200C\u200D](?![\p{L}\p{M}\p{Extended_Pictographic}])/u;

/** A name made only of punctuation, symbols or emoji is visually a blank badge. */
const NAME_HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Builds a display-name schema for a flow with its own length limit. Trims first (so
 * whitespace-only, NBSP-only and tab-only are empty), caps the length, rejects the control, bidi
 * and invisible characters above, and requires at least one letter or number -- otherwise
 * "invisible name" would satisfy the "name is not empty" rule while showing nothing.
 */
export const createDisplayNameSchema = (maxLength: number = DISPLAY_NAME_MAX_LENGTH) => z.string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine((value) => !FORBIDDEN_NAME_CHARACTERS.test(value), 'must not contain control, bidi or invisible characters')
  .refine((value) => !JOINER_OUTSIDE_NAME_CHARACTERS.test(value), 'a zero-width joiner is only allowed between letters, combining marks or pictographs')
  .refine((value) => NAME_HAS_LETTER_OR_NUMBER.test(value), 'must contain at least one letter or number');

/** A person's display name, shared by every contract that accepts one. */
export const DisplayNameSchema = createDisplayNameSchema();

export type DisplayName = z.infer<typeof DisplayNameSchema>;
