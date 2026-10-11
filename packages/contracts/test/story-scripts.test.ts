import { describe, expect, it } from 'vitest';

import {
  CreateStoryScriptRequestSchema,
  STORY_SCRIPT_PERIOD_MAX_DAYS,
  STORY_SCRIPT_PERIOD_MAX_ITEMS,
  StoryScriptPeriodQuerySchema,
  UpdateStoryScriptRequestSchema,
  hasHiddenStoryCharacters,
  storyScriptPeriodDays,
  storyScriptPeriodIssues
} from '../src/index.js';

// Issue #258. The text of a scene and its guidance are free text that the client reads on a phone, so what renders
// as nothing, or reorders what is shown, is refused in the schema: the database refuses only a blank one. Code points
// are spelled as numbers so the invisible characters stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);
const scene = (value: string, guidance?: string | null) => ({ text: value, ...(guidance === undefined ? {} : { guidance }) });
const create = (...scenes: ReadonlyArray<ReturnType<typeof scene>>) => CreateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-20', scenes });

/** One entry per class: the code point and why a script cannot carry it. */
const HIDDEN: ReadonlyArray<readonly [string, number]> = [
  ['NUL', 0x0000],
  ['BEL', 0x0007],
  ['vertical tab', 0x000b],
  ['escape', 0x001b],
  ['delete', 0x007f],
  ['C1 control NEL', 0x0085],
  ['line separator U+2028', 0x2028],
  ['paragraph separator U+2029', 0x2029],
  ['zero-width space U+200B', 0x200b],
  ['zero-width non-joiner U+200C', 0x200c],
  ['zero-width joiner U+200D', 0x200d],
  ['word joiner U+2060', 0x2060],
  ['byte order mark U+FEFF', 0xfeff],
  ['soft hyphen U+00AD', 0x00ad],
  ['right-to-left override U+202E', 0x202e],
  ['right-to-left isolate U+2067', 0x2067],
  ['combining grapheme joiner U+034F (not Cf)', 0x034f],
  ['Mongolian free variation selector U+180B (not Cf)', 0x180b],
  ['variation selector-1 U+FE00 (not Cf)', 0xfe00],
  ['variation selector-15 U+FE0E (not Cf)', 0xfe0e],
  ['supplementary variation selector U+E0100 (not Cf)', 0xe0100],
  ['Khmer inherent vowel U+17B4 (not Cf)', 0x17b4],
  ['Hangul filler U+3164 (not Cf)', 0x3164],
  ['Braille blank U+2800', 0x2800]
];

