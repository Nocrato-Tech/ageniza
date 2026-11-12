import { randomUUID } from 'node:crypto';

import type { PortalContentProgressResponse } from '@ageniza/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createPortalFixtures, type PortalPerson } from './test-support/portal-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Scope redesign-igual, subtask A2: what the portal's Início reads (decisions 2026-11-11): the progress of the month ("Boa notícia"), what
// needs the client in the order of its deadline with the hour, the sender of the round (name and photo, never the person's e-mail or id) and
// the approval with a note to the agency. The instant is the clock the module is given. Every scenario that proves isolation uses a person
// the policy would let read the row (a collaborator with a link, a person with a link to two clients), so a missing filter shows up as a
// leaked row instead of being hidden by row-level security.
const w = createContentsWorld('portal-home');
const p = createPortalFixtures(w);
const { people } = w;

const NOW = new Date('2026-11-10T01:30:00.000Z'); // 2026-11-09 22:30:00 in America/Sao_Paulo
let clock: Date | undefined;
const bucket = { refusing: false };

const knex = () => w.getOwner().knex;
const get = (person: PortalPerson, url: string): Promise<Reply> => w.call('GET', p.people[person].cookie, url);
const post = (person: PortalPerson, url: string, body?: unknown): Promise<Reply> => w.call('POST', p.people[person].cookie, url, body);
const errorOf = (reply: Reply): { code?: string; message?: string } => reply.json().error ?? {};

const progressUrl = (clientId: string): string => `/clients/${clientId}/contents/progress`;
const awaitingUrl = (clientId: string): string => `/clients/${clientId}/contents/awaiting-approval`;
const oneUrl = (clientId: string, contentId: string): string => `/clients/${clientId}/contents/${contentId}`;
const approveUrl = (clientId: string, contentId: string): string => `${oneUrl(clientId, contentId)}/approve`;

const freshClient = async (label: string, members: readonly PortalPerson[] = ['portalOne']): Promise<string> => {
  const clientId = await w.newClient(label);
  for (const member of members) await knex()('client_memberships').insert({ client_id: clientId, user_id: p.people[member].id });
  return clientId;
};

type Round = { dueAt: string | null; note?: string | null; sequence?: number; sentAt?: string; sentBy?: string };
const seedRound = (contentId: string, clientId: string, round: Round): Promise<unknown> =>
  knex()('content_approval_rounds').insert({
    batch_id: randomUUID(), client_id: clientId, content_id: contentId, sequence: round.sequence ?? 1,
    due_at: round.dueAt, due_on: round.dueAt === null ? null : knex().raw('app_private.sao_paulo_date(?::timestamptz)', [round.dueAt]),
    note: round.note ?? null, sent_by: round.sentBy ?? people.manager.id, sent_at: round.sentAt ?? '2026-11-05T12:00:00.000Z'
  });

const waiting = async (clientId: string, title: string, round?: Round, extra: { publishOn?: string; publishAtTime?: string | null } = {}): Promise<string> => {
  const id = await w.seedContent(clientId, { status: 'awaiting_approval', title, ...extra });
  if (round !== undefined) await seedRound(id, clientId, round);
  return id;
};

const commentsOf = async (contentId: string): Promise<Array<Record<string, unknown>>> => {
  const thread = await knex()('client_threads').where({ content_id: contentId }).first('id');
  return thread === undefined ? [] : knex()('client_thread_comments').where({ thread_id: thread.id }).orderBy('created_at', 'asc');
};

beforeAll(async () => {
  await w.setup({
    contentsClock: () => clock ?? new Date(),
    wrapIdentityStorage: (real) => ({
      ...real,
      presignGetObject: async (input) => {
        if (bucket.refusing) throw new Error('The bucket refused to sign.');
        return real.presignGetObject(input);
      }
    })
  });
  await p.setup();
  clock = NOW;
}, 120_000);

afterEach(() => {
  clock = NOW;
  bucket.refusing = false;
});

