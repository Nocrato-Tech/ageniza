import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '@ageniza/database';

import {
  APPLICATION_DATABASE_URL,
  buildTestApp,
  OWNER_DATABASE_URL,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp
} from '../modules/auth/test-support/harness.js';
import { runSeedDemo, SEED_FLAG, type SeedDemoResult } from './seed-demo.js';

// Issue #183 acceptance tests. Runs the real command twice against the migrated local database and
// then signs every printed profile in through the real API, so a password hash that does not match
// Better Auth or a membership created outside the application path fails here.
const origin = { origin: TEST_APP_PUBLIC_URL };
const silentStdout = { write: () => undefined };

let app: TestApp;
let owner: DatabaseClient;
let first: SeedDemoResult;
let second: SeedDemoResult;

// Counts run through the migration owner: most of these tables are behind RLS, and an
// unauthenticated application connection would count zero rows instead of the seed's.
const count = async (query: string, bindings: readonly unknown[]): Promise<number> => {
  const result = await owner.knex.raw<{ rows: { total: string }[] }>(query, Array.from(bindings));
  return Number(result.rows[0]?.total ?? -1);
};

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (email: string, password: string): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });
  expect(response.statusCode, `login for ${email}`).toBe(200);
  return sessionCookieHeader(response.cookies);
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

const roleKeyFor = async (agencyId: string, userId: string): Promise<string | undefined> => {
  const row = await owner.knex('agency_memberships')
    .join('roles', 'roles.id', 'agency_memberships.role_id')
    .where({ 'agency_memberships.agency_id': agencyId, 'agency_memberships.user_id': userId, 'agency_memberships.status': 'active' })
    .first('roles.key');
  return row?.key as string | undefined;
};

const userIdFor = async (email: string): Promise<string> => {
  const row = await owner.knex('auth.user').where({ email }).first('id');
  if (row === undefined) throw new Error(`Seed user not found: ${email}`);
  return row.id as string;
};

interface ContextJson {
  readonly type: 'agency' | 'client';
  readonly agencyId?: string;
  readonly clientId?: string;
  readonly roleKey?: string;
  readonly isOwner?: boolean;
}

const contextsFor = async (cookie: string): Promise<ContextJson[]> => {
  const response = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<{ contexts: ContextJson[] }>().contexts;
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

const expectSamePermissions = (verdicts: ReadonlyMap<string, boolean>, expected: readonly string[]): void => {
  const allowed = [...verdicts.entries()].filter(([, value]) => value).map(([key]) => key).sort();
  expect(allowed).toEqual([...expected].sort());
};

describe('seed:demo (issue #183)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp();
    const env = { DATABASE_URL: APPLICATION_DATABASE_URL, MIGRATION_DATABASE_URL: OWNER_DATABASE_URL };
    first = await runSeedDemo({ env, argv: [SEED_FLAG], stdout: silentStdout });
    second = await runSeedDemo({ env, argv: [SEED_FLAG], stdout: silentStdout });
  });

  afterAll(async () => {
    const agencyIds = first.agencyIds;
    const userIds = first.userIds;
    const clientIds = first.clientIds;
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', userIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    await app.close();
    await owner.close();
  });

  it('running twice neither duplicates nor fails', async () => {
    expect(second.agencyIds).toEqual(first.agencyIds);
    expect(second.userIds).toEqual(first.userIds);
    expect(second.clientIds).toEqual(first.clientIds);
    expect(first.agencyIds).toHaveLength(2);
    expect(first.userIds).toHaveLength(9);
    expect(first.clientIds).toHaveLength(7);
    expect(first.pendingInvitations).toHaveLength(2);

    const agencyIds = first.agencyIds;
    const userIds = first.userIds;
    const clientIds = first.clientIds;
    expect(await count('select count(*)::text as total from public.agencies where id = any(?::uuid[])', [agencyIds])).toBe(2);
    expect(await count('select count(*)::text as total from auth."user" where id = any(?::uuid[])', [userIds])).toBe(9);
    expect(await count('select count(*)::text as total from public.clients where id = any(?::uuid[])', [clientIds])).toBe(7);
    expect(await count("select count(*)::text as total from public.agency_memberships where agency_id = any(?::uuid[]) and status = 'active'", [agencyIds])).toBe(8);
    expect(await count("select count(*)::text as total from public.client_memberships where client_id = any(?::uuid[]) and status = 'active'", [clientIds])).toBe(1);
    expect(await count('select count(*)::text as total from public.client_threads where client_id = any(?::uuid[])', [clientIds])).toBe(3);
    expect(await count('select count(*)::text as total from public.client_thread_comments where client_id = any(?::uuid[])', [clientIds])).toBe(4);
    expect(await count('select count(*)::text as total from public.client_personas where client_id = any(?::uuid[])', [clientIds])).toBe(3);
    expect(await count('select count(*)::text as total from public.client_brand_sections where client_id = any(?::uuid[])', [clientIds])).toBe(11);
    expect(await count("select count(*)::text as total from public.invitations where agency_id = any(?::uuid[]) and used_at is null and revoked_at is null", [agencyIds])).toBe(2);
    // Every membership came through the database function the application uses, not a raw insert.
    expect(await count("select count(*)::text as total from audit.events where agency_id = any(?::uuid[]) and action = 'invitation.accepted'", [agencyIds])).toBe(9);
  });

  it('every printed profile signs in and sees only what its role allows', async () => {
    const catalog = await catalogKeys();
    expect(second.profiles).toHaveLength(9);
    for (const profile of second.profiles) {
      const cookie = await loginCookie(profile.email, profile.password);
      const userId = await userIdFor(profile.email);
      const contexts = await contextsFor(cookie);

      if (profile.agencyId !== null) {
        const context = contexts.find((entry) => entry.type === 'agency' && entry.agencyId === profile.agencyId);
        expect(context, `agency context for ${profile.email}`).toBeDefined();
        const ownerRow = await owner.knex('agencies').where({ id: profile.agencyId }).first('owner_user_id');
        const verdicts = await permissionVerdicts(userId, profile.agencyId);
        if (ownerRow?.owner_user_id === userId) {
          expect(context!.isOwner).toBe(true);
          expectSamePermissions(verdicts, catalog);
        } else {
          const roleKey = await roleKeyFor(profile.agencyId, userId);
          expect(roleKey, `role for ${profile.email}`).toBeDefined();
          expect(context!.roleKey).toBe(roleKey);
          expectSamePermissions(verdicts, await presetKeys(roleKey!));
        }
      } else {
        // The portal profile has exactly its client context and no agency permission at all.
        expect(contexts).toEqual([expect.objectContaining({ type: 'client', clientId: profile.clientId })]);
        const client = await owner.knex('clients').where({ id: profile.clientId! }).first('agency_id');
        const verdicts = await permissionVerdicts(userId, client!.agency_id as string);
        expectSamePermissions(verdicts, []);
      }
    }
  });
});
