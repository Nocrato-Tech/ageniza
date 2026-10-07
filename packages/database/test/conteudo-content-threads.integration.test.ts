import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Issue #250 (specs/conteudo.md §3, §5 rules 1, 2 and 13, §6): the conversation of a content. RLS answers WHO
// may read or write, not through WHICH SIDE, so each rule is attacked with the people who only hold a link, with
// a collaborator who holds a link and a role without Conteúdo (`dualBare`) or with Production (`dualFull`), and
// with an Admin of another agency who holds a link here (`crossDual`). A custom role of one permission stands in
// for each guard.
const w = createContentWorld('conteudo-threads');
const { ids } = w;

const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
const OPEN: readonly ContentStatus[] = ['awaiting_approval', 'adjusting', 'approved', 'published'];
const CLOSED: readonly ContentStatus[] = ['in_production', 'cancelled'];

let onlyOperar: string;
let onlyVisualizar: string;
let operarAndVisualizar: string;
let onlyClienteOperar: string;
const content = {} as Record<ContentStatus, string>;

beforeAll(async () => {
  await w.setup();
  onlyOperar = await w.personWith('conteudo.operar');
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  operarAndVisualizar = await w.personWith('conteudo.operar', 'conteudo.visualizar');
  onlyClienteOperar = await w.personWith('cliente.operar', 'cliente.visualizar');
  for (const status of ['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled'] as const) {
    content[status] = await w.seedContent(ids.clientA1, { status });
  }
});

afterAll(async () => {
  await w.teardown();
});

const openThread = (user: string, contentId: string, side: 'agency' | 'client', extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  return w.asUser(user, (transaction) => transaction('client_threads').insert({
    id, client_id: ids.clientA1, content_id: contentId, opened_by: user, opened_side: side, ...extra
  })).then(() => id);
};

const writeComment = (user: string, threadId: string, side: 'agency' | 'client', body = 'Um comentário', clientId = ids.clientA1): Promise<string> => {
  const id = randomUUID();
  return w.asUser(user, (transaction) => transaction('client_thread_comments').insert({
    id, thread_id: threadId, client_id: clientId, author_user_id: user, author_side: side, body
  })).then(() => id);
};

const seedThread = async (contentId: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  await w.getOwner().knex('client_threads').insert({ id, client_id: ids.clientA1, content_id: contentId, opened_by: ids.adminA, opened_side: 'agency', ...extra });
  return id;
};

const seedComment = async (threadId: string, author: string, side: 'agency' | 'client', clientId = ids.clientA1): Promise<string> => {
  const id = randomUUID();
  await w.getOwner().knex('client_thread_comments').insert({ id, thread_id: threadId, client_id: clientId, author_user_id: author, author_side: side, body: `Texto ${id.slice(0, 6)}` });
  return id;
};

const threadRow = async (id: string): Promise<Record<string, unknown>> =>
  (await w.getOwner().knex('client_threads').where({ id }).first()) as Record<string, unknown>;

const visible = async (user: string, table: 'client_threads' | 'client_thread_comments', column: string, among: readonly string[]): Promise<string[]> =>
  (await w.asUser(user, (transaction) => transaction(table).whereIn(column, among).select(column))).map((row) => row[column] as string).sort();

const authorsOf = (user: string, threadId: string): Promise<string[]> =>
  w.asUser(user, async (transaction) =>
    (await transaction.raw<{ rows: Array<{ author_user_id: string }> }>('select * from app_private.thread_comment_authors(?::uuid)', [threadId])).rows.map((row) => row.author_user_id).sort());

const requestChanges = (user: string, id: string, revision: number, body: string | null) =>
  w.asUser(user, (transaction) => transaction.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [id, revision, body] as never[]));

