import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, waitForBackendsBlockedBy, type DatabaseClient } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';
import { createNotificationFixtures } from './support/notification-fixtures.js';

// Scope redesign-igual, subtask W1-S3 (specs/notificacoes.md, section 8; decision 2026-11-11 "notificações só dentro do app com cinco
// eventos"): each event that already passes through the database creates its notification in the same transaction, for the person the
// spec names, with a summary the database builds. Every event runs the way the application runs it (`ageniza_app`, the person bound, or
// no one bound for the approval link); the owner prepares the world, plants nothing in `notifications`, and reads what was left.
const w = createContentWorld('notif-events');
const { ids } = w;
const f = createNotificationFixtures(w);
const a = createApprovalFixtures(w);
const { applicationUrl } = resolveIntegrationDatabaseUrls();
const owner = (): Knex => w.getOwner().knex;

let worker: DatabaseClient;
const createdUsers: string[] = [];
const createdAgencies: string[] = [];

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
}, 300_000);

afterAll(async () => {
  try {
    const knex = owner();
    await f.cleanUp();
    await a.cleanUp();
    await knex('audit.events').whereIn('target_id', createdAgencies).delete();
    await knex('agency_memberships').whereIn('agency_id', createdAgencies).delete();
    await knex('agencies').whereIn('id', createdAgencies).delete();
    await knex('legal_acceptances').whereIn('user_id', createdUsers).delete();
    await knex('audit.events').whereIn('actor_user_id', createdUsers).delete();
    await knex('client_memberships').whereIn('user_id', createdUsers).delete();
    await knex('agency_memberships').whereIn('user_id', createdUsers).delete();
    await knex('auth.user').whereIn('id', createdUsers).delete();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const nameOf = async (client: string): Promise<string> => (await owner()('clients').where({ id: client }).first('name'))!.name as string;
const titleOf = async (content: string): Promise<string> => (await w.contentRow(content)).title as string;
const statusOf = async (content: string): Promise<string> => (await w.contentRow(content)).status as string;
const revisionOf = async (content: string): Promise<number> => (await w.contentRow(content)).revision as number;

/** A content of the client that waits for the approval of its portal, with `responsible` in charge of it. */
const waiting = (responsible = ids.productionA, client = ids.clientA1): Promise<string> =>
  w.seedContent(client, { status: 'awaiting_approval', owner: responsible });

const approveAs = async (user: string, content: string, note: string | null = null, revision?: number): Promise<unknown> =>
  w.asUser(user, async (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, revision ?? await revisionOf(content), note]));

const requestAs = async (user: string, content: string, body = 'Ajustar a legenda', revision?: number): Promise<unknown> =>
  w.asUser(user, async (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, revision ?? await revisionOf(content), body]));

const settle = (work: Promise<unknown>): Promise<unknown> => work.then(() => 'done', (error: unknown) => error);

const INJECTED = { code: 'P0001', message: expect.stringContaining('injected after the notification') };

// ---- the approval link: an access, the batch of its e-mail and the session of its cookie, no actor bound --------------

const asApp = <T>(work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> => worker.knex.transaction(work);

interface LinkScenario { readonly clientId: string; readonly contents: string[]; readonly sessionHash: string }

const linkScenario = async (responsible = ids.productionA, contentCount = 2): Promise<LinkScenario> => {
  const clientId = await a.freshClient([]);
  const access = (await owner()('client_portal_accesses').insert({ client_id: clientId, email: `${randomUUID()}@notif-link.test` }).returning('id'))[0] as { id: string };
  const contents: string[] = [];
  for (let index = 0; index < contentCount; index += 1) contents.push(await w.seedContent(clientId, { status: 'awaiting_approval', owner: responsible }));

  const claimToken = randomUUID();
  const itemIds: string[] = [];
  for (const contentId of contents) {
    const item = await owner().raw<{ rows: Array<{ id: string }> }>(`
      insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
      values ('content_awaiting_approval', ?, ?, ?, now() - interval '1 minute', now(), ?, 1)
      returning id
    `, [clientId, access.id, contentId, claimToken]);
    itemIds.push(item.rows[0]!.id);
  }
  const tokenHash = sha(randomBytes(32).toString('base64url'));
  const sessionHash = sha(randomBytes(32).toString('base64url'));
  await asApp((t) => t.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [itemIds, claimToken, tokenHash]));
  await asApp((t) => t.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, sessionHash]));
  return { clientId, contents, sessionHash };
};

const approveByLink = (sessionHash: string, content: string, revision = 1): Promise<unknown> =>
  asApp((t) => t.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, ?::integer)', [sessionHash, content, revision]));
const requestByLink = (sessionHash: string, content: string, comment = 'Troque a capa.', revision = 1): Promise<unknown> =>
  asApp((t) => t.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, ?::integer, ?)', [sessionHash, content, revision, comment]));

// ---- the portal asks of a request for material, and an invitation accepted ----------------------------------------------

const answerAs = (user: string, thread: string, body = 'Segue o material.', client = ids.clientA1, side: 'client' | 'agency' = 'client'): Promise<unknown> =>
  w.asUser(user, (t) => t('client_thread_comments').insert({ id: randomUUID(), thread_id: thread, client_id: client, author_user_id: user, author_side: side, body }));

