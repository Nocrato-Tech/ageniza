import { randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #97. `PATCH /agencies/:agencyId/collaborators/:membershipId` and the admin-grant rule on the
// two invitation routes. Authorization is always exercised with a custom role holding exactly one
// permission (the Admin preset has all of them and hides a guard that checks the wrong key), and
// every 200 is confirmed against the row in the database: the UPDATE policy answers "zero rows" in
// silence, so a status code alone proves nothing.
const origin = { origin: TEST_APP_PUBLIC_URL };
const SYSTEM_PRESETS = ['admin', 'account_manager', 'production', 'sales', 'finance'] as const;
type SystemPreset = (typeof SYSTEM_PRESETS)[number];

const ADMIN_GRANT_MESSAGE = 'Só o Owner da agência pode conceder o papel de Admin.';
const OWNER_PROTECTED_MESSAGE = 'O papel do Owner da agência não pode ser alterado.';
// The generic message is the guard's and the database barrier's (a 42501 mapped to 403); the three
// below are the route's own, so a test that sees one knows the API layer did the refusing and not
// the policy or the trigger behind it.
const GENERIC_FORBIDDEN_MESSAGE = 'You do not have permission to perform this action.';
const TITLE_FORBIDDEN_MESSAGE = 'Você não tem permissão para alterar o cargo.';
const ROLE_FORBIDDEN_MESSAGE = 'Você não tem permissão para alterar o papel.';
const SELF_ROLE_MESSAGE = 'Ninguém altera o próprio papel.';

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

interface CollaboratorJson {
  readonly membershipId: string;
  readonly jobTitle: string | null;
  readonly role: { key: string; name: string };
  readonly isOwner: boolean;
  readonly status: 'active' | 'removed';
}

interface MembershipRow {
  readonly role_id: string;
  readonly job_title: string | null;
  readonly status: string;
}

let app: TestApp;
let sender: ReturnType<typeof createFakeEmailSender>;
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
  const email = `${label}.${id.slice(0, 8)}@collab-update.test`;
  await app.pool.query('insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)', [id, `Pessoa ${label}`, email]);
  return { id, email, password: '', name: `Pessoa ${label}` };
};

const createCustomRole = async (agencyId: string, permissionKeys: readonly string[], keyOverride?: string): Promise<string> => {
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: keyOverride ?? `custom-${roleId.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
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
  await owner.knex('agencies').insert({ id: agencyId, name: `Colab Update ${label}`, owner_user_id: ownerUser.id, status: 'active' });
  const ownerMembershipId = options.ownerMembership === false
    ? ''
    : (await owner.knex('agency_memberships')
      .insert({ agency_id: agencyId, user_id: ownerUser.id, role_id: presetRoleIds.admin, job_title: 'Dona', status: 'active' })
      .returning('id'))[0].id as string;
  return { agencyId, ownerUser, ownerCookie: await loginCookie(ownerUser), ownerMembershipId };
};

const addMember = async (
  agencyId: string,
  label: string,
  roleId: string,
  options: { jobTitle?: string | null; status?: 'active' | 'removed'; acts?: boolean } = {}
): Promise<Member> => {
  // Hashing a password and logging in is what makes this suite slow: only people who send a
  // request get a credential, the people who are merely changed are bare user rows.
  const acts = options.acts ?? true;
  const user = acts
    ? await insertTestUser(app.pool, app.auth, { emailLabel: label, name: `Pessoa ${label}` })
    : await insertBareUser(label);
  createdUserIds.push(user.id);
  const [membership] = await owner.knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: user.id, role_id: roleId, job_title: options.jobTitle ?? null, status: options.status ?? 'active' })
    .returning('id');
  return { user, membershipId: membership.id as string, cookie: acts && (options.status ?? 'active') === 'active' ? await loginCookie(user) : '' };
};

/** Gives a person who already has a credential a second link, in another agency. */
const linkExistingUser = async (agencyId: string, member: Member, roleId: string): Promise<string> => {
  const [membership] = await owner.knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: member.user.id, role_id: roleId, status: 'active' })
    .returning('id');
  return membership.id as string;
};

const membershipRow = async (membershipId: string): Promise<MembershipRow> => {
  const row = await owner.knex('agency_memberships').where({ id: membershipId }).first('role_id', 'job_title', 'status');
  return row as MembershipRow;
};

const patch = async (
  cookie: string | undefined,
  agencyId: string,
  membershipId: string,
  payload: unknown
): Promise<{ status: number; body: CollaboratorJson & ApiErrorJson }> => {
  const response = await app.app.inject({
    method: 'PATCH',
    url: `/agencies/${agencyId}/collaborators/${membershipId}`,
    headers: cookie === undefined ? origin : { ...origin, cookie },
    payload: payload as object
  });
  return { status: response.statusCode, body: response.json<CollaboratorJson & ApiErrorJson>() };
};

const expectRefused = async (pending: ReturnType<typeof patch>, message: string): Promise<void> => {
  const response = await pending;
  expect(response.status).toBe(403);
  expect(response.body.error).toEqual({ code: 'FORBIDDEN', message });
};

const inviteCollaborator = async (cookie: string, agencyId: string, email: string, roleId: string) =>
  app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/invitations/collaborators`, headers: { ...origin, cookie }, payload: { email, roleId } });

