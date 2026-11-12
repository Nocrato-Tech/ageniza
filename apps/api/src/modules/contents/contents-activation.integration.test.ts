import { randomUUID } from 'node:crypto';

import type { ContentActivationResponse } from '@ageniza/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPortalFixtures } from './test-support/portal-fixtures.js';
import { createContentsWorld, type PersonKey } from './test-support/world.js';

// The facts the Início reads to show the activation path (decision 2026-11-06). Each test names the mutation of the
// route or of its SQL that turns it red.
const w = createContentsWorld('contents-activation');
const p = createPortalFixtures(w);
const { people } = w;

let client: string;
let clientB: string;

const url = (agencyId = w.agencyA): string => `/agencies/${agencyId}/contents/activation`;
type Facts = Omit<ContentActivationResponse['data'], 'steps'>;
type Steps = ContentActivationResponse['data']['steps'];
const activation = async (cookie = people.admin.cookie, agencyId = w.agencyA): Promise<ContentActivationResponse['data']> => {
  const reply = await w.call('GET', cookie, url(agencyId));
  expect(reply.statusCode).toBe(200);
  return reply.json<ContentActivationResponse>().data;
};
const facts = async (cookie = people.admin.cookie, agencyId = w.agencyA): Promise<Facts> => {
  const { hasContent, sentForApproval, approvedByClient, published } = await activation(cookie, agencyId);
  return { hasContent, sentForApproval, approvedByClient, published };
};
const steps = async (cookie = people.admin.cookie, agencyId = w.agencyA): Promise<Steps> => (await activation(cookie, agencyId)).steps;

beforeAll(async () => {
  await w.setup();
  await p.setup();
  client = await w.newClient('activation-a');
  clientB = await w.newClient('activation-b', { agencyId: w.agencyB });
}, 90_000);