const newAccount = async (name: string | null, email = `${randomUUID()}@notif-events.test`): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  createdUsers.push(id);
  await owner()('auth.user').insert({ id, name: name ?? '', email, emailVerified: true });
  return { id, email };
};

const acceptAs = (user: string, tokenHash: string): Promise<unknown> =>
  w.asUser(user, (t) => t.raw('select * from app_private.accept_invitation(?, ?, ?, ?, ?)', [tokenHash, user, '2026-10-06', '2026-10-06', true]));

describe('approve_content tells the responsible of the content', () => {
  it('creates one notification for the responsible, about that content, with the client and the title in its summary', async () => {
    const content = await waiting();
    await approveAs(ids.portalA1, content);

    const rows = await f.rowsFor({ contentId: content });
    expect(rows).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.productionA, kind: 'content_approved', content_id: content, thread_id: null,
      invitation_id: null, client_id: ids.clientA1, approval_round_id: null, summary: `${await nameOf(ids.clientA1)} aprovou "${await titleOf(content)}"`,
      created_at: expect.any(Date), read_at: null
    }]);
  });

  it('tells the responsible and no one else: not who sent it, not the Admin, not the Owner, not who approved', async () => {
    const content = await waiting(ids.managerA);
    await approveAs(ids.portalA1, content);

    expect((await f.rowsFor({ contentId: content })).map((row) => row.recipient_user_id)).toEqual([ids.managerA]);
    for (const other of [ids.productionA, ids.adminA, ids.ownerA, ids.portalA1]) expect(await f.visibleTo(other), other).not.toContain((await f.rowsFor({ contentId: content }))[0]!.id);
  });

  it('tells the responsible when the content was sent by someone else, through the real send', async () => {
    const content = await a.readyContent(ids.clientA1);
    await a.submit(ids.adminA, content, null, 'Recado da agência');
    await approveAs(ids.portalA1Second, content);

    expect((await f.rowsFor({ contentId: content })).map((row) => [row.kind, row.recipient_user_id])).toEqual([['content_approved', ids.productionA]]);
  });

  it('does not put the note of the approval in the summary, and still writes the note to the conversation', async () => {
    const content = await waiting();
    await approveAs(ids.portalA1, content, 'SEGREDO-DA-NOTA gostei muito, pode agendar para sexta.');

    const [row] = await f.rowsFor({ contentId: content });
    expect(row!.summary).toBe(`${await nameOf(ids.clientA1)} aprovou "${await titleOf(content)}"`);
    expect(row!.summary).not.toContain('SEGREDO');
    expect(await owner()('client_thread_comments').where({ client_id: ids.clientA1 }).where('body', 'like', 'SEGREDO-DA-NOTA%')).toHaveLength(1);
  });

  it('notifies through the two-argument approval as well, which approves with no note', async () => {
    const content = await waiting();
    await w.asUser(ids.portalA1, async (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer)', [content, await revisionOf(content)]));

    expect((await f.rowsFor({ contentId: content })).map((row) => row.kind)).toEqual(['content_approved']);
  });

  it('notifies nobody when the approval is refused: stale revision, a content not awaiting, no access to the client', async () => {
    const stale = await waiting();
    await expect(approveAs(ids.portalA1, stale, null, 99)).rejects.toMatchObject({ code: 'A0063' });
    const inProduction = await w.seedContent(ids.clientA1, { status: 'in_production' });
    await expect(approveAs(ids.portalA1, inProduction)).rejects.toMatchObject({ code: expect.stringMatching(/^A006[02]$/) });
    const elsewhere = await waiting(ids.productionA, ids.clientA1);
    await expect(approveAs(ids.portalA2, elsewhere)).rejects.toMatchObject({ code: 'A0060' });

    for (const content of [stale, inProduction, elsewhere]) expect(await f.rowsFor({ contentId: content }), content).toEqual([]);
  });

  it('does not notify again when the same content is approved a second time with no note: the second call is quiet', async () => {
    const content = await waiting();
    await approveAs(ids.portalA1, content);
    await approveAs(ids.portalA1Second, content);

    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
  });

  it('notifies each approval: a content approved, withdrawn by the client and approved again is two events', async () => {
    const content = await waiting();
    await approveAs(ids.portalA1, content);
    await w.asUser(ids.portalA1, async (t) => t.raw('select app_private.withdraw_content_approval(?::uuid, ?::integer)', [content, await revisionOf(content)]));
    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
    await approveAs(ids.portalA1, content);

    expect((await f.rowsFor({ contentId: content })).map((row) => row.kind)).toEqual(['content_approved', 'content_approved']);
  });

  it('does not notify when the agency approves in the name of the client: it is the agency itself who did it', async () => {
    const content = await waiting();
    await w.asUser(ids.managerA, (t) => t.raw('select app_private.approve_content_by_agency(?::uuid, ?::integer, ?::text)', [content, 1, 'O cliente aprovou por telefone']));

    expect(await statusOf(content)).toBe('approved');
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });
});

