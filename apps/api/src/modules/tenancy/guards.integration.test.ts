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
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #189. `createRequireAgencyAccess` builds `request.tenant` for every agency route. Its permission set is read
// from `app_private.agency_permission_keys`, the one resolution, and these scenarios prove what the guard hands the
// handlers is what RLS (`has_agency_permission`) would answer for the same person, key by key: a guard that
// allowed what RLS denies would only be stopped by the policy, and one that denied what RLS allows would be a 403
// for something the database accepts. The Admin holds every key but `colaborador.atribuir_admin`, so a copy that
// handed the owner's key to everyone is caught here too.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let catalog: string[];
let adminRoleId: string;
let productionRoleId: string;
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];
const createdClientIds: string[] = [];

interface Probe {
  readonly status: number;
  readonly tenant?: { agencyId: string; isOwner: boolean; roleKey: string | null; permissions: string[] };
}

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

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

const addMembership = async (agencyId: string, userId: string, roleId: string, status: 'active' | 'removed' = 'active'): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status });
};

const addClientMembership = async (agencyId: string, userId: string): Promise<void> => {
  const id = randomUUID();
  createdClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: 'Guard Client', status: 'active' });
  await owner.knex('client_memberships').insert({ client_id: id, user_id: userId, status: 'active' });
};

const customRole = async (agencyId: string, key: string, permissionKeys: readonly string[]): Promise<string> => {
  const id = randomUUID();
  createdRoleIds.push(id);
  await owner.knex('roles').insert({ id, agency_id: agencyId, key, name: key, is_system: false });
  await owner.knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: id, permission_key })));
  return id;
};

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const probe = async (cookie: string, agencyId: string): Promise<Probe> => {
  const response = await app.app.inject({ method: 'GET', url: `/__test/agencies/${agencyId}/tenant`, headers: { ...origin, cookie } });
  return response.statusCode === 200 ? { status: 200, tenant: response.json() } : { status: response.statusCode };
};

/** What RLS would answer for this person and key: the function every policy calls. */
const rlsHolds = (userId: string, agencyId: string, permission: string): Promise<boolean> =>
  withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId }), async (transaction) => {
    const result = await raw<{ rows: readonly { held: boolean }[] }>(transaction, 'select app_private.has_agency_permission(?::uuid, ?) as held', [agencyId, permission]);
    return result.rows[0]?.held === true;
  });

/** The guard's set, checked against RLS for every key of the catalog. */
const expectGuardAgreesWithRls = async (userId: string, agencyId: string, permissions: readonly string[]): Promise<void> => {
  for (const key of catalog) {
    expect(await rlsHolds(userId, agencyId, key), key).toBe(permissions.includes(key));
  }
};

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp({
    registerExtraRoutes: (fastifyApp, guards) => {
      fastifyApp.get('/__test/agencies/:agencyId/tenant', { preHandler: [guards.requireSession, guards.requireAgencyAccess] }, async (request) => ({
        agencyId: request.tenant?.agencyId,
        isOwner: request.tenant?.isOwner,
        roleKey: request.tenant?.roleKey,
        permissions: [...(request.tenant?.permissions ?? [])].sort()
      }));
    }
  });
  catalog = (await owner.knex('permissions').orderBy('key').select('key')).map((row) => row.key as string);
  const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'production']).select('id', 'key');
  adminRoleId = roles.find((role) => role.key === 'admin')?.id;
  productionRoleId = roles.find((role) => role.key === 'production')?.id;
  if (adminRoleId === undefined || productionRoleId === undefined) throw new Error('System role seeds are missing.');
});

afterAll(async () => {
  await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
  await owner.knex('client_memberships').whereIn('client_id', createdClientIds).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
  await owner.knex('roles').whereIn('id', createdRoleIds).delete();
  await owner.knex('clients').whereIn('id', createdClientIds).delete();
  await owner.knex('agencies').whereIn('id', createdAgencyIds).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', createdAgencyIds).delete();
  await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
  await app.close();
  await owner.close();
});