describe('the text of a scene and its guidance (#258)', () => {
  it.each(HIDDEN)('refuses %s, in the text and in the guidance, in the middle and at the ends', (_label, codePoint) => {
    const hidden = text(codePoint);
    for (const value of [`Abrir ${hidden}o dia`, `${hidden}Abrir o dia`, `Abrir o dia${hidden}`]) {
      expect({ field: 'text', value, ok: create(scene(value)).success }).toEqual({ field: 'text', value, ok: false });
      expect({ field: 'guidance', value, ok: create(scene('Abrir o dia', value)).success }).toEqual({ field: 'guidance', value, ok: false });
    }
  });

  it('keeps tab, line feed and carriage return, which are the line breaks a person types', () => {
    const parsed = create(scene('Primeira linha\nSegunda linha\r\n\tcom recuo', 'Falar\ndevagar'));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.scenes[0]).toEqual({ text: 'Primeira linha\nSegunda linha\r\n\tcom recuo', guidance: 'Falar\ndevagar' });
  });

  it('accepts accents, a heart written with the emoji selector and ordinary punctuation', () => {
    const heart = `Obrigada ${text(0x2764, 0xfe0f)} pela força! Até já, ç ã é — “ok”.`;

    expect(hasHiddenStoryCharacters(heart)).toBe(false);
    expect(create(scene(heart)).success).toBe(true);
  });

  it('refuses the emoji selector when no pictograph comes before it', () => {
    expect(hasHiddenStoryCharacters(`a${text(0xfe0f)}`)).toBe(true);
    expect(hasHiddenStoryCharacters(`${text(0xfe0f)}a`)).toBe(true);
    expect(hasHiddenStoryCharacters(` ${text(0xfe0f)}`)).toBe(true);
  });

  it('trims the text, and a text of only blanks is empty', () => {
    expect(create(scene('  Abrir o dia  ')).success && create(scene('  Abrir o dia  ')).data?.scenes[0]?.text).toBe('Abrir o dia');
    for (const blank of ['', '   ', '\t\n', text(0x00a0), text(0x3000, 0x2003), text(0x2009)]) {
      expect({ blank, ok: create(scene(blank)).success }).toEqual({ blank, ok: false });
    }
  });

  it('turns a missing, null, empty or blank guidance into null', () => {
    for (const guidance of [undefined, null, '', '   ', text(0x00a0)]) {
      const parsed = create(scene('Abrir o dia', guidance));
      expect({ guidance, value: parsed.success ? parsed.data.scenes[0]?.guidance : 'refused' }).toEqual({ guidance, value: null });
    }
  });

  it('holds the text to 2000 characters and the guidance to 1000, at the edge', () => {
    expect(create(scene('a'.repeat(2000))).success).toBe(true);
    expect(create(scene('a'.repeat(2001))).success).toBe(false);
    expect(create(scene('Abrir', 'g'.repeat(1000))).success).toBe(true);
    expect(create(scene('Abrir', 'g'.repeat(1001))).success).toBe(false);
  });

  it('refuses a field the contract does not name', () => {
    expect(CreateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-20', scenes: [], status: 'sent' }).success).toBe(false);
    expect(CreateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-20', clientId: '4d6f1a1e-0a4b-4f86-9e22-6cf3e6bd1c0a' }).success).toBe(false);
    expect(create({ text: 'Abrir', position: 3 } as never).success).toBe(false);
  });
});

describe('the scenes of a script (#258)', () => {
  it('takes 30 scenes and refuses the 31st', () => {
    const scenes = (count: number) => Array.from({ length: count }, (_, index) => scene(`Cena ${index + 1}`));

    expect(create(...scenes(30)).success).toBe(true);
    expect(create(...scenes(31)).success).toBe(false);
  });

  it('takes a script with no scene, since the rule that a script needs one is not decided', () => {
    const parsed = CreateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-20' });

    expect(parsed.success && parsed.data.scenes).toEqual([]);
  });

  it('takes only a real calendar day for the day of the script', () => {
    for (const scriptOn of ['2026-02-30', '2026-13-01', '2026-10-32', '0000-01-01', '20261020', '2026-10-2', '2026-10-20T00:00:00Z', '', 'hoje']) {
      expect({ scriptOn, ok: CreateStoryScriptRequestSchema.safeParse({ scriptOn }).success }).toEqual({ scriptOn, ok: false });
    }
    expect(CreateStoryScriptRequestSchema.safeParse({ scriptOn: '2028-02-29' }).success).toBe(true);
    expect(CreateStoryScriptRequestSchema.safeParse({ scriptOn: '2027-02-29' }).success).toBe(false);
  });
});

describe('the edit of a script (#258)', () => {
  const sceneId = '4d6f1a1e-0a4b-4f86-9e22-6cf3e6bd1c0a';
  const otherId = '9a0b9c9c-2a56-4f6e-8f43-0d0a7a3a3b11';

  it('needs the day, the scenes or both, and nothing else', () => {
    expect(UpdateStoryScriptRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-21' }).success).toBe(true);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: [scene('Nova')] }).success).toBe(true);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-21', status: 'sent' }).success).toBe(false);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scriptOn: '2026-10-21', clientId: sceneId }).success).toBe(false);
  });

  it('takes scenes with and without an id, and refuses the same id twice', () => {
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: [{ id: sceneId, text: 'Antiga' }, { text: 'Nova' }] }).success).toBe(true);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: [{ id: sceneId, text: 'A' }, { id: otherId, text: 'B' }] }).success).toBe(true);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: [{ id: sceneId, text: 'A' }, { id: sceneId, text: 'B' }] }).success).toBe(false);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: [{ id: 'não-é-uuid', text: 'A' }] }).success).toBe(false);
  });

  it('holds the edit to the same text rules and the same 30 scenes', () => {
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: [{ text: `Abrir ${text(0x200b)}o dia` }] }).success).toBe(false);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: Array.from({ length: 31 }, () => scene('Cena')) }).success).toBe(false);
    expect(UpdateStoryScriptRequestSchema.safeParse({ scenes: Array.from({ length: 30 }, () => scene('Cena')) }).success).toBe(true);
  });
});

describe('the period of the portal listing (#258, format of #254)', () => {
  const period = (from: string, to: string) => StoryScriptPeriodQuerySchema.parse({ from, to });

  it('counts the days with both ends included', () => {
    expect(storyScriptPeriodDays(period('2026-10-01', '2026-10-01'))).toBe(1);
    expect(storyScriptPeriodDays(period('2026-10-01', '2026-10-31'))).toBe(31);
    expect(storyScriptPeriodDays(period('2026-12-31', '2027-01-01'))).toBe(2);
    expect(storyScriptPeriodDays(period('2028-02-28', '2028-03-01'))).toBe(3);
  });

  it('fixes the two ceilings the owner approved for the period query: 93 days and 500 items', () => {
    expect(STORY_SCRIPT_PERIOD_MAX_DAYS).toBe(93);
    expect(STORY_SCRIPT_PERIOD_MAX_ITEMS).toBe(500);
  });

  it('passes 93 days and refuses 94, across a month that is not the same length', () => {
    expect(storyScriptPeriodIssues(period('2026-10-01', '2027-01-01'))).toEqual([]);
    expect(storyScriptPeriodDays(period('2026-10-01', '2027-01-01'))).toBe(93);
    expect(storyScriptPeriodIssues(period('2026-10-01', '2027-01-02'))).toEqual([{ path: 'to', message: 'the period must span at most 93 days' }]);
    expect(storyScriptPeriodIssues(period('2026-06-01', '2026-09-01'))).toEqual([]);
    expect(storyScriptPeriodIssues(period('2026-06-01', '2026-09-02'))).toHaveLength(1);
  });

  it('refuses a period that runs backwards, and a day that does not exist', () => {
    expect(storyScriptPeriodIssues(period('2026-10-02', '2026-10-01'))).toEqual([{ path: 'to', message: 'must not be before from' }]);
    expect(StoryScriptPeriodQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(StoryScriptPeriodQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false);
    expect(StoryScriptPeriodQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02', page: '1' }).success).toBe(false);
  });
});