describe('request_content_changes tells the responsible of the content', () => {
  it('creates one notification for the responsible, with no word of the comment in it', async () => {
    const content = await waiting(ids.managerA);
    await requestAs(ids.portalA1, content, 'SEGREDO-DO-COMENTARIO troque a hashtag e a capa, por favor.');

    expect(await f.rowsFor({ contentId: content })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.managerA, kind: 'content_changes_requested', content_id: content, thread_id: null,
      invitation_id: null, client_id: ids.clientA1, approval_round_id: null, summary: `${await nameOf(ids.clientA1)} pediu ajuste em "${await titleOf(content)}"`,
      created_at: expect.any(Date), read_at: null
    }]);
    expect(await statusOf(content)).toBe('adjusting');
  });

  it('notifies nobody when the request is refused: blank comment, stale revision, a content not awaiting', async () => {
    const blank = await waiting();
    await expect(requestAs(ids.portalA1, blank, '   ')).rejects.toMatchObject({ code: 'A0068' });
    const stale = await waiting();
    await expect(requestAs(ids.portalA1, stale, 'Ajustar', 99)).rejects.toMatchObject({ code: 'A0063' });
    const approved = await w.seedContent(ids.clientA1, { status: 'approved' });
    await expect(requestAs(ids.portalA1, approved)).rejects.toMatchObject({ code: 'A0062' });

    for (const content of [blank, stale, approved]) expect(await f.rowsFor({ contentId: content }), content).toEqual([]);
  });

  it('notifies once per request: a content sent again and adjusted again is a second event', async () => {
    const content = await waiting();
    await requestAs(ids.portalA1, content);
    await owner()('contents').where({ id: content }).update({ status: 'awaiting_approval' });
    await requestAs(ids.portalA1Second, content, 'Ainda falta o logo.');

    expect((await f.rowsFor({ contentId: content })).map((row) => row.kind)).toEqual(['content_changes_requested', 'content_changes_requested']);
  });
});

describe('the approval link tells the responsible of the content', () => {
  it('creates the notification of an approval by link, as the client says, with no account bound', async () => {
    const scenario = await linkScenario(ids.managerA);
    await approveByLink(scenario.sessionHash, scenario.contents[0]!);

    expect(await f.rowsFor({ contentId: scenario.contents[0]! })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.managerA, kind: 'content_approved', content_id: scenario.contents[0], thread_id: null,
      invitation_id: null, client_id: scenario.clientId, approval_round_id: null, summary: `${await nameOf(scenario.clientId)} aprovou "${await titleOf(scenario.contents[0]!)}"`,
      created_at: expect.any(Date), read_at: null
    }]);
    expect(await f.rowsFor({ contentId: scenario.contents[1]! })).toEqual([]);
  });

  it('does not notify again when the same link approves the same content twice', async () => {
    const scenario = await linkScenario();
    await approveByLink(scenario.sessionHash, scenario.contents[0]!);
    await approveByLink(scenario.sessionHash, scenario.contents[0]!);

    expect(await f.rowsFor({ contentId: scenario.contents[0]! })).toHaveLength(1);
  });

  it('creates the notification of a request for changes by link, with no word of the comment in it', async () => {
    const scenario = await linkScenario(ids.managerA);
    await requestByLink(scenario.sessionHash, scenario.contents[1]!, 'SEGREDO-DO-LINK troque a capa.');

    expect(await f.rowsFor({ contentId: scenario.contents[1]! })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.managerA, kind: 'content_changes_requested', content_id: scenario.contents[1], thread_id: null,
      invitation_id: null, client_id: scenario.clientId, approval_round_id: null,
      summary: `${await nameOf(scenario.clientId)} pediu ajuste em "${await titleOf(scenario.contents[1]!)}"`, created_at: expect.any(Date), read_at: null
    }]);
  });

  it('notifies nobody when the link is refused: stale revision, a blank comment, a content of another batch', async () => {
    const scenario = await linkScenario();
    const other = await linkScenario();
    await expect(approveByLink(scenario.sessionHash, scenario.contents[0]!, 99)).rejects.toMatchObject({ code: 'A0063' });
    await expect(requestByLink(scenario.sessionHash, scenario.contents[0]!, '  ')).rejects.toMatchObject({ code: 'A0068' });
    await expect(approveByLink(scenario.sessionHash, other.contents[0]!)).rejects.toMatchObject({ code: 'A0060' });

    for (const content of [...scenario.contents, ...other.contents]) expect(await f.rowsFor({ contentId: content }), content).toEqual([]);
  });
});