describe('one conversation per content (issue #250, acceptance 1)', () => {
  it('refuses a second conversation for the same content, whoever opens it and on whichever side', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const first = await openThread(ids.productionA, id, 'agency');

    await expect(openThread(ids.productionA, id, 'agency')).rejects.toMatchObject({ code: '23505', constraint: 'client_threads_content_key' });
    await expect(openThread(ids.portalA1, id, 'client')).rejects.toMatchObject({ code: '23505', constraint: 'client_threads_content_key' });

    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toEqual([{ id: first }]);
  });

  it('keeps the uniqueness for the schema owner too, and still lets many threads of the other subjects exist', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });
    await seedThread(id);

    await expect(seedThread(id)).rejects.toMatchObject({ code: '23505', constraint: 'client_threads_content_key' });
    await w.getOwner().knex('client_threads').insert([1, 2].map(() => ({ client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' })));
  });

  it('holds exactly one subject: a content together with a section is refused, and so is a thread with none', async () => {
    const base = { client_id: ids.clientA1, opened_by: ids.adminA, opened_side: 'agency' };

    await expect(w.getOwner().knex('client_threads').insert({ ...base, content_id: content.approved, section_key: 'branding' })).rejects.toMatchObject({ code: '23514', constraint: 'client_threads_subject_check' });
    await expect(w.getOwner().knex('client_threads').insert(base)).rejects.toMatchObject({ code: '23514', constraint: 'client_threads_subject_check' });
  });

  it('ties the conversation to the client of the content, for every writer', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'approved' });

    await expect(w.getOwner().knex('client_threads').insert({ client_id: ids.clientA2, content_id: id, opened_by: ids.adminA, opened_side: 'agency' }))
      .rejects.toMatchObject({ code: '23503', constraint: 'client_threads_content_fk' });
  });

  it('lets the application insert content_id and still change nothing but the resolution afterwards', async () => {
    expect(await w.columnsWithPrivilege('client_threads', 'insert')).toEqual(['client_id', 'content_id', 'id', 'opened_by', 'opened_side', 'persona_id', 'section_key']);
    expect(await w.columnsWithPrivilege('client_threads', 'update')).toEqual(['resolved_at', 'resolved_by']);
  });
});

