/**
 * What renders as nothing, or as a space, in a free text and is not a control or a separator: the combining grapheme joiner
 * (U+034F), the variation selectors, the Khmer vowels, the Hangul fillers and the like (`Default_Ignorable_Code_Point`, whether
 * or not it is `Cf`), plus the Braille blank (U+2800) and the musical null notehead (U+1D159), which most fonts draw as a space
 * and Unicode does not list as ignorable. A name or a text with one of them looks like another that has none.
 */
const INVISIBLE_CHARACTER = /[\p{Default_Ignorable_Code_Point}\u2800\u{1D159}]/u;

/**
 * A character of an emoji that is not a letter by itself: the skin tone (U+1F3FB to U+1F3FF) and the combining keycap (U+20E3).
 * They are visible only as part of a complete sequence, so what is left of one after the sequences are taken out is refused.
 */
const EMOJI_COMPONENT = /[\p{Emoji_Modifier}\u20E3]/u;

/** Spaces, format characters and combining marks: what a text made of nothing else shows as nothing. */
const SPACE_FORMAT_OR_MARK = /[\s\p{Cf}\p{M}]/gu;
const COMBINING_MARK = /\p{M}/u;

// One pictograph as UTS #51 writes it: with the selector 16 (a phone writes a heart as U+2764 U+FE0F), or a base that takes a skin
// tone, the tone and the selector 16 that may follow the base or the tone.
const ELEMENT = String.raw`(?:\p{Emoji_Modifier_Base}\uFE0F?\p{Emoji_Modifier}\uFE0F?|\p{Extended_Pictographic}\uFE0F?)`;
// Pictographs joined by ZWJ (a family, a profession); the joiner is only valid with a pictograph on both sides. Three joiners are
// the longest a real emoji has (a kiss between two people), so a longer chain is not an emoji and a text cannot hide in it.
const ZWJ_SEQUENCE = String.raw`${ELEMENT}(?:\u200D${ELEMENT}){0,3}`;
// A digit, # or * and the combining keycap, the selector 16 between them optional.
const KEYCAP = String.raw`[0-9#*]\uFE0F?\u20E3`;
// The black flag, the tags of one of the three subdivisions that have a flag (gbeng, gbsct, gbwls) and the cancel tag. Any other
// run of tag letters would carry an ASCII text through a flag that renders as a plain black flag.
const SUBDIVISION_FLAG = String.raw`\u{1F3F4}(?:\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073}))\u{E007F}`;

const EMOJI_SEQUENCE = new RegExp(`${SUBDIVISION_FLAG}|${KEYCAP}|${ZWJ_SEQUENCE}`, 'gu');

/**
 * The text with every complete and valid emoji sequence replaced by a plain letter. What a sequence carries that is invisible on
 * its own (the joiner, the tags, the selector 16) goes with it; a joiner, a tag, a selector or a tone that is left over is out of
 * a sequence, and the helpers below refuse it. The letter keeps the neighbours from forming a sequence that was not written.
 */
export const withoutEmojiSequences = (value: string): string => value.replace(EMOJI_SEQUENCE, 'x');

// A combining mark needs a character to sit on: a text of marks and spaces only (U+0301 alone) draws an accent in the air. A blank
// text has no mark and is not this one: whether it is empty is for each contract to say.
const isOnlyCombiningMarks = (value: string): boolean => COMBINING_MARK.test(value) && value.replace(SPACE_FORMAT_OR_MARK, '') === '';

/**
 * The single rule of every contract that takes a free text a person reads (folder names, story scripts, titles, captions,
 * comments). An emoji sequence is accepted only whole: ZWJ between pictographs, a keycap, the flag of England, Scotland or Wales,
 * a skin tone after a base that takes one, and the selector 16 after a pictograph. The same characters alone, repeated or next to
 * the wrong thing are still invisible characters, and so is a text that is only combining marks.
 */
export const hasInvisibleCharacters = (value: string): boolean => {
  const rest = withoutEmojiSequences(value);
  return INVISIBLE_CHARACTER.test(rest) || EMOJI_COMPONENT.test(rest) || isOnlyCombiningMarks(rest);
};