describe('the answer of the client in a request for material tells who opened it', () => {
  it('creates one notification for who opened the request, about that request, when the client comments on it', async () => {
    const request = await f.materialRequest({ openedBy: ids.managerA, title: 'Fotos da equipe' });
    await answerAs(ids.portalA1, request);

    expect(await f.rowsFor({ threadId: request })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.managerA, kind: 'material_request_answered', content_id: null, thread_id: request,
      invitation_id: null, client_id: ids.clientA1, approval_round_id: null, summary: `${await nameOf(ids.clientA1)} respondeu "Fotos da equipe"`,
      created_at: expect.any(Date), read_at: null
    }]);
  });

  it('tells nobody but who opened the request, and says it without the title when the request has none', async () => {
    const request = await f.materialRequest({ openedBy: ids.adminA, title: null });
    await answerAs(ids.portalA1, request);

    const rows = await f.rowsFor({ threadId: request });
    expect(rows.map((row) => row.recipient_user_id)).toEqual([ids.adminA]);
    expect(rows[0]!.summary).toBe(`${await nameOf(ids.clientA1)} respondeu ao pedido de material`);
  });

  it('notifies each answer: the client comments twice, two notifications, with no word of the comments in them', async () => {
    const request = await f.materialRequest();
    await answerAs(ids.portalA1, request, 'SEGREDO-DA-RESPOSTA primeira');
    await answerAs(ids.portalA1Second, request, 'SEGREDO-DA-RESPOSTA segunda');

    const rows = await f.rowsFor({ threadId: request });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.summary.includes('SEGREDO'))).toBe(true);
  });

  it('does not notify when the agency is who comments on the request', async () => {
    const request = await f.materialRequest();
    await answerAs(ids.adminA, request, 'Pode enviar até sexta.', ids.clientA1, 'agency');

    expect(await f.rowsFor({ threadId: request })).toEqual([]);
  });

  it('does not notify when the client comments on a conversation that is not a request for material', async () => {
    const content = await waiting();
    const thread = (await owner()('client_threads').insert({ client_id: ids.clientA1, content_id: content, opened_by: ids.adminA, opened_side: 'agency' }).returning('id'))[0] as { id: string };
    await answerAs(ids.portalA1, thread.id);

    expect(await owner()('client_thread_comments').where({ thread_id: thread.id })).toHaveLength(1);
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
    expect(await owner()('notifications').where({ thread_id: thread.id })).toEqual([]);
  });

  it('does not notify when the request is already resolved: it is no longer open', async () => {
    const request = await f.materialRequest({ resolved: true });
    await answerAs(ids.portalA1, request);

    expect(await owner()('client_thread_comments').where({ thread_id: request })).toHaveLength(1);
    expect(await f.rowsFor({ threadId: request })).toEqual([]);
  });

  it('does not notify the answer of a request that was reopened and then answered by the agency', async () => {
    const request = await f.materialRequest();
    await answerAs(ids.portalA1, request);
    await answerAs(ids.adminA, request, 'Recebido.', ids.clientA1, 'agency');

    expect(await f.rowsFor({ threadId: request })).toHaveLength(1);
  });
});

describe('an accepted invitation tells who sent it', () => {
  it('creates the notification of a collaborator invitation, for who sent it, with the name of who accepted', async () => {
    const person = await newAccount('Maria Souza');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: ids.adminA });
    await acceptAs(person.id, invitation.tokenHash);

    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.adminA, kind: 'invitation_accepted', content_id: null, thread_id: null,
      invitation_id: invitation.id, client_id: null, approval_round_id: null, summary: 'Maria Souza aceitou o seu convite', created_at: expect.any(Date), read_at: null
    }]);
  });

  it('creates the notification of a portal invitation that was still pending, with the client in its summary', async () => {
    const person = await newAccount('João Lima');
    const invitation = await f.invitation({ purpose: 'client_invite', email: person.email, invitedBy: ids.managerA, clientId: ids.clientA1 });
    await acceptAs(person.id, invitation.tokenHash);

    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([{
      id: expect.any(String), agency_id: ids.agencyA, recipient_user_id: ids.managerA, kind: 'invitation_accepted', content_id: null, thread_id: null,
      invitation_id: invitation.id, client_id: ids.clientA1, approval_round_id: null,
      summary: `João Lima aceitou o seu convite do portal de ${await nameOf(ids.clientA1)}`, created_at: expect.any(Date), read_at: null
    }]);
  });

  it('calls the person "Alguém" when the account has no name', async () => {
    const person = await newAccount(null);
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: ids.adminA });
    await acceptAs(person.id, invitation.tokenHash);

    expect((await f.rowsFor({ invitationId: invitation.id })).map((row) => row.summary)).toEqual(['Alguém aceitou o seu convite']);
  });

  it('completes the acceptance with no notification when the invitation has no sender to tell', async () => {
    const person = await newAccount('Ana Prado');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: null });

    await expect(acceptAs(person.id, invitation.tokenHash)).resolves.toBeDefined();

    expect((await owner()('invitations').where({ id: invitation.id }).first('used_at'))!.used_at).not.toBeNull();
    expect(await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: person.id, status: 'active' })).toHaveLength(1);
    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([]);
  });

  it('does not notify the activation of an agency, though it has a sender', async () => {
    const agency = randomUUID();
    createdAgencies.push(agency);
    await owner()('agencies').insert({ id: agency, name: `Ativação ${agency}` });
    const person = await newAccount('Dono Novo');
    const invitation = await f.invitation({ purpose: 'agency_activation', email: person.email, invitedBy: ids.adminA, agencyId: agency });
    await acceptAs(person.id, invitation.tokenHash);

    expect((await owner()('agencies').where({ id: agency }).first('owner_user_id'))!.owner_user_id).toBe(person.id);
    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([]);
  });

  it('does not notify when the person is already a member: the acceptance changes nothing', async () => {
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: `${ids.productionA}@notif-events.test`, invitedBy: ids.adminA });
    const result = await acceptAs(ids.productionA, invitation.tokenHash) as { rows: Array<{ status: string }> };

    expect(result.rows[0]!.status).toBe('already_member');
    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([]);
  });

  it('does not notify when the acceptance is refused: another account, a used invitation', async () => {
    const person = await newAccount('Pessoa Certa');
    const wrong = await newAccount('Pessoa Errada');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: ids.adminA });
    await expect(acceptAs(wrong.id, invitation.tokenHash)).rejects.toMatchObject({ code: 'A0002' });
    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([]);

    await acceptAs(person.id, invitation.tokenHash);
    await expect(acceptAs(person.id, invitation.tokenHash)).rejects.toMatchObject({ code: 'A0001' });
    expect(await f.rowsFor({ invitationId: invitation.id })).toHaveLength(1);
  });
});

