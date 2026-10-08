import { randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #98. `POST …/remove` and `POST …/reactivate`, and the filter that reveals removed links.
// Authorization is exercised with custom roles holding exactly one permission (the Admin preset has
// all of them and hides a guard that checks the wrong key), the isolation cases use a person with a
// link in two agencies (the one case where the RLS shows both rows), and every answer is confirmed
// against the row in the database: a policy that filters a row answers "zero rows" in silence.
const origin = { origin: TEST_APP_PUBLIC_URL };
const SYSTEM_PRESETS = ['admin', 'account_manager', 'production', 'sales', 'finance'] as const;
type SystemPreset = (typeof SYSTEM_PRESETS)[number];

const GENERIC_FORBIDDEN_MESSAGE = 'You do not have permission to perform this action.';
const ADMIN_GRANT_MESSAGE = 'Só o Owner da agência pode conceder o papel de Admin.';
const OWNER_REMOVAL_MESSAGE = 'O Owner da agência não pode ser removido.';
const SELF_REMOVAL_MESSAGE = 'Ninguém remove a si mesmo.';
const OWNER_ROLE_MESSAGE = 'O papel do Owner da agência não pode ser alterado.';

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

interface CollaboratorJson {
  readonly membershipId: string;
  readonly name: string;
  readonly jobTitle: string | null;
  readonly role: { key: string; name: string };
  readonly isOwner: boolean;
  readonly isSelf: boolean;
  readonly status: 'active' | 'removed';
}

interface ListJson {
  readonly data: CollaboratorJson[];
  readonly meta: { totalItems: number };
}

interface MembershipRow {
  readonly id: string;
  readonly role_id: string;
  readonly job_title: string | null;
  readonly status: string;
  readonly updated_at: Date;
}

type LockerTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

let app: TestApp;
const owner = ownerClient();
let presetRoleIds: Record<SystemPreset, string>;

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

interface Fixture {
  readonly agencyId: string;
  readonly ownerUser: TestUserFixture;
  readonly ownerCookie: string;
  readonly ownerMembershipId: string;
}

interface Member {
  readonly user: TestUserFixture;
  readonly membershipId: string;
  readonly cookie: string;
}

const insertBareUser = async (label: string): Promise<TestUserFixture> => {
  const id = randomUUID();
  const email = `${label}.${id.slice(0, 8)}@collab-removal.test`;
  await app.pool.query('insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)', [id, `Pessoa ${label}`, email]);
  return { id, email, password: '', name: `Pessoa ${label}` };
};

const createCustomRole = async (agencyId: string, permissionKeys: readonly string[]): Promise<string> => {
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  if (permissionKeys.length > 0) {
    await owner.knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: roleId, permission_key })));
  }
  return roleId;
};

// `ownerMembership: false` is the Owner who is only `agencies.owner_user_id`, with no link and no
// role: the case where a check that reads the role instead of ownership would fail.
const createAgency = async (label: string, options: { ownerMembership?: boolean } = {}): Promise<Fixture> => {
  const ownerUser = await insertTestUser(app.pool, app.auth, { emailLabel: `${label}-owner`, name: 'Dona da Agência' });
  createdUserIds.push(ownerUser.id);
  const agencyId = randomUUID();
  createdAgencyIds.push(agencyId);
  await owner.knex('agencies').insert({ id: agencyId, name: `Colab Removal ${label}`, owner_user_id: ownerUser.id, status: 'active' });
  const ownerMembershipId = options.ownerMembership === false
    ? ''
    : (await owner.knex('agency_memberships')
      .insert({ agency_id: agencyId, user_id: ownerUser.id, role_id: presetRoleIds.admin, job_title: 'Dona', status: 'active' })
      .returning('id'))[0].id as string;
  return { agencyId, ownerUser, ownerCookie: await loginCookie(ownerUser), ownerMembershipId };
};

// Hashing a password and logging in is what makes this suite slow: only people who send a request
// get a credential, the people who are merely changed are bare user rows.
const addMember = async (
  agencyId: string,
  label: string,
  roleId: string,
  options: { jobTitle?: string | null; status?: 'active' | 'removed'; acts?: boolean } = {}
): Promise<Member> => {
  const acts = options.acts ?? true;
  const user = acts
    ? await insertTestUser(app.pool, app.auth, { emailLabel: label, name: `Pessoa ${label}` })
    : await insertBareUser(label);
  createdUserIds.push(user.id);
  const [membership] = await owner.knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: user.id, role_id: roleId, job_title: options.jobTitle ?? null, status: options.status ?? 'active' })
    .returning('id');
  return { user, membershipId: membership.id as string, cookie: acts ? await loginCookie(user) : '' };
};

/** Gives a person who already has a credential a second link, in another agency. */
const linkExistingUser = async (agencyId: string, member: Member, roleId: string): Promise<string> => {
  const [membership] = await owner.knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: member.user.id, role_id: roleId, status: 'active' })
    .returning('id');
  return membership.id as string;
};

const membershipRow = async (membershipId: string): Promise<MembershipRow> =>
  await owner.knex('agency_memberships').where({ id: membershipId }).first('id', 'role_id', 'job_title', 'status', 'updated_at') as MembershipRow;

const sessionCount = async (userId: string): Promise<number> =>
  Number((await owner.knex('auth.session').where({ userId }).count<Array<{ count: string }>>('id as count'))[0]?.count ?? 0);

/**
 * A trigger that makes the DELETE of one person's sessions fail with the given SQLSTATE, as a deadlock or
 * a broken connection would: the proof that ending the sessions and removing the link are one transaction.
 */
const withFailingSessionDelete = async (userId: string, errcode: string, run: () => Promise<void>): Promise<void> => {
  const name = `zz_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await owner.knex.raw(`
    create function public.${name}() returns trigger language plpgsql as $$
    begin
      if old."userId" = '${userId}'::uuid then raise exception 'sessions of this person cannot be deleted' using errcode = '${errcode}'; end if;
      return old;
    end $$;
    create trigger ${name} before delete on auth."session" for each row execute function public.${name}();
  `);
  try {
    await run();
  } finally {
    await owner.knex.raw(`drop trigger if exists ${name} on auth."session"; drop function if exists public.${name}();`);
  }
};

const membershipCount = async (agencyId: string): Promise<number> => {
  const row = await owner.knex('agency_memberships').where({ agency_id: agencyId }).count<Array<{ count: string }>>('id as count');
  return Number(row[0]?.count);
};

const post = async (
  cookie: string | undefined,
  agencyId: string,
  membershipId: string,
  action: 'remove' | 'reactivate',
  payload?: unknown
): Promise<{ status: number; body: CollaboratorJson & ApiErrorJson }> => {
  const response = await app.app.inject({
    method: 'POST',
    url: `/agencies/${agencyId}/collaborators/${membershipId}/${action}`,
    headers: cookie === undefined ? origin : { ...origin, cookie },
    ...(payload === undefined ? {} : { payload: payload as object })
  });
  return { status: response.statusCode, body: response.json<CollaboratorJson & ApiErrorJson>() };
};

const remove = (cookie: string | undefined, agencyId: string, membershipId: string) => post(cookie, agencyId, membershipId, 'remove');
const reactivate = (cookie: string | undefined, agencyId: string, membershipId: string, payload: unknown) =>
  post(cookie, agencyId, membershipId, 'reactivate', payload);

const patchTitle = async (cookie: string, agencyId: string, membershipId: string, jobTitle: string) => {
  const response = await app.app.inject({
    method: 'PATCH',
    url: `/agencies/${agencyId}/collaborators/${membershipId}`,
    headers: { ...origin, cookie },
    payload: { jobTitle }
  });
  return { status: response.statusCode, body: response.json<CollaboratorJson & ApiErrorJson>() };
};

const list = async (cookie: string, agencyId: string, query: Record<string, string> = {}) => {
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/collaborators${Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query).toString()}`}`,
    headers: { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<ListJson & ApiErrorJson>() };
};

const detail = async (cookie: string, agencyId: string, membershipId: string) => {
  const response = await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/collaborators/${membershipId}`, headers: { ...origin, cookie } });
  return { status: response.statusCode, body: response.json<CollaboratorJson & ApiErrorJson>() };
};