describe('who opens and writes in the conversation of a content, and when (issue #250, acceptance 2)', () => {
  it.each(OPEN)('lets a person of the portal open the conversation of a content that is %s, and comment in it', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const thread = await openThread(ids.portalA1, id, 'client');

    await writeComment(ids.portalA1Second, thread, 'client');

    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: thread }).select('id')).toHaveLength(1);
  });

  it.each(CLOSED)('refuses the portal a conversation and a comment on a content that is %s, leaving no row', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const existing = await seedThread(id);
    const before = (await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).length;

    for (const user of [ids.portalA1, ids.dualBare, ids.dualFull, ids.crossDual]) {
      await expect(openThread(user, id, 'client'), String(user)).rejects.toMatchObject(rlsViolation);
      await expect(writeComment(user, existing, 'client'), String(user)).rejects.toMatchObject(rlsViolation);
    }

    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toHaveLength(before);
    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: existing }).select('id')).toHaveLength(0);
  });

  it.each(OPEN)('lets the agency open and write on a content that is %s, with conteudo.operar and conteudo.visualizar', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const thread = await openThread(operarAndVisualizar, id, 'agency');

    await writeComment(ids.productionA, thread, 'agency');
    await writeComment(ids.ownerA, thread, 'agency');

    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: thread }).select('id')).toHaveLength(2);
  });

  it.each(CLOSED)('refuses the agency a conversation and a comment on a content that is %s, because what is written there would reach the client when the content is sent', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });
    const existing = await seedThread(id);

    await expect(openThread(ids.adminA, id, 'agency')).rejects.toMatchObject(rlsViolation);
    await expect(writeComment(ids.adminA, existing, 'agency')).rejects.toMatchObject(rlsViolation);

    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: existing }).select('id')).toHaveLength(0);
  });

  it.each([
    ['a role with only conteudo.operar, who could not read what they wrote', () => onlyOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a role with only cliente.operar, the permission of the other conversations', () => onlyClienteOperar],
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['the Admin of another agency', () => ids.adminB],
    ['an Admin of another agency who holds a link to the client, writing as the agency', () => ids.crossDual],
    ['a collaborator with a link to the client and a role without conteudo.*, writing as the agency', () => ids.dualBare]
  ] as const)('refuses %s to open or to write as the agency in a conversation of a content', async (_label, user) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const existing = await seedThread(id);

    await expect(openThread(user(), content.awaiting_approval, 'agency')).rejects.toMatchObject(rlsViolation);
    await expect(writeComment(user(), existing, 'agency')).rejects.toMatchObject(rlsViolation);

    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: existing }).select('id')).toHaveLength(0);
  });

  it.each([
    ['the Admin of the agency, who has no link to the client', () => ids.adminA],
    ['Production, who has no link to the client', () => ids.productionA],
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['an Admin whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('refuses %s a comment as the client', async (_label, user) => {
    const existing = await seedThread(await w.seedContent(ids.clientA1, { status: 'awaiting_approval' }));

    await expect(writeComment(user(), existing, 'client')).rejects.toMatchObject(rlsViolation);

    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: existing }).select('id')).toHaveLength(0);
  });

  it('refuses a comment with the client of another content, a thread of another client, or a forged author', async () => {
    const existing = await seedThread(await w.seedContent(ids.clientA1, { status: 'awaiting_approval' }));

    await expect(writeComment(ids.portalA2, existing, 'client', 'x', ids.clientA2)).rejects.toBeDefined();
    await expect(writeComment(ids.portalA1, existing, 'client', 'x', ids.clientA2)).rejects.toBeDefined();
    await expect(w.asUser(ids.portalA1, (transaction) => transaction('client_thread_comments').insert({
      thread_id: existing, client_id: ids.clientA1, author_user_id: ids.portalA1Second, author_side: 'client', body: 'forjado'
    }))).rejects.toMatchObject(rlsViolation);
  });

  it('refuses the conversation of an archived client, and of a content of a suspended agency', async () => {
    const archived = await w.seedContent(ids.clientArchived, { status: 'awaiting_approval' });
    const thread = await seedThread(archived, { client_id: ids.clientArchived });
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(writeComment(ids.adminA, thread, 'agency', 'x', ids.clientArchived)).rejects.toMatchObject(rlsViolation);
      await expect(writeComment(ids.portalArchived, thread, 'client', 'x', ids.clientArchived)).rejects.toMatchObject(rlsViolation);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
  });

  it('keeps the other conversations as they were: the agency writes in a section thread with cliente.operar, and Sales still reads it', async () => {
    const thread = randomUUID();
    await w.getOwner().knex('client_threads').insert({ id: thread, client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });

    await writeComment(onlyClienteOperar, thread, 'agency');
    await expect(writeComment(onlyOperar, thread, 'agency')).rejects.toMatchObject(rlsViolation);
    expect(await visible(ids.salesA, 'client_threads', 'id', [thread])).toEqual([thread]);
    expect(await visible(ids.portalA1, 'client_threads', 'id', [thread])).toEqual([thread]);
  });
});

