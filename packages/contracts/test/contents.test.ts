import { describe, expect, it } from 'vitest';

import {
  ApproveContentByAgencyRequestSchema,
  ContentApproverSchema,
  ContentListItemSchema,
  ContentTaskSchema,
  ContentSchema,
  CONTENT_CAPTION_MAX_LENGTH,
  CONTENT_PERIOD_MAX_DAYS,
  CONTENT_REASON_MAX_BYTES,
  CONTENT_TITLE_MAX_LENGTH,
  ContentCaptionSchema,
  ContentPeriodQuerySchema,
  ContentTitleSchema,
  CreateContentRequestSchema,
  PublishContentRequestSchema,
  RescheduleContentRequestSchema,
  UpdateContentRequestSchema,
  contentPeriodIssue
} from '../src/index.js';

const FOLDER = '3b241101-e2bb-4255-8caf-4136c566a962';
const ASSET = '4b241101-e2bb-4255-8caf-4136c566a962';

const valid = (value: string): boolean => ContentTitleSchema.safeParse(value).success;
const validCaption = (value: string): boolean => ContentCaptionSchema.safeParse(value).success;

describe('content period bounds', () => {
  const issue = (from: string, to: string) => contentPeriodIssue({ from, to });

  it('counts both ends: 93 days passes and 94 does not', () => {
    expect(CONTENT_PERIOD_MAX_DAYS).toBe(93);
    expect(issue('2026-01-01', '2026-04-03')).toBeUndefined();
    expect(issue('2026-01-01', '2026-04-04')).toEqual({ path: 'to', message: 'the period must span at most 93 days' });
  });

  it('counts a leap day', () => {
    expect(issue('2028-01-01', '2028-04-02')).toBeUndefined();
    expect(issue('2028-01-01', '2028-04-03')).toBeDefined();
    expect(issue('2027-01-01', '2027-04-03')).toBeUndefined();
  });

  it('accepts one day and refuses a period that ends before it starts', () => {
    expect(issue('2026-10-11', '2026-10-11')).toBeUndefined();
    expect(issue('2026-10-11', '2026-10-10')).toEqual({ path: 'to', message: 'must not be before from' });
  });

  it('refuses a date that does not exist or is not a plain day', () => {
    expect(ContentPeriodQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(ContentPeriodQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31T00:00:00Z' }).success).toBe(false);
    expect(ContentPeriodQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false);
    expect(ContentPeriodQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31', page: 1 }).success).toBe(false);
    expect(ContentPeriodQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
  });
});

describe('content title', () => {
  it('trims and keeps what a person writes', () => {
    expect(ContentTitleSchema.parse('  Lançamento da coleção  ')).toBe('Lançamento da coleção');
    expect(ContentTitleSchema.parse('50% OFF 🎬')).toBe('50% OFF 🎬');
    expect(ContentTitleSchema.parse('Amor ❤️ em família')).toBe('Amor ❤️ em família');
  });

  it('counts characters, not UTF-16 units: 120 pass and 121 do not', () => {
    expect(CONTENT_TITLE_MAX_LENGTH).toBe(120);
    expect(valid('a'.repeat(120))).toBe(true);
    expect(valid('a'.repeat(121))).toBe(false);
    expect(valid('🎬'.repeat(120))).toBe(true);
    expect(valid('🎬'.repeat(121))).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['no-break spaces', '  ']
  ])('refuses a blank title (%s)', (_label, value) => {
    expect(valid(value)).toBe(false);
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['bell', 'a\u0007b'],
    ['line feed', 'a\nb'],
    ['tab', 'a\tb'],
    ['carriage return', 'a\rb'],
    ['DEL', 'a\u007Fb'],
    ['C1 next line', 'a\u0085b'],
    ['line separator', 'a b'],
    ['paragraph separator', 'a b']
  ])('refuses a control or separator character in a title (%s)', (_label, value) => {
    expect(valid(value)).toBe(false);
  });

  it.each([
    ['right-to-left override', 'a‮b'],
    ['zero-width space', 'a​b'],
    ['word joiner', 'a⁠b'],
    ['byte order mark', 'a﻿b'],
    ['soft hyphen', 'a­b'],
    ['Arabic number sign (Cf, not default-ignorable)', 'a؀b'],
    ['Arabic end of ayah (Cf, not default-ignorable)', 'a۝b'],
    ['Syriac abbreviation mark (Cf, not default-ignorable)', 'a܏b']
  ])('refuses a format character (%s)', (_label, value) => {
    expect(valid(value)).toBe(false);
  });

  it.each([
    ['combining grapheme joiner', 'a͏b'],
    ['Mongolian variation selector', 'a᠋b'],
    ['variation selector 16 after a letter', 'a️b'],
    ['variation selector 15 at the start', '︎ab'],
    ['variation selector supplement', 'a\u{E0100}b'],
    ['Khmer inherent vowel', 'a឴b'],
    ['tag character', 'a\u{E0020}b'],
    ['Braille blank', 'a⠀b'],
    ['Hangul filler', 'aㅤb'],
    ['Hangul choseong filler', 'aᅟb'],
    ['halfwidth Hangul filler', 'aﾠb']
  ])('refuses an invisible character that is not a format character (%s)', (_label, value) => {
    expect(valid(value)).toBe(false);
  });

  it('accepts the emoji presentation selector only right after a pictograph, once', () => {
    expect(valid('\u2764\uFE0F')).toBe(true);
    expect(valid('\u2764\uFE0F\uFE0F')).toBe(false);
  });

  it('refuses a lone surrogate', () => {
    expect(valid('a\uD800b')).toBe(false);
    expect(valid('a\uDC00b')).toBe(false);
  });
});

describe('content caption', () => {
  it('keeps the line breaks and the tab a person types', () => {
    expect(ContentCaptionSchema.parse('Primeira linha\nSegunda\r\n\tTerceira')).toBe('Primeira linha\nSegunda\r\n\tTerceira');
    expect(ContentCaptionSchema.parse('Hoje tem ❤️ #oferta')).toBe('Hoje tem ❤️ #oferta');
  });

  it('turns a blank caption into none', () => {
    expect(ContentCaptionSchema.parse('   \n  ')).toBeNull();
    expect(ContentCaptionSchema.parse('')).toBeNull();
  });

  it('counts characters: 2200 pass and 2201 do not', () => {
    expect(CONTENT_CAPTION_MAX_LENGTH).toBe(2200);
    expect(validCaption('a'.repeat(2200))).toBe(true);
    expect(validCaption('a'.repeat(2201))).toBe(false);
    expect(validCaption('🎬'.repeat(2200))).toBe(true);
    expect(validCaption('🎬'.repeat(2201))).toBe(false);
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['escape', 'a\u001Bb'],
    ['vertical tab', 'a\u000Bb'],
    ['form feed', 'a\u000Cb'],
    ['C1 next line', 'a\u0085b'],
    ['line separator', 'a b'],
    ['paragraph separator', 'a b'],
    ['right-to-left override', 'a‮b'],
    ['zero-width space', 'a​b'],
    ['combining grapheme joiner', 'a͏b'],
    ['variation selector after a letter', 'a️b'],
    ['Braille blank', 'a⠀b'],
    ['Hangul filler', 'aㅤb'],
    ['lone surrogate', 'a\uD800b']
  ])('refuses %s', (_label, value) => {
    expect(validCaption(value)).toBe(false);
  });
});

describe('content create and update bodies', () => {
  const create = { title: 'Post', format: 'image', publishOn: '2026-10-20', folderId: FOLDER };

  it('accepts the minimum a content needs', () => {
    expect(CreateContentRequestSchema.safeParse(create).success).toBe(true);
  });

  it.each([
    ['status', { status: 'approved' }],
    ['approvedBy', { approvedBy: ASSET }],
    ['revision', { revision: 9 }],
    ['clientId', { clientId: FOLDER }],
    ['an unknown format', { format: 'story' }],
    ['an unknown platform', { platform: 'tiktok' }],
    ['a date that does not exist', { publishOn: '2026-02-30' }],
    ['a time with seconds', { publishAtTime: '10:30:00' }],
    ['a time past 23:59', { publishAtTime: '24:00' }],
    ['a folder that is not an id', { folderId: 'pasta' }]
  ])('refuses %s on create', (_label, extra) => {
    expect(CreateContentRequestSchema.safeParse({ ...create, ...extra }).success).toBe(false);
  });

  it('accepts a time, a null time and a null cover on create', () => {
    expect(CreateContentRequestSchema.safeParse({ ...create, publishAtTime: '09:05', coverAssetId: null, caption: null }).success).toBe(true);
    expect(CreateContentRequestSchema.safeParse({ ...create, publishAtTime: null }).success).toBe(true);
  });

  it('requires one field on update and allows null to clear the time, the caption and the cover', () => {
    expect(UpdateContentRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ publishAtTime: null, caption: null, coverAssetId: null }).success).toBe(true);
    expect(UpdateContentRequestSchema.safeParse({ publishOn: '2026-10-21' }).success).toBe(true);
  });

  it('refuses a null title or date on update, and any state or approval field', () => {
    expect(UpdateContentRequestSchema.safeParse({ title: null }).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ publishOn: null }).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ status: 'approved' }).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ approvedAt: '2026-10-11T00:00:00Z' }).success).toBe(false);
  });

  it('takes the whole media list: up to 20 ids, and 21 do not pass', () => {
    const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `4b241101-e2bb-4255-8caf-${String(index).padStart(12, '0')}`);
    expect(UpdateContentRequestSchema.safeParse({ mediaAssetIds: ids(20) }).success).toBe(true);
    expect(UpdateContentRequestSchema.safeParse({ mediaAssetIds: ids(21) }).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ mediaAssetIds: [] }).success).toBe(true);
    expect(UpdateContentRequestSchema.safeParse({ mediaAssetIds: ['x'] }).success).toBe(false);
  });
});