describe('the notification is part of the event: it is written in its transaction, and a failure after it undoes the event (acceptance e)', () => {
  it('approve_content: the content stays awaiting, the note is not written, no notification is left', async () => {
    const content = await waiting();
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(approveAs(ids.portalA1, content, 'Uma nota que não pode ficar')).rejects.toMatchObject(INJECTED);
    });

    expect(await statusOf(content)).toBe('awaiting_approval');
    expect(await owner()('client_threads').where({ content_id: content })).toEqual([]);
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('request_content_changes: the content stays awaiting, no comment, no thread, no notification is left', async () => {
    const content = await waiting();
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(requestAs(ids.portalA1, content)).rejects.toMatchObject(INJECTED);
    });

    expect(await statusOf(content)).toBe('awaiting_approval');
    expect(await owner()('client_threads').where({ content_id: content })).toEqual([]);
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('approve_content_by_portal_approval: the content stays awaiting, no notification is left', async () => {
    const scenario = await linkScenario();
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(approveByLink(scenario.sessionHash, scenario.contents[0]!)).rejects.toMatchObject(INJECTED);
    });

    expect(await statusOf(scenario.contents[0]!)).toBe('awaiting_approval');
    expect(await f.rowsFor({ contentId: scenario.contents[0]! })).toEqual([]);
    await expect(approveByLink(scenario.sessionHash, scenario.contents[0]!)).resolves.toBeDefined();
    expect(await f.rowsFor({ contentId: scenario.contents[0]! })).toHaveLength(1);
  });

  it('request_changes_by_portal_approval: the content stays awaiting, no comment, no notification is left', async () => {
    const scenario = await linkScenario();
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(requestByLink(scenario.sessionHash, scenario.contents[0]!)).rejects.toMatchObject(INJECTED);
    });

    expect(await statusOf(scenario.contents[0]!)).toBe('awaiting_approval');
    expect(await owner()('client_threads').where({ content_id: scenario.contents[0]! })).toEqual([]);
    expect(await f.rowsFor({ contentId: scenario.contents[0]! })).toEqual([]);
  });

  it('the answer in a request for material: the comment is not written, no notification is left', async () => {
    const request = await f.materialRequest();
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(answerAs(ids.portalA1, request)).rejects.toMatchObject(INJECTED);
    });

    expect(await owner()('client_thread_comments').where({ thread_id: request })).toEqual([]);
    expect(await f.rowsFor({ threadId: request })).toEqual([]);
  });

  it('accept_invitation: the invitation is not used, the person is not a member, no notification is left', async () => {
    const person = await newAccount('Maria Souza');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: ids.adminA });
    await f.failAfterNotificationWrite(ids.agencyA, async () => {
      await expect(acceptAs(person.id, invitation.tokenHash)).rejects.toMatchObject(INJECTED);
    });

    expect((await owner()('invitations').where({ id: invitation.id }).first('used_at', 'accepted_by_user_id'))).toEqual({ used_at: null, accepted_by_user_id: null });
    expect(await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: person.id })).toEqual([]);
    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([]);
  });
});

