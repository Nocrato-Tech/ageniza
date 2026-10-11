/**
 * What renders as nothing, or as a space, in a free text and is not a control or a separator: the combining grapheme joiner
 * (U+034F), the variation selectors, the Khmer vowels, the Hangul fillers and the like (`Default_Ignorable_Code_Point`, whether
 * or not it is `Cf`), plus the Braille blank (U+2800) and the musical null notehead (U+1D159), which most fonts draw as a space
 * and Unicode does not list as ignorable. A name or a text with one of them looks like another that has none.
 */
const INVISIBLE_CHARACTER = /[\p{Default_Ignorable_Code_Point}\u2800\u{1D159}]/u;

/**
 * The one exception: VS16 (U+FE0F) right after a pictograph, which is how a phone writes a heart. A second selector, a selector
 * after anything else, and every other variation selector are still invisible characters.
 */
const EMOJI_PRESENTATION_SELECTOR = /(?<=\p{Extended_Pictographic})\uFE0F/gu;

/** The single rule of every contract that takes a free text a person reads (folder names, story scripts). */
export const hasInvisibleCharacters = (value: string): boolean =>
  INVISIBLE_CHARACTER.test(value.replace(EMOJI_PRESENTATION_SELECTOR, ''));
