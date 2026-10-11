import { describe, expect, it } from 'vitest';

import {
  CONTENT_CAPTION_MAX_LENGTH,
  CONTENT_PERIOD_MAX_DAYS,
  CONTENT_TITLE_MAX_LENGTH,
  ContentCaptionSchema,
  ContentPeriodQuerySchema,
  ContentTitleSchema,
  CreateContentRequestSchema,
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
    expect(ContentTitleSchema.parse('Amor ❤️ em família 👨‍👩‍👧')).toBe('Amor ❤️ em família 👨‍👩‍👧');
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

  it('accepts a variation selector only right after a pictograph, once', () => {
    expect(valid('❤️')).toBe(true);
    expect(valid('❤️️')).toBe(false);
    expect(valid('1️⃣')).toBe(true);
  });

  it('accepts a joiner between letters but not at the edges', () => {
    expect(valid('می‌خواهم')).toBe(true);
    expect(valid('‍ab')).toBe(false);
    expect(valid('ab‍')).toBe(false);
    expect(valid('a ‍ b')).toBe(false);
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
