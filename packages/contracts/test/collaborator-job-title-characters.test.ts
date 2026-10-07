import { describe, expect, it } from 'vitest';

import {
  CollaboratorJobTitleSchema,
  UpdateCollaboratorRequestSchema,
  createDisplayNameSchema
} from '../src/index.js';

// Issue #324. A job title is text the screen shows about a person, so it follows the display-name
// rule of #200 (the one a name, a client name and a contact follow). The old rule refused C0 and DEL
// only, and stored titles that render as something other than what is stored.

/** Each entry is one class of the review of #320, with the text that proves it. */
const FORBIDDEN_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['right-to-left override (shows "Analista admin")', 'Analista ‮nimda'],
  ['left-to-right isolate', 'Analista ⁦admin'],
  ['the other bidi overrides and isolates', 'a‪b‫c‭d⁧e⁨f⁩g'],
  ['zero-width space inside', 'Ana​lista'],
  ['zero-width space only (invisible, and not whitespace, so not blank)', '​'],
  ['several zero-width spaces only', '​​​'],
  ['word joiner', 'Ana⁠lista'],
  ['byte order mark inside', 'Ana﻿lista'],
  ['NEL (C1)', 'Ana\u0085lista'],
  ['CSI (C1)', 'Ana\u009Blista'],
  ['the C1 edges', 'a\u0080b\u009Fc'],
  ['line separator U+2028', 'Ana lista'],
  ['paragraph separator U+2029', 'Ana lista'],
  ['Hangul choseong filler', 'Anaᅟlista'],
  ['Hangul jungseong filler', 'Anaᅠlista'],
  ['Hangul filler U+3164', 'Anaㅤlista'],
  ['halfwidth Hangul filler', 'Anaﾠlista'],
  ['a Hangul filler only', 'ㅤ'],
  ['C0 and DEL, as before', 'Edi\ntor\u0000\u007F'],
  ['a joiner at the end', 'Ana‍'],
  ['a joiner next to a space', 'Ana ‍lista'],
  ['no letter or number: punctuation', '...'],
  ['no letter or number: a symbol', '—'],
  ['no letter or number: an emoji', '\u{1F600}']
];

const ACCEPTED_TITLES = [
  'Analista',
  'Gestor de Operação',
  'Editor de Vídeo',
  'Designer Sênior (UX/UI)',
  '3D Artist',
  'Gestora de contas — Sul',
  // ZWNJ between letters is how Persian is written; a ZWJ binds an emoji family.
  'می‌خواهم',
  'Designer \u{1F469}‍\u{1F4BB}'
];

/** Whitespace by the JavaScript trim, which the database also uses: blank, not invisible. */
const BLANK_TITLES = ['', ' ', '   ', '\t', '\n', ' ', '﻿', ' \t ﻿ '];

describe('CollaboratorJobTitleSchema follows the display-name rule (issue #324)', () => {
  it.each(FORBIDDEN_TITLES)('refuses %s', (_label, title) => {
    expect(CollaboratorJobTitleSchema.safeParse(title).success).toBe(false);
  });

  it('accepts the titles people actually have, trimmed', () => {
    for (const title of ACCEPTED_TITLES) {
      expect(CollaboratorJobTitleSchema.parse(`  ${title}\t`), JSON.stringify(title)).toBe(title);
    }
  });

  it('agrees, title by title, with the shared display-name schema at the same length', () => {
    const displayName = createDisplayNameSchema(256);
    const samples = [
      ...FORBIDDEN_TITLES.map(([, title]) => title),
      ...ACCEPTED_TITLES,
      ...BLANK_TITLES,
      'a'.repeat(256),
      'a'.repeat(257)
    ];
    for (const sample of samples) {
      expect(CollaboratorJobTitleSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(displayName.safeParse(sample).success);
    }
  });
});

describe('the jobTitle of the update body (issue #324)', () => {
  it.each(FORBIDDEN_TITLES)('refuses %s, so nothing reaches the database', (_label, title) => {
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: title }).success).toBe(false);
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: title, roleId: '66666666-6666-4666-8666-666666666666' }).success).toBe(false);
  });

  it('turns null and every blank value into null, the way to clear the title', () => {
    expect(UpdateCollaboratorRequestSchema.parse({ jobTitle: null })).toEqual({ jobTitle: null });
    for (const blank of BLANK_TITLES) {
      expect(UpdateCollaboratorRequestSchema.parse({ jobTitle: blank }), JSON.stringify(blank)).toEqual({ jobTitle: null });
    }
  });

  it('never turns an invisible-only value into null: it is refused instead of cleared', () => {
    for (const invisible of ['​', '⁠', 'ㅤ', '​ ​']) {
      expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: invisible }).success, JSON.stringify(invisible)).toBe(false);
    }
  });

  it('keeps the 256 cap, counted in UTF-16 units, and refuses what is not a string', () => {
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: 'a'.repeat(256) }).success).toBe(true);
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: 'a'.repeat(257) }).success).toBe(false);
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: 'aa' + '\u{1F600}'.repeat(128) }).success).toBe(false);
    for (const value of [5, true, {}, [], undefined]) {
      expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: value }).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('accepts the titles people actually have', () => {
    for (const title of ACCEPTED_TITLES) {
      expect(UpdateCollaboratorRequestSchema.parse({ jobTitle: title }), JSON.stringify(title)).toEqual({ jobTitle: title });
    }
  });
});
