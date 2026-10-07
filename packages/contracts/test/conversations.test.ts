import { describe, expect, it } from 'vitest';

import {
  CommentBodySchema,
  CreateCommentRequestSchema,
  CreateThreadRequestSchema,
  ThreadListQuerySchema,
  threadSubjectOfQuery
} from '../src/index.js';

const personaId = '88888888-8888-4888-8888-888888888888';

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
});