describe('who reads the conversation of a content (issue #250, acceptance 3)', () => {
  let open: string;
  let closed: string;
  let openComment: string;
  let closedComment: string;
  let otherClientThread: string;
  let otherClientComment: string;

  beforeAll(async () => {
    open = await seedThread(content.awaiting_approval);
    closed = await seedThread(content.in_production);
    openComment = await seedComment(open, ids.portalA1, 'client');
    closedComment = await seedComment(closed, ids.adminA, 'agency');
    const other = await w.seedContent(ids.clientA2, { status: 'awaiting_approval' });
    otherClientThread = await seedThread(other, { client_id: ids.clientA2 });
    otherClientComment = await seedComment(otherClientThread, ids.portalA2, 'client', ids.clientA2);
  });

  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA],
    ['Production', () => ids.productionA],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['a collaborator with the Production role and a link to the client', () => ids.dualFull]
  ] as const)('shows %s every conversation of a content of the agency, in any state, with its comments', async (_label, user) => {
    expect(await visible(user(), 'client_threads', 'id', [open, closed, otherClientThread])).toEqual([open, closed, otherClientThread].sort());
    expect(await visible(user(), 'client_thread_comments', 'id', [openComment, closedComment, otherClientComment])).toEqual([openComment, closedComment, otherClientComment].sort());
  });

  it.each([
    ['Sales', () => ids.salesA],
    ['Finance', () => ids.financeA],
    ['a role with only conteudo.operar', () => onlyOperar],
    ['a role with only cliente.operar', () => onlyClienteOperar],
    ['the Admin of another agency', () => ids.adminB]
  ] as const)('shows %s no conversation of a content and no comment of it', async (_label, user) => {
    expect(await visible(user(), 'client_threads', 'id', [open, closed, otherClientThread])).toEqual([]);
    expect(await visible(user(), 'client_thread_comments', 'id', [openComment, closedComment, otherClientComment])).toEqual([]);
  });

  it.each([
    ['a person of the portal of the client', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('shows %s the conversation of a content the client may open, and none of a content in production or of another client', async (_label, user) => {
    expect(await visible(user(), 'client_threads', 'id', [open, closed, otherClientThread])).toEqual([open]);
    expect(await visible(user(), 'client_thread_comments', 'id', [openComment, closedComment, otherClientComment])).toEqual([openComment]);
  });

  it('shows a person of the portal of another client, or of another agency, only the conversations of their own client', async () => {
    expect(await visible(ids.portalA2, 'client_threads', 'id', [open, closed, otherClientThread])).toEqual([otherClientThread]);
    expect(await visible(ids.portalA2, 'client_thread_comments', 'id', [openComment, closedComment, otherClientComment])).toEqual([otherClientComment]);
    expect(await visible(ids.portalB, 'client_threads', 'id', [open, closed, otherClientThread])).toEqual([]);
  });

  it('follows the state of the content: the conversation leaves the portal when the content is cancelled and comes back when it is sent again', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const thread = await seedThread(id);
    const asOwner = (status: ContentStatus) => w.getOwner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id }).update({ status });
    });

    expect(await visible(ids.portalA1, 'client_threads', 'id', [thread])).toEqual([thread]);
    await asOwner('cancelled');
    expect(await visible(ids.portalA1, 'client_threads', 'id', [thread])).toEqual([]);
    await asOwner('in_production');
    expect(await visible(ids.portalA1, 'client_threads', 'id', [thread])).toEqual([]);
    await asOwner('awaiting_approval');
    expect(await visible(ids.portalA1, 'client_threads', 'id', [thread])).toEqual([thread]);
  });

  it('shows the authors of a conversation only to who reads it: no name leaks about a conversation of a content the reader may not see', async () => {
    const authors = (user: string, thread: string) => authorsOf(user, thread);

    expect(await authors(ids.portalA1, open)).toEqual([ids.portalA1]);
    expect(await authors(ids.dualBare, open)).toEqual([ids.portalA1]);
    expect(await authors(ids.crossDual, open)).toEqual([ids.portalA1]);
    expect(await authors(ids.adminA, closed)).toEqual([ids.adminA]);
    expect(await authors(ids.dualFull, closed)).toEqual([ids.adminA]);

    for (const user of [ids.portalA1, ids.dualBare, ids.crossDual, ids.portalA2, ids.portalB]) {
      expect(await authors(user, closed), `${String(user)} reads the conversation of a content in production`).toEqual([]);
    }
    for (const user of [ids.salesA, ids.financeA, onlyOperar, onlyClienteOperar, ids.adminB, ids.portalA2, ids.portalB]) {
      expect(await authors(user, open), `${String(user)} reads the authors of a conversation of a content`).toEqual([]);
      expect(await authors(user, closed)).toEqual([]);
    }
  });
});

