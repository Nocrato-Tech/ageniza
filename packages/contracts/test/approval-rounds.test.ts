import { describe, expect, it } from 'vitest';

import {
  APPROVAL_BATCH_MAX_CONTENTS,
  APPROVAL_DEADLINE_MAX_DAYS,
  APPROVAL_DEFAULT_DEADLINE_HOURS,
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
  PortalApproveContentRequestSchema,
  PortalApproveContentWithNoteRequestSchema,
  PortalContentOpenDetailSchema,
  PortalContentOpenListItemSchema,
  PortalContentProgressResponseSchema,
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
    expect(SubmitContentRequestSchema.safeParse({ dueAt: '2020-01-01T00:00:00Z' }).success).toBe(true);
    expect(SubmitContentRequestSchema.safeParse({ dueAt: '2999-12-31T23:59:59-03:00' }).success).toBe(true);
  });

  it('takes the deadline as an instant with its offset, as the screens send it (decision 2026-11-11)', () => {
    for (const dueAt of ['2026-11-12T18:00:00-03:00', '2026-11-12T21:00:00Z', '2026-11-12T21:00:00.500Z', '2026-11-12T21:00:00+00:00']) {
      expect(SubmitContentRequestSchema.parse({ dueAt }), dueAt).toEqual({ dueAt });
      expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: [uuid(1)], dueAt }).success, dueAt).toBe(true);
    }
    expect(SubmitContentRequestSchema.parse({ dueAt: '2026-11-12T18:00:00-03:00', note: 'Oi' })).toEqual({ dueAt: '2026-11-12T18:00:00-03:00', note: 'Oi' });
  });

  it('refuses an instant with no offset, a day, a date with a time that does not exist and a null', () => {
    for (const dueAt of ['2026-11-12T18:00:00', '2026-11-12', '2026-11-12 18:00:00Z', '2026-11-12T25:00:00Z', '2026-02-30T10:00:00Z', '0000-01-01T00:00:00Z', 'amanhã', '', null, 1_794_000_000_000]) {
      expect(SubmitContentRequestSchema.safeParse({ dueAt }).success, JSON.stringify(dueAt)).toBe(false);
      expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: [uuid(1)], dueAt }).success, JSON.stringify(dueAt)).toBe(false);
    }
  });

  it('refuses the deadline given twice, as an instant and as a day, in one send and in a batch', () => {
    const both = { dueAt: '2026-11-12T18:00:00-03:00', dueOn: '2026-11-12' };
    const single = SubmitContentRequestSchema.safeParse(both);
    expect(single.success).toBe(false);
    if (!single.success) expect(single.error.issues[0]?.path).toEqual(['dueAt']);
    expect(SubmitContentsBatchRequestSchema.safeParse({ contentIds: [uuid(1)], ...both }).success).toBe(false);
  });

  it('proposes 48 hours and holds a deadline to 90 days: the numbers of the screen and of the database', () => {
    expect(APPROVAL_DEFAULT_DEADLINE_HOURS).toBe(48);
    expect(APPROVAL_DEADLINE_MAX_DAYS).toBe(90);
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
  approval: { sentAt: SENT_AT, dueAt: '2026-11-26T02:59:00.000Z', dueOn: '2026-11-25', note: 'Até terça' }
};

describe('the round a content was sent in, as the agency reads it', () => {
  it('is an object or null in the list item and in the content, and is required', () => {
    expect(ContentListItemSchema.safeParse(listItem).success).toBe(true);
    expect(ContentListItemSchema.safeParse({ ...listItem, approval: null }).success).toBe(true);
    expect(ContentListItemSchema.safeParse({ ...listItem, approval: undefined }).success).toBe(false);
    expect(ContentListItemSchema.safeParse(without(listItem, 'approval')).success).toBe(false);
    expect(ContentSchema.shape.approval.safeParse({ sentAt: SENT_AT, dueAt: null, dueOn: null, note: null }).success).toBe(true);
    expect(ContentSchema.shape.approval.safeParse(null).success).toBe(true);
    expect(ContentSchema.shape.approval.safeParse(undefined).success).toBe(false);
  });

  it('carries the moment it was sent, always, and the deadline (as an instant and as its day) and the note, each possibly null, and no more', () => {
    expect(ContentApprovalSchema.safeParse({ sentAt: SENT_AT, dueAt: null, dueOn: null, note: null }).success).toBe(true);
    expect(ContentApprovalSchema.safeParse({ sentAt: SENT_AT, dueAt: '2026-11-12T21:00:00.000Z', dueOn: '2026-11-12', note: 'x' }).success).toBe(true);
    for (const approval of [
      { sentAt: null, dueAt: null, dueOn: null, note: null },
      { dueAt: null, dueOn: null, note: null },
      { sentAt: 'yesterday', dueAt: null, dueOn: null, note: null },
      { sentAt: SENT_AT, dueAt: null, dueOn: null },
      { sentAt: SENT_AT, dueOn: null, note: null },
      { sentAt: SENT_AT, dueAt: '2026-11-12', dueOn: null, note: null },
      { sentAt: SENT_AT, dueAt: '2026-11-12T18:00:00-03:00', dueOn: null, note: null },
      { sentAt: SENT_AT, dueAt: null, dueOn: null, note: null, batchId: uuid(1) },
      { sentAt: SENT_AT, dueAt: null, dueOn: null, note: null, sentBy: uuid(1) }
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
  const waiting = {
    id: uuid(1), title: 'Post', format: 'reels', publishOn: '2026-11-20', thumbnailAssetId: uuid(5), sentAt: SENT_AT,
    dueAt: '2026-11-13T02:59:00.000Z', dueOn: '2026-11-12', daysWaiting: 3, daysToDue: -1, daysLate: null
  };
  const block = (contents: unknown[], approvers: unknown = ['Ana Souza']) => ({
    data: [{ clientId: uuid(2), clientName: 'Padaria', approvers, contents }], meta: { truncated: false }
  });

  it('groups by client, with the days the server counted', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([waiting])).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse({ data: [], meta: { truncated: true } }).success).toBe(true);
  });

  it('lets a negative daysToDue say "venceu" and nothing else go negative', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, daysToDue: -12 }])).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, daysWaiting: -1 }])).success).toBe(false);
  });

  it('reads a content sent before the rounds as a content with no date and no days', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, sentAt: null, dueAt: null, dueOn: null, daysWaiting: null, daysToDue: null }])).success).toBe(true);
  });

  it('counts the days late as a positive whole number, or null', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, daysLate: 4 }])).success).toBe(true);
    for (const daysLate of [0, -1, 1.5, '2']) {
      expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, daysLate }])).success, JSON.stringify(daysLate)).toBe(false);
    }
  });

  it('carries the cover as a file id or null, and the deadline as an instant', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([{ ...waiting, thumbnailAssetId: null }])).success).toBe(true);
    for (const content of [{ ...waiting, thumbnailAssetId: 'x' }, { ...waiting, dueAt: '2026-11-13' }, { ...waiting, dueAt: '2026-11-12T18:00:00' }, without(waiting, 'thumbnailAssetId'), without(waiting, 'dueAt'), without(waiting, 'daysLate')]) {
      expect(AwaitingClientResponseSchema.safeParse(block([content])).success, JSON.stringify(content)).toBe(false);
    }
  });

  it('names the approvers of the client by name only, null when the person may not read them, never more than 50', () => {
    expect(AwaitingClientResponseSchema.safeParse(block([waiting], [])).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse(block([waiting], null)).success).toBe(true);
    expect(AwaitingClientResponseSchema.safeParse(block([waiting], Array(50).fill('Ana'))).success).toBe(true);
    for (const approvers of [Array(51).fill('Ana'), [{ name: 'Ana', email: 'a@b.co' }], [1], 'Ana']) {
      expect(AwaitingClientResponseSchema.safeParse(block([waiting], approvers)).success, JSON.stringify(approvers)).toBe(false);
    }
    const missing = block([waiting]);
    expect(AwaitingClientResponseSchema.safeParse({ ...missing, data: [without(missing.data[0]!, 'approvers')] }).success).toBe(false);
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

  const round = {
    dueAt: '2026-11-26T02:59:00.000Z', dueOn: '2026-11-25', note: 'Até terça', sentAt: SENT_AT,
    sentBy: { name: 'João Pereira', photoUrl: 'https://files.example/joao.png?sig=x' }
  };
  const nobody = { dueAt: null, dueOn: null, note: null, sentAt: null, sentBy: null };

  it('is the deadline (instant and day), the note, when it was sent and who sent it, or null, in the item and in the detail', () => {
    for (const approval of [null, round, nobody, { ...round, sentBy: { name: 'João', photoUrl: null } }, { ...round, sentBy: null }]) {
      expect(PortalContentOpenListItemSchema.safeParse({ ...open, approval }).success, JSON.stringify(approval)).toBe(true);
      expect(PortalContentOpenDetailSchema.safeParse({ ...without(open, 'thumbnailAssetId'), approval, caption: null, revision: 1, media: [] }).success).toBe(true);
    }
    expect(PortalContentOpenListItemSchema.safeParse(open).success).toBe(false);
  });

  it('names the sender and nothing else of them: no e-mail, id, role or membership, and never the batch', () => {
    for (const approval of [
      { ...round, batchId: uuid(1) },
      { ...round, sentBy: { name: 'João', photoUrl: null, email: 'joao@agencia.co' } },
      { ...round, sentBy: { name: 'João', photoUrl: null, id: uuid(3) } },
      { ...round, sentBy: { name: 'João', photoUrl: null, role: 'admin' } },
      { ...round, sentBy: { name: 'João', photoUrl: null, memberId: uuid(3) } },
      { ...round, sentBy: uuid(3) },
      { ...round, sentBy: { name: 'João' } },
      { ...round, sentBy: { photoUrl: null } },
      { ...without(round, 'sentBy') },
      { ...without(round, 'sentAt') },
      { ...without(round, 'dueAt') },
      { ...round, sentAt: '2026-11-10' },
      { ...round, dueAt: '2026-11-25' }
    ]) {
      expect(PortalContentOpenListItemSchema.safeParse({ ...open, approval }).success, JSON.stringify(approval)).toBe(false);
    }
  });
});

