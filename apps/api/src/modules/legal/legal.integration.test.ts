import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  captureLogs,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type CapturedLogs,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { createInvitationToken } from '../invitations/tokens.js';

// Issue #81 acceptance tests, against the real local database (`pnpm db:migrate`). The two
// versions in force differ on purpose: a route that recorded one document's version for the other
// would pass with equal ones.
const TERMS_VERSION = '2026-03-01';
const PRIVACY_VERSION = '2026-05-01';
const origin = { origin: TEST_APP_PUBLIC_URL };

interface DocumentStatus {
  readonly document: 'terms' | 'privacy';
  readonly currentVersion: string;
  readonly acceptedVersion: string | null;
  readonly pending: boolean;
}

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

let app: TestApp;
let logs: CapturedLogs;
const owner = ownerClient();
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const createAgency = async (ownerUserId: string | null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name: `Legal ${id.slice(0, 8)}`, owner_user_id: ownerUserId, status: 'active' });
  return id;
};

/** A user with one context, so the login is not refused for having none. */
const makeUser = async (label: string, options: { readonly agencyOwner?: boolean } = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: label });
  createdUserIds.push(user.id);
  if (options.agencyOwner ?? true) await createAgency(user.id);
  return user;
};

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const getStatus = async (cookie: string | undefined): Promise<{ status: number; body: ApiErrorJson & { documents?: DocumentStatus[] } }> => {
  const response = await app.app.inject({ method: 'GET', url: '/me/legal-acceptances', headers: cookie === undefined ? origin : { ...origin, cookie } });
  return { status: response.statusCode, body: response.json() };
};

const accept = async (cookie: string | undefined, payload: unknown, contentType = 'application/json'): Promise<{ status: number; body: ApiErrorJson & { documents?: DocumentStatus[] } }> => {
  const response = await app.app.inject({
    method: 'POST',
    url: '/me/legal-acceptances',
    headers: cookie === undefined ? { ...origin, 'content-type': contentType } : { ...origin, cookie, 'content-type': contentType },
    payload: payload as never
  });
  return { status: response.statusCode, body: response.json() };
};

const rowsOf = async (userId: string): Promise<{ document: string; version: string }[]> =>
  owner.knex('legal_acceptances').where({ user_id: userId }).orderBy([{ column: 'document' }, { column: 'version' }]).select('document', 'version');

const seedAcceptance = async (userId: string, document: 'terms' | 'privacy', version: string): Promise<void> => {
  await owner.knex('legal_acceptances').insert({ user_id: userId, document, version });
};

const statusOf = (documents: readonly DocumentStatus[] | undefined, document: 'terms' | 'privacy'): DocumentStatus => {
  const found = documents?.find((entry) => entry.document === document);
  if (found === undefined) throw new Error(`The response has no ${document} entry.`);
  return found;
};

