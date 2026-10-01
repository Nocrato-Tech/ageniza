import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction
} from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { loadAgencyMe } from './service.js';

// Issue #180 acceptance tests. Each `it` names the criterion it proves, and every permission
// assertion is compared against `app_private.has_agency_permission` -- the same function RLS uses
// -- so an endpoint that hardcodes, misses the owner branch or scopes the role wrongly goes red.
const origin = { origin: TEST_APP_PUBLIC_URL };

const SYSTEM_PRESETS = ['admin', 'account_manager', 'production', 'sales', 'finance'] as const;

interface AgencyMeJson {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly isOwner: boolean;
  readonly role: { key: string; name: string };
  readonly permissions: string[];
}

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

let app: TestApp;
const owner = ownerClient();

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdClientIds: string[] = [];
const createdRoleIds: string[] = [];

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

const createClient = async (agencyId: string, name: string): Promise<string> => {
  const id = randomUUID();
  createdClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name });
  return id;
};

const addClientMembership = async (clientId: string, userId: string): Promise<void> => {
  await owner.knex('client_memberships').insert({ client_id: clientId, user_id: userId });
};

const getAgencyMe = async (cookie: string | undefined, agencyId: string): Promise<{ status: number; body: AgencyMeJson & ApiErrorJson }> => {
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/me`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<AgencyMeJson & ApiErrorJson>() };
};

const catalogKeys = async (): Promise<string[]> => {
  const rows = await owner.knex('permissions').orderBy('key').select('key');
  return rows.map((row) => row.key as string);
};

const presetKeys = async (roleKey: string): Promise<string[]> => {
  const rows = await owner.knex('role_permissions')
    .join('roles', 'roles.id', 'role_permissions.role_id')
    .where('roles.key', roleKey)
    .whereNull('roles.agency_id')
    .orderBy('role_permissions.permission_key')
    .select('permission_key');
  return rows.map((row) => row.permission_key as string);
};

/** Every decision `app_private.has_agency_permission` makes for one user and agency, key by key. */
const permissionVerdicts = async (userId: string, agencyId: string): Promise<Map<string, boolean>> => {
  const claims = createVerifiedUserClaims({ userId });
  const result = await withAuthenticatedUserTransaction(app.database, claims, (transaction) =>
    raw<{ rows: readonly { key: string; allowed: boolean }[] }>(transaction, `
      select permission.key, app_private.has_agency_permission(?::uuid, permission.key) as allowed
      from public.permissions as permission
      order by permission.key
    `, [agencyId])
  );
  return new Map(result.rows.map((row) => [row.key, row.allowed === true]));
};

const expectEquivalentToRls = async (userId: string, agencyId: string, response: AgencyMeJson): Promise<void> => {
  const verdicts = await permissionVerdicts(userId, agencyId);
  const keys = await catalogKeys();
  expect([...verdicts.keys()]).toEqual(keys);
  for (const key of keys) {
    expect({ key, allowedByEndpoint: response.permissions.includes(key) })
      .toEqual({ key, allowedByEndpoint: verdicts.get(key) });
  }
};

describe('agencies module (issue #180)', () => {
  let presetRoleIds: Record<(typeof SYSTEM_PRESETS)[number], string>;

  beforeAll(async () => {
    app = await buildTestApp();
    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', [...SYSTEM_PRESETS]).select('id', 'key');
    presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<(typeof SYSTEM_PRESETS)[number], string>;
    for (const preset of SYSTEM_PRESETS) {
      if (presetRoleIds[preset] === undefined) throw new Error(`System role seed is missing: ${preset}`);
    }
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = [...new Set(createdClientIds)];
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('#180: the Owner receives the whole catalog, including the key no preset has', async () => {
    const user = await makeUser('agency-me-owner');
    const agency = await createAgency('Agency Me Owner', user.id);
    await addAgencyMembership(agency, user.id, presetRoleIds.admin);
    const cookie = await loginCookie(user);

    const response = await getAgencyMe(cookie, agency);
    expect(response.status).toBe(200);

    const keys = await catalogKeys();
    expect(keys).toContain('colaborador.atribuir_admin');
    // The owner criterion is only meaningful while no preset grants that key.
    const presetRows = await owner.knex('role_permissions').where({ permission_key: 'colaborador.atribuir_admin' });
    expect(presetRows).toHaveLength(0);

    expect(response.body.permissions).toEqual(keys);
    expect(response.body).toMatchObject({ agencyId: agency, isOwner: true, role: { key: 'admin' } });
    await expectEquivalentToRls(user.id, agency, response.body);
  });

  it('#180: an Owner by ownership and without any membership still receives the whole catalog', async () => {
    const user = await makeUser('agency-me-owner-legacy');
    const agency = await createAgency('Agency Me Legacy Owner', user.id);
    const cookie = await loginCookie(user);

    const response = await getAgencyMe(cookie, agency);
    expect(response.status).toBe(200);
    // A role-only implementation would return an empty list here.
    expect(response.body.permissions).toEqual(await catalogKeys());
    expect(response.body.isOwner).toBe(true);
    // The `admin` fallback label belongs to the owner without a membership role, and to nobody else.
    expect(response.body.role).toEqual({ key: 'admin', name: 'Admin' });
    await expectEquivalentToRls(user.id, agency, response.body);
  });

  it('#180: each of the five presets receives exactly its role_permissions keys, equivalent to has_agency_permission', async () => {
    for (const preset of SYSTEM_PRESETS) {
      const user = await makeUser(`agency-me-${preset}`);
      const agency = await createAgency(`Agency Me ${preset}`, null);
      await addAgencyMembership(agency, user.id, presetRoleIds[preset]);
      const cookie = await loginCookie(user);

      const response = await getAgencyMe(cookie, agency);
      expect(response.status).toBe(200);
      expect(response.body.permissions).toEqual(await presetKeys(preset));
      expect(response.body.isOwner).toBe(false);
      expect(response.body.role.key).toBe(preset);
      await expectEquivalentToRls(user.id, agency, response.body);
    }
  });

  it('#180: a same-agency custom role grants its keys, and a membership pointing at another agency role grants nothing', async () => {
    const sameAgencyUser = await makeUser('agency-me-custom-role');
    const sameAgency = await createAgency('Agency Me Custom Role', null);
    const sameAgencyRoleId = randomUUID();
    createdRoleIds.push(sameAgencyRoleId);
    await owner.knex('roles').insert({ id: sameAgencyRoleId, agency_id: sameAgency, key: 'custom', name: 'Custom', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: sameAgencyRoleId, permission_key: 'cliente.visualizar' });
    await addAgencyMembership(sameAgency, sameAgencyUser.id, sameAgencyRoleId);
    const sameAgencyCookie = await loginCookie(sameAgencyUser);

    const granted = await getAgencyMe(sameAgencyCookie, sameAgency);
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toEqual(['cliente.visualizar']);
    expect(granted.body.role.key).toBe('custom');
    await expectEquivalentToRls(sameAgencyUser.id, sameAgency, granted.body);

    const foreignUser = await makeUser('agency-me-foreign-role');
    const homeAgency = await createAgency('Agency Me Foreign Role Home', null);
    const roleSourceAgency = await createAgency('Agency Me Foreign Role Source', null);
    const foreignRoleId = randomUUID();
    createdRoleIds.push(foreignRoleId);
    await owner.knex('roles').insert({ id: foreignRoleId, agency_id: roleSourceAgency, key: 'bigrole', name: 'Big Role', is_system: false });
    await owner.knex('role_permissions').insert([
      { role_id: foreignRoleId, permission_key: 'cliente.operar' },
      { role_id: foreignRoleId, permission_key: 'colaborador.convidar' }
    ]);
    // The person belongs to BOTH agencies. That is what makes this scenario prove the role scope:
    // `roles_select` (`agency_id is null or is_agency_member(agency_id)`) then shows the role, and
    // only the `role.agency_id is null or role.agency_id = agency.id` filter keeps it out of the
    // home agency's list. Without the membership in the source agency, RLS alone would hide the
    // role and the filter would survive a mutation unnoticed (security review of PR #186).
    await addAgencyMembership(roleSourceAgency, foreignUser.id, foreignRoleId);
    await addAgencyMembership(homeAgency, foreignUser.id, foreignRoleId);
    const foreignCookie = await loginCookie(foreignUser);

    // Where the role is in scope, it grants its keys: the same session can see them in A.
    const source = await getAgencyMe(foreignCookie, roleSourceAgency);
    expect(source.status).toBe(200);
    expect([...source.body.permissions].sort()).toEqual(['cliente.operar', 'colaborador.convidar']);
    expect(source.body.role).toEqual({ key: 'bigrole', name: 'Big Role' });
    await expectEquivalentToRls(foreignUser.id, roleSourceAgency, source.body);

    // The membership is active in `homeAgency`, so the guard lets the caller in; the role belongs
    // to another agency, so -- exactly like has_agency_permission -- it grants nothing, and the
    // label does not borrow "Admin".
    const foreign = await getAgencyMe(foreignCookie, homeAgency);
    expect(foreign.status).toBe(200);
    expect(foreign.body.permissions).toEqual([]);
    expect(foreign.body.role).toEqual({ key: 'sem-papel', name: 'Sem papel' });
    await expectEquivalentToRls(foreignUser.id, homeAgency, foreign.body);

    // The guard carries the same scope filter (tenancy/guards.ts), and `requirePermission` is what
    // consumes it. The invitations list needs `colaborador.convidar`: it must pass in A and be
    // denied in B, where the foreign role must not leak into `request.tenant.permissions`.
    const sourceInvitations = await app.app.inject({ method: 'GET', url: `/agencies/${roleSourceAgency}/invitations`, headers: { ...origin, cookie: foreignCookie } });
    expect(sourceInvitations.statusCode).toBe(200);
    const homeInvitations = await app.app.inject({ method: 'GET', url: `/agencies/${homeAgency}/invitations`, headers: { ...origin, cookie: foreignCookie } });
    expect(homeInvitations.statusCode).toBe(403);
    expect(homeInvitations.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('#180: nonexistent, suspended, other person and removed membership all answer the same 404', async () => {
    const member = await makeUser('agency-me-404-member');
    const ownAgency = await createAgency('Agency Me 404 Own', member.id);
    const cookie = await loginCookie(member);

    const nonexistent = await getAgencyMe(cookie, randomUUID());

    const otherOwner = await makeUser('agency-me-404-other-owner');
    const otherAgency = await createAgency('Agency Me 404 Other', otherOwner.id);
    const otherPersons = await getAgencyMe(cookie, otherAgency);

    const suspendedAgency = await createAgency('Agency Me 404 Suspended', null, 'suspended');
    await addAgencyMembership(suspendedAgency, member.id, presetRoleIds.production);
    const suspended = await getAgencyMe(cookie, suspendedAgency);

    const removedAgency = await createAgency('Agency Me 404 Removed', null);
    await addAgencyMembership(removedAgency, member.id, presetRoleIds.production, 'removed');
    const removed = await getAgencyMe(cookie, removedAgency);

    for (const response of [nonexistent, otherPersons, suspended, removed]) {
      expect(response.status).toBe(404);
    }
    // The four cases must be indistinguishable, not merely all 404.
    const [first, ...rest] = [nonexistent, otherPersons, suspended, removed];
    for (const response of rest) {
      expect(response.body.error).toEqual(first!.body.error);
    }
    expect(first!.body.error).toEqual({ code: 'NOT_FOUND', message: 'Agency not found.' });

    // Positive control: the same session still reaches the agency it can access.
    const own = await getAgencyMe(cookie, ownAgency);
    expect(own.status).toBe(200);
  });

  it('#180: a client-portal-only person receives 404 and never an agency permission set', async () => {
    const user = await makeUser('agency-me-portal-only');
    const agencyOwner = await makeUser('agency-me-portal-agency-owner');
    const agency = await createAgency('Agency Me Portal Only', agencyOwner.id);
    const client = await createClient(agency, 'Client Of Portal User');
    await addClientMembership(client, user.id);
    const cookie = await loginCookie(user);

    const response = await getAgencyMe(cookie, agency);
    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({ code: 'NOT_FOUND', message: 'Agency not found.' });
  });

  it('#180: without a session the route answers 401', async () => {
    const response = await getAgencyMe(undefined, randomUUID());
    expect(response.status).toBe(401);
  });

  it('#180: loadAgencyMe itself repeats the access conditions, not only RLS and the guard', async () => {
    // The route only calls this service after the guard, and RLS also hides a suspended agency or
    // a removed membership from the application role -- so end to end, a mutation dropping
    // `agency.status` or `membership.status` from the query survives. Running the same service on
    // the migration owner (RLS bypassed) is what holds that repetition to its word: these are the
    // conditions that would matter if a policy ever changed. The actor still has to be bound in
    // the transaction, because `loadAgencyMe` reads it through `app_private.current_user_id()`.
    const asOwner = <TResult>(userId: string, work: (transaction: Parameters<Parameters<typeof owner.transaction>[0]>[0]) => Promise<TResult>): Promise<TResult> =>
      owner.transaction(async (transaction) => {
        await raw(transaction, 'select app_private.bind_actor(?::uuid)', [userId]);
        return work(transaction);
      });

    const user = await makeUser('agency-me-direct');
    const agency = await createAgency('Agency Me Direct', null);
    await addAgencyMembership(agency, user.id, presetRoleIds.production);

    const active = await asOwner(user.id, (transaction) => loadAgencyMe(transaction, agency));
    expect(active).toBeDefined();
    expect(active!.permissions).toEqual(await presetKeys('production'));

    await setAgencyStatus(agency, 'suspended');
    const suspended = await asOwner(user.id, (transaction) => loadAgencyMe(transaction, agency));
    expect(suspended).toBeUndefined();

    await setAgencyStatus(agency, 'active');
    await setMembershipStatus(agency, user.id, 'removed');
    const removed = await asOwner(user.id, (transaction) => loadAgencyMe(transaction, agency));
    expect(removed).toBeUndefined();
  });
});