describe('the approval of the portal, with a note to the agency (decision 2026-11-11)', () => {
  it('takes the revision and, optionally, the note of the agency: trimmed, 500 characters, never blank', () => {
    expect(PortalApproveContentWithNoteRequestSchema.parse({ revision: 3 })).toEqual({ revision: 3 });
    expect(PortalApproveContentWithNoteRequestSchema.parse({ revision: 3, note: '  Pode publicar!  ' })).toEqual({ revision: 3, note: 'Pode publicar!' });
    expect(PortalApproveContentWithNoteRequestSchema.safeParse({ revision: 3, note: 'a'.repeat(500) }).success).toBe(true);
    expect(PortalApproveContentWithNoteRequestSchema.safeParse({ revision: 3, note: 'a'.repeat(501) }).success).toBe(false);
    for (const note of ['', '   ', text(0x200b), null, 7]) {
      expect(PortalApproveContentWithNoteRequestSchema.safeParse({ revision: 3, note }).success, JSON.stringify(note)).toBe(false);
    }
  });

  it('refuses a revision that is not a positive whole number and a field of the body that names who approved or when', () => {
    for (const body of [{}, { revision: 0 }, { revision: 1.5 }, { revision: '1' }, { revision: 1, approvedBy: uuid(1) }, { revision: 1, approvedAt: SENT_AT }]) {
      expect(PortalApproveContentWithNoteRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('leaves the request of the link and of the withdrawal with the revision alone', () => {
    expect(PortalApproveContentRequestSchema.safeParse({ revision: 3 }).success).toBe(true);
    expect(PortalApproveContentRequestSchema.safeParse({ revision: 3, note: 'x' }).success).toBe(false);
  });
});

describe('the progress of the month in the Início of the portal (decision 2026-11-11)', () => {
  const next = { id: uuid(1), title: 'Post', publishOn: '2026-11-20', publishAtTime: '09:30' };

  it('is the month, how many are approved of how many, and the next post to go on air or null', () => {
    expect(PortalContentProgressResponseSchema.parse({ data: { month: '2026-11', approved: 3, total: 8, next } })).toEqual({ data: { month: '2026-11', approved: 3, total: 8, next } });
    expect(PortalContentProgressResponseSchema.safeParse({ data: { month: '2026-11', approved: 0, total: 0, next: null } }).success).toBe(true);
    expect(PortalContentProgressResponseSchema.safeParse({ data: { month: '2026-11', approved: 1, total: 1, next: { ...next, publishAtTime: null } } }).success).toBe(true);
  });

  it('refuses a month that is not YYYY-MM, a negative or fractional count, and anything that is not the post: no caption, status or person', () => {
    const data = { month: '2026-11', approved: 3, total: 8, next };
    for (const bad of [
      { ...data, month: '2026-1' }, { ...data, month: '2026-11-01' }, { ...data, month: 'novembro' },
      { ...data, approved: -1 }, { ...data, total: 1.5 }, without(data, 'next'), without(data, 'month'),
      { ...data, next: { ...next, caption: 'x' } }, { ...data, next: { ...next, status: 'approved' } }, { ...data, next: without(next, 'publishAtTime') },
      { ...data, owner: uuid(1) }
    ]) {
      expect(PortalContentProgressResponseSchema.safeParse({ data: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(PortalContentProgressResponseSchema.safeParse({ data: { month: '2026-11', approved: 3, total: 8, next }, meta: {} }).success).toBe(false);
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

  it('opens with materialRequest alone, with or without a deadline', () => {
    expect(CreateThreadRequestSchema.parse({ subject: material, body: 'Envie 3 fotos da equipe' })).toEqual({ subject: material, body: 'Envie 3 fotos da equipe' });
    expect(CreateThreadRequestSchema.parse({ subject: material, body: 'x', dueOn: '2026-11-20' })).toEqual({ subject: material, body: 'x', dueOn: '2026-11-20' });
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
      expect(CreateThreadRequestSchema.safeParse({ subject, body: 'x' }).success, JSON.stringify(subject)).toBe(false);
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
    dueOn: '2026-11-20'
  };

  it('is read in a thread with its deadline, which every thread carries as a day or null', () => {
    expect(ThreadSchema.safeParse(thread).success).toBe(true);
    expect(ThreadSchema.safeParse({ ...thread, dueOn: null }).success).toBe(true);
    expect(ThreadSchema.safeParse(without(thread, 'dueOn')).success).toBe(false);
    expect(ThreadSchema.safeParse({ ...thread, subject: { materialRequest: true, contentId } }).success).toBe(false);
  });

  it('lists the open requests of the client in the standard envelope', () => {
    const request = { threadId: uuid(1), body: 'Envie 3 fotos da equipe', dueOn: '2026-11-20', createdAt: SENT_AT, state: 'open' };
    const meta = { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };
    expect(MaterialRequestListResponseSchema.safeParse({ data: [request], meta }).success).toBe(true);
    expect(MaterialRequestListResponseSchema.safeParse({ data: [{ ...request, dueOn: null }], meta }).success).toBe(true);
    for (const item of [{ ...request, state: 'closed' }, { ...request, createdAt: 'ontem' }, { ...request, openedBy: 'Ana' }, { threadId: request.threadId }]) {
      expect(MaterialRequestListResponseSchema.safeParse({ data: [item], meta }).success, JSON.stringify(item)).toBe(false);
    }
  });
});
