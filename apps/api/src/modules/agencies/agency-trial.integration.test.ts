import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAgencyCliDatabase, createAgencyCommandService } from '../../cli/agency.js';
import {
  buildTestApp,
  insertTestUser,
  OWNER_DATABASE_URL,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issues #708 and #709 through the API: creating an agency in trial, the plan in `/me`, `canCreateAgency`, and the
// database refusals of the plan answered as 409, never as 500. The end of the trial is moved in the database.
const origin = { origin: TEST_APP_PUBLIC_URL };

let app: TestApp;
const owner = ownerClient();

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

let portalAgencyId: string;
let portalClientId: string;

/**
 * A person with a session (a portal link elsewhere gives them a context), verified or not. The password login
 * refuses an unconfirmed account (#706), so the only unconfirmed account that holds a session is the one an
 * invitation created: it signs in confirmed, and then becomes unconfirmed with the accepted portal invitation
 * that `app_private.unconfirmed_account_may_hold_session` asks for.
 */
const signedIn = async (verified: boolean): Promise<{ user: TestUserFixture; cookie: string }> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'trial' });
  createdUserIds.push(user.id);
  await owner.knex('client_memberships').insert({ client_id: portalClientId, user_id: user.id });
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  if (!verified) {
    const invitationId = randomUUID();
    await owner.knex('invitations').insert({
      id: invitationId,
      agency_id: portalAgencyId,
      purpose: 'client_invite',
      email: user.email,
      client_id: portalClientId,
      token_hash: `trial-${invitationId}`,
      expires_at: new Date(Date.now() + 86_400_000),
      used_at: new Date(),
      accepted_by_user_id: user.id
    });
    await owner.knex('auth.user').where({ id: user.id }).update({ emailVerified: false });
  }
  return { user, cookie: sessionCookieHeader(response.cookies) };
};