afterAll(async () => {
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('the progress of the month, "Boa notícia"', () => {
  let client: string;
  let ids: Record<string, string>;

  const progress = async (at: Date = NOW, person: PortalPerson = 'portalOne', clientId: string = client): Promise<PortalContentProgressResponse['data']> => {
    clock = at;
    const reply = await get(person, progressUrl(clientId));
    expect(reply.statusCode).toBe(200);
    return reply.json<PortalContentProgressResponse>().data;
  };

  beforeAll(async () => {
    client = await freshClient('progress', ['portalOne', 'portalMulti', 'dualRead']);
    const other = await freshClient('progress-other', ['portalMulti']);
    const seed = (status: 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled', publishOn: string, title: string, publishAtTime: string | null = null) =>
      w.seedContent(client, { status, publishOn, publishAtTime, title });
    ids = {
      inProduction: await seed('in_production', '2026-11-20', 'Em produção'),
      awaiting: await seed('awaiting_approval', '2026-11-05', 'Esperando'),
      adjusting: await seed('adjusting', '2026-11-06', 'Em ajuste'),
      approvedPast: await seed('approved', '2026-11-02', 'Aprovado e passou'),
      approvedFuture: await seed('approved', '2026-11-30', 'Aprovado para o fim do mês', '09:00'),
      published: await seed('published', '2026-11-01', 'Publicado'),
      publishedAhead: await seed('published', '2026-11-12', 'Publicado, com o dia planejado adiante', '08:00'),
      cancelled: await seed('cancelled', '2026-11-10', 'Cancelado'),
      todayLate: await seed('approved', '2026-11-09', 'Hoje à noite', '23:00'),
      todayNoHour: await seed('approved', '2026-11-09', 'Hoje sem hora'),
      todayPassed: await seed('approved', '2026-11-09', 'Hoje, já passou', '22:30'),
      lastMonth: await seed('approved', '2026-10-31', 'Do mês passado'),
      decemberAwaiting: await seed('awaiting_approval', '2026-12-01', 'Esperando em dezembro'),
      decemberApproved: await seed('approved', '2026-12-10', 'Aprovado em dezembro', '10:00')
    };
    // Of another client the same person reads: its numbers never enter this client's, and its earlier post is not this client's next.
    await w.seedContent(other, { status: 'approved', publishOn: '2026-11-09', publishAtTime: '22:45', title: 'De outro cliente' });
    await w.seedContent(other, { status: 'awaiting_approval', publishOn: '2026-11-12', title: 'De outro cliente, esperando' });
  }, 60_000);

  it('counts the contents of the month, not cancelled, and those among them that are approved or published', async () => {
    const data = await progress();

    expect(data.month).toBe('2026-11');
    expect(data.total).toBe(10);
    expect(data.approved).toBe(7);
  });

  it('gives the next post to go on air: the earliest approved one whose hour has not come', async () => {
    const data = await progress();

    expect(data.next).toEqual({ id: ids.todayLate, title: 'Hoje à noite', publishOn: '2026-11-09', publishAtTime: '23:00' });
  });

  it('never gives a post that is already published as the next one, whatever day it was planned for', async () => {
    const data = await progress(new Date('2026-11-10T03:00:00.000Z'));

    expect(data.next?.id).not.toBe(ids.publishedAhead);
    expect(data.next?.id).toBe(ids.approvedFuture);
  });

  it('keeps today\'s post with no hour until the day is over, then goes on to the next day\'s', async () => {
    expect((await progress(new Date('2026-11-10T02:31:00.000Z'))).next).toEqual({ id: ids.todayNoHour, title: 'Hoje sem hora', publishOn: '2026-11-09', publishAtTime: null }); // 23:31
    expect((await progress(new Date('2026-11-10T02:59:00.000Z'))).next?.id).toBe(ids.todayNoHour); // 23:59
    expect((await progress(new Date('2026-11-10T03:00:00.000Z'))).next).toEqual({ id: ids.approvedFuture, title: 'Aprovado para o fim do mês', publishOn: '2026-11-30', publishAtTime: '09:00' }); // 00:00 of the 10th
  });

  it('gives no post whose hour is the very minute: the hour must be ahead', async () => {
    expect((await progress(new Date('2026-11-10T01:30:00.000Z'))).next?.id).toBe(ids.todayLate); // 22:30:00, the 23:00 is ahead
    expect((await progress(new Date('2026-12-10T12:59:00.000Z'))).next?.id).toBe(ids.decemberApproved); // 09:59, the 10:00 is ahead
    expect((await progress(new Date('2026-12-10T13:00:00.000Z'))).next).toBeNull(); // 10:00:00, it is the very minute
  });

  it('turns the month at midnight of São Paulo, though it is the same UTC day', async () => {
    const lastMinute = await progress(new Date('2026-12-01T02:59:00.000Z'));
    expect(lastMinute).toMatchObject({ month: '2026-11', total: 10, approved: 7 });

    const december = await progress(new Date('2026-12-01T03:00:00.000Z'));
    expect(december).toMatchObject({ month: '2026-12', total: 2, approved: 1 });
    expect(december.next).toEqual({ id: ids.decemberApproved, title: 'Aprovado em dezembro', publishOn: '2026-12-10', publishAtTime: '10:00' });
  });

  it('has nothing to say of a month with no contents, and no next post', async () => {
    expect(await progress(new Date('2027-01-05T12:00:00.000Z'))).toEqual({ month: '2027-01', approved: 0, total: 0, next: null });
  });

  it('gives only the fields of the contract: no status, caption, owner or id of anything but the next post', async () => {
    const reply = await get('portalOne', progressUrl(client));

    expect(Object.keys(reply.json())).toEqual(['data']);
    expect(Object.keys(reply.json().data).sort()).toEqual(['approved', 'month', 'next', 'total']);
    expect(Object.keys(reply.json().data.next).sort()).toEqual(['id', 'publishAtTime', 'publishOn', 'title']);
    for (const secret of [ids.awaiting!, ids.inProduction!, ids.cancelled!, ids.decemberAwaiting!, 'Esperando', 'Em produção', people.production.id]) {
      expect(JSON.stringify(reply.json())).not.toContain(secret);
    }
  });

  it('gives a person with a link to two clients the client of the path only, in both directions', async () => {
    const other = (await knex()('contents').where({ title: 'De outro cliente' }).first('client_id'))?.client_id as string;

    expect(await progress(NOW, 'portalMulti', client)).toEqual(await progress(NOW, 'portalOne', client));
    const theirs = await progress(NOW, 'portalMulti', other);
    expect(theirs).toMatchObject({ total: 2, approved: 1 });
    expect(theirs.next?.title).toBe('De outro cliente');
  });

  it('reads the same for a collaborator of the agency who also has a link: the portal gives what the portal gives', async () => {
    expect(await progress(NOW, 'dualRead')).toEqual(await progress(NOW, 'portalOne'));
  });

  it('answers 401 without a session', async () => {
    const reply = await w.getApp().app.inject({ method: 'GET', url: progressUrl(client), headers: { origin: TEST_APP_PUBLIC_URL } });

    expect(reply.statusCode).toBe(401);
  });

  it.each(['removed', 'portalOther', 'portalB'] as const)('answers 404 to %s, who has no active link to the client', async (person) => {
    const reply = await get(person, progressUrl(client));

    expect(reply.statusCode).toBe(404);
    expect(JSON.stringify(reply.json())).not.toContain('Hoje à noite');
  });

  it('answers 404 to a collaborator of the agency with no link to the client, though the policy would let them read its contents', async () => {
    for (const cookie of [people.admin.cookie, people.owner.cookie, people.reader.cookie]) {
      const reply = await w.call('GET', cookie, progressUrl(client));
      expect(reply.statusCode).toBe(404);
      expect(JSON.stringify(reply.json())).not.toContain('Hoje à noite');
    }
  });

  it('answers 404 once the client is archived, though the person still has the link', async () => {
    const archived = await freshClient('progress-archived');
    await w.seedContent(archived, { status: 'approved', publishOn: '2026-11-20' });
    await knex()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });

    expect((await get('portalOne', progressUrl(archived))).statusCode).toBe(404);
  });

  it('is not read as the id of a content: a malformed id is the same 404 as an absent one, and progress is the route of the month', async () => {
    expect((await get('portalOne', oneUrl(client, 'progress-not-an-id'))).statusCode).toBe(404);
    expect((await get('portalOne', progressUrl(client))).statusCode).toBe(200);
  });
});

describe('what needs the client, in the order of the deadline with its hour', () => {
  it('orders by the instant of the deadline: the hour breaks a day, the publication day breaks a deadline, and without a deadline comes last', async () => {
    const client = await freshClient('awaiting-order');
    const day = (iso: string): Round => ({ dueAt: iso });
    // The publication days are the opposite of the deadlines' order where it matters, so ordering by publication day would give another list.
    const first = await waiting(client, 'Primeiro', day('2026-11-12T13:00:00.000Z'), { publishOn: '2026-12-20' });
    const second = await waiting(client, 'Segundo, mesmo dia, mais tarde', day('2026-11-12T20:00:00.000Z'), { publishOn: '2026-12-01' });
    const third = await waiting(client, 'Terceiro', day('2026-11-15T02:59:00.000Z'), { publishOn: '2026-12-05', publishAtTime: '09:00' });
    const tieLateHour = await waiting(client, 'Empate, publica mais tarde', day('2026-11-18T02:59:00.000Z'), { publishOn: '2026-12-10', publishAtTime: '14:00' });
    const tieDay = await waiting(client, 'Empate, publica antes', day('2026-11-18T02:59:00.000Z'), { publishOn: '2026-12-08' });
    const tieEarlyHour = await waiting(client, 'Empate, publica mais cedo', day('2026-11-18T02:59:00.000Z'), { publishOn: '2026-12-10', publishAtTime: '09:00' });
    // Sent twice: the deadline of the latest send is the one that orders it.
    const resent = await waiting(client, 'Reenviado', { dueAt: '2026-11-10T12:00:00.000Z', sequence: 1, sentAt: '2026-11-04T12:00:00.000Z' }, { publishOn: '2026-12-30' });
    await seedRound(resent, client, { dueAt: '2026-11-30T12:00:00.000Z', sequence: 2, sentAt: '2026-11-08T12:00:00.000Z' });
    const noDue = await waiting(client, 'Sem prazo', { dueAt: null }, { publishOn: '2026-12-02' });
    const legacy = await waiting(client, 'Antes das rodadas', undefined, { publishOn: '2026-12-03' });

    const reply = await get('portalOne', awaitingUrl(client));

    expect(reply.statusCode).toBe(200);
    expect(reply.json().data.map((item: { id: string }) => item.id)).toEqual([first, second, third, tieDay, tieEarlyHour, tieLateHour, resent, noDue, legacy]);
    expect(reply.json().data[1].approval).toMatchObject({ dueAt: '2026-11-12T20:00:00.000Z', dueOn: '2026-11-12' });
    expect(reply.json().data[6].approval).toMatchObject({ dueAt: '2026-11-30T12:00:00.000Z' });
  });

  it('keeps the page boundaries on that order: the second page continues where the first stopped', async () => {
    const client = await freshClient('awaiting-pages');
    const order: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      order.push(await waiting(client, `Conteúdo ${index}`, { dueAt: `2026-11-${String(20 + index)}T12:00:00.000Z` }));
    }

    const firstPage = await get('portalOne', `${awaitingUrl(client)}?page=1&pageSize=2`);
    const secondPage = await get('portalOne', `${awaitingUrl(client)}?page=2&pageSize=2`);

    expect(firstPage.json().data.map((item: { id: string }) => item.id)).toEqual(order.slice(0, 2));
    expect(secondPage.json().data.map((item: { id: string }) => item.id)).toEqual(order.slice(2, 4));
  });
});