describe('who is not to be told, is not told, and the event goes on (acceptance e)', () => {
  const create = async (statement: string, bindings: readonly unknown[] = []): Promise<string | null> =>
    (await owner().raw<{ rows: Array<{ created: string | null }> }>(`select ${statement} as created`, [...bindings])).rows[0]!.created;

  it('creates nothing, and no error, when there is no one to tell: the creator is given no recipient', async () => {
    const content = await waiting();
    expect(await create(
      "app_private.add_notification('content_approved', null, ?::uuid, ?::uuid, ?::uuid, null, null, null, 'Ninguém')", [ids.agencyA, ids.clientA1, content]
    )).toBeNull();
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('creates the notification of the control, so that the refusals below are the rule and not a broken call', async () => {
    const content = await waiting();
    expect(await create("app_private.notify_content_owner('content_approved', ?::uuid)", [content])).toEqual(expect.any(String));
    const request = await f.materialRequest();
    expect(await create('app_private.notify_material_request_answered(?::uuid)', [request])).toEqual(expect.any(String));
    const person = await newAccount('Maria Souza');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: ids.adminA });
    await acceptAs(person.id, invitation.tokenHash);
    expect(await f.rowsFor({ invitationId: invitation.id })).toHaveLength(1);
  });

  it('creates nothing for an archived client, for any of the events', async () => {
    const client = await a.freshClient([]);
    const content = await w.seedContent(client, { status: 'awaiting_approval' });
    const request = await f.materialRequest({ clientId: client });
    const invitation = await f.invitation({ purpose: 'client_invite', email: `${randomUUID()}@notif-events.test`, invitedBy: ids.adminA, clientId: client });
    await owner()('invitations').where({ id: invitation.id }).update({ used_at: new Date(), accepted_by_user_id: ids.portalA1 });
    await w.archiveClient(client);

    expect(await create("app_private.notify_content_owner('content_approved', ?::uuid)", [content])).toBeNull();
    expect(await create("app_private.notify_content_owner('content_changes_requested', ?::uuid)", [content])).toBeNull();
    expect(await create('app_private.notify_material_request_answered(?::uuid)', [request])).toBeNull();
    expect(await create('app_private.notify_invitation_accepted(?::uuid)', [invitation.id])).toBeNull();
    expect(await owner()('notifications').where({ client_id: client })).toEqual([]);
  });

  it('creates nothing for a suspended agency, for any of the events', async () => {
    await w.withSuspendedAgencyActive(async () => {
      const content = await w.seedContent(ids.clientSuspended, { status: 'awaiting_approval', owner: ids.adminSuspended });
      const request = await f.materialRequest({ clientId: ids.clientSuspended, openedBy: ids.adminSuspended });
      const invitation = await f.invitation({ purpose: 'collaborator_invite', email: `${randomUUID()}@notif-events.test`, invitedBy: ids.adminSuspended, agencyId: ids.agencySuspended });
      await owner()('invitations').where({ id: invitation.id }).update({ used_at: new Date(), accepted_by_user_id: ids.adminA });
      await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });

      expect(await create("app_private.notify_content_owner('content_approved', ?::uuid)", [content])).toBeNull();
      expect(await create('app_private.notify_material_request_answered(?::uuid)', [request])).toBeNull();
      expect(await create('app_private.notify_invitation_accepted(?::uuid)', [invitation.id])).toBeNull();
    });

    expect(await owner()('notifications').where({ agency_id: ids.agencySuspended })).toEqual([]);
  });

  it('refuses an event the notification does not know, and a content that does not exist is nothing to tell', async () => {
    const content = await waiting();
    await expect(create("app_private.notify_content_owner('content_published', ?::uuid)", [content])).rejects.toMatchObject({ code: '22023' });
    expect(await create("app_private.notify_content_owner('content_approved', gen_random_uuid())")).toBeNull();
    expect(await create('app_private.notify_material_request_answered(gen_random_uuid())')).toBeNull();
    expect(await create('app_private.notify_invitation_accepted(gen_random_uuid())')).toBeNull();
  });

  it('creates nothing for an invitation that nobody accepted', async () => {
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: `${randomUUID()}@notif-events.test`, invitedBy: ids.adminA });

    expect(await create('app_private.notify_invitation_accepted(?::uuid)', [invitation.id])).toBeNull();
    expect(await f.rowsFor({ invitationId: invitation.id })).toEqual([]);
  });

  it('creates nothing for a client that is not of the agency given, and says so with no error', async () => {
    const content = await waiting();
    expect(await create(
      "app_private.add_notification('content_approved', ?::uuid, ?::uuid, ?::uuid, ?::uuid, null, null, null, 'Cruzada')", [ids.productionA, ids.agencyB, ids.clientA1, content]
    )).toBeNull();
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it('waits for the archive of the client that is in flight, finds the client archived and creates nothing', async () => {
    const client = await a.freshClient([]);
    const content = await w.seedContent(client, { status: 'awaiting_approval' });

    const archiving = await owner().transaction();
    const archivingPid = await backendPid(archiving);
    let creating: Promise<unknown> | undefined;
    try {
      await archiving.raw('select 1 from public.clients where id = ?::uuid for update', [client]);
      await archiving.raw("update public.clients set status = 'archived', archived_at = now() where id = ?::uuid", [client]);
      creating = settle(create("app_private.notify_content_owner('content_approved', ?::uuid)", [content]));
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }

    expect(await creating).toBe('done');
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });
});