const request = async (cookie: string, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  payload === undefined
    ? await app.app.inject({ method, url, headers: { ...origin, cookie } })
    : await app.app.inject({ method, url, headers: { ...origin, cookie }, payload });

const createAgency = async (cookie: string, name = `Agência ${randomUUID().slice(0, 8)}`) => {
  const response = await request(cookie, 'POST', '/agencies', { name });
  if (response.statusCode === 201) createdAgencyIds.push(response.json<{ context: { agencyId: string } }>().context.agencyId);
  return response;
};

beforeAll(async () => {
  app = await buildTestApp();
  portalAgencyId = randomUUID();
  portalClientId = randomUUID();
  createdAgencyIds.push(portalAgencyId);
  await owner.knex('agencies').insert({ id: portalAgencyId, name: `Agência do portal ${portalAgencyId}` });
  await owner.knex('clients').insert({ id: portalClientId, agency_id: portalAgencyId, name: `Cliente ${portalClientId}` });
});

afterAll(async () => {
  const clientIds = (await owner.knex('clients').whereIn('agency_id', createdAgencyIds).select('id')).map((row) => row.id as string);
  await owner.knex('invitations').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
  await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
  await owner.knex('clients').whereIn('id', clientIds).delete();
  await owner.knex('agency_storage_quotas').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex.raw('delete from audit.events where agency_id = any(?::uuid[])', [createdAgencyIds]);
  await owner.knex('agencies').whereIn('id', createdAgencyIds).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', createdAgencyIds).delete();
  await owner.knex('legal_acceptances').whereIn('user_id', createdUserIds).delete();
  await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
  await app.close();
  await owner.close();
});

describe('POST /agencies (issue #709)', () => {
  it('refuses an account whose e-mail is not verified, and does not offer the creation', async () => {
    const { user, cookie } = await signedIn(false);
    const contexts = await request(cookie, 'GET', '/me/contexts');
    expect(contexts.json<{ canCreateAgency: boolean }>().canCreateAgency).toBe(false);
    const response = await createAgency(cookie);
    expect(response.statusCode).toBe(403);
    // The session guard answers first (decision 2026-10-27): the session of an unconfirmed account opens no route.
    expect(response.json<{ error: { code: string } }>().error.code).toBe('EMAIL_NOT_CONFIRMED');
    expect(await owner.knex('agencies').where({ owner_user_id: user.id })).toHaveLength(0);
  });

  it('creates the agency in trial with the caller as Owner and answers the context to enter', async () => {
    const { user, cookie } = await signedIn(true);
    expect((await request(cookie, 'GET', '/me/contexts')).json<{ canCreateAgency: boolean }>().canCreateAgency).toBe(true);

    const response = await createAgency(cookie, 'Estúdio Novo');
    expect(response.statusCode).toBe(201);
    const { context } = response.json<{ context: Record<string, unknown> & { agencyId: string } }>();
    expect(context).toEqual({ type: 'agency', agencyId: expect.any(String), agencyName: 'Estúdio Novo', roleKey: 'admin', roleName: 'Admin', isOwner: true });
    expect(await owner.knex('agencies').where({ id: context.agencyId }).first('owner_user_id', 'plan')).toEqual({ owner_user_id: user.id, plan: 'trial' });

    const me = await request(cookie, 'GET', `/agencies/${context.agencyId}/me`);
    expect(me.statusCode).toBe(200);
    const plan = me.json<{ plan: { kind: string; trialEndsAt: string; readOnly: boolean } }>().plan;
    expect(plan).toMatchObject({ kind: 'trial', readOnly: false });
    expect(Math.round((Date.parse(plan.trialEndsAt) - Date.now()) / 86_400_000)).toBe(14);

    const contexts = (await request(cookie, 'GET', '/me/contexts')).json<{ contexts: Array<{ agencyId: string; type: string }>; canCreateAgency: boolean }>();
    expect(contexts.canCreateAgency).toBe(false);
    expect(contexts.contexts.some((entry) => entry.type === 'agency' && entry.agencyId === context.agencyId)).toBe(true);

    const second = await createAgency(cookie);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('TRIAL_ALREADY_EXISTS');
  });

  it('answers TRIAL_ALREADY_EXISTS to every creation but one when they arrive together', async () => {
    const { cookie } = await signedIn(true);
    const responses = await Promise.all([createAgency(cookie), createAgency(cookie), createAgency(cookie)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409]);
  });

  it('validates the name like the operation command does', async () => {
    const { cookie } = await signedIn(true);
    expect((await createAgency(cookie, '   ')).statusCode).toBe(400);
    expect((await createAgency(cookie, 'Nome​invisível')).statusCode).toBe(400);
    expect((await createAgency(cookie, 'a'.repeat(257))).statusCode).toBe(400);
  });
});

describe('the plan refusals through the API (issue #708)', () => {
  it('answers 409 TRIAL_CLIENT_LIMIT for the 4th client and 409 TRIAL_COLLABORATOR_LIMIT for the 3rd invitation', async () => {
    const { cookie } = await signedIn(true);
    const agencyId = (await createAgency(cookie)).json<{ context: { agencyId: string } }>().context.agencyId;
    for (let index = 0; index < 3; index += 1) {
      expect((await request(cookie, 'POST', `/agencies/${agencyId}/clients`, { name: `Cliente ${index} ${randomUUID().slice(0, 6)}` })).statusCode).toBe(201);
    }
    const fourth = await request(cookie, 'POST', `/agencies/${agencyId}/clients`, { name: `Cliente 4 ${randomUUID().slice(0, 6)}` });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json<{ error: { code: string; message: string } }>().error).toEqual({ code: 'TRIAL_CLIENT_LIMIT', message: 'O período de teste permite até 3 clientes ativos.' });

    const roleId = (await owner.knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id as string;
    for (let index = 0; index < 2; index += 1) {
      expect((await request(cookie, 'POST', `/agencies/${agencyId}/invitations/collaborators`, { email: `c${index}-${randomUUID().slice(0, 6)}@trial.test`, roleId })).statusCode).toBe(201);
    }
    const third = await request(cookie, 'POST', `/agencies/${agencyId}/invitations/collaborators`, { email: `c3-${randomUUID().slice(0, 6)}@trial.test`, roleId });
    expect(third.statusCode).toBe(409);
    expect(third.json<{ error: { code: string } }>().error.code).toBe('TRIAL_COLLABORATOR_LIMIT');
  });

  it('answers 409 AGENCY_READ_ONLY once the trial ended, keeps the reads, and says so in /me and in the portal', async () => {
    const { cookie } = await signedIn(true);
    const agencyId = (await createAgency(cookie)).json<{ context: { agencyId: string } }>().context.agencyId;
    const clientId = (await request(cookie, 'POST', `/agencies/${agencyId}/clients`, { name: `Cliente ${randomUUID().slice(0, 6)}` })).json<{ id: string }>().id;
    const portal = await signedIn(true);
    await owner.knex('client_memberships').insert({ client_id: clientId, user_id: portal.user.id });

    await owner.knex('agencies').where({ id: agencyId }).update({ trial_ends_at: owner.knex.raw("now() - interval '1 minute'") });

    const write = await request(cookie, 'POST', `/agencies/${agencyId}/clients`, { name: `Outro ${randomUUID().slice(0, 6)}` });
    expect(write.statusCode).toBe(409);
    expect(write.json<{ error: { code: string } }>().error.code).toBe('AGENCY_READ_ONLY');

    const me = await request(cookie, 'GET', `/agencies/${agencyId}/me`);
    expect(me.json<{ plan: { readOnly: boolean } }>().plan.readOnly).toBe(true);
    expect((await request(cookie, 'GET', `/agencies/${agencyId}/clients/${clientId}`)).statusCode).toBe(200);

    const portalClient = await request(portal.cookie, 'GET', `/clients/${clientId}`);
    expect(portalClient.statusCode).toBe(200);
    expect(portalClient.json<{ agencyReadOnly: boolean }>().agencyReadOnly).toBe(true);
    expect((await request(portal.cookie, 'GET', `/clients/${portalClientId}`)).json<{ agencyReadOnly: boolean }>().agencyReadOnly).toBe(false);
  });
});

describe('the operation command lifts the trial (issue #708)', () => {
  it('set-plan ativo turns a read-only trial into ativo, writable and without the trial quota; new-trial gives it another end', async () => {
    const { cookie } = await signedIn(true);
    const agencyId = (await createAgency(cookie)).json<{ context: { agencyId: string } }>().context.agencyId;
    await owner.knex('agencies').where({ id: agencyId }).update({ trial_ends_at: owner.knex.raw("now() - interval '1 minute'") });
    expect((await request(cookie, 'POST', `/agencies/${agencyId}/clients`, { name: `Antes ${randomUUID().slice(0, 6)}` })).statusCode).toBe(409);

    const database = createAgencyCliDatabase(OWNER_DATABASE_URL);
    const service = createAgencyCommandService({
      database,
      mailer: { sendActivationEmail: async () => undefined, close: async () => undefined },
      appPublicUrl: TEST_APP_PUBLIC_URL
    });
    try {
      const ends = new Date(Date.now() + 5 * 86_400_000).toISOString();
      await expect(service.setPlan(agencyId, 'trial', ends)).resolves.toMatchObject({ plan: 'trial' });
      expect((await request(cookie, 'GET', `/agencies/${agencyId}/me`)).json<{ plan: { readOnly: boolean } }>().plan.readOnly).toBe(false);

      await expect(service.setPlan(agencyId, 'ativo')).resolves.toEqual({ agencyId, plan: 'ativo', trialEndsAt: null });
      expect((await request(cookie, 'GET', `/agencies/${agencyId}/me`)).json<{ plan: unknown }>().plan).toEqual({ kind: 'ativo', trialEndsAt: null, readOnly: false, supportContactEmail: null });
      expect((await owner.knex('agency_storage_quotas').where({ agency_id: agencyId }).first('quota_bytes')).quota_bytes).toBeNull();
      for (let index = 0; index < 4; index += 1) {
        expect((await request(cookie, 'POST', `/agencies/${agencyId}/clients`, { name: `Depois ${index} ${randomUUID().slice(0, 6)}` })).statusCode).toBe(201);
      }
      // With the first agency ativo, the account may start a trial again.
      expect((await createAgency(cookie)).statusCode).toBe(201);
    } finally {
      await database.close();
    }
  });
});

describe('the daily e-mail limit through the API (issue #708)', () => {
  it('answers 429 DAILY_EMAIL_LIMIT once the agency sent its invitations of the day', async () => {
    const { cookie } = await signedIn(true);
    const agencyId = (await createAgency(cookie)).json<{ context: { agencyId: string } }>().context.agencyId;
    await owner.knex('agencies').where({ id: agencyId }).update({ daily_email_limit: 1 });
    const roleId = (await owner.knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id as string;
    expect((await request(cookie, 'POST', `/agencies/${agencyId}/invitations/collaborators`, { email: `d1-${randomUUID().slice(0, 6)}@trial.test`, roleId })).statusCode).toBe(201);
    const second = await request(cookie, 'POST', `/agencies/${agencyId}/invitations/collaborators`, { email: `d2-${randomUUID().slice(0, 6)}@trial.test`, roleId });
    expect(second.statusCode).toBe(429);
    expect(second.json<{ error: { code: string; message: string } }>().error).toEqual({ code: 'DAILY_EMAIL_LIMIT', message: 'Limite diário de envios atingido. Tente amanhã.' });
    expect(await owner.knex('invitations').where({ agency_id: agencyId })).toHaveLength(1);
  });
});

describe('the support contact of the plan notice', () => {
  it('serves SUPPORT_CONTACT_EMAIL in /me only when it is configured', async () => {
    const { cookie } = await signedIn(true);
    const agencyId = (await createAgency(cookie)).json<{ context: { agencyId: string } }>().context.agencyId;
    expect((await request(cookie, 'GET', `/agencies/${agencyId}/me`)).json<{ plan: { supportContactEmail: unknown } }>().plan.supportContactEmail).toBeNull();

    const configured = await buildTestApp({ config: { supportContactEmail: 'suporte@ageniza.test' } });
    try {
      const me = await configured.app.inject({ method: 'GET', url: `/agencies/${agencyId}/me`, headers: { ...origin, cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ plan: { supportContactEmail: unknown } }>().plan.supportContactEmail).toBe('suporte@ageniza.test');
    } finally {
      await configured.close();
    }
  });
});