import { describe, expect, it } from 'vitest';

import {
  CreateThreadCommentRequestSchema,
  CreateThreadRequestSchema,
  ThreadListQuerySchema
} from '../src/index.js';

const personaId = '3f2b6c8e-5a47-4d31-9c0e-1b7a8d2e4f60';

describe('conversation contracts', () => {
  it('trims the body and keeps its line breaks and tabs', () => {
    expect(CreateThreadCommentRequestSchema.parse({ body: '  linha 1\n\nlinha\t2\r\nlinha 3  ' }).body).toBe('linha 1\n\nlinha\t2\r\nlinha 3');
  });

  it('refuses an empty body, one with only whitespace, and every other control character', () => {
    for (const body of ['', '   ', '\n\t', ' ', ' ']) {
      expect(CreateThreadCommentRequestSchema.safeParse({ body }).success).toBe(false);
    }
    for (const code of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f]) {
      expect(CreateThreadCommentRequestSchema.safeParse({ body: `a${String.fromCharCode(code)}b` }).success).toBe(false);
    }
  });

  it('limits the body to 5000 UTF-8 bytes after trimming', () => {
    expect(CreateThreadCommentRequestSchema.safeParse({ body: 'a'.repeat(5_000) }).success).toBe(true);
    expect(CreateThreadCommentRequestSchema.safeParse({ body: ` ${'a'.repeat(5_000)} ` }).success).toBe(true);
    expect(CreateThreadCommentRequestSchema.safeParse({ body: 'a'.repeat(5_001) }).success).toBe(false);
    expect(CreateThreadCommentRequestSchema.safeParse({ body: 'é'.repeat(2_500) }).success).toBe(true);
    expect(CreateThreadCommentRequestSchema.safeParse({ body: 'é'.repeat(2_501) }).success).toBe(false);
  });

  it('never accepts a side, an author or any other field in the body', () => {
    expect(CreateThreadCommentRequestSchema.safeParse({ body: 'x', side: 'client' }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ subject: { sectionKey: 'branding' }, body: 'x', openedSide: 'client' }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ subject: { sectionKey: 'branding' }, body: 'x', side: 'client' }).success).toBe(false);
  });

  it('takes exactly one subject: a section out of the seven, or a persona', () => {
    for (const sectionKey of ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations']) {
      expect(CreateThreadRequestSchema.safeParse({ subject: { sectionKey }, body: 'x' }).success).toBe(true);
    }
    expect(CreateThreadRequestSchema.safeParse({ subject: { personaId }, body: 'x' }).success).toBe(true);
    expect(CreateThreadRequestSchema.safeParse({ subject: { sectionKey: 'content' }, body: 'x' }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ subject: { sectionKey: 'branding', personaId }, body: 'x' }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ subject: {}, body: 'x' }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ subject: { personaId: 'not-a-uuid' }, body: 'x' }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ body: 'x' }).success).toBe(false);
  });

  it('accepts the list filters and refuses an unknown state, field or page overflow', () => {
    expect(ThreadListQuerySchema.safeParse({ sectionKey: 'branding', state: 'open', page: '2', pageSize: '20' }).success).toBe(true);
    expect(ThreadListQuerySchema.safeParse({ personaId, state: 'resolved' }).success).toBe(true);
    expect(ThreadListQuerySchema.safeParse({ sectionKey: 'branding', state: 'reopened' }).success).toBe(false);
    expect(ThreadListQuerySchema.safeParse({ sectionKey: 'branding', extra: '1' }).success).toBe(false);
    expect(ThreadListQuerySchema.safeParse({ sectionKey: 'branding', page: '4e17' }).success).toBe(false);
  });
});
