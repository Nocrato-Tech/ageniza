import { describe, expect, it } from 'vitest';

import {
  APPROVAL_BATCH_MAX_CONTENTS,
  APPROVAL_NOTE_MAX_CHARACTERS,
  ApprovalNoteSchema,
  AwaitingClientResponseSchema,
  ClientMemberSchema,
  ContentApprovalSchema,
  ContentListItemSchema,
  ContentMoveRequestSchema,
  ContentSchema,
  CreateThreadRequestSchema,
  MaterialRequestListResponseSchema,
  isMaterialRequestOverdue,
  PortalContentOpenDetailSchema,
  PortalContentOpenListItemSchema,
  PortalCreateThreadRequestSchema,
  SubmitContentRequestSchema,
  SubmitContentsBatchRequestSchema,
  SubmitContentsBatchResponseSchema,
  ThreadListQuerySchema,
  ThreadSchema,
  threadSubjectOfQuery
} from '../src/index.js';

const uuid = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const personaId = uuid(900);
const contentId = uuid(901);
const SENT_AT = '2026-11-10T15:00:00.000Z';

// Code points are spelled as numbers so the invisible characters stay visible in this file.
const without = (value: object, key: string): object => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

describe('the note of an approval round (decision 2026-11-10, same rule as A0068)', () => {
  it('trims, keeps line breaks and accepts exactly 500 characters', () => {
    expect(ApprovalNoteSchema.parse('  Aprovar até sexta.\nObrigado!  ')).toBe('Aprovar até sexta.\nObrigado!');
    expect(ApprovalNoteSchema.parse('a'.repeat(APPROVAL_NOTE_MAX_CHARACTERS))).toHaveLength(500);
    expect(ApprovalNoteSchema.parse(`  ${'a'.repeat(500)}  `)).toHaveLength(500);
  });

  it('counts characters, not bytes and not UTF-16 units', () => {
    expect(ApprovalNoteSchema.safeParse('ã'.repeat(500)).success).toBe(true);
    expect(ApprovalNoteSchema.safeParse('😀'.repeat(500)).success).toBe(true);
    expect(ApprovalNoteSchema.safeParse('😀'.repeat(501)).success).toBe(false);
  });

  it('refuses 501 characters', () => {
    expect(ApprovalNoteSchema.safeParse('a'.repeat(501)).success).toBe(false);
    expect(ApprovalNoteSchema.safeParse('ã'.repeat(501)).success).toBe(false);
  });

  it('refuses empty, blank, control and invisible characters', () => {
    for (const note of ['', '   ', '\n\t\r ', 'a\u0000b', 'a\u007fb', text(0x200b), text(0x00a0, 0x2060), text(0x3000), text(0x034f), `a${text(0x2800)}b`, text(0x2028)]) {
      expect(ApprovalNoteSchema.safeParse(note).success, JSON.stringify(note)).toBe(false);
    }
  });

  it('refuses every character the database counts as blank, alone and in a run (A0068)', () => {
    // The class of `app_private.approval_note_is_valid` (migration 20261110000100), spelled as ranges of code points.
    const ranges: ReadonlyArray<readonly [number, number]> = [
      [0x01, 0x08], [0x09, 0x0d], [0x0e, 0x1f], [0x20, 0x20], [0x7f, 0x7f], [0xa0, 0xa0], [0xad, 0xad], [0x1680, 0x1680], [0x180e, 0x180e],
      [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x2060], [0x3000, 0x3000], [0xfeff, 0xfeff]
    ];
    for (const [from, to] of ranges) {
      for (let codePoint = from; codePoint <= to; codePoint += 1) {
        expect(ApprovalNoteSchema.safeParse(text(codePoint)).success, `U+${codePoint.toString(16)}`).toBe(false);
        expect(ApprovalNoteSchema.safeParse(text(codePoint, 0x20, codePoint)).success, `U+${codePoint.toString(16)} run`).toBe(false);
      }
    }
  });

  it('refuses a lone surrogate, in any position, and keeps a whole pair', () => {
    for (const lone of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      for (const note of [text(lone), `a${text(lone)}b`, `a${text(lone)}`, `${text(lone)}a`]) {
        expect(ApprovalNoteSchema.safeParse(note).success, JSON.stringify(note)).toBe(false);
      }
    }
    expect(ApprovalNoteSchema.safeParse(text(0xd83d, 0xde00)).success).toBe(true);
  });

  it('is a string and nothing else', () => {
    for (const note of [7, null, true, ['a']]) expect(ApprovalNoteSchema.safeParse(note).success, JSON.stringify(note)).toBe(false);
  });
});

