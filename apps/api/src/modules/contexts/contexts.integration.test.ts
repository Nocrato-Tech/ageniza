import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

import {
  buildTestApp,
  captureLogs,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// AUTH-20C (issue #33) acceptance tests. All 17 numbered criteria are covered below; each `it`
// names the criterion(s) it proves.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdClientIds: string[] = [];
const createdRoleIds: string[] = [];

let adminRoleId: string;
let productionRoleId: string;

interface AgencyContextJson {
  readonly type: 'agency';
  readonly agencyId: string;
  readonly agencyName: string;
  readonly roleKey: string;
  readonly roleName: string;
  readonly isOwner: boolean;
}

interface ClientContextJson {
  readonly type: 'client';
  readonly clientId: string;
  readonly clientName: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly onboardingPending: boolean;
}

type ContextJson = AgencyContextJson | ClientContextJson;

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUserIds.push(user.id);
  return user;
};

const createAgency = async (name: string, ownerUserId: string | null, status: 'active' | 'suspended' = 'active'): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name, owner_user_id: ownerUserId, status });
  return id;
};

const addAgencyMembership = async (agencyId: string, userId: string, roleId: string, status: 'active' | 'removed' = 'active'): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status });
};

const setAgencyStatus = async (agencyId: string, status: 'active' | 'suspended'): Promise<void> => {
  await owner.knex('agencies').where({ id: agencyId }).update({ status });
};

const setMembershipStatus = async (agencyId: string, userId: string, status: 'active' | 'removed'): Promise<void> => {
  await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: userId }).update({ status });
};

const createClient = async (agencyId: string, name: string, status: 'active' | 'archived' = 'active'): Promise<string> => {
  const id = randomUUID();
  createdClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name, status });
  return id;
};

const addClientMembership = async (clientId: string, userId: string, status: 'active' | 'removed' = 'active'): Promise<void> => {
  await owner.knex('client_memberships').insert({ client_id: clientId, user_id: userId, status });
};

const getContexts = async (cookie: string): Promise<{ status: number; contexts: ContextJson[] }> => {
  const response = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie } });
  return { status: response.statusCode, contexts: response.statusCode === 200 ? response.json<{ contexts: ContextJson[] }>().contexts : [] };
};

const resolve = async (cookie: string, preferred?: string): Promise<{ status: number; body: unknown }> => {
  const query = preferred === undefined ? '' : `?preferred=${encodeURIComponent(preferred)}`;
  const response = await app.app.inject({ method: 'GET', url: `/me/contexts/resolve${query}`, headers: { ...origin, cookie } });
  return { status: response.statusCode, body: response.json() };
};

const putLastContext = async (cookie: string, body: Record<string, unknown>): Promise<number> => {
  const response = await app.app.inject({ method: 'PUT', url: '/me/last-context', headers: { ...origin, cookie }, payload: body });
  return response.statusCode;
};

const postOnboardingSeen = async (cookie: string, clientId: string): Promise<number> => {
  const response = await app.app.inject({ method: 'POST', url: `/clients/${clientId}/onboarding/seen`, headers: { ...origin, cookie } });
  return response.statusCode;
};

