import { describe, expect, it } from 'vitest';

import {
  CommentBodySchema,
  hasHiddenStoryCharacters,
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

// Code points are spelled as numbers so the invisible characters stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);
const HEART = 0x2764;
const VS16 = 0xfe0f;

describe('what a comment may carry (#259)', () => {
  it('refuses the invisible characters that are not format characters, anywhere in the text', () => {
    for (const hidden of [
      text(0x034f), text(0x2800), text(0x3164), text(0x115f), text(0x1160), text(0xffa0), text(0x180b), text(0x17b4),
      text(0xfe00), text(0xfe0e), text(0xe0100), text(0x1d159)
    ]) {
      for (const body of [hidden, `a${hidden}b`, `a${hidden}`, `${hidden}a`]) {
        expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
      }
    }
  });

  it('allows the emoji selector once, and only it, right after a pictograph', () => {
    for (const body of [text(HEART, VS16), text(0x1f600, VS16), text(0x00a9, VS16), text(HEART, VS16, HEART, VS16), `Adorei ${text(0x2600, VS16)}!`]) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
    for (const body of [
      text(HEART, VS16, VS16), text(HEART, 0xfe0e), text(HEART, 0xfe00), text(HEART, 0xe0100), text(HEART, VS16, 0xfe00),
      text(HEART, VS16, 0x034f), text(HEART, VS16, 0x61, VS16), text(0x61, VS16), text(VS16)
    ]) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('refuses the C1 controls and the line and paragraph separators, which the C0 rule does not reach', () => {
    for (const hidden of [text(0x0085), text(0x0080), text(0x009f), text(0x2028), text(0x2029)]) {
      expect(CommentBodySchema.safeParse(`a${hidden}b`).success, JSON.stringify(hidden)).toBe(false);
    }
  });

  it('refuses a text of spaces and format characters alone, as the database does for a request for changes', () => {
    for (const body of [
      text(0x200b), text(0x200b, 0x20, 0x200d, 0x200c), text(0xfeff), text(0x2060), text(0x202e), text(0x20, 0x200b, 0x0a, 0x2066, 0x20), text(0x00ad)
    ]) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('keeps what a person really writes: an emoji with its selector, accents and line breaks', () => {
    for (const body of [text(HEART, VS16), `Adorei ${text(0x2600, VS16)}!`, 'coração', 'linha 1\nlinha 2\t3', 'Ótimo 👍 e 🎉']) {
      expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  // One rule of free text in the product: the story script's. A format character is refused in the middle of a
  // word as much as at its edges, and a joiner is accepted only inside a complete emoji sequence (#539).
  it('refuses every format character between letters, the bidi controls and the joiners included', () => {
    for (const hidden of [
      text(0x200b), text(0x200c), text(0x200d), text(0x200e), text(0x200f), text(0x202a), text(0x202e), text(0x2060),
      text(0x2066), text(0x2069), text(0xfeff), text(0x00ad), text(0x061c)
    ]) {
      for (const body of [`a${hidden}b`, `a${hidden}`, `${hidden}a`, `um comentário${hidden}`]) {
        expect(CommentBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
      }
    }
    expect(CommentBodySchema.safeParse(`${text(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)} juntos`).success).toBe(true);
    expect(CommentBodySchema.safeParse(`${text(0x1f468, 0x200d, 0x1f469, 0x200d)} juntos`).success).toBe(false);
    expect(CommentBodySchema.safeParse(`um${text(0x200d)}comentário`).success).toBe(false);
    expect(CommentBodySchema.safeParse(`Top ${text(0x31, 0xfe0f, 0x20e3)}`).success).toBe(true);
  });

  it('says what the story script says about every character of the Basic Multilingual Plane and the musical null', () => {
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const body = `a${String.fromCodePoint(codePoint)}b`;
      expect(CommentBodySchema.safeParse(body).success, `U+${codePoint.toString(16)}`).toBe(!hasHiddenStoryCharacters(body));
    }
    expect(CommentBodySchema.safeParse(`a${text(0x1d159)}b`).success).toBe(false);
  }, 30_000);
});