// One rule of free text in Conteudo: the story script's. These were accepted by an older copy of the rule. The emoji family and the keycap
// were refused here until #539 and are now accepted whole by the shared helper (invisible-characters.test.ts has the edges).
describe.each([
  ['title', valid],
  ['caption', validCaption]
])('content %s follows the story script rule', (_name, accepts) => {
  it.each([
    ['zero-width joiner between letters', 'a\u200Db'],
    ['zero-width non-joiner between letters', 'a\u200Cb'],
    ['text selector after a pictograph', '\u2764\uFE0E'],
    ['emoji selector after a digit, without the keycap', '1\uFE0F'],
    ['text selector after a digit', '1\uFE0E'],
    ['emoji selector after a number sign', '#\uFE0F'],
    ['musical null notehead U+1D159', 'a\u{1D159}b'],
    ['musical null notehead alone at the start', '\u{1D159}ab']
  ])('refuses %s', (_label, value) => {
    expect(accepts(value)).toBe(false);
  });

  it('keeps accepting the emoji selector right after a pictograph and plain pictographs', () => {
    expect(accepts('\u2764\uFE0F')).toBe(true);
    expect(accepts('\u{1F3AC}')).toBe(true);
  });

  it('accepts a complete emoji sequence, and refuses the same one broken', () => {
    expect(accepts('\u{1F468}‍\u{1F469}‍\u{1F467}')).toBe(true);
    expect(accepts('1️⃣')).toBe(true);
    expect(accepts('\u{1F468}‍\u{1F469}‍')).toBe(false);
    expect(accepts('1️⃣⃣')).toBe(false);
  });
});