describe('the body of the submit of one content', () => {
  it('stays valid empty and takes a deadline and a note', () => {
    expect(SubmitContentRequestSchema.parse({})).toEqual({});
    expect(SubmitContentRequestSchema.parse({ dueOn: '2026-11-20' })).toEqual({ dueOn: '2026-11-20' });
    expect(SubmitContentRequestSchema.parse({ note: ' Até quinta ' })).toEqual({ note: 'Até quinta' });
    expect(SubmitContentRequestSchema.parse({ dueOn: '2028-02-29', note: 'x' })).toEqual({ dueOn: '2028-02-29', note: 'x' });
  });

  it('checks only the format of the day: the range is the database', () => {
    expect(SubmitContentRequestSchema.safeParse({ dueOn: '2020-01-01' }).success).toBe(true);
    expect(SubmitContentRequestSchema.safeParse({ dueOn: '2999-12-31' }).success).toBe(true);
  });

  it('refuses a malformed day, a null and any other field', () => {
    for (const body of [
      { dueOn: '2026-02-30' },
      { dueOn: '2026-13-01' },
      { dueOn: '20/11/2026' },
      { dueOn: '2026-1-5' },
      { dueOn: '2026-11-20T00:00:00Z' },
      { dueOn: '' },
      { dueOn: null },
      { dueOn: 20261120 },
      { note: '   ' },
      { note: 'a'.repeat(501) },
      { note: null },
      { sentAt: SENT_AT },
      { batchId: uuid(1) },
      { notes: 'x' }
    ]) {
      expect(SubmitContentRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('does not change the body of the moves that take no field', () => {
    expect(ContentMoveRequestSchema.safeParse({}).success).toBe(true);
    expect(ContentMoveRequestSchema.safeParse({ dueOn: '2026-11-20' }).success).toBe(false);
    expect(ContentMoveRequestSchema.safeParse({ note: 'x' }).success).toBe(false);
  });
});

describe('the body of the submit of a batch', () => {
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => uuid(index + 1));

  it('takes from 1 to 30 distinct contents', () => {
    for (const count of [1, 2, APPROVAL_BATCH_MAX_CONTENTS]) {
      expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: ids(count) }).success, String(count)).toBe(true);
    }
    expect(SubmitContentsBatchRequestSchema.parse({ contentIds: ids(2), dueOn: '2026-11-20', note: ' Oi ' })).toEqual({ contentIds: ids(2), dueOn: '2026-11-20', note: 'Oi' });
  });

  it('refuses 0 and 31 contents', () => {
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: [] }).success).toBe(false);
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: ids(31) }).success).toBe(false);
  });

  it('refuses a repeated content, whatever the case of the id', () => {
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: [uuid(1), uuid(1)] }).success).toBe(false);
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: [uuid(1), uuid(2), uuid(1)] }).success).toBe(false);
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: ['AAAAAAAA-0000-4000-8000-000000000001', uuid(1)] }).success).toBe(false);
    const thirtyOne = [...ids(30), uuid(1)];
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: thirtyOne }).success).toBe(false);
  });

  it('refuses a missing list, a value that is not an id, a bad day, a bad note and any other field', () => {
    for (const body of [
      {},
      { contentIds: 'x' },
      { contentIds: ['not-a-uuid'] },
      { contentIds: [uuid(1)], dueOn: '2026-02-30' },
      { contentIds: [uuid(1)], note: '  ' },
      { contentIds: [uuid(1)], note: 'a'.repeat(501) },
      { contentIds: [uuid(1)], note: `a${text(0xd800)}` },
      { contentIds: [uuid(1)], clientId: uuid(2) },
      { contentIds: [uuid(1)], batchId: uuid(2) }
    ]) {
      expect(SubmitContentsBatchRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

const listItem = {
  id: uuid(1),
  title: 'Post',
  platform: 'instagram',
  format: 'image',
  publishOn: '2026-11-20',
  publishAtTime: null,
  status: 'awaiting_approval',
  owner: null,
  coverAssetId: null,
  thumbnailAssetId: null,
  revision: 1,
  publishedOn: null,
  tasksTotal: 0,
  tasksApproved: 0,
  approval: { sentAt: SENT_AT, dueOn: '2026-11-25', note: 'Até terça' }
};

describe('the round a content was sent in, as the agency reads it', () => {
  it('is an object or null in the list item and in the content, and is required', () => {
    expect(ContentListItemSchema.safeParse(listItem).success).toBe(true);
    expect(ContentListItemSchema.safeParse({ ...listItem, approval: null }).success).toBe(true);
    expect(ContentListItemSchema.safeParse({ ...listItem, approval: undefined }).success).toBe(false);
    expect(ContentListItemSchema.safeParse(without(listItem, 'approval')).success).toBe(false);
    expect(ContentSchema.shape.approval.safeParse({ sentAt: SENT_AT, dueOn: null, note: null }).success).toBe(true);
    expect(ContentSchema.shape.approval.safeParse(null).success).toBe(true);
    expect(ContentSchema.shape.approval.safeParse(undefined).success).toBe(false);
  });

  it('carries the moment it was sent, always, and the deadline and the note, each possibly null, and no more', () => {
    expect(ContentApprovalSchema.safeParse({ sentAt: SENT_AT, dueOn: null, note: null }).success).toBe(true);
    for (const approval of [
      { sentAt: null, dueOn: null, note: null },
      { dueOn: null, note: null },
      { sentAt: 'yesterday', dueOn: null, note: null },
      { sentAt: SENT_AT, dueOn: null },
      { sentAt: SENT_AT, dueOn: null, note: null, batchId: uuid(1) },
      { sentAt: SENT_AT, dueOn: null, note: null, sentBy: uuid(1) }
    ]) {
      expect(ContentApprovalSchema.safeParse(approval).success, JSON.stringify(approval)).toBe(false);
    }
  });

  it('answers the batch with the id and the contents, 1 to 30, all as the list reads them', () => {
    expect(SubmitContentsBatchResponseSchema.safeParse({ data: { batchId: uuid(7), contents: [listItem] } }).success).toBe(true);
    expect(SubmitContentsBatchResponseSchema.safeParse({ data: { batchId: uuid(7), contents: [] } }).success).toBe(false);
    expect(SubmitContentsBatchResponseSchema.safeParse({ data: { batchId: uuid(7), contents: Array(31).fill(listItem) } }).success).toBe(false);
    expect(SubmitContentsBatchResponseSchema.safeParse({ data: { contents: [listItem] } }).success).toBe(false);
  });
});

describe('the contents that wait for the client (Parado no cliente)', () => {
  const waiting = { id: uuid(1), title: 'Post', format: 'reels', publishOn: '2026-11-20', sentAt: SENT_AT, dueOn: '2026-11-12', daysWaiting: 3, daysToDue: -1 };
  const block = (contents: unknown[]) => ({ data: [{ clientId: uuid(2), clientName: 'Padaria', contents }], meta: { truncated: false } });

  it('groups by client, with the days the server counted', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([waiting])).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse({ data: [], meta: { truncated: true } }).success).toBe(true);
  });

  it('lets a negative daysToDue say "venceu" and nothing else go negative', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, daysToDue: -12 }])).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, daysWaiting: -1 }])).success).toBe(false);
  });

  it('reads a content sent before the rounds as a content with no date and no days', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, sentAt: null, dueOn: null, daysWaiting: null, daysToDue: null }])).success).toBe(true);
  });

  it('refuses a fraction of a day, a missing field, an extra one and a missing meta', () => {
    for (const content of [{ ...waiting, daysToDue: 1.5 }, { ...waiting, daysWaiting: 0.5 }, { ...waiting, format: 'story' }, { ...waiting, caption: 'x' }]) {
      expect(AwaitingClientResponseSchema.safeParse(block([content])).success, JSON.stringify(content)).toBe(false);
    }
    expect(AwaitingClientResponseSchema.safeParse(block([without(waiting, 'daysToDue')])).success).toBe(false);
    expect(AwaitingClientResponseSchema.safeParse({ data: [] }).success).toBe(false);
    expect(AwaitingClientResponseSchema.safeParse({ data: [], meta: { truncated: false, page: 1 } }).success).toBe(false);
  });

  it('holds at most 50 contents of a client', () => {
    expect(AwaitingClientResponseSchema.safeParse(block(Array(50).fill(waiting))).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse(block(Array(51).fill(waiting))).success).toBe(false);
    expect(AwaitingClientResponseSchema.safeParse(block([])).success).toBe(false);
  });
});

