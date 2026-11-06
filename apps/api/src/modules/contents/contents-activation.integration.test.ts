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
const facts = async (cookie = people.admin.cookie, agencyId = w.agencyA) => {
  const reply = await w.call('GET', cookie, url(agencyId));
  expect(reply.statusCode).toBe(200);
  return reply.json<{ data: { hasContent: boolean; sentForApproval: boolean; approvedByClient: boolean; published: boolean } }>().data;
};

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