describe('the body of the approval outside the platform (issue #256)', () => {
  const parse = (value: unknown) => ApproveContentByAgencyRequestSchema.safeParse(value);
  const reasonOf = (reason: string) => parse({ revision: 1, reason });

  it('trims the reason and keeps its line breaks', () => {
    expect(reasonOf('  Aprovado por telefone.\nCliente confirmou.  ')).toMatchObject({ success: true, data: { reason: 'Aprovado por telefone.\nCliente confirmou.' } });
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['no-break space only', '\u00A0\u00A0'],
    ['zero-width space only', '\u200B'],
    ['zero-width joiner only', '\u200D'],
    ['word joiner only', '\u2060'],
    ['byte order mark only', '\uFEFF'],
    ['soft hyphen only', '\u00AD'],
    ['combining grapheme joiner only', '\u034F'],
    ['control character only', '\u0001'],
    ['zero-width space between words', 'ok\u200Bok'],
    ['control character between words', 'ok\u0007ok'],
    ['a lone surrogate', 'ok\uD800'],
    ['a bidi override', 'ok\u202Eok']
  ])('refuses a reason that is %s', (_label, reason) => {
    expect(reasonOf(reason).success).toBe(false);
  });

  it('counts the 5000 bytes of the column, not the characters: 5000 passes and 5001 does not', () => {
    expect(CONTENT_REASON_MAX_BYTES).toBe(5000);
    expect(reasonOf('a'.repeat(5000)).success).toBe(true);
    expect(reasonOf('a'.repeat(5001)).success).toBe(false);
    expect(reasonOf('é'.repeat(2500)).success).toBe(true);
    expect(reasonOf('é'.repeat(2501)).success).toBe(false);
  });

  it('needs the revision the person read, as an integer the column holds', () => {
    expect(parse({ reason: 'ok' }).success).toBe(false);
    expect(parse({ revision: 0, reason: 'ok' }).success).toBe(false);
    expect(parse({ revision: 1.5, reason: 'ok' }).success).toBe(false);
    expect(parse({ revision: '1', reason: 'ok' }).success).toBe(false);
    expect(parse({ revision: 2_147_483_647, reason: 'ok' }).success).toBe(true);
    expect(parse({ revision: 2_147_483_648, reason: 'ok' }).success).toBe(false);
  });

  it('refuses a field that is the database\'s to fix', () => {
    expect(parse({ revision: 1, reason: 'ok', approvedBy: '4b241101-e2bb-4255-8caf-4136c566a962' }).success).toBe(false);
    expect(parse({ revision: 1, reason: 'ok', status: 'approved' }).success).toBe(false);
  });
});