describe('contexts module (AUTH-20C)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp();

    const adminRole = await owner.knex('roles').where({ key: 'admin' }).whereNull('agency_id').first('id');
    const productionRole = await owner.knex('roles').where({ key: 'production' }).whereNull('agency_id').first('id');
    if (adminRole === undefined || productionRole === undefined) throw new Error('System role seeds are missing.');
    adminRoleId = adminRole.id;
    productionRoleId = productionRole.id;
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = [...new Set(createdClientIds)];
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('#1 isolates user_context_preferences by user through RLS', async () => {
    const userA = await makeUser('ctx-rls-a');
    const userB = await makeUser('ctx-rls-b');
    const agency = await createAgency('RLS Agency', userA.id);
    await addAgencyMembership(agency, userA.id, adminRoleId);

    const claimsA = createVerifiedUserClaims({ userId: userA.id });
    const claimsB = createVerifiedUserClaims({ userId: userB.id });

    await withAuthenticatedUserTransaction(app.database, claimsA, (transaction) =>
      raw(transaction, `
        insert into public.user_context_preferences (user_id, context_type, agency_id)
        values (app_private.current_user_id(), 'agency', ?::uuid)
      `, [agency])
    );

    // B cannot read A's preference row.
    const readAsB = await withAuthenticatedUserTransaction(app.database, claimsB, (transaction) =>
      raw<{ rows: readonly unknown[] }>(transaction, 'select * from public.user_context_preferences where user_id = ?::uuid', [userA.id])
    );
    expect(readAsB.rows).toHaveLength(0);

    // B's attempt to overwrite A's row (RLS `using` on UPDATE) affects zero rows, never A's data.
    const updateAsB = await withAuthenticatedUserTransaction(app.database, claimsB, (transaction) =>
      raw<{ rowCount: number | null }>(transaction, `
        update public.user_context_preferences set context_type = 'agency' where user_id = ?::uuid
      `, [userA.id])
    );
    expect(updateAsB.rowCount ?? 0).toBe(0);

    const readAsA = await withAuthenticatedUserTransaction(app.database, claimsA, (transaction) =>
      raw<{ rows: readonly { user_id: string }[] }>(transaction, 'select user_id from public.user_context_preferences where user_id = ?::uuid', [userA.id])
    );
    expect(readAsA.rows).toHaveLength(1);
  });

  it('#2 zero contexts: resolve ends the session instead of returning an empty app (issue #68)', async () => {
    const user = await makeUser('ctx-resolve-none');
    const agency = await createAgency('Resolve None Agency', user.id);
    await addAgencyMembership(agency, user.id, adminRoleId);
    // Login succeeds: the person currently has exactly one context.
    const cookie = await loginCookie(user);

    // The session guard itself never charges for zero contexts (AGENTS.md / decisions.md
    // 2026-09-24): with a still-valid session, `GET /me/contexts` plainly reports nothing.
    await setAgencyStatus(agency, 'suspended');
    const emptyList = await getContexts(cookie);
    expect(emptyList.contexts).toEqual([]);

    // `resolve` is where the zero-context rule is charged: it both answers `none` and ends the
    // session, per the 2026-09-24 decision ("quem perde o último contexto... é encerrado na
    // próxima passagem pelo resolve").
    const none = await resolve(cookie);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ decision: 'none' });

    // The same cookie is now unusable: the session row is gone, not merely stale.
    const afterNone = await resolve(cookie);
    expect(afterNone.status).toBe(401);
    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);
  });

  it('#3, #4, #5, #6, #7, #8, #10 (partial) cover the resolve algorithm as contexts are added, preferred, suspended and restored', async () => {
    const user = await makeUser('ctx-resolve');
    const agencyOne = await createAgency('Resolve Agency One', user.id);
    await addAgencyMembership(agencyOne, user.id, adminRoleId);
    const cookie = await loginCookie(user);

    // #3: exactly one valid context -> enter it directly.
    const single = await resolve(cookie);
    expect(single.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyOne } });

    // #6 (case A): two valid contexts, no last-used preference -> select with highlighted null.
    const agencyTwoOwner = await makeUser('ctx-resolve-agency-two-owner');
    const agencyTwo = await createAgency('Resolve Agency Two', agencyTwoOwner.id);
    await addAgencyMembership(agencyTwo, user.id, productionRoleId);
    const twoNoLast = await resolve(cookie);
    expect(twoNoLast.body).toMatchObject({ decision: 'select', highlighted: null });
    expect((twoNoLast.body as { contexts: ContextJson[] }).contexts).toHaveLength(2);

    // #4: last-used context, still valid, wins with 2+ contexts.
    expect(await putLastContext(cookie, { type: 'agency', agencyId: agencyTwo })).toBe(204);
    const withLast = await resolve(cookie);
    expect(withLast.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyTwo } });

    // #5 and #10 (part 1): suspending the last-used agency invalidates it; exactly one other
    // valid context remains -> enter that one, and it disappears from `GET /me/contexts`.
    await setAgencyStatus(agencyTwo, 'suspended');
    const lastInvalidOneOther = await resolve(cookie);
    expect(lastInvalidOneOther.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyOne } });
    const listWhileSuspended = await getContexts(cookie);
    expect(listWhileSuspended.contexts.map((context) => (context as AgencyContextJson).agencyId)).toEqual([agencyOne]);

    // #10 (part 2): reverting the suspension brings the agency back.
    await setAgencyStatus(agencyTwo, 'active');
    const listRestored = await getContexts(cookie);
    expect(listRestored.contexts).toHaveLength(2);

    // Third context, with the last-used preference (agencyTwo) still valid among 3.
    const agencyThree = await createAgency('Resolve Agency Three', user.id);
    await addAgencyMembership(agencyThree, user.id, adminRoleId);
    const threeWithLast = await resolve(cookie);
    expect(threeWithLast.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyTwo } });

    // #7: an explicit, valid `preferred` wins over a valid last-used preference.
    const preferredWins = await resolve(cookie, `agency:${agencyThree}`);
    expect(preferredWins.body).toMatchObject({ decision: 'select', highlighted: { type: 'agency', agencyId: agencyThree } });
    expect((preferredWins.body as { contexts: ContextJson[] }).contexts).toHaveLength(3);

    // #8: a `preferred` the user has no access to is ignored in silence; falls through to step 5.
    const inaccessiblePreferred = await resolve(cookie, `agency:${randomUUID()}`);
    expect(inaccessiblePreferred.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyTwo } });

    const malformedPreferred = await resolve(cookie, 'not-a-context');
    expect(malformedPreferred.status).toBe(200);
    expect(malformedPreferred.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyTwo } });

    const oversizedPreferred = await resolve(cookie, 'x'.repeat(257));
    expect(oversizedPreferred.status).toBe(200);
    expect(oversizedPreferred.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyTwo } });

    const repeatedPreferred = await app.app.inject({
      method: 'GET',
      url: '/me/contexts/resolve?preferred=invalid-one&preferred=invalid-two',
      headers: { ...origin, cookie }
    });
    expect(repeatedPreferred.statusCode).toBe(200);
    expect(repeatedPreferred.json()).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyTwo } });

    // #6 (case B): suspend the last-used agency permanently; 2 other valid contexts remain ->
    // select with highlighted null (no single winner, no valid preferred).
    await setAgencyStatus(agencyTwo, 'suspended');
    const lastInvalidSeveralOther = await resolve(cookie);
    expect(lastInvalidSeveralOther.body).toMatchObject({ decision: 'select', highlighted: null });
    expect((lastInvalidSeveralOther.body as { contexts: ContextJson[] }).contexts).toHaveLength(2);
  });

  it('#9 orders contexts: last-used first, then alphabetically ignoring accent/case, then agency before client, then by id', async () => {
    const user = await makeUser('ctx-order');
    const beta = await createAgency('beta', user.id);
    await addAgencyMembership(beta, user.id, adminRoleId);
    const cookie = await loginCookie(user);

    const agil = await createAgency('Ágil', user.id);
    await addAgencyMembership(agil, user.id, adminRoleId);

    const { contexts } = await getContexts(cookie);
    expect(contexts.map((context) => (context as AgencyContextJson).agencyName)).toEqual(['Ágil', 'beta']);

    // Same display name, different types: agency sorts before client.
    const tieAgency = await createAgency('Torre', user.id);
    await addAgencyMembership(tieAgency, user.id, adminRoleId);
    const tieAgencyForClient = await createAgency('Torre Client Agency', user.id);
    await addAgencyMembership(tieAgencyForClient, user.id, adminRoleId);
    const tieClient = await createClient(tieAgencyForClient, 'Torre');
    await addClientMembership(tieClient, user.id);

    const { contexts: withTie } = await getContexts(cookie);
    const torreEntries = withTie.filter((context) =>
      (context.type === 'agency' && context.agencyName === 'Torre') || (context.type === 'client' && context.clientName === 'Torre')
    );
    expect(torreEntries).toHaveLength(2);
    expect(torreEntries[0]?.type).toBe('agency');
    expect(torreEntries[1]?.type).toBe('client');

    // Last-used still comes first even though it is not alphabetically first.
    expect(await putLastContext(cookie, { type: 'agency', agencyId: beta })).toBe(204);
    const { contexts: withLastUsed } = await getContexts(cookie);
    expect((withLastUsed[0] as AgencyContextJson).agencyId).toBe(beta);
  });

  it('#11 an owner without an explicit membership row appears as isOwner with the Admin role', async () => {
    const user = await makeUser('ctx-owner-no-membership');
    const agency = await createAgency('Owner Only Agency', user.id);
    // Deliberately no agency_memberships row: the legacy/partially-provisioned owner path.
    const cookie = await loginCookie(user);

    const { contexts } = await getContexts(cookie);
    expect(contexts).toEqual([
      { type: 'agency', agencyId: agency, agencyName: 'Owner Only Agency', roleKey: 'admin', roleName: 'Admin', isOwner: true }
    ]);
  });

  it('#12 a client context carries agencyName and onboardingPending, which flips exactly once and stays fixed after', async () => {
    const owner1 = await makeUser('ctx-onboarding-owner');
    const member = await makeUser('ctx-onboarding-member');
    const agency = await createAgency('Onboarding Agency', owner1.id);
    await addAgencyMembership(agency, owner1.id, adminRoleId);
    const client = await createClient(agency, 'Onboarding Client');
    await addClientMembership(client, member.id);
    const memberCookie = await loginCookie(member);

    const before = await getContexts(memberCookie);
    expect(before.contexts).toEqual([
      { type: 'client', clientId: client, clientName: 'Onboarding Client', agencyId: agency, agencyName: 'Onboarding Agency', onboardingPending: true }
    ]);

    expect(await postOnboardingSeen(memberCookie, client)).toBe(204);
    const afterFirstSeen = await getContexts(memberCookie);
    expect((afterFirstSeen.contexts[0] as ClientContextJson).onboardingPending).toBe(false);
    const firstSeenAt = await owner.knex('client_memberships').where({ client_id: client, user_id: member.id }).first('onboarding_seen_at');

    // Idempotent: calling again still returns 204, and the recorded timestamp never changes.
    expect(await postOnboardingSeen(memberCookie, client)).toBe(204);
    const secondSeenAt = await owner.knex('client_memberships').where({ client_id: client, user_id: member.id }).first('onboarding_seen_at');
    expect(new Date(secondSeenAt.onboarding_seen_at).getTime()).toBe(new Date(firstSeenAt.onboarding_seen_at).getTime());
  });

  it('#13 PUT /me/last-context with an invalid context responds 404 and leaves the previous preference unchanged', async () => {
    const user = await makeUser('ctx-put-invalid');
    const agencyY = await createAgency('Put Agency Y', user.id);
    await addAgencyMembership(agencyY, user.id, adminRoleId);
    const agencyZ = await createAgency('Put Agency Z', user.id);
    await addAgencyMembership(agencyZ, user.id, adminRoleId);
    const cookie = await loginCookie(user);

    expect(await putLastContext(cookie, { type: 'agency', agencyId: agencyY })).toBe(204);
    const beforeInvalid = await resolve(cookie);
    expect(beforeInvalid.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyY } });

    const invalidStatus = await putLastContext(cookie, { type: 'agency', agencyId: randomUUID() });
    expect(invalidStatus).toBe(404);

    const afterInvalid = await resolve(cookie);
    expect(afterInvalid.body).toMatchObject({ decision: 'enter', context: { type: 'agency', agencyId: agencyY } });
  });

  it('#14 the same user in two "tabs" gets independent, non-interfering answers for two agencies (no session-held context)', async () => {
    const user = await makeUser('ctx-two-tabs');
    // Owned by someone else: `user` is a plain collaborator, so removing their membership below
    // actually revokes access (an owner's access does not depend on having a membership row).
    const otherOwner = await makeUser('ctx-two-tabs-owner');
    const agencyA = await createAgency('Tabs Agency A', otherOwner.id);
    await addAgencyMembership(agencyA, otherOwner.id, adminRoleId);
    await addAgencyMembership(agencyA, user.id, productionRoleId);
    const agencyB = await createAgency('Tabs Agency B', otherOwner.id);
    await addAgencyMembership(agencyB, otherOwner.id, adminRoleId);
    await addAgencyMembership(agencyB, user.id, productionRoleId);

    const pingApp = await buildTestApp({
      registerExtraRoutes: (fastifyApp, guards) => {
        fastifyApp.get('/__test/agencies/:agencyId/ping', { preHandler: [guards.requireSession, guards.requireAgencyAccess] }, async (request) => ({
          agencyId: request.tenant?.agencyId
        }));
      }
    });
    try {
      const pingCookie = await (async () => {
        const response = await pingApp!.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
        expect(response.statusCode).toBe(200);
        return sessionCookieHeader(response.cookies);
      })();

      const ping = (agencyId: string) => pingApp!.app.inject({ method: 'GET', url: `/__test/agencies/${agencyId}/ping`, headers: { ...origin, cookie: pingCookie } });

      const [firstA, firstB, secondA, secondB] = await Promise.all([ping(agencyA), ping(agencyB), ping(agencyA), ping(agencyB)]);
      expect(firstA.statusCode).toBe(200);
      expect(firstA.json()).toEqual({ agencyId: agencyA });
      expect(firstB.statusCode).toBe(200);
      expect(firstB.json()).toEqual({ agencyId: agencyB });
      expect(secondA.statusCode).toBe(200);
      expect(secondA.json()).toEqual({ agencyId: agencyA });
      expect(secondB.statusCode).toBe(200);
      expect(secondB.json()).toEqual({ agencyId: agencyB });

      // #15: revoking access to A takes effect on the very next request, while B stays reachable.
      await setMembershipStatus(agencyA, user.id, 'removed');
      const afterRevokeA = await ping(agencyA);
      expect(afterRevokeA.statusCode).toBe(404);
      const afterRevokeB = await ping(agencyB);
      expect(afterRevokeB.statusCode).toBe(200);
    } finally {
      await pingApp?.close();
    }
  });

  it('#16 an agency collaborator without a client membership gets 404 from requireClientAccess', async () => {
    const collaborator = await makeUser('ctx-collaborator');
    const agencyOwner = await makeUser('ctx-collaborator-owner');
    const agency = await createAgency('Collaborator Agency', agencyOwner.id);
    await addAgencyMembership(agency, agencyOwner.id, adminRoleId);
    await addAgencyMembership(agency, collaborator.id, productionRoleId);
    const collaboratorCookie = await loginCookie(collaborator);
    const client = await createClient(agency, 'Collaborator Client');
    // Deliberately no client_memberships row for `collaborator`.

    const status = await postOnboardingSeen(collaboratorCookie, client);
    expect(status).toBe(404);
  });

  it('#18 a membership pointing at another agency role shows a neutral label, never Admin', async () => {
    const user = await makeUser('ctx-foreign-role');
    const homeAgency = await createAgency('Foreign Role Home', null);
    const sourceAgency = await createAgency('Foreign Role Source', null);
    const roleId = randomUUID();
    createdRoleIds.push(roleId);
    await owner.knex('roles').insert({ id: roleId, agency_id: sourceAgency, key: 'bigrole', name: 'Big Role', is_system: false });
    await addAgencyMembership(homeAgency, user.id, roleId);
    const cookie = await loginCookie(user);

    const { status, contexts } = await getContexts(cookie);
    expect(status).toBe(200);
    expect(contexts).toEqual([
      expect.objectContaining({ type: 'agency', agencyId: homeAgency, roleKey: 'sem-papel', roleName: 'Sem papel', isOwner: false })
    ]);
  });

  it('#17 no log line contains a full email address or a cookie value across the context routes', async () => {
    const { logger, text } = captureLogs();
    const loggedApp = await buildTestApp({ logger });
    try {
      const user = await insertTestUser(loggedApp.pool, loggedApp.auth, { emailLabel: 'ctx-log' });
      createdUserIds.push(user.id);
      await createAgency('Log Agency', user.id);
      const login = await loggedApp.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
      expect(login.statusCode).toBe(200);
      const cookieValue = login.cookies[0]?.value;
      expect(cookieValue).toBeDefined();
      const cookie = sessionCookieHeader(login.cookies);

      await loggedApp.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie } });
      await loggedApp.app.inject({ method: 'GET', url: '/me/contexts/resolve', headers: { ...origin, cookie } });
      await loggedApp.app.inject({ method: 'PUT', url: '/me/last-context', headers: { ...origin, cookie }, payload: { type: 'agency', agencyId: randomUUID() } });

      const logText = text();
      expect(logText).not.toContain(user.email);
      if (cookieValue !== undefined) expect(logText).not.toContain(cookieValue);
    } finally {
      await loggedApp.close();
    }
  });
});