describe('a comment of the client reopens the conversation of a content (issue #250, acceptance 4)', () => {
  it('reopens a resolved conversation when a person of the portal comments, and resolves again with conteudo.operar', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'adjusting' });
    const thread = await seedThread(id);
    await seedComment(thread, ids.adminA, 'agency');

    await w.asUser(operarAndVisualizar, (transaction) => transaction('client_threads').where({ id: thread }).update({ resolved_by: operarAndVisualizar, resolved_at: new Date() }));
    expect(await threadRow(thread)).toMatchObject({ resolved_by: operarAndVisualizar });

    await writeComment(ids.portalA1, thread, 'client', 'Ainda falta o logo');
    expect(await threadRow(thread)).toMatchObject({ resolved_by: null, resolved_at: null });

    await w.asUser(ids.productionA, (transaction) => transaction('client_threads').where({ id: thread }).update({ resolved_by: ids.productionA, resolved_at: new Date() }));
    expect(await threadRow(thread)).toMatchObject({ resolved_by: ids.productionA });
  });

  it('does not reopen it for a comment of the agency', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'adjusting' });
    const thread = await seedThread(id, { resolved_by: ids.adminA, resolved_at: new Date() });

    await writeComment(ids.productionA, thread, 'agency', 'Ajustado');

    expect(await threadRow(thread)).toMatchObject({ resolved_by: ids.adminA });
  });

  it.each([
    ['a role with only cliente.operar, the permission of the other conversations', () => onlyClienteOperar],
    ['a role with only conteudo.visualizar', () => onlyVisualizar],
    ['Sales', () => ids.salesA],
    ['a person of the portal', () => ids.portalA1],
    ['a collaborator with a link to the client and a role without conteudo.*', () => ids.dualBare]
  ] as const)('does not let %s resolve the conversation of a content: the UPDATE reaches no row', async (_label, user) => {
    const thread = await seedThread(await w.seedContent(ids.clientA1, { status: 'adjusting' }));

    expect(await w.asUser(user(), (transaction) => transaction('client_threads').where({ id: thread }).update({ resolved_by: user(), resolved_at: new Date() }))).toBe(0);

    expect(await threadRow(thread)).toMatchObject({ resolved_by: null });
  });
});