describe('the days of publishing and rescheduling (issue #256)', () => {
  it('takes no body field but the day, and the day is a real one', () => {
    expect(PublishContentRequestSchema.safeParse({}).success).toBe(true);
    expect(PublishContentRequestSchema.safeParse({ publishedOn: '2026-10-10' }).success).toBe(true);
    expect(PublishContentRequestSchema.safeParse({ publishedOn: '2026-02-30' }).success).toBe(false);
    expect(PublishContentRequestSchema.safeParse({ publishedOn: null }).success).toBe(false);
    expect(PublishContentRequestSchema.safeParse({ publishedAt: '2026-10-10T10:00:00Z' }).success).toBe(false);
    expect(RescheduleContentRequestSchema.safeParse({}).success).toBe(true);
    expect(RescheduleContentRequestSchema.safeParse({ publishOn: '2026-11-03' }).success).toBe(true);
    expect(RescheduleContentRequestSchema.safeParse({ publishOn: '2026-13-01' }).success).toBe(false);
    expect(RescheduleContentRequestSchema.safeParse({ publishOn: null }).success).toBe(false);
    expect(RescheduleContentRequestSchema.safeParse({ status: 'in_production' }).success).toBe(false);
  });
});

describe('the person in charge is named by link (issue #552)', () => {
  const LINK = '5b241101-e2bb-4255-8caf-4136c566a962';

  it('takes the link on create and on edit, and no user id', () => {
    const base = { title: 'Post', format: 'reels', publishOn: '2026-10-20', folderId: FOLDER };
    expect(CreateContentRequestSchema.safeParse({ ...base, ownerMembershipId: LINK }).success).toBe(true);
    expect(CreateContentRequestSchema.safeParse({ ...base, ownerUserId: LINK }).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ ownerMembershipId: LINK }).success).toBe(true);
    expect(UpdateContentRequestSchema.safeParse({ ownerUserId: LINK }).success).toBe(false);
  });

  it('refuses a link that is not an id, and a null one', () => {
    expect(UpdateContentRequestSchema.safeParse({ ownerMembershipId: 'x' }).success).toBe(false);
    expect(UpdateContentRequestSchema.safeParse({ ownerMembershipId: null }).success).toBe(false);
  });

  it('describes the person in charge as { membershipId, name } or null, in the list and in the detail, and never a user id', () => {
    expect(ContentListItemSchema.shape).toHaveProperty('owner');
    expect(ContentListItemSchema.shape).not.toHaveProperty('ownerUserId');
    expect(ContentSchema.shape).toHaveProperty('owner');
    expect(ContentSchema.shape).not.toHaveProperty('ownerUserId');
    expect(ContentSchema.shape.owner.safeParse({ membershipId: LINK, name: 'Ana' }).success).toBe(true);
    expect(ContentSchema.shape.owner.safeParse(null).success).toBe(true);
    expect(ContentSchema.shape.owner.safeParse({ membershipId: LINK, name: 'Ana', userId: LINK }).success).toBe(false);
  });
});

describe('no contract of Conteúdo carries the user id of a person (issue #552)', () => {
  const LINK = '5b241101-e2bb-4255-8caf-4136c566a962';

  it('says who approved by name and side, and nothing else', () => {
    expect(ContentApproverSchema.safeParse({ name: 'Ana', side: 'agency' }).success).toBe(true);
    expect(ContentApproverSchema.safeParse({ name: 'Ana', side: 'client' }).success).toBe(true);
    expect(ContentApproverSchema.safeParse({ name: 'Ana', side: 'portal' }).success).toBe(false);
    expect(ContentApproverSchema.safeParse({ name: 'Ana', side: 'agency', userId: LINK }).success).toBe(false);
    expect(ContentApproverSchema.safeParse(LINK).success).toBe(false);
    expect(ContentSchema.shape.approvedBy.safeParse(null).success).toBe(true);
    expect(ContentSchema.shape.approvedBy.safeParse(LINK).success).toBe(false);
  });

  it('describes a subtask by the person it is for, as { membershipId, name } or null, and who approved it like the content does', () => {
    expect(ContentTaskSchema.shape).toHaveProperty('assignee');
    expect(ContentTaskSchema.shape).not.toHaveProperty('assigneeUserId');
    expect(ContentTaskSchema.shape.assignee.safeParse({ membershipId: LINK, name: 'Ana' }).success).toBe(true);
    expect(ContentTaskSchema.shape.assignee.safeParse(null).success).toBe(true);
    expect(ContentTaskSchema.shape.assignee.safeParse(LINK).success).toBe(false);
    expect(ContentTaskSchema.shape.approvedBy.safeParse({ name: 'Ana', side: 'agency' }).success).toBe(true);
    expect(ContentTaskSchema.shape.approvedBy.safeParse(LINK).success).toBe(false);
  });
});