afterAll(async () => {
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('the facts, in the order an agency lives them', () => {
  it('is all false for an agency with no content (mutation: hasContent reads true)', async () => {
    expect(await facts()).toEqual({ hasContent: false, sentForApproval: false, approvedByClient: false, published: false });
  });

  it('has taken no step but the clients\' for an agency with clients and no content', async () => {
    const taken = await steps();

    expect(taken.firstClient).not.toBeNull();
    expect([taken.firstContent, taken.firstSent, taken.firstApproved]).toEqual([null, null, null]);
    expect(Object.keys(taken).sort()).toEqual(['firstApproved', 'firstClient', 'firstContent', 'firstSent']);
  });

  it('counts a content in production as content only (mutation: sent includes in_production)', async () => {
    await w.seedContent(client, { status: 'in_production' });
    expect(await facts()).toEqual({ hasContent: true, sentForApproval: false, approvedByClient: false, published: false });
  });

  it('counts a cancelled content as content, not as sent (mutation: sent includes cancelled)', async () => {
    await w.seedContent(client, { status: 'cancelled' });
    expect((await facts()).sentForApproval).toBe(false);
  });

  it('counts a content awaiting approval as sent, not as approved (mutation: approved reads sent)', async () => {
    await w.seedContent(client, { status: 'awaiting_approval' });
    expect(await facts()).toEqual({ hasContent: true, sentForApproval: true, approvedByClient: false, published: false });
  });

  it('does not count an approval outside the platform, which always carries a reason (mutation: drop the reason filter)', async () => {
    const id = await w.seedContent(client, { status: 'awaiting_approval' });
    const approved = await w.call('POST', people.admin.cookie, `/agencies/${w.agencyA}/clients/${client}/contents/${id}/approve-by-agency`, { revision: 1, reason: 'Aprovado por telefone' });
    expect(approved.statusCode).toBe(200);
    expect(await facts()).toEqual({ hasContent: true, sentForApproval: true, approvedByClient: false, published: false });
  });

  it('counts an approval by a person of the client (mutation: approved requires status published)', async () => {
    await w.seedContent(client, { status: 'approved' });
    expect(await facts()).toEqual({ hasContent: true, sentForApproval: true, approvedByClient: true, published: false });
  });

  it('counts a published content (mutation: published reads approved)', async () => {
    await w.seedContent(client, { status: 'published' });
    expect((await facts()).published).toBe(true);
  });

  it('never reads the contents of another agency (mutation: drop the agency filter)', async () => {
    expect(await facts(people.adminB.cookie, w.agencyB)).toEqual({ hasContent: false, sentForApproval: false, approvedByClient: false, published: false });
    await w.seedContent(clientB, { status: 'in_production', ownerUserId: people.adminB.id });
    expect(await facts(people.adminB.cookie, w.agencyB)).toEqual({ hasContent: true, sentForApproval: false, approvedByClient: false, published: false });
  });
});

describe('a person in two agencies', () => {
  it('reads the agency of the path only, though the policy would let them see both (mutation: drop the agency filter)', async () => {
    const owner = w.getOwner().knex;
    const adminRole = await owner('roles').whereNull('agency_id').where({ key: 'admin' }).first<{ id: string }>('id');
    await owner('agency_memberships').insert({ agency_id: w.agencyB, user_id: people.admin.id, role_id: adminRole.id });
    expect(await facts(people.admin.cookie, w.agencyB)).toEqual({ hasContent: true, sentForApproval: false, approvedByClient: false, published: false });
  });
});

describe('the date and the name of each step already taken', () => {
  // The tests of this block go in order: each one leaves what the next one reads. The dates are written by the owner of the database, so
  // the instant of each step is the one the test names, and no clock is involved.
  const clientName = async (id: string): Promise<string> => (await w.getOwner().knex('clients').where({ id }).first<{ name: string }>('name')).name;
  let awaitingId: string;
  let ana: { id: string; email: string };
  let invitedEmail: string;
  let anaAccessId: string;
  let inviteAccessId: string;
  const sendRound = async (clientId: string, contentId: string, sentAt: string): Promise<void> => {
    await w.getOwner().knex('content_approval_rounds').insert({
      batch_id: randomUUID(), client_id: clientId, content_id: contentId, sequence: 1, due_on: null, due_at: null, note: null, sent_by: people.manager.id, sent_at: sentAt
    });
  };

  it('dates the first client and the first content of this agency, though another agency has earlier ones', async () => {
    const knex = w.getOwner().knex;
    await knex('clients').where({ id: client }).update({ created_at: '2026-01-05T15:00:00.000Z' });
    await knex('clients').where({ id: clientB }).update({ created_at: '2025-12-01T10:00:00.000Z' });
    await w.seedContent(clientB, { status: 'in_production', ownerUserId: people.adminB.id, createdAt: '2025-12-02T10:00:00.000Z' });
    await w.seedContent(client, { status: 'in_production', title: 'Primeiro conteúdo', createdAt: '2026-01-06T09:00:00.000Z' });

    const taken = await steps();

    expect(taken.firstClient).toEqual({ at: '2026-01-05T15:00:00.000Z', name: await clientName(client) });
    expect(taken.firstContent).toEqual({ at: '2026-01-06T09:00:00.000Z', name: 'Primeiro conteúdo' });
  });

  it('dates no send for what waited before the rounds existed: the fact is true and the step is null', async () => {
    expect((await facts()).sentForApproval).toBe(true);
    expect((await steps()).firstSent).toBeNull();
  });

  it('dates the earliest send of the agency, named for the client while nobody of its portal has entered, with no others', async () => {
    awaitingId = (await w.getOwner().knex('contents').where({ client_id: client, status: 'awaiting_approval' }).orderBy('created_at').first<{ id: string }>('id')).id;
    const later = await w.seedContent(client, { status: 'awaiting_approval' });
    await sendRound(client, later, '2026-02-01T10:00:00.000Z');
    await sendRound(client, awaitingId, '2026-01-07T10:00:00.000Z');
    // Another agency sent even earlier: it is not this agency's step.
    const sentInB = await w.seedContent(clientB, { status: 'awaiting_approval', ownerUserId: people.adminB.id });
    await sendRound(clientB, sentInB, '2025-12-03T10:00:00.000Z');

    expect((await steps()).firstSent).toEqual({ at: '2026-01-07T10:00:00.000Z', name: await clientName(client), others: 0 });
  });

  it('names the send for the first person of the portal of that client who entered, and counts the others', async () => {
    const knex = w.getOwner().knex;
    // A person of another client's portal, given the access first: it is nobody's here.
    await w.seedPortalPerson(await w.newClient('activation-other'), 'Zé de Outro Cliente');
    ana = await w.seedPortalPerson(client, 'Ana Aprovadora');
    await w.seedPortalPerson(client, 'Beto Aprovador');
    await w.seedPortalPerson(client, 'Caio Removido', 'removed');
    await w.seedPortalPerson(client, 'Edu Nunca Entrou', 'not-entered');
    invitedEmail = `convidada-${randomUUID().slice(0, 8)}@activation.test`;
    await knex('client_portal_accesses').insert({ client_id: client, email: invitedEmail, status: 'active' });
    anaAccessId = (await knex('client_portal_accesses').where({ client_id: client, user_id: ana.id }).first<{ id: string }>('id')).id;
    inviteAccessId = (await knex('client_portal_accesses').where({ client_id: client, email: invitedEmail }).first<{ id: string }>('id')).id;

    for (const person of ['admin', 'owner'] as const) {
      expect((await steps(people[person].cookie)).firstSent, person).toEqual({ at: '2026-01-07T10:00:00.000Z', name: 'Ana Aprovadora', others: 1 });
    }
  });

  it('gives no name of the portal to a person who reads the contents without reading the people of the portal: the client\'s, and no others', async () => {
    const reply = await w.call('GET', people.reader.cookie, url());

    expect(reply.json<ContentActivationResponse>().data.steps.firstSent).toEqual({ at: '2026-01-07T10:00:00.000Z', name: await clientName(client), others: 0 });
    for (const secret of ['Ana Aprovadora', 'Beto Aprovador', 'Caio Removido', 'Edu Nunca Entrou', ana.email, ana.id, invitedEmail]) expect(JSON.stringify(reply.json())).not.toContain(secret);
  });

  it('keeps the name from a person who may only remove people of the portal, though the table of accesses lets that person read them', async () => {
    const membership = await w.getOwner().knex('agency_memberships').where({ agency_id: w.agencyA, user_id: people.reader.id }).first<{ role_id: string }>('role_id');
    await w.getOwner().knex('role_permissions').insert({ role_id: membership.role_id, permission_key: 'cliente.remover_usuario' });
    try {
      expect((await steps(people.reader.cookie)).firstSent).toEqual({ at: '2026-01-07T10:00:00.000Z', name: await clientName(client), others: 0 });
    } finally {
      await w.getOwner().knex('role_permissions').where({ role_id: membership.role_id, permission_key: 'cliente.remover_usuario' }).delete();
    }
  });

  it('names the first approval for the client when the account that approved is not one of its people', async () => {
    // The seeded approved and published contents were approved by an agency collaborator, who is no one of the portal of the client.
    expect((await steps()).firstApproved).toEqual({ at: '2026-10-05T12:00:00.000Z', name: await clientName(client) });
  });

  it('dates the first approval by a person of the client, named as the content detail names them, and skips the one outside the platform', async () => {
    await w.seedContent(client, { status: 'approved', approval: { by: ana.id, at: '2026-01-08T11:00:00.000Z' } });
    // The agency approved by phone even earlier: it carries a reason, and it is not the client's approval.
    await w.seedContent(client, { status: 'approved', approval: { agencyReason: 'Aprovado por telefone', at: '2026-01-02T08:00:00.000Z' } });

    expect((await steps()).firstApproved).toEqual({ at: '2026-01-08T11:00:00.000Z', name: 'Ana Aprovadora' });
  });

  it('names the approval made through a link of an access by the person of that access', async () => {
    await w.seedContent(client, { status: 'approved', approval: { byPortalAccessId: anaAccessId, at: '2026-01-03T08:00:00.000Z' } });

    expect((await steps()).firstApproved).toEqual({ at: '2026-01-03T08:00:00.000Z', name: 'Ana Aprovadora' });

    // An address that never created an account is named as the content detail names it: by the address the agency invited.
    await w.seedContent(client, { status: 'approved', approval: { byPortalAccessId: inviteAccessId, at: '2026-01-03T07:00:00.000Z' } });
    expect((await steps()).firstApproved).toEqual({ at: '2026-01-03T07:00:00.000Z', name: invitedEmail });
  });

  it('reads only the steps of the agency of the path, in both directions', async () => {
    const inB = await steps(people.adminB.cookie, w.agencyB);

    expect(inB.firstClient).toEqual({ at: '2025-12-01T10:00:00.000Z', name: await clientName(clientB) });
    expect(inB.firstContent?.at).toBe('2025-12-02T10:00:00.000Z');
    expect(inB.firstSent).toEqual({ at: '2025-12-03T10:00:00.000Z', name: await clientName(clientB), others: 0 });
    expect(inB.firstApproved).toBeNull();
    expect(JSON.stringify(inB)).not.toContain('Ana Aprovadora');
  });
});

describe('authorization', () => {
  const denied: readonly PersonKey[] = ['sales', 'finance', 'noContent', 'operateOnly'];
  const allowed: readonly PersonKey[] = ['admin', 'manager', 'production', 'owner', 'reader'];

  it.each(denied)('answers 403 to %s, before any statement reaches the contents', async (key) => {
    w.statements.length = 0;
    const reply = await w.call('GET', people[key].cookie, url());
    expect(reply.statusCode).toBe(403);
    expect(w.mentionsContents()).toBe(false);
  });

  it.each(allowed)('lets %s read', async (key) => {
    expect((await w.call('GET', people[key].cookie, url())).statusCode).toBe(200);
  });

  it('answers 401 without a session', async () => {
    expect((await w.getApp().app.inject({ method: 'GET', url: url() })).statusCode).toBe(401);
  });

  it('answers 404 to an agency the person does not belong to', async () => {
    expect((await w.call('GET', people.production.cookie, url(w.agencyB))).statusCode).toBe(404);
  });
});