const resendInvitation = async (cookie: string, agencyId: string, invitationId: string) =>
  app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/invitations/${invitationId}/resend`, headers: { ...origin, cookie } });

const pendingInvitationCount = async (agencyId: string): Promise<number> => {
  const row = await owner.knex('invitations').where({ agency_id: agencyId, purpose: 'collaborator_invite' }).whereNull('revoked_at').whereNull('used_at').count<{ count: string }>('id as count').first();
  return Number(row?.count ?? 0);
};

/** A trigger fixed to one row (or one email) that replaces what the database would have done. */
const withTemporaryTrigger = async (
  table: 'agency_memberships' | 'invitations',
  event: 'update' | 'insert',
  condition: string,
  body: string,
  run: () => Promise<void>
): Promise<void> => {
  const name = `zz_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await owner.knex.raw(`
    create function public.${name}() returns trigger language plpgsql as $$ begin ${body} end $$;
    create trigger ${name} before ${event} on public.${table}
      for each row when (${condition}) execute function public.${name}();
  `);
  try {
    await run();
  } finally {
    await owner.knex.raw(`drop trigger if exists ${name} on public.${table}; drop function if exists public.${name}();`);
  }
};

type LockerTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const waitUntilQueuedBehindLock = async (count: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // The route locks with `for update of membership`; a request counted here has passed its guards
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

beforeAll(async () => {
  sender = createFakeEmailSender();
  app = await buildTestApp({ sender });
  const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', [...SYSTEM_PRESETS]).select('id', 'key');
  presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<SystemPreset, string>;
});

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

describe('PATCH /agencies/:agencyId/collaborators/:membershipId (issue #97)', { timeout: 60_000 }, () => {
  it('an Admin changes the job title of another person: 200, and the stored value changes', async () => {
    const fx = await createAgency('title');
    const admin = await addMember(fx.agencyId, 'title-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'title-target', presetRoleIds.production, { jobTitle: 'Estagiária', acts: false });

    const response = await patch(admin.cookie, fx.agencyId, target.membershipId, { jobTitle: 'Editor de Vídeo' });

    expect(response.status).toBe(200);
    expect(response.body.membershipId).toBe(target.membershipId);
    expect(response.body.jobTitle).toBe('Editor de Vídeo');
    expect(await membershipRow(target.membershipId)).toMatchObject({ job_title: 'Editor de Vídeo', role_id: presetRoleIds.production });
  });

  it('a null job title clears it, and the title is stored trimmed', async () => {
    const fx = await createAgency('clear');
    const target = await addMember(fx.agencyId, 'clear-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const trimmed = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: '  Designer  ' });
    expect(trimmed.status).toBe(200);
    expect((await membershipRow(target.membershipId)).job_title).toBe('Designer');

    const cleared = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.jobTitle).toBeNull();
    expect((await membershipRow(target.membershipId)).job_title).toBeNull();
  });

  it('an Admin changes the role to a non-administrative one: 200, and the stored role changes', async () => {
    const fx = await createAgency('role');
    const admin = await addMember(fx.agencyId, 'role-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'role-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const response = await patch(admin.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales });

    expect(response.status).toBe(200);
    expect(response.body.role.key).toBe('sales');
    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.sales, job_title: 'Editor' });
  });

  it('an Admin granting the admin role is refused with 403 and nothing changes, even with a title in the same body', async () => {
    const fx = await createAgency('admin-refused');
    const admin = await addMember(fx.agencyId, 'admin-refused-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'admin-refused-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const roleOnly = await patch(admin.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin });
    expect(roleOnly.status).toBe(403);
    expect(roleOnly.body.error).toEqual({ code: 'FORBIDDEN', message: ADMIN_GRANT_MESSAGE });

    const both = await patch(admin.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin, jobTitle: 'Chefe' });
    expect(both.status).toBe(403);
    expect(both.body.error.message).toBe(ADMIN_GRANT_MESSAGE);

    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.production, job_title: 'Editor' });
  });

  it('the Owner grants the admin role: 200', async () => {
    const fx = await createAgency('owner-grant');
    const target = await addMember(fx.agencyId, 'owner-grant-target', presetRoleIds.production, { acts: false });

    const response = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin });

    expect(response.status).toBe(200);
    expect(response.body.role.key).toBe('admin');
    expect((await membershipRow(target.membershipId)).role_id).toBe(presetRoleIds.admin);
  });

  it('the admin role is recognized wherever it lives: an agency role keyed admin needs the grant too', async () => {
    const fx = await createAgency('agency-admin');
    const admin = await addMember(fx.agencyId, 'agency-admin-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'agency-admin-target', presetRoleIds.production, { acts: false });
    const agencyAdminRole = await createCustomRole(fx.agencyId, [], 'admin');

    const refused = await patch(admin.cookie, fx.agencyId, target.membershipId, { roleId: agencyAdminRole });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(ADMIN_GRANT_MESSAGE);
    expect((await membershipRow(target.membershipId)).role_id).toBe(presetRoleIds.production);
  });

  it('an account_manager changes the job title (200) and never the role (403), alone or beside a title', async () => {
    const fx = await createAgency('manager');
    const manager = await addMember(fx.agencyId, 'manager-manager', presetRoleIds.account_manager);
    const target = await addMember(fx.agencyId, 'manager-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const title = await patch(manager.cookie, fx.agencyId, target.membershipId, { jobTitle: 'Editor Sênior' });
    expect(title.status).toBe(200);
    expect((await membershipRow(target.membershipId)).job_title).toBe('Editor Sênior');

    const role = await patch(manager.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales });
    expect(role.status).toBe(403);
    expect(role.body.error.message).toBe(ROLE_FORBIDDEN_MESSAGE);
    const both = await patch(manager.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales, jobTitle: 'Outro' });
    expect(both.status).toBe(403);
    expect(both.body.error.message).toBe(ROLE_FORBIDDEN_MESSAGE);
    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.production, job_title: 'Editor Sênior' });
  });

  it('a production member is refused on every change, and refused before the body is validated', async () => {
    const fx = await createAgency('production');
    const production = await addMember(fx.agencyId, 'production-member', presetRoleIds.production);
    const target = await addMember(fx.agencyId, 'production-target', presetRoleIds.sales, { jobTitle: 'Vendedor', acts: false });

    for (const payload of [{ jobTitle: 'X' }, { roleId: presetRoleIds.finance }, { jobTitle: 'X', roleId: presetRoleIds.finance }, {}, { roleId: 'not-a-uuid' }]) {
      const response = await patch(production.cookie, fx.agencyId, target.membershipId, payload);
      expect(response.status, JSON.stringify(payload)).toBe(403);
      expect(response.body.error.message).toBe(GENERIC_FORBIDDEN_MESSAGE);
    }
    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.sales, job_title: 'Vendedor' });
  });

  it('asks for the permission of each field present, proven with one-permission custom roles', async () => {
    const fx = await createAgency('perfield');
    const target = await addMember(fx.agencyId, 'perfield-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });
    const onlyTitle = await addMember(fx.agencyId, 'perfield-title', await createCustomRole(fx.agencyId, ['colaborador.alterar_funcao']));
    const onlyRole = await addMember(fx.agencyId, 'perfield-role', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel']));
    const onlyGrant = await addMember(fx.agencyId, 'perfield-grant', await createCustomRole(fx.agencyId, ['colaborador.atribuir_admin']));
    const onlyView = await addMember(fx.agencyId, 'perfield-view', await createCustomRole(fx.agencyId, ['colaborador.visualizar']));

    // alterar_funcao alone: the title, nothing else.
    expect((await patch(onlyTitle.cookie, fx.agencyId, target.membershipId, { jobTitle: 'A' })).status).toBe(200);
    await expectRefused(patch(onlyTitle.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales }), ROLE_FORBIDDEN_MESSAGE);
    await expectRefused(patch(onlyTitle.cookie, fx.agencyId, target.membershipId, { jobTitle: 'B', roleId: presetRoleIds.sales }), ROLE_FORBIDDEN_MESSAGE);
    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.production, job_title: 'A' });

    // alterar_papel alone: a non-administrative role, never the title, never admin.
    expect((await patch(onlyRole.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales })).status).toBe(200);
    await expectRefused(patch(onlyRole.cookie, fx.agencyId, target.membershipId, { jobTitle: 'C' }), TITLE_FORBIDDEN_MESSAGE);
    await expectRefused(patch(onlyRole.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin }), ADMIN_GRANT_MESSAGE);
    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.sales, job_title: 'A' });

    // atribuir_admin alone cannot change a role (it is a refinement of alterar_papel), nor can view alone:
    // neither gets past the guard, which answers with the generic message.
    await expectRefused(patch(onlyGrant.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin }), GENERIC_FORBIDDEN_MESSAGE);
    await expectRefused(patch(onlyView.cookie, fx.agencyId, target.membershipId, { jobTitle: 'D' }), GENERIC_FORBIDDEN_MESSAGE);
    expect(await membershipRow(target.membershipId)).toMatchObject({ role_id: presetRoleIds.sales, job_title: 'A' });
  });

  it('atribuir_admin is a permission, not a synonym of owner: alterar_papel plus atribuir_admin grants admin', async () => {
    const fx = await createAgency('grantee');
    const target = await addMember(fx.agencyId, 'grantee-target', presetRoleIds.production, { acts: false });
    const grantee = await addMember(fx.agencyId, 'grantee-member', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel', 'colaborador.atribuir_admin']));

    const response = await patch(grantee.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin });

    expect(response.status).toBe(200);
    expect((await membershipRow(target.membershipId)).role_id).toBe(presetRoleIds.admin);
  });

  it('refuses to change the role of the Owner, even by the Owner, and leaves the Owner title editable', async () => {
    const fx = await createAgency('owner-target');
    const admin = await addMember(fx.agencyId, 'owner-target-admin', presetRoleIds.admin);

    const byAdmin = await patch(admin.cookie, fx.agencyId, fx.ownerMembershipId, { roleId: presetRoleIds.production });
    const byOwner = await patch(fx.ownerCookie, fx.agencyId, fx.ownerMembershipId, { roleId: presetRoleIds.production });
    // The Owner passes the admin-grant rule, so only the Owner protection can refuse the role they
    // already have: the route never compares the value.
    const sameRole = await patch(fx.ownerCookie, fx.agencyId, fx.ownerMembershipId, { roleId: presetRoleIds.admin });
    // The message tells the route's own refusal from the database trigger's, which would also say 403.
    for (const response of [byAdmin, byOwner, sameRole]) {
      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe(OWNER_PROTECTED_MESSAGE);
    }
    // An Admin naming the admin role is stopped one rule earlier, by the value, and still changes nothing.
    const adminSameRole = await patch(admin.cookie, fx.agencyId, fx.ownerMembershipId, { roleId: presetRoleIds.admin });
    expect(adminSameRole.status).toBe(403);
    expect(adminSameRole.body.error.message).toBe(ADMIN_GRANT_MESSAGE);
    expect((await membershipRow(fx.ownerMembershipId)).role_id).toBe(presetRoleIds.admin);

    const title = await patch(admin.cookie, fx.agencyId, fx.ownerMembershipId, { jobTitle: 'Fundadora' });
    expect(title.status).toBe(200);
    expect(title.body.isOwner).toBe(true);
    expect((await membershipRow(fx.ownerMembershipId)).job_title).toBe('Fundadora');
  });

  it('nobody changes their own role, not even an Admin, while changing a peer is allowed', async () => {
    const fx = await createAgency('self');
    const admin = await addMember(fx.agencyId, 'self-admin', presetRoleIds.admin);
    const peer = await addMember(fx.agencyId, 'self-peer', presetRoleIds.admin, { acts: false });

    const self = await patch(admin.cookie, fx.agencyId, admin.membershipId, { roleId: presetRoleIds.production });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toBe(SELF_ROLE_MESSAGE);
    expect((await membershipRow(admin.membershipId)).role_id).toBe(presetRoleIds.admin);

    const other = await patch(admin.cookie, fx.agencyId, peer.membershipId, { roleId: presetRoleIds.production });
    expect(other.status).toBe(200);
    expect((await membershipRow(peer.membershipId)).role_id).toBe(presetRoleIds.production);
  });

  it('a body that is empty or malformed is a 400 validation error, never a silent 200', async () => {
    const fx = await createAgency('validation');
    const target = await addMember(fx.agencyId, 'validation-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });
    const huge = 'a'.repeat(200_000);
    const astral = '😀'.repeat(129);
    const bodies: unknown[] = [
      {}, { jobTitle: undefined }, { unknown: 1 }, { jobTitle: 'X', extra: true }, { roleId: null }, { roleId: 'nope' }, { roleId: 7 },
      { jobTitle: '' }, { jobTitle: '   ' }, { jobTitle: 5 }, { jobTitle: 'a'.repeat(257) }, { jobTitle: huge },
      { jobTitle: astral }, { jobTitle: 'Edi\ntor' }, { jobTitle: 'Edi\u0000tor' }, { jobTitle: 'Edi\ttor' }, { jobTitle: '\u007F' }
    ];
    for (const payload of bodies) {
      const response = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, payload);
      expect(response.status, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const content of ['null', '', '[]', '"x"']) {
      const response = await app.app.inject({
        method: 'PATCH',
        url: `/agencies/${fx.agencyId}/collaborators/${target.membershipId}`,
        headers: { ...origin, cookie: fx.ownerCookie, 'content-type': 'application/json' },
        payload: content
      });
      expect(response.statusCode, content).toBe(400);
    }
    expect((await membershipRow(target.membershipId)).job_title).toBe('Editor');

    // The boundary itself is accepted: 256 UTF-16 units, the contract's limit.
    const boundary = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: 'b'.repeat(256) });
    expect(boundary.status).toBe(200);
    expect((await membershipRow(target.membershipId)).job_title).toBe('b'.repeat(256));
  });

  it('every title the route stores can be found by the job title filter of the listing', async () => {
    const fx = await createAgency('filter');
    const target = await addMember(fx.agencyId, 'filter-target', presetRoleIds.production, { acts: false });
    for (const title of ['Editor de Vídeo', 'Designer  Sênior', 'Gestor (Operação) 100%', `${'c'.repeat(255)}é`]) {
      const stored = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: title });
      expect(stored.status).toBe(200);
      const listed = await app.app.inject({
        method: 'GET',
        url: `/agencies/${fx.agencyId}/collaborators?${new URLSearchParams({ jobTitle: title }).toString()}`,
        headers: { ...origin, cookie: fx.ownerCookie }
      });
      expect(listed.statusCode, title).toBe(200);
      expect(listed.json<{ data: Array<{ membershipId: string }> }>().data.map((item) => item.membershipId)).toEqual([target.membershipId]);
    }
  });

  it('a membership of another agency, a nonexistent, malformed or removed one is the same 404, and nothing changes', async () => {
    const fx = await createAgency('scope');
    const other = await createAgency('scope-other');
    const foreign = await addMember(other.agencyId, 'scope-foreign', presetRoleIds.production, { jobTitle: 'Original', acts: false });
    const removed = await addMember(fx.agencyId, 'scope-removed', presetRoleIds.production, { jobTitle: 'Original', status: 'removed', acts: false });

    const foreignResponse = await patch(fx.ownerCookie, fx.agencyId, foreign.membershipId, { jobTitle: 'Invadido' });
    const missing = await patch(fx.ownerCookie, fx.agencyId, randomUUID(), { jobTitle: 'Invadido' });
    const malformed = await patch(fx.ownerCookie, fx.agencyId, 'not-a-uuid', { jobTitle: 'Invadido' });
    const removedResponse = await patch(fx.ownerCookie, fx.agencyId, removed.membershipId, { jobTitle: 'Invadido' });
    for (const response of [foreignResponse, missing, malformed, removedResponse]) {
      expect(response.status).toBe(404);
      expect(response.body.error).toEqual({ code: 'NOT_FOUND', message: 'Collaborator not found.' });
    }
    // Using the other agency's id in the URL: an owner of another agency has no access to this one at all.
    const noAccess = await patch(fx.ownerCookie, other.agencyId, foreign.membershipId, { jobTitle: 'Invadido' });
    expect(noAccess.status).toBe(404);
    expect(noAccess.body.error.message).toBe('Agency not found.');

    expect((await membershipRow(foreign.membershipId)).job_title).toBe('Original');
    expect((await membershipRow(removed.membershipId)).job_title).toBe('Original');
    expect(await patch(undefined, fx.agencyId, removed.membershipId, { jobTitle: 'X' })).toMatchObject({ status: 401 });
  });

  // The isolation cases below use a person with a link in both agencies: that is the one case where
  // the RLS shows them both rows, so only the route's own agency filter can refuse.
  it('a person with a link in two agencies cannot reach the membership of the other one through this agency', async () => {
    const home = await createAgency('dual-home');
    const away = await createAgency('dual-away');
    const traveller = await addMember(home.agencyId, 'dual-traveller', presetRoleIds.admin);
    await linkExistingUser(away.agencyId, traveller, presetRoleIds.admin);
    const awayTarget = await addMember(away.agencyId, 'dual-away-target', presetRoleIds.production, { jobTitle: 'Original', acts: false });

    const visibleToTraveller = await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: traveller.user.id }), async (transaction) =>
      transaction('agency_memberships').where({ id: awayTarget.membershipId }).count<Array<{ count: string }>>('id as count')
    );
    expect(Number(visibleToTraveller[0]?.count)).toBe(1);

    for (const payload of [{ jobTitle: 'Invadido' }, { roleId: presetRoleIds.sales }, { jobTitle: 'Invadido', roleId: presetRoleIds.sales }]) {
      const response = await patch(traveller.cookie, home.agencyId, awayTarget.membershipId, payload);
      expect(response.status, JSON.stringify(payload)).toBe(404);
      expect(response.body.error).toEqual({ code: 'NOT_FOUND', message: 'Collaborator not found.' });
    }
    expect(await membershipRow(awayTarget.membershipId)).toMatchObject({ job_title: 'Original', role_id: presetRoleIds.production, status: 'active' });

    // The same person does reach it through the agency it belongs to.
    const control = await patch(traveller.cookie, away.agencyId, awayTarget.membershipId, { jobTitle: 'No lugar certo' });
    expect(control.status).toBe(200);
    expect((await membershipRow(awayTarget.membershipId)).job_title).toBe('No lugar certo');
  });

  it('a person with a link in two agencies cannot use a role of the other agency here: 400 INVALID_ROLE', async () => {
    const home = await createAgency('dual-role-home');
    const away = await createAgency('dual-role-away');
    const traveller = await addMember(home.agencyId, 'dual-role-traveller', presetRoleIds.admin);
    await linkExistingUser(away.agencyId, traveller, presetRoleIds.admin);
    const target = await addMember(home.agencyId, 'dual-role-target', presetRoleIds.production, { jobTitle: 'Original', acts: false });
    const awayRole = await createCustomRole(away.agencyId, ['colaborador.visualizar']);

    const visibleToTraveller = await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: traveller.user.id }), async (transaction) =>
      transaction('roles').where({ id: awayRole }).count<Array<{ count: string }>>('id as count')
    );
    expect(Number(visibleToTraveller[0]?.count)).toBe(1);

    const response = await patch(traveller.cookie, home.agencyId, target.membershipId, { roleId: awayRole });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_ROLE');
    expect(await membershipRow(target.membershipId)).toMatchObject({ job_title: 'Original', role_id: presetRoleIds.production });
  });

  it('an Owner with no membership and no role passes by ownership: edits the title and grants admin, on both routes', async () => {
    const fx = await createAgency('ownerless', { ownerMembership: false });
    const target = await addMember(fx.agencyId, 'ownerless-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });
    expect(await owner.knex('agency_memberships').where({ agency_id: fx.agencyId, user_id: fx.ownerUser.id }).count<Array<{ count: string }>>('id as count')).toEqual([{ count: '0' }]);

    const title = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: 'Diretor' });
    expect(title.status).toBe(200);
    const grant = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin });
    expect(grant.status).toBe(200);
    expect(await membershipRow(target.membershipId)).toMatchObject({ job_title: 'Diretor', role_id: presetRoleIds.admin });

    const invited = await inviteCollaborator(fx.ownerCookie, fx.agencyId, 'sem-vinculo-admin@exemplo.test', presetRoleIds.admin);
    expect(invited.statusCode).toBe(201);
    const resent = await resendInvitation(fx.ownerCookie, fx.agencyId, invited.json<{ invitationId: string }>().invitationId);
    expect(resent.statusCode).toBe(200);
  });

  it('refuses a role that belongs to no agency of the caller, with 400 INVALID_ROLE', async () => {
    const fx = await createAgency('invalid-role');
    const other = await createAgency('invalid-role-other');
    const target = await addMember(fx.agencyId, 'invalid-role-target', presetRoleIds.production, { acts: false });
    const foreignRole = await createCustomRole(other.agencyId, []);

    for (const roleId of [foreignRole, randomUUID()]) {
      const response = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { roleId });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ROLE');
    }
    // A caller without alterar_papel never learns whether the role exists.
    const production = await addMember(fx.agencyId, 'invalid-role-production', presetRoleIds.production);
    expect((await patch(production.cookie, fx.agencyId, target.membershipId, { roleId: foreignRole })).status).toBe(403);
    expect((await membershipRow(target.membershipId)).role_id).toBe(presetRoleIds.production);
  });

  it('never answers 200 for a statement that changed zero rows', async () => {
    const fx = await createAgency('zero-rows');
    const target = await addMember(fx.agencyId, 'zero-rows-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    await withTemporaryTrigger('agency_memberships', 'update', `old.id = '${target.membershipId}'::uuid`, 'return null;', async () => {
      const response = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: 'Silencioso' });
      expect(response.status).toBe(403);
    });
    expect((await membershipRow(target.membershipId)).job_title).toBe('Editor');

    const afterwards = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: 'Normal' });
    expect(afterwards.status).toBe(200);
    expect((await membershipRow(target.membershipId)).job_title).toBe('Normal');
  });

  it('turns an insufficient-privilege error raised by the database into 403, never a 500', async () => {
    const fx = await createAgency('db-403');
    const target = await addMember(fx.agencyId, 'db-403-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    await withTemporaryTrigger('agency_memberships', 'update', `old.id = '${target.membershipId}'::uuid`, "raise exception using errcode = '42501', message = 'forced';", async () => {
      const response = await patch(fx.ownerCookie, fx.agencyId, target.membershipId, { jobTitle: 'Bloqueado' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
    expect((await membershipRow(target.membershipId)).job_title).toBe('Editor');
  });

  it('agrees with the database policy: whatever the API allows, the same update is allowed to that person in SQL', async () => {
    const fx = await createAgency('coherence');
    const target = await addMember(fx.agencyId, 'coherence-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });
    const actors: Array<{ label: string; member: Member | { user: TestUserFixture; cookie: string } }> = [
      { label: 'owner', member: { user: fx.ownerUser, cookie: fx.ownerCookie } },
      { label: 'admin', member: await addMember(fx.agencyId, 'coherence-admin', presetRoleIds.admin) },
      { label: 'account_manager', member: await addMember(fx.agencyId, 'coherence-manager', presetRoleIds.account_manager) },
      { label: 'production', member: await addMember(fx.agencyId, 'coherence-production', presetRoleIds.production) },
      { label: 'only alterar_papel', member: await addMember(fx.agencyId, 'coherence-role', await createCustomRole(fx.agencyId, ['colaborador.alterar_papel'])) },
      { label: 'only alterar_funcao', member: await addMember(fx.agencyId, 'coherence-title', await createCustomRole(fx.agencyId, ['colaborador.alterar_funcao'])) },
      { label: 'only atribuir_admin', member: await addMember(fx.agencyId, 'coherence-grant', await createCustomRole(fx.agencyId, ['colaborador.atribuir_admin'])) },
      { label: 'only remover', member: await addMember(fx.agencyId, 'coherence-remove', await createCustomRole(fx.agencyId, ['colaborador.remover'])) }
    ];
    const changes: Array<{ label: string; body: { jobTitle?: string; roleId?: string }; column: Record<string, string> }> = [
      { label: 'title', body: { jobTitle: 'Novo Cargo' }, column: { job_title: 'Novo Cargo' } },
      { label: 'role', body: { roleId: presetRoleIds.sales }, column: { role_id: presetRoleIds.sales } },
      { label: 'admin role', body: { roleId: presetRoleIds.admin }, column: { role_id: presetRoleIds.admin } },
      { label: 'both', body: { jobTitle: 'Novo Cargo', roleId: presetRoleIds.sales }, column: { job_title: 'Novo Cargo', role_id: presetRoleIds.sales } }
    ];
    const reset = async (): Promise<void> => {
      await owner.knex('agency_memberships').where({ id: target.membershipId }).update({ job_title: 'Editor', role_id: presetRoleIds.production });
    };

    for (const actor of actors) {
      for (const change of changes) {
        await reset();
        // The direct UPDATE runs as the same person, through the same policy and trigger, and is
        // rolled back whatever it decided: it is only a measurement.
        const rollback = new Error('rollback');
        let sqlAllowed = false;
        await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: actor.member.user.id }), async (transaction) => {
          try {
            const updated = await transaction('agency_memberships').where({ id: target.membershipId }).update(change.column);
            sqlAllowed = updated === 1;
          } catch (error) {
            if ((error as { code?: string }).code !== '42501') throw error;
          }
          throw rollback;
        }).catch((error: unknown) => {
          if (error !== rollback) throw error;
        });

        const response = await patch(actor.member.cookie, fx.agencyId, target.membershipId, change.body);
        const label = `${actor.label} / ${change.label}`;
        expect(response.status === 200, label).toBe(sqlAllowed);
        const stored = await membershipRow(target.membershipId);
        if (response.status === 200) expect(stored, label).toMatchObject(change.column);
        else expect(stored, label).toMatchObject({ job_title: 'Editor', role_id: presetRoleIds.production });
      }
    }
  }, 120_000);

  it('two changes of different fields at the same moment both land: neither overwrites the other', async () => {
    const fx = await createAgency('concurrent');
    const first = await addMember(fx.agencyId, 'concurrent-first', presetRoleIds.admin);
    const second = await addMember(fx.agencyId, 'concurrent-second', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'concurrent-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const [titleResponse, roleResponse] = await settleBehindLock(target.membershipId, () => [
      patch(first.cookie, fx.agencyId, target.membershipId, { jobTitle: 'Diretor de Arte' }),
      patch(second.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.sales })
    ]);

    expect(titleResponse.status).toBe(200);
    expect(roleResponse.status).toBe(200);
    expect(await membershipRow(target.membershipId)).toMatchObject({ job_title: 'Diretor de Arte', role_id: presetRoleIds.sales });
  });

  it('a target removed while the change waits for the row is a 404 and stays untouched', async () => {
    const fx = await createAgency('removed-meanwhile');
    const admin = await addMember(fx.agencyId, 'removed-meanwhile-admin', presetRoleIds.admin);
    const target = await addMember(fx.agencyId, 'removed-meanwhile-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

    const [settled] = await settleBehindLock(
      target.membershipId,
      () => [patch(admin.cookie, fx.agencyId, target.membershipId, { jobTitle: 'Tarde demais' })],
      async (locker) => {
        await locker.raw("update public.agency_memberships set status = 'removed' where id = ?::uuid", [target.membershipId]);
      }
    );

    expect(settled.status).toBe(404);
    expect(await membershipRow(target.membershipId)).toMatchObject({ job_title: 'Editor', status: 'removed' });
  });

  describe('a permission revoked after the guard read it and before the row is written', () => {
    const revoke = (roleId: string, permissionKey: string) => async (locker: LockerTransaction): Promise<void> => {
      const deleted = await locker.raw<{ rowCount: number }>('delete from public.role_permissions where role_id = ?::uuid and permission_key = ?', [roleId, permissionKey]);
      expect(deleted.rowCount).toBe(1);
    };

    it('the UPDATE policy then filters the row and the route answers 403, not a 200 that changed nothing', async () => {
      const fx = await createAgency('revoked-policy');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.alterar_funcao']);
      const member = await addMember(fx.agencyId, 'revoked-policy-member', roleId);
      const target = await addMember(fx.agencyId, 'revoked-policy-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [patch(member.cookie, fx.agencyId, target.membershipId, { jobTitle: 'Sem permissão' })],
        revoke(roleId, 'colaborador.alterar_funcao')
      );

      expect(settled.status).toBe(403);
      expect(settled.body.error.code).toBe('FORBIDDEN');
      expect((await membershipRow(target.membershipId)).job_title).toBe('Editor');
    });

    it('the UPDATE trigger then refuses the field with 42501 and the route answers 403, not 500', async () => {
      const fx = await createAgency('revoked-trigger');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.alterar_funcao', 'colaborador.alterar_papel']);
      const member = await addMember(fx.agencyId, 'revoked-trigger-member', roleId);
      const target = await addMember(fx.agencyId, 'revoked-trigger-target', presetRoleIds.production, { jobTitle: 'Editor', acts: false });

      // Still holds alterar_papel, so the policy lets the row through and only the trigger can refuse.
      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [patch(member.cookie, fx.agencyId, target.membershipId, { jobTitle: 'Sem permissão' })],
        revoke(roleId, 'colaborador.alterar_funcao')
      );

      expect(settled.status).toBe(403);
      expect(settled.body.error.code).toBe('FORBIDDEN');
      expect((await membershipRow(target.membershipId)).job_title).toBe('Editor');
    });

    it('a grantee who loses atribuir_admin while queued does not hand out admin', async () => {
      const fx = await createAgency('revoked-grant');
      const roleId = await createCustomRole(fx.agencyId, ['colaborador.alterar_papel', 'colaborador.atribuir_admin']);
      const grantee = await addMember(fx.agencyId, 'revoked-grant-member', roleId);
      const target = await addMember(fx.agencyId, 'revoked-grant-target', presetRoleIds.production, { acts: false });

      const [settled] = await settleBehindLock(
        target.membershipId,
        () => [patch(grantee.cookie, fx.agencyId, target.membershipId, { roleId: presetRoleIds.admin })],
        revoke(roleId, 'colaborador.atribuir_admin')
      );

      expect(settled.status).toBe(403);
      expect((await membershipRow(target.membershipId)).role_id).toBe(presetRoleIds.production);
    });
  });
});