describe('who sent the round, as the portal shows it', () => {
  let client: string;
  let managerPhotoKey: string;
  let withPhoto: string;
  let withoutPhoto: string;
  let withForeignPhoto: string;
  let managerEmail: string;

  beforeAll(async () => {
    managerPhotoKey = `users/${people.manager.id}/avatar/${randomUUID()}.png`;
    await knex().raw('update auth."user" set image = ? where id = ?', [managerPhotoKey, people.manager.id]);
    await knex().raw('update auth."user" set image = ? where id = ?', ['https://evil.example/avatar.png', people.production.id]);
    managerEmail = (await knex()('auth.user').where({ id: people.manager.id }).first('email'))?.email as string;

    client = await freshClient('sender');
    withPhoto = await waiting(client, 'Enviado pela gerente', { dueAt: '2026-11-12T13:00:00.000Z', sentBy: people.manager.id }, { publishOn: '2026-12-01' });
    withoutPhoto = await waiting(client, 'Enviado por comercial', { dueAt: '2026-11-13T13:00:00.000Z', sentBy: people.sales.id }, { publishOn: '2026-12-02' });
    withForeignPhoto = await waiting(client, 'Enviado pela produção', { dueAt: '2026-11-14T13:00:00.000Z', sentBy: people.production.id }, { publishOn: '2026-12-03' });
  }, 60_000);

  const senderOf = (reply: Reply, id: string): unknown => {
    const body = reply.json();
    const items: Array<{ id: string; approval?: { sentBy?: unknown } }> = Array.isArray(body.data) ? body.data : [body];
    return items.find((item) => item.id === id)?.approval?.sentBy;
  };

  it.each(['period', 'awaiting', 'one'] as const)('gives the name and a signed address of the photo in the %s read, and only for a key of an avatar', async (read) => {
    const reply = await get('portalOne', read === 'period' ? `/clients/${client}/contents?from=2026-12-01&to=2026-12-31` : read === 'awaiting' ? awaitingUrl(client) : oneUrl(client, withPhoto));

    expect(reply.statusCode).toBe(200);
    const sender = senderOf(reply, withPhoto) as { name: string; photoUrl: string | null };
    expect(sender.name).toBe('Pessoa manager');
    expect(decodeURIComponent(new URL(sender.photoUrl as string).pathname)).toContain(managerPhotoKey);
    expect(senderOf(reply, read === 'one' ? withPhoto : withoutPhoto)).toEqual(read === 'one' ? sender : { name: 'Pessoa sales', photoUrl: null });
    if (read !== 'one') {
      // An image that is not a key of the identity bucket is a string the account holds, not something to sign or to hand over.
      expect(senderOf(reply, withForeignPhoto)).toEqual({ name: 'Pessoa production', photoUrl: null });
      expect(JSON.stringify(reply.json())).not.toContain('evil.example');
    }
  });

  it('gives the name and no photo when the bucket refuses to sign: the answer does not fail', async () => {
    bucket.refusing = true;

    const reply = await get('portalOne', oneUrl(client, withPhoto));

    expect(reply.statusCode).toBe(200);
    expect(senderOf(reply, withPhoto)).toEqual({ name: 'Pessoa manager', photoUrl: null });
  });

  it('never gives the e-mail, the id, the role or the batch of the person of the agency, nor the key of the photo', async () => {
    const replies = [await get('portalOne', oneUrl(client, withPhoto)), await get('portalOne', awaitingUrl(client)), await get('portalOne', `/clients/${client}/contents?from=2026-12-01&to=2026-12-31`)];

    for (const reply of replies) {
      // The signed address of a photo is a URL of the bucket: it is the one place the key of the object, which names the account, is in.
      const text = JSON.stringify(reply.json(), (key, value) => (key === 'photoUrl' && typeof value === 'string' ? '<signed url>' : value));
      for (const secret of [managerEmail, people.manager.id, people.production.id, people.sales.id, 'batch', 'role', 'membership', managerPhotoKey]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).toContain('Pessoa manager');
    }
  });

  it('answers the sender with the answer of the approval too, as it reads the content back', async () => {
    const own = await freshClient('sender-approve');
    const id = await waiting(own, 'Aprovar e ler de volta', { dueAt: '2026-11-12T13:00:00.000Z', sentBy: people.manager.id });

    const approved = await post('portalOne', approveUrl(own, id), { revision: 1 });

    expect(approved.statusCode).toBe(200);
    expect(approved.json().approval.sentBy.name).toBe('Pessoa manager');
    expect(decodeURIComponent(new URL(approved.json().approval.sentBy.photoUrl).pathname)).toContain(managerPhotoKey);
  });
});