describe('legal acceptance per document (issue #81)', () => {
  beforeAll(async () => {
    logs = captureLogs();
    app = await buildTestApp({
      logger: logs.logger,
      config: { authTermsVersion: TERMS_VERSION, authPrivacyVersion: PRIVACY_VERSION }
    });
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const userIds = [...new Set(createdUserIds)];
    await owner.knex('legal_acceptances').whereIn('user_id', userIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', userIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    await app.close();
    await owner.close();
  });

  it('refuses both routes without a session, and records nothing', async () => {
    expect((await getStatus(undefined)).status).toBe(401);
    const denied = await accept(undefined, { document: 'terms' });
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('reports a never-accepted account as pending on both documents, without blocking anything', async () => {
    const user = await makeUser('legal-never');
    const cookie = await login(user);

    const { status, body } = await getStatus(cookie);

    expect(status).toBe(200);
    expect(body.documents).toEqual([
      { document: 'terms', currentVersion: TERMS_VERSION, acceptedVersion: null, pending: true },
      { document: 'privacy', currentVersion: PRIVACY_VERSION, acceptedVersion: null, pending: true }
    ]);
    // A pending acceptance gates nothing: the login above already succeeded and the account still
    // reaches its own contexts.
    const contexts = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie } });
    expect(contexts.statusCode).toBe(200);
  });

  it('accepting the Privacy Policy records only the Privacy Policy, at the version in force', async () => {
    const user = await makeUser('legal-privacy-only');
    const cookie = await login(user);

    const { status, body } = await accept(cookie, { document: 'privacy' });

    expect(status).toBe(200);
    expect(statusOf(body.documents, 'privacy')).toEqual({ document: 'privacy', currentVersion: PRIVACY_VERSION, acceptedVersion: PRIVACY_VERSION, pending: false });
    expect(statusOf(body.documents, 'terms')).toEqual({ document: 'terms', currentVersion: TERMS_VERSION, acceptedVersion: null, pending: true });
    expect(await rowsOf(user.id)).toEqual([{ document: 'privacy', version: PRIVACY_VERSION }]);
  });

  it('accepting the Terms records only the Terms, at the version in force', async () => {
    const user = await makeUser('legal-terms-only');
    const cookie = await login(user);

    const { body } = await accept(cookie, { document: 'terms' });

    expect(statusOf(body.documents, 'terms')).toEqual({ document: 'terms', currentVersion: TERMS_VERSION, acceptedVersion: TERMS_VERSION, pending: false });
    expect(statusOf(body.documents, 'privacy').pending).toBe(true);
    expect(await rowsOf(user.id)).toEqual([{ document: 'terms', version: TERMS_VERSION }]);
  });

  it('moves an account on an older version to the current one, keeping the older row as history', async () => {
    const user = await makeUser('legal-outdated');
    await seedAcceptance(user.id, 'terms', '2026-01-01');
    await seedAcceptance(user.id, 'privacy', '2026-02-01');
    const cookie = await login(user);

    const before = await getStatus(cookie);
    expect(statusOf(before.body.documents, 'terms')).toMatchObject({ acceptedVersion: '2026-01-01', pending: true });
    expect(statusOf(before.body.documents, 'privacy')).toMatchObject({ acceptedVersion: '2026-02-01', pending: true });

    const { body } = await accept(cookie, { document: 'terms' });

    expect(statusOf(body.documents, 'terms')).toMatchObject({ acceptedVersion: TERMS_VERSION, pending: false });
    expect(statusOf(body.documents, 'privacy')).toMatchObject({ acceptedVersion: '2026-02-01', pending: true });
    expect(await rowsOf(user.id)).toEqual([
      { document: 'privacy', version: '2026-02-01' },
      { document: 'terms', version: '2026-01-01' },
      { document: 'terms', version: TERMS_VERSION }
    ]);
  });

  it('shows no notice to an account that already accepted the versions in force', async () => {
    const user = await makeUser('legal-current');
    await seedAcceptance(user.id, 'terms', TERMS_VERSION);
    await seedAcceptance(user.id, 'privacy', PRIVACY_VERSION);
    const cookie = await login(user);

    const { body } = await getStatus(cookie);

    expect(body.documents?.map((entry) => entry.pending)).toEqual([false, false]);
  });

  it('is idempotent: repeating the acceptance, even at the same time, keeps one row and the same answer', async () => {
    const user = await makeUser('legal-idempotent');
    const cookie = await login(user);

    const first = await accept(cookie, { document: 'privacy' });
    const second = await accept(cookie, { document: 'privacy' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const racer = await makeUser('legal-race');
    const racerCookie = await login(racer);
    const results = await Promise.all([
      accept(racerCookie, { document: 'terms' }),
      accept(racerCookie, { document: 'terms' }),
      accept(racerCookie, { document: 'terms' })
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);

    expect(await rowsOf(user.id)).toEqual([{ document: 'privacy', version: PRIVACY_VERSION }]);
    expect(await rowsOf(racer.id)).toEqual([{ document: 'terms', version: TERMS_VERSION }]);
  });

  it('never regresses: an account that already accepted a newer version records nothing and is not pending', async () => {
    const user = await makeUser('legal-ahead');
    await seedAcceptance(user.id, 'terms', '2026-09-01');
    const cookie = await login(user);

    const before = await getStatus(cookie);
    expect(statusOf(before.body.documents, 'terms')).toEqual({ document: 'terms', currentVersion: TERMS_VERSION, acceptedVersion: '2026-09-01', pending: false });

    const { status, body } = await accept(cookie, { document: 'terms' });

    expect(status).toBe(200);
    expect(statusOf(body.documents, 'terms')).toMatchObject({ acceptedVersion: '2026-09-01', pending: false });
    expect(await rowsOf(user.id)).toEqual([{ document: 'terms', version: '2026-09-01' }]);
  });

  it('never takes the version from the client: a version field is a 400 and records nothing', async () => {
    const user = await makeUser('legal-client-version');
    const cookie = await login(user);

    for (const payload of [
      { document: 'terms', version: '2099-01-01' },
      { document: 'terms', version: TERMS_VERSION },
      { version: '2099-01-01' },
      { document: 'terms', userId: randomUUID() },
      { document: 'cookies' },
      { document: ['terms', 'privacy'] },
      { document: null },
      {},
      []
    ]) {
      const denied = await accept(cookie, payload);
      expect({ payload, status: denied.status }).toEqual({ payload, status: 400 });
      expect(denied.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await rowsOf(user.id)).toEqual([]);
  });

  it('answers a malformed or empty JSON body with 400, without an error log', async () => {
    const user = await makeUser('legal-malformed');
    const cookie = await login(user);
    const before = logs.text().length;

    const malformed = await accept(cookie, '{"document": ', 'application/json');
    const empty = await accept(cookie, '', 'application/json');

    expect(malformed.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(logs.text().slice(before)).not.toMatch(/"level":50/);
    expect(await rowsOf(user.id)).toEqual([]);
  });

  it('keeps accounts apart: one account accepting never marks, nor reveals, another', async () => {
    const alice = await makeUser('legal-alice');
    const bob = await makeUser('legal-bob');
    await seedAcceptance(bob.id, 'terms', TERMS_VERSION);
    const aliceCookie = await login(alice);
    const bobCookie = await login(bob);

    await accept(aliceCookie, { document: 'privacy' });

    expect(await rowsOf(alice.id)).toEqual([{ document: 'privacy', version: PRIVACY_VERSION }]);
    expect(await rowsOf(bob.id)).toEqual([{ document: 'terms', version: TERMS_VERSION }]);
    const bobStatus = await getStatus(bobCookie);
    expect(statusOf(bobStatus.body.documents, 'terms').acceptedVersion).toBe(TERMS_VERSION);
    expect(statusOf(bobStatus.body.documents, 'privacy').acceptedVersion).toBeNull();
    const aliceStatus = await getStatus(aliceCookie);
    expect(statusOf(aliceStatus.body.documents, 'terms').acceptedVersion).toBeNull();
    expect(statusOf(aliceStatus.body.documents, 'privacy').acceptedVersion).toBe(PRIVACY_VERSION);
  });

  it('needs no module permission: a custom role holding a single unrelated permission accepts, and so does an owner without a role', async () => {
    const agencyId = await createAgency(null);
    const roleId = randomUUID();
    createdRoleIds.push(roleId);
    await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Custom', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: roleId, permission_key: 'midia.enviar' });
    const member = await makeUser('legal-single-permission', { agencyOwner: false });
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: member.id, role_id: roleId, status: 'active' });
    const ownerWithoutRole = await makeUser('legal-owner-no-role');

    for (const user of [member, ownerWithoutRole]) {
      const cookie = await login(user);
      const { status, body } = await accept(cookie, { document: 'terms' });
      expect({ user: user.id, status }).toEqual({ user: user.id, status: 200 });
      expect(statusOf(body.documents, 'terms').acceptedVersion).toBe(TERMS_VERSION);
    }
  });

  it('keeps the signup contract: a new account created from an invitation accepts both versions in force', async () => {
    const agencyId = await createAgency(null);
    const invitation = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
    const email = `legal-signup.${randomUUID().slice(0, 8)}@auth-integration.test`;
    await owner.knex('invitations').insert({
      agency_id: agencyId,
      purpose: 'agency_activation',
      email,
      token_hash: invitation.tokenHash,
      expires_at: invitation.expiresAt
    });

    const response = await app.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept-new-account`,
      headers: origin,
      payload: { name: 'Pessoa Nova', password: 'a correct horse battery staple', acceptTerms: true }
    });
    expect(response.statusCode).toBe(201);
    const created = await app.pool.query<{ id: string }>('select id from auth."user" where email = $1', [email]);
    const userId = created.rows[0]?.id;
    if (userId === undefined) throw new Error('The account was not created.');
    createdUserIds.push(userId);

    expect(await rowsOf(userId)).toEqual([
      { document: 'privacy', version: PRIVACY_VERSION },
      { document: 'terms', version: TERMS_VERSION }
    ]);
    const cookie = sessionCookieHeader(response.cookies);
    const { body } = await getStatus(cookie);
    expect(body.documents?.map((entry) => entry.pending)).toEqual([false, false]);
  });
});