describe('the admin grant on invitations (issue #97)', { timeout: 60_000 }, () => {
  it('an Admin inviting someone as admin gets 403 and no invitation or e-mail; the Owner gets 201', async () => {
    const fx = await createAgency('invite');
    const admin = await addMember(fx.agencyId, 'invite-admin', presetRoleIds.admin);
    const sentBefore = sender.sent.length;

    const refused = await inviteCollaborator(admin.cookie, fx.agencyId, 'novo-admin@exemplo.test', presetRoleIds.admin);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<ApiErrorJson>().error.message).toBe(ADMIN_GRANT_MESSAGE);
    expect(await pendingInvitationCount(fx.agencyId)).toBe(0);
    expect(sender.sent.length).toBe(sentBefore);

    const allowedRole = await inviteCollaborator(admin.cookie, fx.agencyId, 'novo-producao@exemplo.test', presetRoleIds.production);
    expect(allowedRole.statusCode).toBe(201);

    const byOwner = await inviteCollaborator(fx.ownerCookie, fx.agencyId, 'novo-admin@exemplo.test', presetRoleIds.admin);
    expect(byOwner.statusCode).toBe(201);
    expect(await pendingInvitationCount(fx.agencyId)).toBe(2);
  });

  it('is decided by the permission: convidar alone cannot invite an admin, convidar plus atribuir_admin can', async () => {
    const fx = await createAgency('invite-perm');
    const onlyInvite = await addMember(fx.agencyId, 'invite-perm-one', await createCustomRole(fx.agencyId, ['colaborador.convidar']));
    const granter = await addMember(fx.agencyId, 'invite-perm-two', await createCustomRole(fx.agencyId, ['colaborador.convidar', 'colaborador.atribuir_admin']));

    expect((await inviteCollaborator(onlyInvite.cookie, fx.agencyId, 'a1@exemplo.test', presetRoleIds.production)).statusCode).toBe(201);
    const refused = await inviteCollaborator(onlyInvite.cookie, fx.agencyId, 'a2@exemplo.test', presetRoleIds.admin);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<ApiErrorJson>().error.message).toBe(ADMIN_GRANT_MESSAGE);
    expect((await inviteCollaborator(granter.cookie, fx.agencyId, 'a3@exemplo.test', presetRoleIds.admin)).statusCode).toBe(201);
  });

  it('resending an invitation that carries the admin role: 403 for an Admin and for a resend-only role, success for the Owner', async () => {
    const fx = await createAgency('resend');
    const admin = await addMember(fx.agencyId, 'resend-admin', presetRoleIds.admin);
    const onlyResend = await addMember(fx.agencyId, 'resend-only', await createCustomRole(fx.agencyId, ['convite.reenviar']));
    const created = await inviteCollaborator(fx.ownerCookie, fx.agencyId, 'reenviar-admin@exemplo.test', presetRoleIds.admin);
    expect(created.statusCode).toBe(201);
    const invitationId = created.json<{ invitationId: string }>().invitationId;
    const plain = await inviteCollaborator(admin.cookie, fx.agencyId, 'reenviar-plain@exemplo.test', presetRoleIds.production);
    const plainId = plain.json<{ invitationId: string }>().invitationId;

    for (const caller of [admin, onlyResend]) {
      const refused = await resendInvitation(caller.cookie, fx.agencyId, invitationId);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<ApiErrorJson>().error.message).toBe(ADMIN_GRANT_MESSAGE);
    }
    // The refused resend rolled back: the original is still the one pending invitation of that address.
    const stillPending = await owner.knex('invitations').where({ id: invitationId }).first('revoked_at', 'used_at');
    expect(stillPending).toMatchObject({ revoked_at: null, used_at: null });
    expect(await owner.knex('invitations').where({ agency_id: fx.agencyId, email: 'reenviar-admin@exemplo.test' }).count<{ count: string }>('id as count').first()).toMatchObject({ count: '1' });

    // A non-admin invitation is still resent by the same restricted callers.
    expect((await resendInvitation(onlyResend.cookie, fx.agencyId, plainId)).statusCode).toBe(200);

    const byOwner = await resendInvitation(fx.ownerCookie, fx.agencyId, invitationId);
    expect(byOwner.statusCode).toBe(200);
    const original = await owner.knex('invitations').where({ id: invitationId }).first('revoked_at');
    expect(original?.revoked_at).not.toBeNull();
  });

  it('turns an insufficient-privilege error from the invitation policy into 403, on create and on resend', async () => {
    const fx = await createAgency('invite-db-403');
    const created = await inviteCollaborator(fx.ownerCookie, fx.agencyId, 'resend-me@exemplo.test', presetRoleIds.production);
    const invitationId = created.json<{ invitationId: string }>().invitationId;

    await withTemporaryTrigger('invitations', 'insert', "new.email in ('forced-create@exemplo.test', 'resend-me@exemplo.test')", "raise exception using errcode = '42501', message = 'forced';", async () => {
      const onCreate = await inviteCollaborator(fx.ownerCookie, fx.agencyId, 'forced-create@exemplo.test', presetRoleIds.production);
      expect(onCreate.statusCode).toBe(403);
      expect(onCreate.json<ApiErrorJson>().error.message).toBe(GENERIC_FORBIDDEN_MESSAGE);
      const onResend = await resendInvitation(fx.ownerCookie, fx.agencyId, invitationId);
      expect(onResend.statusCode).toBe(403);
      expect(onResend.json<ApiErrorJson>().error.message).toBe(GENERIC_FORBIDDEN_MESSAGE);
    });
    const original = await owner.knex('invitations').where({ id: invitationId }).first('revoked_at');
    expect(original?.revoked_at).toBeNull();
  });
});