describe('request changes: awaiting approval to adjusting, with a comment (issue #250)', () => {
  const adjusting = async (id: string): Promise<void> => {
    expect(await w.contentRow(id)).toMatchObject({ status: 'adjusting' });
  };

  it.each([
    ['a person of the portal of the client', () => ids.portalA1],
    ['another person of the portal of the same client', () => ids.portalA1Second],
    ['a collaborator with a link to the client and a role without conteudo.*, who is an active person of the portal', () => ids.dualBare],
    ['a collaborator with the Production role and a link to the client', () => ids.dualFull],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('lets %s ask for changes: the comment enters the conversation of the content, written as the client by who asked', async (_label, user) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });

    await requestChanges(user(), id, 1, 'Troque a foto da capa');

    await adjusting(id);
    const threads = await w.getOwner().knex('client_threads').where({ content_id: id }).select('*');
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ client_id: ids.clientA1, opened_by: user(), opened_side: 'client', section_key: null, persona_id: null, resolved_at: null });
    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: threads[0].id }).select('author_user_id', 'author_side', 'body'))
      .toEqual([{ author_user_id: user(), author_side: 'client', body: 'Troque a foto da capa' }]);
  });

  it('adds the comment to the conversation the agency already opened, and reopens it if it was resolved', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const thread = await seedThread(id, { resolved_by: ids.adminA, resolved_at: new Date() });

    await requestChanges(ids.portalA1, id, 1, 'Mais uma coisa');

    await adjusting(id);
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toEqual([{ id: thread }]);
    expect(await threadRow(thread)).toMatchObject({ resolved_by: null, resolved_at: null });
    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: thread }).select('body')).toEqual([{ body: 'Mais uma coisa' }]);
  });

  it.each([
    ['null', null], ['empty', ''], ['spaces', '   '], ['a no-break space', String.fromCharCode(0xa0)],
    ['an ideographic space', String.fromCharCode(0x3000)], ['more than 5000 bytes', 'a'.repeat(5001)]
  ] as const)('refuses a comment that is %s, leaving the content waiting and no conversation behind', async (_label, body) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });

    await expect(requestChanges(ids.portalA1, id, 1, body)).rejects.toMatchObject({ code: 'A0068' });

    expect((await w.contentRow(id)).status).toBe('awaiting_approval');
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toHaveLength(0);
  });

  it('refuses a revision that is not the one the person saw, so the request is not made against an edited post', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    await w.asUser(ids.productionA, (transaction) => transaction('contents').where({ id }).update({ caption: 'Outra legenda' }));

    await expect(requestChanges(ids.portalA1, id, 1, 'Pedido')).rejects.toMatchObject({ code: 'A0063' });

    expect((await w.contentRow(id)).status).toBe('awaiting_approval');
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toHaveLength(0);
  });

  it.each([
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['an Admin of the agency, who holds every permission but has no link to the client', () => ids.adminA],
    ['the Owner of the agency, who has no link to the client', () => ids.ownerA],
    ['Production, who has no link to the client', () => ids.productionA],
    ['an Admin whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('answers "not found" to %s, leaving the content waiting', async (_label, user) => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });

    await expect(requestChanges(user(), id, 1, 'Pedido')).rejects.toMatchObject({ code: 'A0060' });

    expect((await w.contentRow(id)).status).toBe('awaiting_approval');
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toHaveLength(0);
  });

  it('does not tell the portal that a content in production or a cancelled one exists, and tells the collaborator who reads it the truth', async () => {
    for (const status of CLOSED) {
      for (const user of [ids.portalA1, ids.dualBare]) {
        const forContent = await requestChanges(user, content[status], 1, 'x').catch((error: unknown) => error);
        const forUnknown = await requestChanges(user, randomUUID(), 1, 'x').catch((error: unknown) => error);
        expect(forContent, `${status} ${String(user)}`).toMatchObject({ code: 'A0060' });
        expect((forContent as { message: string }).message).toBe((forUnknown as { message: string }).message);
      }
      await expect(requestChanges(ids.dualFull, content[status], 1, 'x')).rejects.toMatchObject({ code: 'A0062' });
    }
  });

  it.each(['adjusting', 'approved', 'published'] as const)('does not ask for changes on a content that is %s', async (status) => {
    const id = await w.seedContent(ids.clientA1, { status });

    await expect(requestChanges(ids.portalA1, id, 1, 'Pedido')).rejects.toMatchObject({ code: 'A0062' });

    expect((await w.contentRow(id)).status).toBe(status);
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toHaveLength(0);
  });

  it('does not ask for changes for a client that is archived, or for an agency that is suspended', async () => {
    const archived = await w.seedContent(ids.clientArchived, { status: 'awaiting_approval' });
    await w.archiveClient(ids.clientArchived);
    await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });

    try {
      await expect(requestChanges(ids.portalArchived, archived, 1, 'x')).rejects.toMatchObject({ code: 'A0060' });
      await expect(requestChanges(ids.portalSuspended, randomUUID(), 1, 'x')).rejects.toMatchObject({ code: 'A0060' });
    } finally {
      await w.getOwner().knex('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
      await w.reactivateClient(ids.clientArchived);
    }
    expect((await w.contentRow(archived)).status).toBe('awaiting_approval');
  });

  it('waits for an edit that holds the row, then refuses the revision the person saw', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const editor = await w.openTransactionAs(ids.productionA);
    let asking: Promise<unknown> | undefined;

    try {
      await editor('contents').where({ id }).update({ caption: 'Legenda nova' });
      asking = requestChanges(ids.portalA1, id, 1, 'Pedido sobre a legenda antiga').catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await editor.commit();
    }

    expect(await asking).toMatchObject({ code: 'A0063' });
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', revision: 2 });
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toHaveLength(0);
  });

  it('waits for the agency that is opening the conversation of the same content, then uses that one', async () => {
    const id = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const agency = await w.openTransactionAs(ids.productionA);
    const threadId = randomUUID();
    let asking: Promise<unknown> | undefined;

    try {
      await agency('client_threads').insert({ id: threadId, client_id: ids.clientA1, content_id: id, opened_by: ids.productionA, opened_side: 'agency' });
      asking = requestChanges(ids.portalA1, id, 1, 'Pedido do cliente').catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await agency.commit();
    }

    expect(await asking).not.toBeInstanceOf(Error);
    await adjusting(id);
    expect(await w.getOwner().knex('client_threads').where({ content_id: id }).select('id')).toEqual([{ id: threadId }]);
    expect(await w.getOwner().knex('client_thread_comments').where({ thread_id: threadId }).select('body')).toEqual([{ body: 'Pedido do cliente' }]);
  });
});