const expectRefused = (response: { status: number; body: ApiErrorJson }, status: number, code: string, message?: string): void => {
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  if (message !== undefined) expect(response.body.error.message).toBe(message);
};

const waitUntilQueuedBehindLock = async (count: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // The routes lock with `for update of membership`; a request counted here has passed its guards
    // and is waiting on the row, which is the state a race needs.
    const waiting = await owner.knex.raw<{ rows: Array<{ count: string }> }>(
      "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for update of membership%'"
    );
    if (Number(waiting.rows[0]?.count) >= count) return;
    if (Date.now() > deadline) throw new Error(`${count} request(s) never queued behind the lock.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Two real transactions: a third one holds the row, the requests start and queue behind it, the
 * holder does `whileHeld` (still before releasing) and commits, and only then do the requests go on.
 * The holder asserts it locked exactly one row: without that, a lock that matched nothing would
 * make every race test a green void.
 */
const settleBehindLock = async <T>(
  membershipId: string,
  start: () => Array<Promise<T>>,
  whileHeld: (locker: LockerTransaction) => Promise<void> = async () => undefined
): Promise<T[]> => {
  const locker = await owner.knex.transaction();
  let pending: Array<Promise<T>> = [];
  try {
    const locked = await locker.raw<{ rows: unknown[] }>('select id from public.agency_memberships where id = ?::uuid for update', [membershipId]);
    expect(locked.rows).toHaveLength(1);
    pending = start();
    await waitUntilQueuedBehindLock(pending.length);
    await whileHeld(locker);
    await locker.commit();
  } catch (error) {
    await locker.rollback().catch(() => undefined);
    await Promise.allSettled(pending);
    throw error;
  }
  return Promise.all(pending);
};

const revoke = (roleId: string, permissionKey: string) => async (locker: LockerTransaction): Promise<void> => {
  const deleted = await locker.raw<{ rowCount: number }>('delete from public.role_permissions where role_id = ?::uuid and permission_key = ?', [roleId, permissionKey]);
  expect(deleted.rowCount).toBe(1);
};

// The per-IP login window (100 per 15 minutes) is bound to the route, not injectable, and this suite
// logs in more people than that: each block gets an app of its own, which starts the window over.
let appBuilt = false;
const freshApp = async (): Promise<void> => {
  if (appBuilt) await app.close();
  app = await buildTestApp();
  appBuilt = true;
  const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', [...SYSTEM_PRESETS]).select('id', 'key');
  presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<SystemPreset, string>;
};

afterAll(async () => {
  const agencyIds = [...new Set(createdAgencyIds)];
  await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
  await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
  await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
  await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
  await owner.knex('roles').whereIn('id', createdRoleIds).delete();
  await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', agencyIds).delete();
  await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
  await app.close();
  await owner.close();
});

describe('POST /agencies/:agencyId/collaborators/:membershipId/remove (issue #98)', { timeout: 60_000 }, () => {
  beforeAll(freshApp);

  it('an Admin removes another person: 200, the row stays with the same id, and nothing else about it changes', async () => {
    const fx = await createAgency('remove');
    const admin = await addMember(fx.agencyId, 'remove-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'remove-target', presetRoleIds.sales, { jobTitle: 'Vendedor', acts: false });
    const before = await membershipRow(target.membershipId);
    const rowsBefore = await membershipCount(fx.agencyId);

    const response = await remove(admin.cookie, fx.agencyId, target.membershipId);

    expect(response.status).toBe(200);
    // Nobody removes themselves (below), so the item this route answers is always someone else's link: `isSelf` false (issue #286).
    expect(response.body).toMatchObject({ membershipId: target.membershipId, status: 'removed', jobTitle: 'Vendedor', role: { key: 'sales' }, isSelf: false });
    const after = await membershipRow(target.membershipId);
    expect(after).toMatchObject({ id: target.membershipId, status: 'removed', role_id: presetRoleIds.sales, job_title: 'Vendedor' });
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(await membershipCount(fx.agencyId)).toBe(rowsBefore);
  });

  it('the Owner, who is only agencies.owner_user_id with no link and no role, removes a person', async () => {
    const fx = await createAgency('remove-ownerless', { ownerMembership: false });
    const target = await addMember(fx.agencyId, 'remove-ownerless-target', presetRoleIds.production, { acts: false });
    expect(await membershipCount(fx.agencyId)).toBe(1);

    const response = await remove(fx.ownerCookie, fx.agencyId, target.membershipId);

    expect(response.status).toBe(200);
    expect((await membershipRow(target.membershipId)).status).toBe('removed');
  });

  it('removing the last Admin is a legitimate state: the Owner still administers (decisions.md, 2026-09-24)', async () => {
    const fx = await createAgency('remove-last-admin');
    const onlyAdmin = await addMember(fx.agencyId, 'remove-last-admin-admin', presetRoleIds.admin, { acts: false });

    const response = await remove(fx.ownerCookie, fx.agencyId, onlyAdmin.membershipId);

    expect(response.status).toBe(200);
    expect((await membershipRow(onlyAdmin.membershipId)).status).toBe('removed');
    const stillAdministers = await list(fx.ownerCookie, fx.agencyId, { status: 'removed' });
    expect(stillAdministers.status).toBe(200);
  });

  it('is decided by colaborador.remover alone: a role with only that permission removes, one with any other single permission is refused', async () => {
    const fx = await createAgency('remove-perms');
    const allowedRole = await createCustomRole(fx.agencyId, ['colaborador.remover']);
    const allowed = await addMember(fx.agencyId, 'remove-perms-allowed', allowedRole);
    const refusedRoles = await Promise.all(
      ['colaborador.alterar_papel', 'colaborador.alterar_funcao', 'colaborador.visualizar', 'colaborador.atribuir_admin', 'colaborador.convidar']
        .map(async (permission) => ({ permission, member: await addMember(fx.agencyId, `remove-perms-${permission.split('.')[1]}`, await createCustomRole(fx.agencyId, [permission])) }))
    );
    const target = await addMember(fx.agencyId, 'remove-perms-target', presetRoleIds.production, { acts: false });

    for (const { permission, member } of refusedRoles) {
      const response = await remove(member.cookie, fx.agencyId, target.membershipId);
      expectRefused(response, 403, 'FORBIDDEN');
      expect((await membershipRow(target.membershipId)).status, permission).toBe('active');
    }

    const response = await remove(allowed.cookie, fx.agencyId, target.membershipId);
    expect(response.status).toBe(200);
    expect((await membershipRow(target.membershipId)).status).toBe('removed');
  });

  it('account_manager, production, sales and finance get 403 and nothing changes', async () => {
    const fx = await createAgency('remove-presets');
    const target = await addMember(fx.agencyId, 'remove-presets-target', presetRoleIds.production, { acts: false });
    for (const preset of ['account_manager', 'production', 'sales', 'finance'] as const) {
      const member = await addMember(fx.agencyId, `remove-presets-${preset}`, presetRoleIds[preset]);
      expectRefused(await remove(member.cookie, fx.agencyId, target.membershipId), 403, 'FORBIDDEN', GENERIC_FORBIDDEN_MESSAGE);
    }
    expect((await membershipRow(target.membershipId)).status).toBe('active');
  });

  it('refuses to remove the Owner, by an Admin and by a role that only removes, with the route\'s own message', async () => {
    const fx = await createAgency('remove-owner');
    const admin = await addMember(fx.agencyId, 'remove-owner-admin', presetRoleIds.admin);
    const remover = await addMember(fx.agencyId, 'remove-owner-remover', await createCustomRole(fx.agencyId, ['colaborador.remover']));

    for (const caller of [admin, remover]) {
      expectRefused(await remove(caller.cookie, fx.agencyId, fx.ownerMembershipId), 403, 'FORBIDDEN', OWNER_REMOVAL_MESSAGE);
    }
    // The Owner removing themselves is the same refusal, and still the Owner's.
    expectRefused(await remove(fx.ownerCookie, fx.agencyId, fx.ownerMembershipId), 403, 'FORBIDDEN', OWNER_REMOVAL_MESSAGE);
    expect(await membershipRow(fx.ownerMembershipId)).toMatchObject({ status: 'active', role_id: presetRoleIds.admin });
  });

  it('nobody removes themselves, not even an Admin, while removing a peer is allowed', async () => {
    const fx = await createAgency('remove-self');
    const admin = await addMember(fx.agencyId, 'remove-self-admin', presetRoleIds.admin);
    const peer = await addMember(fx.agencyId, 'remove-self-peer', presetRoleIds.admin, { acts: false });

    expectRefused(await remove(admin.cookie, fx.agencyId, admin.membershipId), 403, 'FORBIDDEN', SELF_REMOVAL_MESSAGE);
    expect((await membershipRow(admin.membershipId)).status).toBe('active');

    expect((await remove(admin.cookie, fx.agencyId, peer.membershipId)).status).toBe(200);
    expect((await membershipRow(peer.membershipId)).status).toBe('removed');
  });

  it('a person with a link in two agencies cannot remove the link of the other agency through this one', async () => {
    const home = await createAgency('remove-dual-home');
    const away = await createAgency('remove-dual-away');
    const traveller = await addMember(home.agencyId, 'remove-dual-traveller', presetRoleIds.admin);
    await linkExistingUser(away.agencyId, traveller, presetRoleIds.admin);
    const awayTarget = await addMember(away.agencyId, 'remove-dual-target', presetRoleIds.production, { acts: false });

    const visibleToTraveller = await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: traveller.user.id }), async (transaction) =>
      transaction('agency_memberships').where({ id: awayTarget.membershipId }).count<Array<{ count: string }>>('id as count')
    );
    expect(Number(visibleToTraveller[0]?.count)).toBe(1);

    expectRefused(await remove(traveller.cookie, home.agencyId, awayTarget.membershipId), 404, 'NOT_FOUND', 'Collaborator not found.');
    expect((await membershipRow(awayTarget.membershipId)).status).toBe('active');

    // The same person does reach it through the agency it belongs to.
    expect((await remove(traveller.cookie, away.agencyId, awayTarget.membershipId)).status).toBe(200);
    expect((await membershipRow(awayTarget.membershipId)).status).toBe('removed');
  });

  it('a nonexistent or malformed id is the same 404, and an agency the caller does not belong to is the agency 404', async () => {
    const fx = await createAgency('remove-404');
    const other = await createAgency('remove-404-other');
    const foreign = await addMember(other.agencyId, 'remove-404-foreign', presetRoleIds.production, { acts: false });

    expectRefused(await remove(fx.ownerCookie, fx.agencyId, randomUUID()), 404, 'NOT_FOUND', 'Collaborator not found.');
    expectRefused(await remove(fx.ownerCookie, fx.agencyId, 'not-a-uuid'), 404, 'NOT_FOUND', 'Collaborator not found.');
    expectRefused(await remove(fx.ownerCookie, fx.agencyId, foreign.membershipId), 404, 'NOT_FOUND', 'Collaborator not found.');
    expectRefused(await remove(fx.ownerCookie, other.agencyId, foreign.membershipId), 404, 'NOT_FOUND', 'Agency not found.');
    expect((await remove(undefined, fx.agencyId, foreign.membershipId)).status).toBe(401);
    expect((await membershipRow(foreign.membershipId)).status).toBe('active');
  });

  it('removing someone who is already removed is a 409 and changes nothing, not even updated_at', async () => {
    const fx = await createAgency('remove-twice');
    const target = await addMember(fx.agencyId, 'remove-twice-target', presetRoleIds.production, { acts: false });
    expect((await remove(fx.ownerCookie, fx.agencyId, target.membershipId)).status).toBe(200);
    const afterFirst = await membershipRow(target.membershipId);

    expectRefused(await remove(fx.ownerCookie, fx.agencyId, target.membershipId), 409, 'COLLABORATOR_ALREADY_REMOVED');

    expect(await membershipRow(target.membershipId)).toEqual(afterFirst);
  });

  it('the person is signed out of everything on the very next request, other agencies included, and signs in again with only the other agency (#411)', async () => {
    const home = await createAgency('remove-access-home');
    const away = await createAgency('remove-access-away');
    const person = await addMember(home.agencyId, 'remove-access-person', presetRoleIds.admin);
    await linkExistingUser(away.agencyId, person, presetRoleIds.production);
    const secondDevice = await loginCookie(person.user);
    const bystander = await addMember(away.agencyId, 'remove-access-bystander', presetRoleIds.admin);

    const before = await list(person.cookie, home.agencyId);
    expect(before.status).toBe(200);
    const contextsBefore = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie: person.cookie } });
    expect(contextsBefore.body).toContain(home.agencyId);
    expect(await sessionCount(person.user.id)).toBe(2);

    expect((await remove(home.ownerCookie, home.agencyId, person.membershipId)).status).toBe(200);

    // The sessions are gone from the database, not only refused: every cookie of the person is a 401, the
    // agency they still belong to included, because the session is global.
    expect(await sessionCount(person.user.id)).toBe(0);
    for (const cookie of [person.cookie, secondDevice]) {
      expectRefused(await list(cookie, home.agencyId), 401, 'UNAUTHENTICATED');
      expectRefused(await list(cookie, away.agencyId), 401, 'UNAUTHENTICATED');
      expect((await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie } })).statusCode).toBe(401);
    }
    // Whoever removed keeps their session, and so does anybody else.
    expect((await list(home.ownerCookie, home.agencyId)).status).toBe(200);
    expect(await sessionCount(home.ownerUser.id)).toBe(1);
    expect((await list(bystander.cookie, away.agencyId)).status).toBe(200);

    // They sign in again and choose the agency they still have.
    const again = await loginCookie(person.user);
    expectRefused(await list(again, home.agencyId), 404, 'NOT_FOUND', 'Agency not found.');
    const contextsAfter = await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie: again } });
    expect(contextsAfter.statusCode).toBe(200);
    expect(contextsAfter.body).not.toContain(home.agencyId);
    expect(contextsAfter.body).toContain(away.agencyId);
    expect((await list(again, away.agencyId)).status).toBe(200);
  });

  it('a session being refreshed at the moment of the removal is ended all the same: the delete waits for the row and then takes it (#411)', async () => {
    const fx = await createAgency('remove-refresh-race');
    const person = await addMember(fx.agencyId, 'remove-refresh-person', presetRoleIds.production);

    // Better Auth renews a session with an UPDATE of its row; a second transaction holds that row.
    const locker = await owner.knex.transaction();
    let removal: ReturnType<typeof remove> | undefined;
    try {
      const touched = await locker.raw<{ rowCount: number }>('update auth."session" set "updatedAt" = now() where "userId" = ?::uuid', [person.user.id]);
      expect(touched.rowCount).toBe(1);
      removal = remove(fx.ownerCookie, fx.agencyId, person.membershipId);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await owner.knex.raw<{ rows: Array<{ count: string }> }>(
          "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%delete from auth.\"session\"%'"
        );
        if (Number(waiting.rows[0]?.count) >= 1) break;
        if (Date.now() > deadline) throw new Error('The removal never queued behind the session row.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await locker.commit();
    } catch (error) {
      await locker.rollback().catch(() => undefined);
      await Promise.allSettled([removal]);
      throw error;
    }

    expect((await removal).status).toBe(200);
    expect(await sessionCount(person.user.id)).toBe(0);
    expectRefused(await list(person.cookie, fx.agencyId), 401, 'UNAUTHENTICATED');
  });

  it.each([['40P01', 409, 'TRY_AGAIN'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'ending the sessions is part of the removal: when it fails (%s) the link stays active, the sessions stay, and repeating works (#411)',
    async (errcode, status, code) => {
      const fx = await createAgency(`remove-atomic-${errcode.toLowerCase()}`);
      const person = await addMember(fx.agencyId, `remove-atomic-person-${errcode.toLowerCase()}`, presetRoleIds.production);
      const secondDevice = await loginCookie(person.user);
      const before = await membershipRow(person.membershipId);
      expect(await sessionCount(person.user.id)).toBe(2);

      await withFailingSessionDelete(person.user.id, errcode, async () => {
        const failed = await remove(fx.ownerCookie, fx.agencyId, person.membershipId);
        expect(failed.status).toBe(status);
        expect(failed.body.error.code).toBe(code);
      });

      // Nothing happened: not the removal, not one session, and the person still works with both cookies.
      expect(await membershipRow(person.membershipId)).toEqual(before);
      expect(await sessionCount(person.user.id)).toBe(2);
      for (const cookie of [person.cookie, secondDevice]) expect((await list(cookie, fx.agencyId)).status).toBe(200);

      expect((await remove(fx.ownerCookie, fx.agencyId, person.membershipId)).status).toBe(200);
      expect((await membershipRow(person.membershipId)).status).toBe('removed');
      expect(await sessionCount(person.user.id)).toBe(0);
    }
  );

  it('does not end any session when the removal is refused: the Owner, oneself, someone already removed, a person without the permission (#411)', async () => {
    const fx = await createAgency('remove-keeps-sessions');
    const admin = await addMember(fx.agencyId, 'remove-keeps-admin', presetRoleIds.admin);
    const peer = await addMember(fx.agencyId, 'remove-keeps-peer', presetRoleIds.production);
    const other = await createAgency('remove-keeps-other');
    const gone = await addMember(fx.agencyId, 'remove-keeps-gone', presetRoleIds.production);
    await linkExistingUser(other.agencyId, gone, presetRoleIds.production);
    const viewer = await addMember(fx.agencyId, 'remove-keeps-viewer', await createCustomRole(fx.agencyId, ['colaborador.visualizar']));
    expect((await remove(fx.ownerCookie, fx.agencyId, gone.membershipId)).status).toBe(200);
    expect(await sessionCount(gone.user.id)).toBe(0);
    const reopened = await loginCookie(gone.user);

    expectRefused(await remove(admin.cookie, fx.agencyId, fx.ownerMembershipId), 403, 'FORBIDDEN', OWNER_REMOVAL_MESSAGE);
    expectRefused(await remove(admin.cookie, fx.agencyId, admin.membershipId), 403, 'FORBIDDEN', SELF_REMOVAL_MESSAGE);
    expectRefused(await remove(viewer.cookie, fx.agencyId, peer.membershipId), 403, 'FORBIDDEN', GENERIC_FORBIDDEN_MESSAGE);
    expectRefused(await remove(fx.ownerCookie, fx.agencyId, gone.membershipId), 409, 'COLLABORATOR_ALREADY_REMOVED');

    for (const user of [fx.ownerUser, admin.user, peer.user, viewer.user]) expect(await sessionCount(user.id), user.email).toBe(1);
    // The 409 for someone already removed does not sign them out again either.
    expect(await sessionCount(gone.user.id)).toBe(1);
    expect((await app.app.inject({ method: 'GET', url: '/me/contexts', headers: { ...origin, cookie: reopened } })).statusCode).toBe(200);
  });

  it('two removals of the same person at the same moment: one wins with 200, the other is the 409, and the row is removed once', async () => {
    const fx = await createAgency('remove-race');
    const first = await addMember(fx.agencyId, 'remove-race-first', presetRoleIds.admin);
    const second = await addMember(fx.agencyId, 'remove-race-second', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'remove-race-target', presetRoleIds.production, { acts: false });

    const responses = await settleBehindLock(target.membershipId, () => [
      remove(first.cookie, fx.agencyId, target.membershipId),
      remove(second.cookie, fx.agencyId, target.membershipId)
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe('COLLABORATOR_ALREADY_REMOVED');
    expect((await membershipRow(target.membershipId)).status).toBe('removed');
  });

  it('a job title change racing the removal is either applied before it or refused after it, never lost in the middle', async () => {
    const fx = await createAgency('remove-vs-patch');
    const remover = await addMember(fx.agencyId, 'remove-vs-patch-remover', presetRoleIds.admin);
    const editor = await addMember(fx.agencyId, 'remove-vs-patch-editor', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'remove-vs-patch-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const [removal, edit] = await settleBehindLock(target.membershipId, () => [
      remove(remover.cookie, fx.agencyId, target.membershipId),
      patchTitle(editor.cookie, fx.agencyId, target.membershipId, 'Diretor')
    ]);

    expect(removal.status).toBe(200);
    const stored = await membershipRow(target.membershipId);
    expect(stored.status).toBe('removed');
    // A 200 means the title is stored; a 404 means the removal came first and the title is intact.
    if (edit.status === 200) expect(stored.job_title).toBe('Diretor');
    else {
      expect(edit.status).toBe(404);
      expect(stored.job_title).toBe('Editor');
    }
  });

  describe('a permission revoked after the guard read it and before the row is written', () => {
    it('the UPDATE policy then filters the row and the route answers 403, not a 200 that removed nobody', async () => {
      const fx = await createAgency('remove-revoked-policy');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.remover']);
      const member = await addMember(fx.agencyId, 'remove-revoked-policy-member', roleId);
      const target = await addMember(fx.agencyId, 'remove-revoked-policy-target', presetRoleIds.production, { acts: false });

      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [remove(member.cookie, fx.agencyId, target.membershipId)],
        revoke(roleId, 'colaborador.remover')
      );

      expectRefused(settled, 403, 'FORBIDDEN');
      expect((await membershipRow(target.membershipId)).status).toBe('active');
    });

    it('the UPDATE trigger then refuses the status with 42501 and the route answers 403, not 500', async () => {
      const fx = await createAgency('remove-revoked-trigger');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.remover', 'colaborador.alterar_papel']);
      const member = await addMember(fx.agencyId, 'remove-revoked-trigger-member', roleId);
      const target = await addMember(fx.agencyId, 'remove-revoked-trigger-target', presetRoleIds.production, { acts: false });

      // Still holds alterar_papel, so the policy lets the row through and only the trigger can refuse.
      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [remove(member.cookie, fx.agencyId, target.membershipId)],
        revoke(roleId, 'colaborador.remover')
      );

      expectRefused(settled, 403, 'FORBIDDEN');
      expect((await membershipRow(target.membershipId)).status).toBe('active');
    });
  });

  it('agrees with the database policy: whatever the API allows, the same update is allowed to that person in SQL', async () => {
    const fx = await createAgency('remove-coherence');
    const target = await addMember(fx.agencyId, 'remove-coherence-target', presetRoleIds.production, { acts: false });
    const actors: Array<{ label: string; user: TestUserFixture; cookie: string }> = [
      { label: 'owner', user: fx.ownerUser, cookie: fx.ownerCookie }
    ];
    for (const [label, roleId] of [
      ['admin', presetRoleIds.admin],
      ['account_manager', presetRoleIds.account_manager],
      ['production', presetRoleIds.production],
      ['only remover', await createCustomRole(fx.agencyId, ['colaborador.remover'])],
      ['only alterar_papel', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel'])],
      ['only alterar_funcao', await createCustomRole(fx.agencyId, ['colaborador.alterar_funcao'])]
    ] as const) {
      const member = await addMember(fx.agencyId, `remove-coherence-${label.replace(' ', '-')}`, roleId);
      actors.push({ label, user: member.user, cookie: member.cookie });
    }

    for (const actor of actors) {
      await owner.knex('agency_memberships').where({ id: target.membershipId }).update({ status: 'active' });
      // The direct UPDATE runs as the same person, through the same policy and trigger, and is
      // rolled back whatever it decided: it is only a measurement.
      const rollback = new Error('rollback');
      let sqlAllowed = false;
      await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: actor.user.id }), async (transaction) => {
        try {
          sqlAllowed = await transaction('agency_memberships').where({ id: target.membershipId }).update({ status: 'removed' }) === 1;
        } catch (error) {
          if ((error as { code?: string }).code !== '42501') throw error;
        }
        throw rollback;
      }).catch((error: unknown) => {
        if (error !== rollback) throw error;
      });

      const response = await remove(actor.cookie, fx.agencyId, target.membershipId);
      expect(response.status === 200, actor.label).toBe(sqlAllowed);
      expect((await membershipRow(target.membershipId)).status, actor.label).toBe(response.status === 200 ? 'removed' : 'active');
    }
  }, 120_000);
});

describe('POST /agencies/:agencyId/collaborators/:membershipId/reactivate (issue #98)', { timeout: 60_000 }, () => {
  beforeAll(freshApp);

  it('an Admin reactivates with the role of the body: 200, the same membership id, and not the role the person had', async () => {
    const fx = await createAgency('reactivate');
    const admin = await addMember(fx.agencyId, 'reactivate-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'reactivate-target', presetRoleIds.sales, { jobTitle: 'Vendedor', status: 'removed', acts: false });
    const rowsBefore = await membershipCount(fx.agencyId);

    const response = await reactivate(admin.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.production });

    expect(response.status).toBe(200);
    // A removed person has no session to reactivate themselves with, so the answered link is someone else's: `isSelf` false (issue #286).
    expect(response.body).toMatchObject({ membershipId: target.membershipId, status: 'active', jobTitle: 'Vendedor', role: { key: 'production' }, isSelf: false });
    expect(await membershipRow(target.membershipId)).toMatchObject({ id: target.membershipId, status: 'active', role_id: presetRoleIds.production, job_title: 'Vendedor' });
    expect(await membershipCount(fx.agencyId)).toBe(rowsBefore);
  });

  it('without a role in the body it is a 400 and nothing changes: the old role is never inherited', async () => {
    const fx = await createAgency('reactivate-validation');
    const target = await addMember(fx.agencyId, 'reactivate-validation-target', presetRoleIds.sales, { status: 'removed', acts: false });
    const before = await membershipRow(target.membershipId);

    for (const payload of [{}, { roleId: null }, { roleId: 'not-a-uuid' }, { roleId: 7 }, { role_id: presetRoleIds.production }, { roleId: presetRoleIds.production, extra: 1 }, { roleId: undefined }]) {
      expectRefused(await reactivate(fx.ownerCookie, fx.agencyId, target.membershipId, payload), 400, 'VALIDATION_ERROR');
    }
    for (const content of ['null', '', '[]', '"x"']) {
      const response = await app.app.inject({
        method: 'POST',
        url: `/agencies/${fx.agencyId}/collaborators/${target.membershipId}/reactivate`,
        headers: { ...origin, cookie: fx.ownerCookie, 'content-type': 'application/json' },
        payload: content
      });
      expect(response.statusCode, content).toBe(400);
    }
    // A request with no body at all is the same refusal.
    const bare = await app.app.inject({ method: 'POST', url: `/agencies/${fx.agencyId}/collaborators/${target.membershipId}/reactivate`, headers: { ...origin, cookie: fx.ownerCookie } });
    expect(bare.statusCode).toBe(400);
    expect(await membershipRow(target.membershipId)).toEqual(before);
  });

  it('with the admin role: 403 for an Admin and for alterar_papel alone, 200 for the Owner and for atribuir_admin plus alterar_papel', async () => {
    const fx = await createAgency('reactivate-admin-role');
    const admin = await addMember(fx.agencyId, 'reactivate-admin-role-admin', presetRoleIds.admin);
    const grantee = await addMember(fx.agencyId, 'reactivate-admin-role-grantee', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel', 'colaborador.atribuir_admin']));
    const target = await addMember(fx.agencyId, 'reactivate-admin-role-target', presetRoleIds.production, { status: 'removed', acts: false });

    expectRefused(await reactivate(admin.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin }), 403, 'FORBIDDEN', ADMIN_GRANT_MESSAGE);
    expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.production });

    expect((await reactivate(grantee.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin })).status).toBe(200);
    expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'active', role_id: presetRoleIds.admin });

    const second = await addMember(fx.agencyId, 'reactivate-admin-role-second', presetRoleIds.production, { status: 'removed', acts: false });
    expect((await reactivate(fx.ownerCookie, fx.agencyId, second.membershipId, { roleId: presetRoleIds.admin })).status).toBe(200);
    expect((await membershipRow(second.membershipId)).role_id).toBe(presetRoleIds.admin);
  });

  // A person who was an Admin and comes back as an Admin keeps the same role_id, which the trigger
  // used to let through (fixed by the migration of this issue): the route answers with its own
  // message, and the database refuses it too (`collaborators-reactivation-grant.integration.test.ts`).
  it('an Admin cannot bring back a removed Admin as an Admin, though the role id would not change', async () => {
    const fx = await createAgency('reactivate-same-admin');
    const admin = await addMember(fx.agencyId, 'reactivate-same-admin-admin', presetRoleIds.admin);
    const formerAdmin = await addMember(fx.agencyId, 'reactivate-same-admin-former', presetRoleIds.admin, { status: 'removed', acts: false });

    expectRefused(await reactivate(admin.cookie, fx.agencyId, formerAdmin.membershipId, { roleId: presetRoleIds.admin }), 403, 'FORBIDDEN', ADMIN_GRANT_MESSAGE);
    expect(await membershipRow(formerAdmin.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.admin });

    expect((await reactivate(fx.ownerCookie, fx.agencyId, formerAdmin.membershipId, { roleId: presetRoleIds.admin })).status).toBe(200);
    expect((await membershipRow(formerAdmin.membershipId)).status).toBe('active');
  });

  it('is decided by colaborador.alterar_papel alone: a role with only that permission reactivates, one with any other single permission is refused', async () => {
    const fx = await createAgency('reactivate-perms');
    const allowed = await addMember(fx.agencyId, 'reactivate-perms-allowed', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel']));
    const refusedRoles = await Promise.all(
      ['colaborador.remover', 'colaborador.alterar_funcao', 'colaborador.visualizar', 'colaborador.atribuir_admin', 'colaborador.convidar']
        .map(async (permission) => ({ permission, member: await addMember(fx.agencyId, `reactivate-perms-${permission.split('.')[1]}`, await createCustomRole(fx.agencyId, [permission])) }))
    );
    const target = await addMember(fx.agencyId, 'reactivate-perms-target', presetRoleIds.production, { status: 'removed', acts: false });

    for (const { permission, member } of refusedRoles) {
      expectRefused(await reactivate(member.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales }), 403, 'FORBIDDEN');
      expect((await membershipRow(target.membershipId)).status, permission).toBe('removed');
    }

    expect((await reactivate(allowed.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales })).status).toBe(200);
    expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'active', role_id: presetRoleIds.sales });
  });

  it('account_manager, production, sales and finance get 403 and nothing changes', async () => {
    const fx = await createAgency('reactivate-presets');
    const target = await addMember(fx.agencyId, 'reactivate-presets-target', presetRoleIds.production, { status: 'removed', acts: false });
    for (const preset of ['account_manager', 'production', 'sales', 'finance'] as const) {
      const member = await addMember(fx.agencyId, `reactivate-presets-${preset}`, presetRoleIds[preset]);
      expectRefused(await reactivate(member.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales }), 403, 'FORBIDDEN', GENERIC_FORBIDDEN_MESSAGE);
    }
    expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.production });
  });

  it('refuses a role that belongs to no agency of the caller, even to a person who can see the role of the other agency', async () => {
    const home = await createAgency('reactivate-role-home');
    const away = await createAgency('reactivate-role-away');
    const traveller = await addMember(home.agencyId, 'reactivate-role-traveller', presetRoleIds.admin);
    await linkExistingUser(away.agencyId, traveller, presetRoleIds.admin);
    const target = await addMember(home.agencyId, 'reactivate-role-target', presetRoleIds.production, { status: 'removed', acts: false });
    const awayRole = await createCustomRole(away.agencyId, ['colaborador.visualizar']);

    const visibleToTraveller = await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: traveller.user.id }), async (transaction) =>
      transaction('roles').where({ id: awayRole }).count<Array<{ count: string }>>('id as count')
    );
    expect(Number(visibleToTraveller[0]?.count)).toBe(1);

    for (const roleId of [awayRole, randomUUID()]) {
      expectRefused(await reactivate(traveller.cookie, home.agencyId, target.membershipId, { roleId }), 400, 'INVALID_ROLE');
    }
    expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.production });
  });

  it('a person with a link in two agencies cannot reactivate the link of the other agency through this one', async () => {
    const home = await createAgency('reactivate-dual-home');
    const away = await createAgency('reactivate-dual-away');
    const traveller = await addMember(home.agencyId, 'reactivate-dual-traveller', presetRoleIds.admin);
    await linkExistingUser(away.agencyId, traveller, presetRoleIds.admin);
    const awayTarget = await addMember(away.agencyId, 'reactivate-dual-target', presetRoleIds.production, { status: 'removed', acts: false });

    expectRefused(await reactivate(traveller.cookie, home.agencyId, awayTarget.membershipId, { roleId: presetRoleIds.sales }), 404, 'NOT_FOUND', 'Collaborator not found.');
    expect(await membershipRow(awayTarget.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.production });

    expect((await reactivate(traveller.cookie, away.agencyId, awayTarget.membershipId, { roleId: presetRoleIds.sales })).status).toBe(200);
  });

  it('a nonexistent or malformed id is the same 404', async () => {
    const fx = await createAgency('reactivate-404');
    expectRefused(await reactivate(fx.ownerCookie, fx.agencyId, randomUUID(), { roleId: presetRoleIds.sales }), 404, 'NOT_FOUND', 'Collaborator not found.');
    expectRefused(await reactivate(fx.ownerCookie, fx.agencyId, 'not-a-uuid', { roleId: presetRoleIds.sales }), 404, 'NOT_FOUND', 'Collaborator not found.');
    expect((await reactivate(undefined, fx.agencyId, randomUUID(), { roleId: presetRoleIds.sales })).status).toBe(401);
  });

  it('reactivating someone who is not removed is a 409, and the role they have is not overwritten', async () => {
    const fx = await createAgency('reactivate-active');
    const target = await addMember(fx.agencyId, 'reactivate-active-target', presetRoleIds.sales, { acts: false });
    const before = await membershipRow(target.membershipId);

    expectRefused(await reactivate(fx.ownerCookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.finance }), 409, 'COLLABORATOR_NOT_REMOVED');

    expect(await membershipRow(target.membershipId)).toEqual(before);
  });

  it('the Owner link is never changed by this route, even when its row says removed', async () => {
    const fx = await createAgency('reactivate-owner');
    await owner.knex('agency_memberships').where({ id: fx.ownerMembershipId }).update({ status: 'removed' });

    expectRefused(await reactivate(fx.ownerCookie, fx.agencyId, fx.ownerMembershipId, { roleId: presetRoleIds.production }), 403, 'FORBIDDEN', OWNER_ROLE_MESSAGE);
    expect(await membershipRow(fx.ownerMembershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.admin });
  });

  it('the person gets the agency back on signing in again; reactivating creates no session and ends none (#411)', async () => {
    const fx = await createAgency('reactivate-access');
    const person = await addMember(fx.agencyId, 'reactivate-access-person', presetRoleIds.sales);
    expect((await remove(fx.ownerCookie, fx.agencyId, person.membershipId)).status).toBe(200);
    expectRefused(await list(person.cookie, fx.agencyId), 401, 'UNAUTHENTICATED');
    // Their only agency is gone, so there is no context to sign in to until they are brought back.
    const refusedLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: person.user.email, password: person.user.password } });
    expect(refusedLogin.statusCode).toBe(403);
    expect(await sessionCount(person.user.id)).toBe(0);

    expect((await reactivate(fx.ownerCookie, fx.agencyId, person.membershipId, { roleId: presetRoleIds.production })).status).toBe(200);

    expect(await sessionCount(person.user.id)).toBe(0);
    expectRefused(await list(person.cookie, fx.agencyId), 401, 'UNAUTHENTICATED');
    const again = await loginCookie(person.user);
    expect((await list(again, fx.agencyId)).status).toBe(200);
    // Production reads the team but does not administer it: the role of the body is what applies.
    expectRefused(await remove(again, fx.agencyId, fx.ownerMembershipId), 403, 'FORBIDDEN', GENERIC_FORBIDDEN_MESSAGE);
  });

  it('two reactivations of the same person at the same moment: one wins with 200, the other is the 409, and its role is not applied', async () => {
    const fx = await createAgency('reactivate-race');
    const first = await addMember(fx.agencyId, 'reactivate-race-first', presetRoleIds.admin);
    const second = await addMember(fx.agencyId, 'reactivate-race-second', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'reactivate-race-target', presetRoleIds.finance, { status: 'removed', acts: false });

    const responses = await settleBehindLock(target.membershipId, () => [
      reactivate(first.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.production }),
      reactivate(second.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales })
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.status === 200);
    const stored = await membershipRow(target.membershipId);
    expect(stored.status).toBe('active');
    expect(stored.role_id).toBe(winner?.body.role.key === 'production' ? presetRoleIds.production : presetRoleIds.sales);
    expect(stored.role_id).not.toBe(presetRoleIds.finance);
  });

  describe('a permission revoked after the guard read it and before the row is written', () => {
    it('the UPDATE policy then filters the row and the route answers 403, not a 200 that reactivated nobody', async () => {
      const fx = await createAgency('reactivate-revoked-policy');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.alterar_papel']);
      const member = await addMember(fx.agencyId, 'reactivate-revoked-policy-member', roleId);
      const target = await addMember(fx.agencyId, 'reactivate-revoked-policy-target', presetRoleIds.production, { status: 'removed', acts: false });

      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [reactivate(member.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales })],
        revoke(roleId, 'colaborador.alterar_papel')
      );

      expectRefused(settled, 403, 'FORBIDDEN');
      expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.production });
    });

    it('a grantee who loses atribuir_admin while queued does not bring anyone back as an Admin', async () => {
      const fx = await createAgency('reactivate-revoked-grant');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.alterar_papel', 'colaborador.atribuir_admin']);
      const grantee = await addMember(fx.agencyId, 'reactivate-revoked-grant-member', roleId);
      const target = await addMember(fx.agencyId, 'reactivate-revoked-grant-target', presetRoleIds.production, { status: 'removed', acts: false });

      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [reactivate(grantee.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin })],
        revoke(roleId, 'colaborador.atribuir_admin')
      );

      expectRefused(settled, 403, 'FORBIDDEN');
      expect(await membershipRow(target.membershipId)).toMatchObject({ status: 'removed', role_id: presetRoleIds.production });
    });
  });

  it('agrees with the database policy and trigger: whatever the API allows, the same update is allowed to that person in SQL', async () => {
    const fx = await createAgency('reactivate-coherence');
    const target = await addMember(fx.agencyId, 'reactivate-coherence-target', presetRoleIds.production, { status: 'removed', acts: false });
    const actors: Array<{ label: string; user: TestUserFixture; cookie: string }> = [
      { label: 'owner', user: fx.ownerUser, cookie: fx.ownerCookie }
    ];
    for (const [label, roleId] of [
      ['admin', presetRoleIds.admin],
      ['account_manager', presetRoleIds.account_manager],
      ['only remover', await createCustomRole(fx.agencyId, ['colaborador.remover'])],
      ['only alterar_papel', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel'])],
      ['alterar_papel + atribuir_admin', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel', 'colaborador.atribuir_admin'])]
    ] as const) {
      const member = await addMember(fx.agencyId, `reactivate-coherence-${label.replace(/[ +]/g, '-')}`, roleId);
      actors.push({ label, user: member.user, cookie: member.cookie });
    }
    // The second scenario is the one the trigger used to miss: the role id does not change.
    const scenarios = [
      { label: 'to a non-administrative role', before: presetRoleIds.production, roleId: presetRoleIds.sales, sql: { status: 'active', role_id: presetRoleIds.sales } },
      { label: 'a former Admin back as Admin', before: presetRoleIds.admin, roleId: presetRoleIds.admin, sql: { status: 'active' } }
    ];

    for (const scenario of scenarios) {
      for (const actor of actors) {
        const label = `${actor.label} / ${scenario.label}`;
        await owner.knex('agency_memberships').where({ id: target.membershipId }).update({ status: 'removed', role_id: scenario.before });
        const rollback = new Error('rollback');
        let sqlAllowed = false;
        await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: actor.user.id }), async (transaction) => {
          try {
            sqlAllowed = await transaction('agency_memberships').where({ id: target.membershipId }).update(scenario.sql) === 1;
          } catch (error) {
            if ((error as { code?: string }).code !== '42501') throw error;
          }
          throw rollback;
        }).catch((error: unknown) => {
          if (error !== rollback) throw error;
        });

        const response = await reactivate(actor.cookie, fx.agencyId, target.membershipId, { roleId: scenario.roleId });
        expect(response.status === 200, label).toBe(sqlAllowed);
        expect(await membershipRow(target.membershipId), label).toMatchObject(
          response.status === 200 ? { status: 'active', role_id: scenario.roleId } : { status: 'removed', role_id: scenario.before }
        );
      }
    }
  }, 180_000);
});

describe('who sees removed links (issue #98, SPEC §5 rule 9)', { timeout: 60_000 }, () => {
  beforeAll(freshApp);

  it('the filter is for whoever may remove or reactivate, and for the Owner by ownership; everyone else gets 403 before any read', async () => {
    const fx = await createAgency('view-removed', { ownerMembership: false });
    const gone = await addMember(fx.agencyId, 'view-removed-gone', presetRoleIds.production, { status: 'removed', acts: false });
    await addMember(fx.agencyId, 'view-removed-active', presetRoleIds.production, { acts: false });
    const allowed = [
      { label: 'owner without a link', cookie: fx.ownerCookie },
      { label: 'admin', cookie: (await addMember(fx.agencyId, 'view-removed-admin', presetRoleIds.admin)).cookie },
      { label: 'only remover', cookie: (await addMember(fx.agencyId, 'view-removed-remover', await createCustomRole(fx.agencyId, ['colaborador.visualizar', 'colaborador.remover']))).cookie },
      { label: 'only alterar_papel', cookie: (await addMember(fx.agencyId, 'view-removed-papel', await createCustomRole(fx.agencyId, ['colaborador.visualizar', 'colaborador.alterar_papel']))).cookie }
    ];
    const refused = [
      { label: 'account_manager', cookie: (await addMember(fx.agencyId, 'view-removed-manager', presetRoleIds.account_manager)).cookie },
      { label: 'production', cookie: (await addMember(fx.agencyId, 'view-removed-production', presetRoleIds.production)).cookie },
      { label: 'only visualizar', cookie: (await addMember(fx.agencyId, 'view-removed-view', await createCustomRole(fx.agencyId, ['colaborador.visualizar']))).cookie },
      { label: 'visualizar + alterar_funcao', cookie: (await addMember(fx.agencyId, 'view-removed-title', await createCustomRole(fx.agencyId, ['colaborador.visualizar', 'colaborador.alterar_funcao']))).cookie }
    ];

    for (const { label, cookie } of allowed) {
      const response = await list(cookie, fx.agencyId, { status: 'removed' });
      expect(response.status, label).toBe(200);
      expect(response.body.data.map((item) => item.membershipId), label).toEqual([gone.membershipId]);
      expect(response.body.data[0]?.status, label).toBe('removed');
      expect(response.body.meta.totalItems, label).toBe(1);
    }
    for (const { label, cookie } of refused) {
      expectRefused(await list(cookie, fx.agencyId, { status: 'removed' }), 403, 'FORBIDDEN');
      // The default and the `active` lists never show a removed link, whoever asks.
      const defaultList = await list(cookie, fx.agencyId);
      expect(defaultList.body.data.map((item) => item.membershipId), label).not.toContain(gone.membershipId);
    }
    for (const { label, cookie } of allowed) {
      const defaultList = await list(cookie, fx.agencyId);
      expect(defaultList.body.data.map((item) => item.membershipId), label).not.toContain(gone.membershipId);
    }
  });

  it('the filter is checked after the guard and the validation: without colaborador.visualizar it is the guard that answers, and a bad status is a 400', async () => {
    const fx = await createAgency('view-removed-order');
    const noView = await addMember(fx.agencyId, 'view-removed-order-noview', await createCustomRole(fx.agencyId, ['colaborador.remover']));
    const production = await addMember(fx.agencyId, 'view-removed-order-production', presetRoleIds.production);

    expectRefused(await list(noView.cookie, fx.agencyId, { status: 'removed' }), 403, 'FORBIDDEN', GENERIC_FORBIDDEN_MESSAGE);
    expectRefused(await list(production.cookie, fx.agencyId, { status: 'gone' }), 400, 'VALIDATION_ERROR');
    expectRefused(await list(fx.ownerCookie, fx.agencyId, { status: 'gone' }), 400, 'VALIDATION_ERROR');
  });

  it('permissions are per agency: an Admin of one agency and a Production member of the other sees removed links only where they administer', async () => {
    const admin = await createAgency('view-dual-admin');
    const plain = await createAgency('view-dual-plain');
    const traveller = await addMember(admin.agencyId, 'view-dual-traveller', presetRoleIds.admin);
    await linkExistingUser(plain.agencyId, traveller, presetRoleIds.production);
    const adminGone = await addMember(admin.agencyId, 'view-dual-admin-gone', presetRoleIds.production, { status: 'removed', acts: false });
    const plainGone = await addMember(plain.agencyId, 'view-dual-plain-gone', presetRoleIds.production, { status: 'removed', acts: false });

    const where = await list(traveller.cookie, admin.agencyId, { status: 'removed' });
    expect(where.status).toBe(200);
    // The RLS lets this person read both agencies' rows: only the route's agency filter keeps the
    // other agency's removed person out.
    expect(where.body.data.map((item) => item.membershipId)).toEqual([adminGone.membershipId]);

    expectRefused(await list(traveller.cookie, plain.agencyId, { status: 'removed' }), 403, 'FORBIDDEN');
    expect(plainGone.membershipId).not.toBe(adminGone.membershipId);
  });

  it('a removed person is visible in the detail to whoever may see removed links and a 404 for everyone else', async () => {
    const fx = await createAgency('view-detail');
    const gone = await addMember(fx.agencyId, 'view-detail-gone', presetRoleIds.sales, { jobTitle: 'Vendedor', status: 'removed', acts: false });
    const remover = await addMember(fx.agencyId, 'view-detail-remover', await createCustomRole(fx.agencyId, ['colaborador.visualizar', 'colaborador.remover']));
    const manager = await addMember(fx.agencyId, 'view-detail-manager', presetRoleIds.account_manager);

    const seen = await detail(remover.cookie, fx.agencyId, gone.membershipId);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ membershipId: gone.membershipId, status: 'removed', jobTitle: 'Vendedor' });
    expect((await detail(fx.ownerCookie, fx.agencyId, gone.membershipId)).status).toBe(200);

    expectRefused(await detail(manager.cookie, fx.agencyId, gone.membershipId), 404, 'NOT_FOUND', 'Collaborator not found.');
  });

  it('a removed link cannot be edited through the PATCH of #97: it is the same 404', async () => {
    const fx = await createAgency('view-patch');
    const gone = await addMember(fx.agencyId, 'view-patch-gone', presetRoleIds.sales, { jobTitle: 'Vendedor', status: 'removed', acts: false });

    const response = await patchTitle(fx.ownerCookie, fx.agencyId, gone.membershipId, 'Invadido');

    expectRefused(response, 404, 'NOT_FOUND', 'Collaborator not found.');
    expect((await membershipRow(gone.membershipId)).job_title).toBe('Vendedor');
  });
});