describe('requireAgencyAccess builds request.tenant from the one resolution (issue #189)', () => {
  it('an owner without a membership row: owner, no role key, the whole catalog', async () => {
    const user = await makeUser('guard-owner-bare');
    const agency = await createAgency('Guard Owner Bare', user.id);

    const result = await probe(await loginCookie(user), agency);

    expect(result.status).toBe(200);
    expect(result.tenant).toEqual({ agencyId: agency, isOwner: true, roleKey: null, permissions: catalog });
    await expectGuardAgreesWithRls(user.id, agency, result.tenant?.permissions ?? []);
  });

  it('an owner with a membership: the role key is the membership\'s, the permissions are still the whole catalog', async () => {
    const user = await makeUser('guard-owner-member');
    const agency = await createAgency('Guard Owner Member', user.id);
    await addMembership(agency, user.id, productionRoleId);

    const result = await probe(await loginCookie(user), agency);

    expect(result.tenant).toEqual({ agencyId: agency, isOwner: true, roleKey: 'production', permissions: catalog });
    await expectGuardAgreesWithRls(user.id, agency, result.tenant?.permissions ?? []);
  });

  it('the Admin preset holds every key except the two only the owner holds', async () => {
    const user = await makeUser('guard-admin');
    const agency = await createAgency('Guard Admin', null);
    await addMembership(agency, user.id, adminRoleId);

    const result = await probe(await loginCookie(user), agency);

    expect(result.tenant).toEqual({
      agencyId: agency,
      isOwner: false,
      roleKey: 'admin',
      permissions: catalog.filter((key) => key !== 'colaborador.atribuir_admin' && key !== 'assinatura.gerenciar')
    });
    await expectGuardAgreesWithRls(user.id, agency, result.tenant?.permissions ?? []);
  });

  it('a custom role of two keys holds exactly those two', async () => {
    const user = await makeUser('guard-custom');
    const agency = await createAgency('Guard Custom', null);
    await addMembership(agency, user.id, await customRole(agency, 'two-keys', ['midia.enviar', 'convite.reenviar']));

    const result = await probe(await loginCookie(user), agency);

    expect(result.tenant).toEqual({ agencyId: agency, isOwner: false, roleKey: 'two-keys', permissions: ['convite.reenviar', 'midia.enviar'] });
    await expectGuardAgreesWithRls(user.id, agency, result.tenant?.permissions ?? []);
  });

  it('a membership pointing at another agency\'s role holds nothing and has no role key, though the person belongs to that agency too', async () => {
    const user = await makeUser('guard-foreign-role');
    const home = await createAgency('Guard Foreign Home', null);
    const source = await createAgency('Guard Foreign Source', null);
    const foreignRoleId = await customRole(source, 'bigrole', ['cliente.operar', 'colaborador.convidar']);
    // The person belongs to BOTH agencies, so `roles_select` shows them the role: only the scope clause keeps it out of
    // the home agency (security review of #186). Without the membership in the source, RLS alone would hide the role.
    await addMembership(source, user.id, foreignRoleId);
    await addMembership(home, user.id, foreignRoleId);
    const cookie = await loginCookie(user);

    const atHome = await probe(cookie, home);
    expect(atHome.tenant).toEqual({ agencyId: home, isOwner: false, roleKey: null, permissions: [] });
    await expectGuardAgreesWithRls(user.id, home, atHome.tenant?.permissions ?? []);

    const atSource = await probe(cookie, source);
    expect(atSource.tenant).toEqual({ agencyId: source, isOwner: false, roleKey: 'bigrole', permissions: ['cliente.operar', 'colaborador.convidar'] });
    await expectGuardAgreesWithRls(user.id, source, atSource.tenant?.permissions ?? []);
  });

  it('a removed membership and a suspended agency are the same 404 as an agency that does not exist', async () => {
    const removed = await makeUser('guard-removed');
    const agency = await createAgency('Guard Removed', null);
    await addMembership(agency, removed.id, adminRoleId, 'removed');
    await addMembership(await createAgency('Guard Removed Other', null), removed.id, adminRoleId);
    expect((await probe(await loginCookie(removed), agency)).status).toBe(404);

    const ownerOfSuspended = await makeUser('guard-suspended');
    const suspended = await createAgency('Guard Suspended', ownerOfSuspended.id, 'suspended');
    // Login needs one valid context, so the person also belongs to an agency that is active.
    await addMembership(await createAgency('Guard Suspended Other', null), ownerOfSuspended.id, adminRoleId);
    const cookie = await loginCookie(ownerOfSuspended);
    expect((await probe(cookie, suspended)).status).toBe(404);
    expect((await probe(cookie, randomUUID())).status).toBe(404);
  });

  // RLS already hides an agency from a person whose only tie to it was the removed membership, so the 404 above does
  // not prove the guard's own `membership.status = 'active'`. These two people still SEE the agency (the owner by
  // ownership, the client user by the portal policy) and their own removed row, which is the only place the filter
  // is observable.
  it('a removed membership is not read for an owner: the Owner keeps the catalog but no role key', async () => {
    const user = await makeUser('guard-owner-removed');
    const agency = await createAgency('Guard Owner Removed', user.id);
    await addMembership(agency, user.id, adminRoleId, 'removed');

    const result = await probe(await loginCookie(user), agency);

    expect(result.status).toBe(200);
    expect(result.tenant).toEqual({ agencyId: agency, isOwner: true, roleKey: null, permissions: catalog });
  });

  it('a removed collaborator who is still a client user of the agency gets the same 404, not the workspace', async () => {
    const user = await makeUser('guard-removed-client');
    const agency = await createAgency('Guard Removed Client', null);
    await addMembership(agency, user.id, adminRoleId, 'removed');
    await addClientMembership(agency, user.id);

    expect((await probe(await loginCookie(user), agency)).status).toBe(404);
  });
});