describe('what the notification says (acceptance g)', () => {
  const summaryOf = async (content: string): Promise<string> => (await f.rowsFor({ contentId: content }))[0]!.summary;
  const retitle = (content: string, title: string): Promise<number> => owner()('contents').where({ id: content }).update({ title });
  const rename = (client: string, name: string): Promise<number> => owner()('clients').where({ id: client }).update({ name });

  it('keeps the summary within 160 characters when the title has 120 and the client name is long', async () => {
    const client = await a.freshClient([]);
    await rename(client, 'N'.repeat(100));
    const content = await w.seedContent(client, { status: 'awaiting_approval' });
    await retitle(content, 'T'.repeat(120));
    await owner().raw("select app_private.notify_content_owner('content_approved', ?::uuid)", [content]);

    const summary = await summaryOf(content);
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.startsWith(`${'N'.repeat(49)}… aprovou "`)).toBe(true);
    expect(summary.endsWith('…"')).toBe(true);
  });

  it('keeps the summary within 160 characters, counting characters and not bytes, with multibyte text', async () => {
    const client = await a.freshClient([]);
    await rename(client, 'Ção'.repeat(40));
    const content = await w.seedContent(client, { status: 'awaiting_approval' });
    await retitle(content, '😀é'.repeat(60));
    await owner().raw("select app_private.notify_content_owner('content_changes_requested', ?::uuid)", [content]);

    const summary = await summaryOf(content);
    expect([...summary].length).toBeLessThanOrEqual(160);
    expect(summary.startsWith(`${'Ção'.repeat(16)}Ç… pediu ajuste em "`)).toBe(true);
    expect(summary.endsWith('…"')).toBe(true);
  });

  it('leaves room for what follows the title: a prefix, a title far too long and a suffix come to 160 characters exactly', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ summary: string }> }>(
      'select app_private.notification_summary(?::text, ?::text, ?::text) as summary', ['Prefix ', 'x'.repeat(300), ' suffix']
    );

    expect(rows[0]!.summary.length).toBe(160);
    expect(rows[0]!.summary.startsWith('Prefix "x')).toBe(true);
    expect(rows[0]!.summary.endsWith('…" suffix')).toBe(true);
  });

  it('cuts a title only when it does not fit: 109 characters stay whole beside a client of 40, and 110 become 108 and an ellipsis', async () => {
    const client = await a.freshClient([]);
    await rename(client, 'C'.repeat(40));
    const fits = await w.seedContent(client, { status: 'awaiting_approval' });
    const overflows = await w.seedContent(client, { status: 'awaiting_approval' });
    await retitle(fits, 'T'.repeat(109));
    await retitle(overflows, 'T'.repeat(110));
    await owner().raw("select app_private.notify_content_owner('content_approved', ?::uuid)", [fits]);
    await owner().raw("select app_private.notify_content_owner('content_approved', ?::uuid)", [overflows]);

    expect(await summaryOf(fits)).toBe(`${'C'.repeat(40)} aprovou "${'T'.repeat(109)}"`);
    expect(await summaryOf(overflows)).toBe(`${'C'.repeat(40)} aprovou "${'T'.repeat(108)}…"`);
    expect((await summaryOf(fits)).length).toBe(160);
    expect((await summaryOf(overflows)).length).toBe(160);
  });

  it('does not cut a title that fits, and does not add an ellipsis to it', async () => {
    const content = await waiting();
    const title = 'Lançamento da coleção de verão';
    await retitle(content, title);
    await owner().raw("select app_private.notify_content_owner('content_approved', ?::uuid)", [content]);

    expect(await summaryOf(content)).toBe(`${await nameOf(ids.clientA1)} aprovou "${title}"`);
  });

  it('writes the title on one line: line breaks and runs of spaces become one space', async () => {
    const content = await waiting();
    await retitle(content, '  Promo\n\n de   Natal\t2026  ');
    await owner().raw("select app_private.notify_content_owner('content_approved', ?::uuid)", [content]);

    expect(await summaryOf(content)).toBe(`${await nameOf(ids.clientA1)} aprovou "Promo de Natal 2026"`);
  });

  it('has no word of the note or the comment, whatever their length', async () => {
    const approved = await waiting();
    await approveAs(ids.portalA1, approved, `SEGREDO ${'n'.repeat(480)}`);
    const requested = await waiting();
    await requestAs(ids.portalA1, requested, `SEGREDO ${'c'.repeat(4900)}`);
    const request = await f.materialRequest();
    await answerAs(ids.portalA1, request, `SEGREDO ${'r'.repeat(4900)}`);

    const rows = [...await f.rowsFor({ contentId: approved }), ...await f.rowsFor({ contentId: requested }), ...await f.rowsFor({ threadId: request })];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.summary.length).toBeLessThanOrEqual(160);
      expect(row.summary).not.toContain('SEGREDO');
    }
  });

  it('is checked by the table as well: a summary of 161 characters, a blank one, and one with only spaces are refused', async () => {
    const content = await waiting();
    const insert = (summary: string): Promise<unknown> => owner()('notifications').insert({
      agency_id: ids.agencyA, recipient_user_id: ids.productionA, kind: 'content_approved', content_id: content, client_id: ids.clientA1, summary
    });

    await expect(insert('x'.repeat(161))).rejects.toMatchObject({ code: '23514' });
    await expect(insert('')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('   ')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('x'.repeat(160))).resolves.toBeDefined();
  });
});