describe('approving with a note to the agency', () => {
  const NOTE = 'Aprovado! Pode publicar às 18h, e obrigada pelo cuidado.';
  const noteOf = async (id: string): Promise<Array<Record<string, unknown>>> => commentsOf(id);

  it('approves and records the note as a comment of the client in the conversation of the content, in the same move', async () => {
    const client = await freshClient('note');
    const id = await waiting(client, 'Com recado');

    const reply = await post('portalOne', approveUrl(client, id), { revision: 1, note: NOTE });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id, status: 'approved' });
    expect(await w.contentRow(id)).toMatchObject({ status: 'approved', approved_by: p.people.portalOne.id });
    const thread = await knex()('client_threads').where({ content_id: id }).first();
    expect(thread).toMatchObject({ client_id: client, opened_by: p.people.portalOne.id, opened_side: 'client' });
    const comments = await noteOf(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ client_id: client, author_user_id: p.people.portalOne.id, author_side: 'client', body: NOTE });
  });

  it('writes the note trimmed, as the agency\'s is', async () => {
    const client = await freshClient('note-trim');
    const id = await waiting(client, 'Recado com espaços');

    expect((await post('portalOne', approveUrl(client, id), { revision: 1, note: `  ${NOTE}\n ` })).statusCode).toBe(200);

    expect((await noteOf(id))[0]?.body).toBe(NOTE);
  });

  it('writes the note into the conversation the agency already opened for the content, and keeps what was there', async () => {
    const client = await freshClient('note-open-thread');
    const id = await waiting(client, 'Com conversa aberta');
    const threadId = randomUUID();
    await knex()('client_threads').insert({ id: threadId, client_id: client, content_id: id, opened_by: people.manager.id, opened_side: 'agency' });
    await knex()('client_thread_comments').insert({ id: randomUUID(), thread_id: threadId, client_id: client, author_user_id: people.manager.id, author_side: 'agency', body: 'Qualquer dúvida, me avise.' });

    expect((await post('portalOne', approveUrl(client, id), { revision: 1, note: NOTE })).statusCode).toBe(200);

    expect(await knex()('client_threads').where({ content_id: id })).toHaveLength(1);
    expect((await noteOf(id)).map((comment) => [comment.author_side, comment.body])).toEqual([['agency', 'Qualquer dúvida, me avise.'], ['client', NOTE]]);
  });

  it('opens no conversation when the client approves without a note', async () => {
    const client = await freshClient('note-none');
    const id = await waiting(client, 'Sem recado');

    expect((await post('portalOne', approveUrl(client, id), { revision: 1 })).statusCode).toBe(200);

    expect(await knex()('client_threads').where({ content_id: id })).toHaveLength(0);
    expect(await w.contentRow(id)).toMatchObject({ status: 'approved' });
  });

  it('accepts a note of exactly 500 visible characters, counted as characters and not bytes, and refuses the 501st', async () => {
    const client = await freshClient('note-limit');
    const ascii = await waiting(client, 'Limite ascii');
    const accented = await waiting(client, 'Limite acentuado');
    const over = await waiting(client, 'Acima do limite');
    const overAccented = await waiting(client, 'Acima do limite acentuado');

    expect((await post('portalOne', approveUrl(client, ascii), { revision: 1, note: 'a'.repeat(500) })).statusCode).toBe(200);
    expect((await post('portalOne', approveUrl(client, accented), { revision: 1, note: 'ç'.repeat(500) })).statusCode).toBe(200);
    expect((await noteOf(accented))[0]?.body).toBe('ç'.repeat(500));
    for (const [id, note] of [[over, 'a'.repeat(501)], [overAccented, 'ç'.repeat(501)]] as const) {
      const reply = await post('portalOne', approveUrl(client, id), { revision: 1, note });
      expect(reply.statusCode).toBe(400);
      expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
      expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null });
      expect(await knex()('client_threads').where({ content_id: id })).toHaveLength(0);
    }
  });

  it('refuses a blank note and a note with an invisible, control or format character, leaving the content awaiting approval', async () => {
    const client = await freshClient('note-invalid');
    const id = await waiting(client, 'Recado inválido');
    const zeroWidth = String.fromCodePoint(0x200b);
    const bidi = String.fromCodePoint(0x202e);
    const control = String.fromCodePoint(0x07);

    for (const note of ['', '   ', `\n\t`, `Ok${zeroWidth}`, `Ok${bidi}`, `Ok${control}`, null, 12, ['a']]) {
      const reply = await post('portalOne', approveUrl(client, id), { revision: 1, note });
      expect(reply.statusCode, JSON.stringify(note)).toBe(400);
      expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
    }
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval' });
    expect(await knex()('client_threads').where({ content_id: id })).toHaveLength(0);
  });

  // The contract stops everything the database stops, so the second barrier is reached only by a note the contract lets through: here, one the database is made to refuse.
  it('names the refusal of the database as the note of the approval, not as a comment, and leaves the content awaiting approval', async () => {
    const client = await freshClient('note-second-barrier');
    const id = await waiting(client, 'Segunda barreira');
    const original = (await knex().raw<{ rows: Array<{ definition: string }> }>("select pg_get_functiondef('app_private.approval_note_is_valid(text)'::regprocedure) as definition")).rows[0]!.definition;
    await knex().raw("create or replace function app_private.approval_note_is_valid(p_note text) returns boolean language sql immutable set search_path = '' as $$ select p_note is null or p_note <> 'Recusado pelo banco' $$");
    try {
      const reply = await post('portalOne', approveUrl(client, id), { revision: 1, note: 'Recusado pelo banco' });

      expect(reply.statusCode).toBe(400);
      expect(errorOf(reply).code).toBe('CONTENT_APPROVAL_NOTE_INVALID');
      expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval' });
      expect(await knex()('client_threads').where({ content_id: id })).toHaveLength(0);
    } finally {
      await knex().raw(original);
    }
  });

  it('refuses an unknown field in the body, as before, and the note of the request of changes is still its comment', async () => {
    const client = await freshClient('note-strict');
    const id = await waiting(client, 'Corpo estrito');

    expect((await post('portalOne', approveUrl(client, id), { revision: 1, comment: NOTE })).statusCode).toBe(400);
    expect((await post('portalOne', approveUrl(client, id), { revision: 1, note: NOTE, status: 'approved' })).statusCode).toBe(400);
    expect((await post('portalOne', `${oneUrl(client, id)}/request-changes`, { revision: 1, note: NOTE })).statusCode).toBe(400);
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval' });
  });

  it('does not write a second note when the content is already approved: the first person to approve stays', async () => {
    const client = await freshClient('note-twice', ['portalOne', 'portalMulti']);
    const id = await waiting(client, 'Aprovado duas vezes');

    expect((await post('portalOne', approveUrl(client, id), { revision: 1, note: NOTE })).statusCode).toBe(200);
    const again = await post('portalMulti', approveUrl(client, id), { revision: 1, note: 'Outro recado' });

    expect(again.statusCode).toBe(200);
    expect(await w.contentRow(id)).toMatchObject({ status: 'approved', approved_by: p.people.portalOne.id });
    expect((await noteOf(id)).map((comment) => comment.body)).toEqual([NOTE]);
  });

  it('leaves no comment behind when the approval is refused: a content not awaiting, a stale revision', async () => {
    const client = await freshClient('note-refused');
    const adjusting = await w.seedContent(client, { status: 'adjusting' });
    const published = await w.seedContent(client, { status: 'published' });
    const stale = await waiting(client, 'Revisão antiga');

    const adjustingReply = await post('portalOne', approveUrl(client, adjusting), { revision: 1, note: NOTE });
    const publishedReply = await post('portalOne', approveUrl(client, published), { revision: 1, note: NOTE });
    const staleReply = await post('portalOne', approveUrl(client, stale), { revision: 2, note: NOTE });

    expect([adjustingReply.statusCode, publishedReply.statusCode, staleReply.statusCode]).toEqual([409, 409, 409]);
    expect(errorOf(staleReply).code).toBe('CONTENT_REVISION_CHANGED');
    for (const id of [adjusting, published, stale]) expect(await noteOf(id)).toEqual([]);
    expect(await w.contentRow(stale)).toMatchObject({ status: 'awaiting_approval' });
  });

  it('refuses the approval and the note together when the agency is read-only: neither is written', async () => {
    const client = await freshClient('note-readonly');
    const id = await waiting(client, 'Agência só leitura');
    await knex()('agencies').where({ id: w.agencyA }).update({ plan: 'trial', trial_ends_at: knex().raw("now() - interval '1 minute'"), trial_owner_email_key: knex().raw('coalesce(trial_owner_email_key, id::text)') });
    try {
      const reply = await post('portalOne', approveUrl(client, id), { revision: 1, note: NOTE });

      expect(reply.statusCode).toBe(409);
      expect(errorOf(reply).code).toBe('AGENCY_READ_ONLY');
      expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null });
      expect(await noteOf(id)).toEqual([]);
    } finally {
      await knex()('agencies').where({ id: w.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
    }
  });

  it('keeps the note from anyone who is not a person of the portal of that client', async () => {
    const client = await freshClient('note-attacks', ['portalOne']);
    const id = await waiting(client, 'Só do cliente');
    const attackers: ReadonlyArray<[string, Reply]> = [
      ['agency admin with no link', await w.call('POST', people.admin.cookie, approveUrl(client, id), { revision: 1, note: NOTE })],
      ['agency owner with no link', await w.call('POST', people.owner.cookie, approveUrl(client, id), { revision: 1, note: NOTE })],
      ['person of another client', await post('portalOther', approveUrl(client, id), { revision: 1, note: NOTE })],
      ['removed link', await post('removed', approveUrl(client, id), { revision: 1, note: NOTE })],
      ['person of another agency', await post('portalB', approveUrl(client, id), { revision: 1, note: NOTE })],
      ['no session', await w.getApp().app.inject({ method: 'POST', url: approveUrl(client, id), headers: { origin: TEST_APP_PUBLIC_URL }, payload: { revision: 1, note: NOTE } })]
    ];

    for (const [who, reply] of attackers) expect(reply.statusCode, who).toBe(who === 'no session' ? 401 : 404);
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null });
    expect(await noteOf(id)).toEqual([]);
  });

  it('does not let a person with a link to two clients approve a content of one through the path of the other', async () => {
    const mine = await freshClient('note-cross-mine', ['portalMulti']);
    const theirs = await freshClient('note-cross-theirs', ['portalMulti']);
    const id = await waiting(theirs, 'Do outro cliente');

    const reply = await post('portalMulti', approveUrl(mine, id), { revision: 1, note: NOTE });

    expect(reply.statusCode).toBe(404);
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval' });
    expect(await noteOf(id)).toEqual([]);
  });
});