describe('what the portal reads of a round', () => {
  const open = {
    id: uuid(1), title: 'Post', platform: 'instagram', format: 'image', publishOn: '2026-11-20', publishAtTime: null,
    status: 'awaiting_approval', coverAssetId: null, thumbnailAssetId: null, publishedOn: null
  };

  it('is the deadline and the note, or null, in the item and in the detail', () => {
    for (const approval of [null, { dueOn: '2026-11-25', note: 'Até terça' }, { dueOn: null, note: null }]) {
      expect(PortalContentOpenListItemSchema.safeParse({ ...open, approval }).success, JSON.stringify(approval)).toBe(true);
      expect(PortalContentOpenDetailSchema.safeParse({ ...without(open, 'thumbnailAssetId'), approval, caption: null, revision: 1, media: [] }).success).toBe(true);
    }
    expect(PortalContentOpenListItemSchema.safeParse(open).success).toBe(false);
  });

  it('never carries the date it was sent, who sent it or the batch', () => {
    for (const approval of [{ dueOn: null, note: null, sentAt: SENT_AT }, { dueOn: null, note: null, sentBy: uuid(1) }, { dueOn: null, note: null, batchId: uuid(1) }, { dueOn: null }]) {
      expect(PortalContentOpenListItemSchema.safeParse({ ...open, approval }).success, JSON.stringify(approval)).toBe(false);
    }
  });
});

