import { describe, expect, it } from 'vitest';

import {
  CommentBodySchema,
  CreateCommentRequestSchema,
  CreateThreadRequestSchema,
  ThreadListQuerySchema,
  ThreadSchema,
  threadSubjectOfQuery
} from '../src/index.js';

const personaId = '88888888-8888-4888-8888-888888888888';
const contentId = '99999999-9999-4999-8999-999999999999';

describe('CommentBodySchema (issues #128 and #130)', () => {
  it('trims, keeps line breaks and accepts exactly 5000 bytes', () => {
    expect(CommentBodySchema.parse('  linha 1\nlinha 2\t ')).toBe('linha 1\nlinha 2');
    expect(CommentBodySchema.parse('a'.repeat(5000))).toHaveLength(5000);
    expect(CommentBodySchema.parse(`  ${'a'.repeat(5000)}  `)).toHaveLength(5000);
  });

  it('refuses empty, blank, control characters and more than 5000 bytes', () => {
    for (const body of ['', '   ', '\n\t\r ', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a'.repeat(5001), 'ã'.repeat(2501), '😀'.repeat(1251), 7, null]) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)?.slice(0, 20)).toBe(false);
    }
    expect(CommentBodySchema.safeParse('ã'.repeat(2500)).success).toBe(true);
  });
});

describe('the conversation request bodies', () => {
  it('take exactly one subject and never a side', () => {
    expect(CreateThreadRequestSchema.parse({ subject: { sectionKey: 'branding' }, body: 'x' })).toEqual({ subject: { sectionKey: 'branding' }, body: 'x' });
    expect(CreateThreadRequestSchema.parse({ subject: { personaId }, body: 'x' })).toEqual({ subject: { personaId }, body: 'x' });
    for (const body of [
      { subject: { sectionKey: 'branding', personaId }, body: 'x' },
      { subject: {}, body: 'x' },
      { subject: { sectionKey: 'logo' }, body: 'x' },
      { subject: { personaId: 'not-a-uuid' }, body: 'x' },
      { subject: { sectionKey: 'branding' }, body: 'x', side: 'client' },
      { subject: { sectionKey: 'branding' }, body: 'x', openedSide: 'client' },
      { subject: { sectionKey: 'branding' } },
      { body: 'x' }
    ]) {
      expect(CreateThreadRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('refuse a side and any extra field on a comment', () => {
    expect(CreateCommentRequestSchema.parse({ body: 'x' })).toEqual({ body: 'x' });
    for (const body of [{ body: 'x', side: 'agency' }, { body: 'x', authorSide: 'client' }, { body: 'x', createdAt: '2020-01-01T00:00:00Z' }, {}]) {
      expect(CreateCommentRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('the thread listing query', () => {
  it('names its subject by exactly one of sectionKey and personaId', () => {
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ sectionKey: 'colors' }))).toEqual({ sectionKey: 'colors' });
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ personaId }))).toEqual({ personaId });
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({}))).toBeUndefined();
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ sectionKey: 'colors', personaId }))).toBeUndefined();
  });

  it('accepts only the declared state and no unknown parameter', () => {
    expect(ThreadListQuerySchema.parse({ sectionKey: 'colors', state: 'resolved' }).state).toBe('resolved');
    for (const query of [{ sectionKey: 'colors', state: 'all' }, { sectionKey: 'colors', status: 'open' }, { sectionKey: 'logo' }, { sectionKey: 'colors', page: '1e20' }, { sectionKey: 'colors', page: '0' }]) {
      expect(ThreadListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('names a content by contentId, alone, and refuses a contentId that is not a uuid (#259)', () => {
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ contentId }))).toEqual({ contentId });
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ contentId, sectionKey: 'colors' }))).toBeUndefined();
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ contentId, personaId }))).toBeUndefined();
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ contentId, personaId, sectionKey: 'colors' }))).toBeUndefined();
    expect(ThreadListQuerySchema.safeParse({ contentId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('the subject of a conversation about a content (#259)', () => {
  it('opens a thread with a contentId alone', () => {
    expect(CreateThreadRequestSchema.parse({ subject: { contentId }, body: 'x' })).toEqual({ subject: { contentId }, body: 'x' });
    for (const body of [
      { subject: { contentId, sectionKey: 'branding' }, body: 'x' },
      { subject: { contentId, personaId }, body: 'x' },
      { subject: { contentId: 'not-a-uuid' }, body: 'x' },
      { subject: { contentId, clientId: personaId }, body: 'x' }
    ]) {
      expect(CreateThreadRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('reads a thread subject as exactly one of the three', () => {
    expect(ThreadSchema.shape.subject.safeParse({ contentId }).success).toBe(true);
    expect(ThreadSchema.shape.subject.safeParse({ contentId, personaId }).success).toBe(false);
  });
});

describe('what a comment may carry (#259)', () => {
  it('refuses the invisible characters that are not format characters, anywhere in the text', () => {
    for (const body of [
      '͏', 'a͏b', '⠀', 'a⠀', 'ㅤ', 'aㅤb', '᠋', 'a︀', 'a︎', 'a\u{e0100}', 'aᅟ',
      'a️', '️', '❤︎'
    ]) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('refuses the C1 controls and the line and paragraph separators, which the C0 rule does not reach', () => {
    for (const body of ['a\u0085b', '\u0080', 'a\u009fb', 'a b', 'a b']) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('refuses a text of spaces and format characters alone, as the database does for a request for changes', () => {
    for (const body of ['​', '​ ‍‌', '﻿', '⁠', '‮', ' ​\n⁦ ', '­']) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('keeps what a person really writes: emoji with their selector and joiners, accents and line breaks', () => {
    for (const body of ['❤️', 'Adorei ☀️!', '\u{1f468}‍\u{1f469}‍\u{1f467} juntos', 'coração', 'linha 1\nlinha 2\t3', 'a‍b']) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });
});