describe('the shape of a notification is checked by the table', () => {
  const insert = (row: Record<string, unknown>): Promise<unknown> => owner()('notifications').insert({
    agency_id: ids.agencyA, recipient_user_id: ids.productionA, summary: 'Resumo', ...row
  });

  it('refuses a kind the product does not have', async () => {
    const content = await waiting();
    await expect(insert({ kind: 'content_published', content_id: content, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a notification with two subjects, and one with none, or the wrong one for its kind', async () => {
    const content = await waiting();
    const request = await f.materialRequest();
    await expect(insert({ kind: 'content_approved', content_id: content, thread_id: request, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'content_approved', client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'content_approved', thread_id: request, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'material_request_answered', content_id: content, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'invitation_accepted', content_id: content, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'content_approved', content_id: content })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a content that is not of the client, a client that is not of the agency, and a round that is not of the content', async () => {
    const content = await waiting();
    const other = await waiting(ids.productionA, ids.clientA2);
    await expect(insert({ kind: 'content_approved', content_id: content, client_id: ids.clientA2 })).rejects.toMatchObject({ code: '23503' });
    await expect(insert({ agency_id: ids.agencyB, kind: 'content_approved', content_id: content, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23503' });
    const round = await f.round(content, { dueAt: new Date(Date.now() - 3_600_000).toISOString() });
    await expect(insert({ kind: 'approval_deadline_passed', content_id: other, client_id: ids.clientA2, approval_round_id: round })).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the client with the request for material and the invitation with its notification', async () => {
    const request = await f.materialRequest();
    await expect(insert({ kind: 'material_request_answered', thread_id: request })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'material_request_answered', client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'invitation_accepted' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'material_request_answered', thread_id: request, client_id: ids.clientA1 })).resolves.toBeDefined();
  });

  it('keeps the round for the deadline alone: the deadline needs it and no other kind carries it', async () => {
    const content = await waiting();
    const round = await f.round(content, { dueAt: new Date(Date.now() - 3_600_000).toISOString() });
    await expect(insert({ kind: 'approval_deadline_passed', content_id: content, client_id: ids.clientA1 })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ kind: 'content_approved', content_id: content, client_id: ids.clientA1, approval_round_id: round })).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps one notification of the deadline of a round for each person, and lets the repeatable events repeat', async () => {
    const content = await waiting();
    const round = await f.round(content, { dueAt: new Date(Date.now() - 3_600_000).toISOString() });
    const deadline = { kind: 'approval_deadline_passed', content_id: content, client_id: ids.clientA1, approval_round_id: round };
    await insert(deadline);
    await expect(insert(deadline)).rejects.toMatchObject({ code: '23505' });
    await expect(insert({ ...deadline, recipient_user_id: ids.adminA })).resolves.toBeDefined();

    await insert({ kind: 'content_approved', content_id: content, client_id: ids.clientA1 });
    await expect(insert({ kind: 'content_approved', content_id: content, client_id: ids.clientA1 })).resolves.toBeDefined();
  });
});

describe('two transactions of the same event neither duplicate nor deadlock (acceptance h)', () => {
  it('two people approve the same content at the same moment: one notification, and the second is quiet', async () => {
    const content = await waiting();
    const revision = await revisionOf(content);

    const first = await w.openTransactionAs(ids.portalA1);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, revision, null]);
      second = settle(approveAs(ids.portalA1Second, content, null, revision));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toBe('done');
    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
  });

  it('one approves and the other asks for changes at the same moment: the one that waited finds the content decided, and only the first tells', async () => {
    const content = await waiting();
    const revision = await revisionOf(content);

    const first = await w.openTransactionAs(ids.portalA1);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, revision, null]);
      second = settle(requestAs(ids.portalA1Second, content, 'Ajustar', revision));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0062' });
    expect((await f.rowsFor({ contentId: content })).map((row) => row.kind)).toEqual(['content_approved']);
  });

  it('two approvals by the same link at the same moment: one notification', async () => {
    const scenario = await linkScenario();
    const content = scenario.contents[0]!;

    const first = await worker.knex.transaction();
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [scenario.sessionHash, content]);
      second = settle(approveByLink(scenario.sessionHash, content));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toBe('done');
    expect(await f.rowsFor({ contentId: content })).toHaveLength(1);
  });

  it('two acceptances of the same invitation at the same moment: one acceptance, one notification', async () => {
    const person = await newAccount('Maria Souza');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: person.email, invitedBy: ids.adminA });

    const first = await w.openTransactionAs(person.id);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select * from app_private.accept_invitation(?, ?, ?, ?, ?)', [invitation.tokenHash, person.id, '2026-10-06', '2026-10-06', true]);
      second = settle(acceptAs(person.id, invitation.tokenHash));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0001' });
    expect(await f.rowsFor({ invitationId: invitation.id })).toHaveLength(1);
  });

  // Two comments in flight on the SAME thread deadlock at commit, with or without this feature: the foreign key of each holds the thread
  // FOR KEY SHARE and reopen_thread_on_client_comment (20260930000300) wants FOR UPDATE on it at commit. That is not tested here.
  it('two answers of the client to two requests at the same moment: one notification for each, and no deadlock', async () => {
    const requests = [await f.materialRequest(), await f.materialRequest({ openedBy: ids.managerA })];

    const first = await w.openTransactionAs(ids.portalA1);
    const second = await w.openTransactionAs(ids.portalA1Second);
    try {
      const insert = (transaction: Knex.Transaction, user: string, thread: string): Promise<unknown> => transaction('client_thread_comments').insert({
        thread_id: thread, client_id: ids.clientA1, author_user_id: user, author_side: 'client', body: 'Segue'
      });
      await Promise.all([insert(first, ids.portalA1, requests[0]!), insert(second, ids.portalA1Second, requests[1]!)]);
    } finally {
      await Promise.all([first.commit(), second.commit()]);
    }

    expect((await f.rowsFor({ threadId: requests[0]! })).map((row) => row.recipient_user_id)).toEqual([ids.adminA]);
    expect((await f.rowsFor({ threadId: requests[1]! })).map((row) => row.recipient_user_id)).toEqual([ids.managerA]);
  });

  it('an answer and the archive of the client at the same moment: the answer waits for the archive, is refused, and nothing is notified', async () => {
    const client = await a.freshClient([ids.portalA1]);
    const request = await f.materialRequest({ clientId: client });

    const archiving = await owner().transaction();
    const archivingPid = await backendPid(archiving);
    let answering: Promise<unknown> | undefined;
    try {
      await archiving.raw('select 1 from public.clients where id = ?::uuid for update', [client]);
      answering = settle(answerAs(ids.portalA1, request, 'Segue', client));
      await waitForBackendsBlockedBy(owner(), archivingPid);
      await archiving.raw("update public.clients set status = 'archived', archived_at = now() where id = ?::uuid", [client]);
    } finally {
      await archiving.commit();
    }

    expect(await answering).toMatchObject({ code: expect.stringMatching(/^A00\d\d$/) });
    expect(await owner()('client_thread_comments').where({ thread_id: request })).toEqual([]);
    expect(await f.rowsFor({ threadId: request })).toEqual([]);
  });
});