describe('the last entrance of a person of the portal, as the agency reads it', () => {
  const member = { accessId: uuid(1), name: null, email: 'a@b.co', status: 'active', entered: false, lastEnteredAt: null, since: SENT_AT };

  it('is a moment or null, required beside entered, and may be set while the person has not entered with the account', () => {
    expect(ClientMemberSchema.safeParse(member).success).toBe(true);
    expect(ClientMemberSchema.safeParse({ ...member, entered: true, name: 'Ana', lastEnteredAt: SENT_AT }).success).toBe(true);
    expect(ClientMemberSchema.safeParse({ ...member, lastEnteredAt: SENT_AT }).success).toBe(true);
    expect(ClientMemberSchema.safeParse(without(member, 'lastEnteredAt')).success).toBe(false);
    expect(ClientMemberSchema.safeParse({ ...member, lastEnteredAt: 'ontem' }).success).toBe(false);
  });
});

describe('the request for material as a subject of the conversation of the client', () => {
  const material = { materialRequest: true };

  it('opens with materialRequest alone and a title, with or without a deadline', () => {
    expect(CreateThreadRequestSchema.parse({ subject: material, title: 'Fotos da equipe', body: 'Envie 3 fotos da equipe' }))
      .toEqual({ subject: material, title: 'Fotos da equipe', body: 'Envie 3 fotos da equipe' });
    expect(CreateThreadRequestSchema.parse({ subject: material, title: 'Fotos', body: 'x', dueOn: '2026-11-20' }))
      .toEqual({ subject: material, title: 'Fotos', body: 'x', dueOn: '2026-11-20' });
  });

  it('needs a title for a request, and takes it as one trimmed visible line of up to 80 characters', () => {
    const body = { subject: material, body: 'x' };
    const missing = CreateThreadRequestSchema.safeParse(body);
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.issues.map((issue) => issue.path)).toEqual([['title']]);

    expect(CreateThreadRequestSchema.parse({ ...body, title: '  Logo da marca  ' }).title).toBe('Logo da marca');
    expect(CreateThreadRequestSchema.parse({ ...body, title: 'a'.repeat(80) }).title).toHaveLength(80);
    expect(CreateThreadRequestSchema.parse({ ...body, title: 'ç'.repeat(80) }).title).toHaveLength(80);
    for (const title of [null, '', '   ', 5, ['Fotos'], 'a'.repeat(81), 'a'.repeat(501), 'Duas\nlinhas', 'Com\ttab', text(0x41, 0x07), text(0x41, 0x00), text(0x41, 0x85), text(0x41, 0x200b), text(0x41, 0x202e), '!!!']) {
      expect(CreateThreadRequestSchema.safeParse({ ...body, title }).success, JSON.stringify(title)).toBe(false);
    }
  });

  it('counts the 80 characters of the title as characters, as the column does: a letter and 79 emoji pass, with one more emoji it does not', () => {
    const body = { subject: material, body: 'x' };
    const camera = text(0x1f4f8);
    expect(CreateThreadRequestSchema.parse({ ...body, title: `a${camera.repeat(79)}` }).title).toBe(`a${camera.repeat(79)}`);
    expect(CreateThreadRequestSchema.parse({ ...body, title: `${'a'.repeat(79)}${camera}` }).title).toHaveLength(81);
    expect(CreateThreadRequestSchema.safeParse({ ...body, title: `a${camera.repeat(80)}` }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ ...body, title: `${'a'.repeat(80)}${camera}` }).success).toBe(false);
    expect(CreateThreadRequestSchema.safeParse({ ...body, title: camera.repeat(80) }).success, 'only emoji is no text').toBe(false);
  });

  it('refuses a title for any other subject, and a title on its own is not a request', () => {
    for (const subject of [{ sectionKey: 'branding' }, { personaId }, { contentId }]) {
      const result = CreateThreadRequestSchema.safeParse({ subject, body: 'x', title: 'Fotos' });
      expect(result.success, JSON.stringify(subject)).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['title']);
    }
    expect(PortalCreateThreadRequestSchema.safeParse({ subject: { contentId }, body: 'x', title: 'Fotos' }).success).toBe(false);
  });

  it('is exactly one subject: it never joins another one, and is never false', () => {
    for (const subject of [
      { materialRequest: true, contentId },
      { materialRequest: true, personaId },
      { materialRequest: true, sectionKey: 'branding' },
      { materialRequest: false },
      { materialRequest: 'true' },
      { materialRequest: 1 },
      { materialRequest: true, extra: true }
    ]) {
      expect(CreateThreadRequestSchema.safeParse({ subject, title: 'Fotos', body: 'x' }).success, JSON.stringify(subject)).toBe(false);
    }
  });

  it('refuses a deadline for any other subject', () => {
    for (const subject of [{ sectionKey: 'branding' }, { personaId }, { contentId }]) {
      const result = CreateThreadRequestSchema.safeParse({ subject, body: 'x', dueOn: '2026-11-20' });
      expect(result.success, JSON.stringify(subject)).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['dueOn']);
      expect(CreateThreadRequestSchema.safeParse({ subject, body: 'x' }).success, JSON.stringify(subject)).toBe(true);
    }
  });

  it('checks the format of the day of the request for material, and takes no null', () => {
    for (const dueOn of ['2026-02-30', '20/11/2026', '2026-11-20T00:00:00Z', '', null, 20261120]) {
      expect(CreateThreadRequestSchema.safeParse({ subject: material, body: 'x', dueOn }).success, JSON.stringify(dueOn)).toBe(false);
    }
  });

  it('is never opened by the portal, which keeps the subjects it always had', () => {
    expect(PortalCreateThreadRequestSchema.parse({ subject: { contentId }, body: 'x' })).toEqual({ subject: { contentId }, body: 'x' });
    expect(PortalCreateThreadRequestSchema.parse({ subject: { sectionKey: 'branding' }, body: 'x' })).toEqual({ subject: { sectionKey: 'branding' }, body: 'x' });
    expect(PortalCreateThreadRequestSchema.safeParse({ subject: material, body: 'x' }).success).toBe(false);
    expect(PortalCreateThreadRequestSchema.safeParse({ subject: { contentId }, body: 'x', dueOn: '2026-11-20' }).success).toBe(false);
  });

  it('is named in a listing by materialRequest=true alone', () => {
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ materialRequest: 'true' }))).toEqual(material);
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ materialRequest: 'true', state: 'open' }))).toEqual(material);
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ materialRequest: 'true', contentId }))).toBeUndefined();
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ materialRequest: 'true', sectionKey: 'colors' }))).toBeUndefined();
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ materialRequest: 'true', personaId }))).toBeUndefined();
    expect(threadSubjectOfQuery(ThreadListQuerySchema.parse({ contentId }))).toEqual({ contentId });
    for (const materialRequest of ['false', '1', '', true]) {
      expect(ThreadListQuerySchema.safeParse({ materialRequest }).success, JSON.stringify(materialRequest)).toBe(false);
    }
  });

  const thread = {
    id: uuid(1),
    subject: material,
    state: 'open',
    openedBy: { name: 'Ana', side: 'agency' },
    lastComment: { side: 'agency', at: SENT_AT, excerpt: 'Envie' },
    commentCount: 1,
    resolvedBy: null,
    resolvedAt: null,
    dueOn: '2026-11-20',
    title: 'Fotos da equipe'
  };

  it('is read in a thread with its deadline and its title, each a value or null on every thread', () => {
    expect(ThreadSchema.safeParse(thread).success).toBe(true);
    expect(ThreadSchema.safeParse({ ...thread, dueOn: null }).success).toBe(true);
    expect(ThreadSchema.safeParse({ ...thread, title: null }).success).toBe(true);
    expect(ThreadSchema.safeParse(without(thread, 'dueOn')).success).toBe(false);
    expect(ThreadSchema.safeParse(without(thread, 'title')).success).toBe(false);
    expect(ThreadSchema.safeParse({ ...thread, title: 5 }).success).toBe(false);
    expect(ThreadSchema.safeParse({ ...thread, subject: { materialRequest: true, contentId } }).success).toBe(false);
  });

  it('lists the open requests of the client in the standard envelope, with the title that may be null for an old one', () => {
    const request = { threadId: uuid(1), title: 'Fotos da equipe', body: 'Envie 3 fotos da equipe', dueOn: '2026-11-20', createdAt: SENT_AT, state: 'open' };
    const meta = { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };
    expect(MaterialRequestListResponseSchema.safeParse({ data: [request], meta }).success).toBe(true);
    expect(MaterialRequestListResponseSchema.safeParse({ data: [{ ...request, dueOn: null }], meta }).success).toBe(true);
    expect(MaterialRequestListResponseSchema.safeParse({ data: [{ ...request, title: null }], meta }).success).toBe(true);
    for (const item of [
      { ...request, state: 'closed' }, { ...request, createdAt: 'ontem' }, { ...request, openedBy: 'Ana' }, { threadId: request.threadId },
      without(request, 'title'), { ...request, title: 5 }
    ]) {
      expect(MaterialRequestListResponseSchema.safeParse({ data: [item], meta }).success, JSON.stringify(item)).toBe(false);
    }
  });

  it('is overdue when the day of its deadline passed and nobody resolved it, and never without a deadline', () => {
    expect(isMaterialRequestOverdue({ dueOn: '2026-11-10', state: 'open' }, '2026-11-11')).toBe(true);
    expect(isMaterialRequestOverdue({ dueOn: '2026-11-11', state: 'open' }, '2026-11-11')).toBe(false);
    expect(isMaterialRequestOverdue({ dueOn: '2026-11-12', state: 'open' }, '2026-11-11')).toBe(false);
    expect(isMaterialRequestOverdue({ dueOn: '2026-11-10', state: 'resolved' }, '2026-11-11')).toBe(false);
    expect(isMaterialRequestOverdue({ dueOn: null, state: 'open' }, '2026-11-11')).toBe(false);
    expect(isMaterialRequestOverdue({ dueOn: '2025-12-31', state: 'open' }, '2026-01-01')).toBe(true);
  });
});
