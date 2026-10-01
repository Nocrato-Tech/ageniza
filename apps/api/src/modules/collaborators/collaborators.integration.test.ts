import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  captureLogs,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #95 acceptance tests. This is the product's first listing, so the suite also holds the
// contract every later listing copies: pagination by page, the global ceiling, the one ordering
// rule, and -- above all -- that the query starts from `agency_memberships` and never from
// `auth."user"`, which has no RLS (`specs/colaboradores.md` §5, rule 2).
const origin = { origin: TEST_APP_PUBLIC_URL };

const SYSTEM_PRESETS = ['admin', 'account_manager', 'production', 'sales', 'finance'] as const;
type SystemPreset = (typeof SYSTEM_PRESETS)[number];

interface CollaboratorJson {
  readonly membershipId: string;
  readonly name: string;
  readonly email: string;
  readonly photoUrl: string | null;
  readonly jobTitle: string | null;
  readonly role: { key: string; name: string };
  readonly isOwner: boolean;
  readonly status: 'active' | 'removed';
  readonly joinedAt: string;
}

interface PaginationMetaJson {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

interface CollaboratorListJson {
  readonly data: readonly CollaboratorJson[];
  readonly meta: PaginationMetaJson;
}

interface CollaboratorJobTitlesJson {
  readonly data: readonly string[];
}

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

let app: TestApp;
const owner = ownerClient();
// Captured so a test can prove a hostile filter never becomes a logged 500, and that an invalid
// photo key warns without leaking it. `warn` is enough for both and skips the cost of serializing
// every info line of the many logins this suite performs.
const logs = captureLogs('warn');
let presetRoleIds: Record<SystemPreset, string>;

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (emailLabel: string, name = 'Integration Test User'): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel, name });
  createdUserIds.push(user.id);
  return user;
};

const createAgency = async (name: string, ownerUserId: string | null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name, owner_user_id: ownerUserId, status: 'active' });
  return id;
};

const addAgencyMembership = async (
  agencyId: string,
  userId: string,
  roleId: string,
  jobTitle: string | null = null,
  status: 'active' | 'removed' = 'active'
): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId, job_title: jobTitle, status });
};

/** Agency with an owner who also holds the `admin` preset, like an activated agency. */
const createAgencyWithOwner = async (
  name: string,
  label: string,
  ownerName = 'Owner User'
): Promise<{ agencyId: string; ownerUser: TestUserFixture }> => {
  const ownerUser = await makeUser(`${label}-owner`, ownerName);
  const agencyId = await createAgency(name, ownerUser.id);
  await addAgencyMembership(agencyId, ownerUser.id, presetRoleIds.admin);
  return { agencyId, ownerUser };
};

const addMember = async (
  agencyId: string,
  input: { name: string; emailLabel: string; roleId: string; jobTitle?: string | null; status?: 'active' | 'removed' }
): Promise<TestUserFixture> => {
  const user = await makeUser(input.emailLabel, input.name);
  await addAgencyMembership(agencyId, user.id, input.roleId, input.jobTitle ?? null, input.status ?? 'active');
  return user;
};

/**
 * Same as `addMember`, but with a caller-chosen membership id and a bare user row (no credential
 * account): these members never sign in, so hashing a password just made the suite slower.
 */
const addMemberWithMembershipId = async (
  agencyId: string,
  input: { membershipId: string; name: string; emailLabel: string; roleId: string }
): Promise<string> => {
  const userId = randomUUID();
  createdUserIds.push(userId);
  await app.pool.query(
    'insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)',
    [userId, input.name, `${input.emailLabel}.${randomUUID().slice(0, 8)}@collab-integration.test`]
  );
  await owner.knex('agency_memberships').insert({ id: input.membershipId, agency_id: agencyId, user_id: userId, role_id: input.roleId, job_title: null, status: 'active' });
  return userId;
};

const membershipIdOf = async (agencyId: string, userId: string): Promise<string> => {
  const row = await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: userId }).first('id');
  return row.id as string;
};

/** An agency-scoped role with exactly the permissions given -- the strong custom-role fixture. */
const createCustomRole = async (agencyId: string, permissionKeys: readonly string[]): Promise<string> => {
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  if (permissionKeys.length > 0) {
    await owner.knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: roleId, permission_key })));
  }
  return roleId;
};

const getCollaborators = async (
  cookie: string | undefined,
  agencyId: string,
  query: Record<string, string | number> = {}
): Promise<{ status: number; body: CollaboratorListJson & ApiErrorJson }> => {
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)] as [string, string]));
  const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/collaborators${suffix}`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<CollaboratorListJson & ApiErrorJson>() };
};

const names = (body: CollaboratorListJson): string[] => body.data.map((item) => item.name);

const getCollaboratorDetail = async (
  cookie: string | undefined,
  agencyId: string,
  membershipId: string
): Promise<{ status: number; body: CollaboratorJson & ApiErrorJson }> => {
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/collaborators/${membershipId}`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<CollaboratorJson & ApiErrorJson>() };
};

const getJobTitles = async (
  cookie: string | undefined,
  agencyId: string
): Promise<{ status: number; body: CollaboratorJobTitlesJson & ApiErrorJson }> => {
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/collaborators/job-titles`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<CollaboratorJobTitlesJson & ApiErrorJson>() };
};

/** Inserts bare users (no credential account) in one statement -- the bulk pagination fixture. */
const insertBareUsers = async (count: number, label: string): Promise<string[]> => {
  const ids = Array.from({ length: count }, () => randomUUID());
  const values: unknown[] = [];
  const placeholders = ids.map((id, index) => {
    const base = index * 3;
    values.push(id, `Pessoa Cap ${String(index + 1).padStart(3, '0')}`, `${label}.${index + 1}.${randomUUID().slice(0, 8)}@collab-integration.test`);
    return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, false)`;
  }).join(', ');
  await app.pool.query(`insert into auth."user" (id, name, email, "emailVerified") values ${placeholders}`, values);
  createdUserIds.push(...ids);
  return ids;
};

describe('collaborators module (issue #95)', () => {
  beforeAll(async () => {
    app = await buildTestApp({ logger: logs.logger });
    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', [...SYSTEM_PRESETS]).select('id', 'key');
    presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<SystemPreset, string>;
    for (const preset of SYSTEM_PRESETS) {
      if (presetRoleIds[preset] === undefined) throw new Error(`System role seed is missing: ${preset}`);
    }
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
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

  it('#95: the five presets receive the same list and the same totalItems', async () => {
    const { agencyId } = await createAgencyWithOwner('Colab Same List', 'same');
    const viewers: TestUserFixture[] = [];
    for (const preset of SYSTEM_PRESETS) {
      viewers.push(await addMember(agencyId, { name: `Pessoa ${preset}`, emailLabel: `same-${preset}`, roleId: presetRoleIds[preset] }));
    }

    const expected = await getCollaborators(await loginCookie(viewers[0]!), agencyId);
    expect(expected.status).toBe(200);
    expect(expected.body.meta.totalItems).toBe(6);
    for (const viewer of viewers) {
      const response = await getCollaborators(await loginCookie(viewer), agencyId);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expected.body);
    }
  });

  it('#95: without pageSize there are 24 per page, with pageSize=500 at most 100 -- it limits, never refuses', async () => {
    const { agencyId } = await createAgencyWithOwner('Colab Pagination', 'pagination');
    const viewer = await addMember(agencyId, { name: 'Ana Cap Viewer', emailLabel: 'cap-viewer', roleId: presetRoleIds.production });
    const bare = await insertBareUsers(101, 'cap');
    await owner.knex('agency_memberships').insert(bare.map((userId) => ({ agency_id: agencyId, user_id: userId, role_id: presetRoleIds.production })));
    const cookie = await loginCookie(viewer);

    const defaultPage = await getCollaborators(cookie, agencyId);
    expect(defaultPage.status).toBe(200);
    // 101 bulk members + the viewer + the owner.
    expect(defaultPage.body.meta).toEqual({ page: 1, pageSize: 24, totalItems: 103, totalPages: 5 });
    expect(defaultPage.body.data).toHaveLength(24);

    const capped = await getCollaborators(cookie, agencyId, { pageSize: 500 });
    expect(capped.status).toBe(200);
    expect(capped.body.meta.pageSize).toBe(100);
    expect(capped.body.meta.totalItems).toBe(103);
    expect(capped.body.data).toHaveLength(100);

    // A huge `page` is a 400, never a 500 from an overflowing OFFSET (pagination.ts `.safe()`).
    for (const page of ['1e20', '4e17']) {
      const overflow = await getCollaborators(cookie, agencyId, { page });
      expect(overflow.status).toBe(400);
      expect(overflow.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('#95: the order is always name ascending', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Ordering', 'ordering', 'Bruno Costa');
    await addMember(agencyId, { name: 'Zelia Prado', emailLabel: 'order-zelia', roleId: presetRoleIds.production });
    await addMember(agencyId, { name: 'Ana Alves', emailLabel: 'order-ana', roleId: presetRoleIds.sales });
    expect(ownerUser.name).toBe('Bruno Costa');

    const response = await getCollaborators(await loginCookie(ownerUser), agencyId);
    expect(response.status).toBe(200);
    expect(names(response.body)).toEqual(['Ana Alves', 'Bruno Costa', 'Zelia Prado']);
  });

  it('#95: q finds by part of the name and part of the email, case-insensitively, and escapes wildcards', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Search', 'search', 'Owner Search');
    await addMember(agencyId, { name: 'Fernanda Alves', emailLabel: 'avatar.principal', roleId: presetRoleIds.production });
    await addMember(agencyId, { name: 'Carlos Pereira', emailLabel: 'financeiro.novo', roleId: presetRoleIds.sales });
    const cookie = await loginCookie(ownerUser);

    const byName = await getCollaborators(cookie, agencyId, { q: 'nanda' });
    expect(names(byName.body)).toEqual(['Fernanda Alves']);
    const byNameUpper = await getCollaborators(cookie, agencyId, { q: 'NANDA' });
    expect(names(byNameUpper.body)).toEqual(['Fernanda Alves']);

    const byEmail = await getCollaborators(cookie, agencyId, { q: 'financeiro' });
    expect(names(byEmail.body)).toEqual(['Carlos Pereira']);
    const byEmailUpper = await getCollaborators(cookie, agencyId, { q: 'FINANCEIRO' });
    expect(names(byEmailUpper.body)).toEqual(['Carlos Pereira']);

    // `%` and `_` are ILIKE metacharacters; escaped, they are literal and match nothing here. A
    // mutation that drops the escaping returns every row.
    for (const q of ['%', '_']) {
      const wildcard = await getCollaborators(cookie, agencyId, { q });
      expect(wildcard.body.meta.totalItems).toBe(0);
      expect(wildcard.body.data).toHaveLength(0);
    }
  });

  it('#95: role and jobTitle filter alone and combined, and the combination reflects in totalItems', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Filters', 'filters');
    const alice = await addMember(agencyId, { name: 'Alice Editora', emailLabel: 'filter-alice', roleId: presetRoleIds.production, jobTitle: 'Editor de Vídeo' });
    const bob = await addMember(agencyId, { name: 'Bob Designer', emailLabel: 'filter-bob', roleId: presetRoleIds.production, jobTitle: 'Designer' });
    const carol = await addMember(agencyId, { name: 'Carol Editora', emailLabel: 'filter-carol', roleId: presetRoleIds.sales, jobTitle: 'Editor de Vídeo' });
    const cookie = await loginCookie(ownerUser);

    const membershipIdOf = async (userId: string): Promise<string> => {
      const row = await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: userId }).first('id');
      return row.id as string;
    };
    const [aliceId, bobId, carolId] = await Promise.all([membershipIdOf(alice.id), membershipIdOf(bob.id), membershipIdOf(carol.id)]);

    const byRole = await getCollaborators(cookie, agencyId, { role: 'production' });
    expect(byRole.body.meta.totalItems).toBe(2);
    expect(byRole.body.data.map((item) => item.membershipId).sort()).toEqual([aliceId, bobId].sort());

    const byJobTitle = await getCollaborators(cookie, agencyId, { jobTitle: 'Editor de Vídeo' });
    expect(byJobTitle.body.meta.totalItems).toBe(2);
    expect(byJobTitle.body.data.map((item) => item.membershipId).sort()).toEqual([aliceId, carolId].sort());

    const combined = await getCollaborators(cookie, agencyId, { role: 'production', jobTitle: 'Editor de Vídeo' });
    expect(combined.body.meta.totalItems).toBe(1);
    expect(combined.body.data.map((item) => item.membershipId)).toEqual([aliceId]);
  });

  it('#95: isolation -- the list of A never brings B, with or without q', async () => {
    const alpha = await createAgencyWithOwner('Isolamento Alfa', 'iso-alpha', 'Alice Alfa');
    const beta = await createAgencyWithOwner('Isolamento Alfa Beta', 'iso-beta', 'Bob Beta');

    // The same person belongs to BOTH agencies. That is deliberate: `agency_memberships_select`
    // only shows the agency's links to someone who is a member of it, so a viewer with a single
    // membership would let RLS hide a query that forgot the agency filter (issue #186 lesson).
    const viewer = await addMember(alpha.agencyId, { name: 'Victor Viewer', emailLabel: 'iso-viewer', roleId: presetRoleIds.admin });
    await addAgencyMembership(beta.agencyId, viewer.id, presetRoleIds.admin);
    await addMember(alpha.agencyId, { name: 'Ana Alfa', emailLabel: 'iso-ana', roleId: presetRoleIds.production });
    await addMember(beta.agencyId, { name: 'Zeca Beta', emailLabel: 'iso-zeca', roleId: presetRoleIds.production });
    const cookie = await loginCookie(viewer);

    const listAlpha = await getCollaborators(cookie, alpha.agencyId);
    expect(listAlpha.status).toBe(200);
    expect(listAlpha.body.meta.totalItems).toBe(3);
    expect(names(listAlpha.body).sort()).toEqual(['Alice Alfa', 'Ana Alfa', 'Victor Viewer'].sort());
    expect(names(listAlpha.body)).not.toContain('Bob Beta');
    expect(names(listAlpha.body)).not.toContain('Zeca Beta');

    const listBeta = await getCollaborators(cookie, beta.agencyId);
    expect(listBeta.status).toBe(200);
    expect(names(listBeta.body).sort()).toEqual(['Bob Beta', 'Victor Viewer', 'Zeca Beta'].sort());
    expect(names(listBeta.body)).not.toContain('Alice Alfa');
    expect(names(listBeta.body)).not.toContain('Ana Alfa');

    // The search must filter by the ally agency too: a subquery resolving users by name before
    // scoping would leak Zeca into A's result.
    const searchAlpha = await getCollaborators(cookie, alpha.agencyId, { q: 'Zeca' });
    expect(searchAlpha.body.meta.totalItems).toBe(0);
    expect(searchAlpha.body.data).toHaveLength(0);
    const searchAlphaOwn = await getCollaborators(cookie, alpha.agencyId, { q: 'Ana' });
    expect(names(searchAlphaOwn.body)).toEqual(['Ana Alfa']);
  });

  it('#95: status=removed is refused for every role and removed links never appear by default', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Removed', 'removed', 'Owner Removed');
    const production = await addMember(agencyId, { name: 'Pessoa Produção', emailLabel: 'removed-production', roleId: presetRoleIds.production });
    const onlyVisualizar = await createCustomRole(agencyId, ['colaborador.visualizar']);
    const customRole = await addMember(agencyId, { name: 'Pessoa Papel Personalizado', emailLabel: 'removed-custom', roleId: onlyVisualizar });
    await addMember(agencyId, { name: 'Pessoa Removida', emailLabel: 'removed-gone', roleId: presetRoleIds.production, status: 'removed' });

    // Owner, Produção and a custom role that only holds `colaborador.visualizar`: revealing removed
    // links requires an administrative permission (SPEC §5, rule 9), so all three are refused until
    // the removal task (#98) adds the value together with that guard.
    for (const user of [ownerUser, production, customRole]) {
      const cookie = await loginCookie(user);
      const defaultList = await getCollaborators(cookie, agencyId);
      expect(defaultList.status).toBe(200);
      expect(names(defaultList.body)).not.toContain('Pessoa Removida');

      const refused = await getCollaborators(cookie, agencyId, { status: 'removed' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_ERROR');

      const active = await getCollaborators(cookie, agencyId, { status: 'active' });
      expect(active.status).toBe(200);
      expect(names(active.body)).not.toContain('Pessoa Removida');
    }
  });

  it('#95: a NUL byte or a control character in a filter is a 400, never a logged 500', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Control', 'control');
    const cookie = await loginCookie(ownerUser);
    const before = logs.lines().length;

    const hostile: readonly Record<string, string>[] = [
      { q: '\u0000' },
      { q: 'ana\u0001maria' },
      { role: 'a\u0000b' },
      { role: 'a\u001fb' },
      { jobTitle: '\u0000' },
      { jobTitle: 'x\u007fy' }
    ];
    for (const query of hostile) {
      const response = await getCollaborators(cookie, agencyId, query);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const during = logs.lines().slice(before).join('\n');
    expect(during).not.toContain('"level":50');
    expect(during).not.toContain('INTERNAL_ERROR');
  });

  it('#95: same-name people page without repetition or loss, held stable by the membership id', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Tiebreak', 'tiebreak', 'Owner Tiebreak');
    const membershipIds = Array.from({ length: 12 }, () => randomUUID());
    // Insert in descending id order: the heap order is the reverse of the expected tie-break order,
    // so dropping `membership.id` from `order by` cannot pass by accident.
    for (const membershipId of [...membershipIds].sort().reverse()) {
      await addMemberWithMembershipId(agencyId, {
        membershipId,
        name: 'Pessoa Repetida',
        emailLabel: `tiebreak-${membershipId.slice(0, 8)}`,
        roleId: presetRoleIds.production
      });
    }
    const cookie = await loginCookie(ownerUser);

    const collected: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const response = await getCollaborators(cookie, agencyId, { page, pageSize: 4 });
      expect(response.status).toBe(200);
      collected.push(...response.body.data.map((item) => item.membershipId));
    }

    // `Owner Tiebreak` sorts before `Pessoa Repetida`; the twelve identical names must come in
    // membership-id order, each exactly once, across the page boundaries.
    expect(collected).toHaveLength(13);
    expect(new Set(collected).size).toBe(13);
    expect(collected).toEqual([await membershipIdOf(agencyId, ownerUser.id), ...[...membershipIds].sort()]);
  });

  it('#95: a link pointing at another agency role never appears in this agency list', async () => {
    const alpha = await createAgencyWithOwner('Colab Escopo Papel A', 'scope-a', 'Owner Escopo A');
    const beta = await createAgencyWithOwner('Colab Escopo Papel B', 'scope-b', 'Owner Escopo B');
    // The viewer is a member of BOTH agencies, so `roles_select` shows B's role and only the
    // explicit role-scope filter can keep it out of A's list (issue #186 lesson).
    const viewer = await addMember(alpha.agencyId, { name: 'Viewer Escopo', emailLabel: 'scope-viewer', roleId: presetRoleIds.admin });
    await addAgencyMembership(beta.agencyId, viewer.id, presetRoleIds.admin);
    const foreignRole = await createCustomRole(beta.agencyId, ['colaborador.visualizar']);
    await addMemberWithMembershipId(alpha.agencyId, {
      membershipId: randomUUID(),
      name: 'Pessoa Papel Externo',
      emailLabel: 'scope-foreign',
      roleId: foreignRole
    });
    await addMember(alpha.agencyId, { name: 'Pessoa Normal A', emailLabel: 'scope-normal', roleId: presetRoleIds.production });

    const response = await getCollaborators(await loginCookie(viewer), alpha.agencyId);
    expect(response.status).toBe(200);
    expect(names(response.body)).not.toContain('Pessoa Papel Externo');
    expect(names(response.body)).toContain('Pessoa Normal A');
  });

  it('#95: without colaborador.visualizar a member receives 403; without agency access, the same 404', async () => {
    const { agencyId } = await createAgencyWithOwner('Colab Authz', 'authz');
    const visualizadorRole = await createCustomRole(agencyId, ['colaborador.visualizar']);
    const otherRole = await createCustomRole(agencyId, ['cliente.visualizar']);
    const allowed = await addMember(agencyId, { name: 'Pessoa Permitida', emailLabel: 'authz-allowed', roleId: visualizadorRole });
    const denied = await addMember(agencyId, { name: 'Pessoa Negada', emailLabel: 'authz-denied', roleId: otherRole });

    const allowedResponse = await getCollaborators(await loginCookie(allowed), agencyId);
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.body.meta.totalItems).toBe(3);

    const deniedResponse = await getCollaborators(await loginCookie(denied), agencyId);
    expect(deniedResponse.status).toBe(403);
    expect(deniedResponse.body.error.code).toBe('FORBIDDEN');

    const { agencyId: otherAgencyId } = await createAgencyWithOwner('Colab Authz Other', 'authz-other');
    const outsider = await addMember(otherAgencyId, { name: 'Pessoa De Fora', emailLabel: 'authz-outsider', roleId: presetRoleIds.admin });
    const outsiderCookie = await loginCookie(outsider);

    const noAccess = await getCollaborators(outsiderCookie, agencyId);
    const nonexistent = await getCollaborators(outsiderCookie, randomUUID());
    expect(noAccess.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    // Indistinguishable, not merely both 404.
    expect(noAccess.body.error).toEqual(nonexistent.body.error);
    expect(noAccess.body.error).toEqual({ code: 'NOT_FOUND', message: 'Agency not found.' });

    const unauthenticatedResponse = await getCollaborators(undefined, agencyId);
    expect(unauthenticatedResponse.status).toBe(401);
  });

  it('#95: the response carries only the six allowed fields, with a signed photo URL and the membership date', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Shape', 'shape', 'Owner Shape');
    const withPhoto = await addMember(agencyId, { name: 'Com Foto', emailLabel: 'shape-photo', roleId: presetRoleIds.production, jobTitle: 'Editor de Vídeo' });
    const storageKey = `users/${withPhoto.id}/avatar/${randomUUID()}.png`;
    await app.pool.query('update auth."user" set image = $1 where id = $2', [storageKey, withPhoto.id]);

    const cookie = await loginCookie(ownerUser);
    const response = await getCollaborators(cookie, agencyId);
    expect(response.status).toBe(200);

    const photoRow = response.body.data.find((item) => item.name === 'Com Foto');
    expect(photoRow?.photoUrl).toContain('X-Amz-Signature');
    expect(photoRow?.jobTitle).toBe('Editor de Vídeo');
    expect(photoRow?.isOwner).toBe(false);
    expect(photoRow?.status).toBe('active');
    expect(Object.keys(photoRow!).sort()).toEqual(
      ['email', 'isOwner', 'jobTitle', 'joinedAt', 'membershipId', 'name', 'photoUrl', 'role', 'status'].sort()
    );

    // The signed URL lasts exactly as long as the configured identity download expiry.
    const signedPhoto = new URL(photoRow!.photoUrl!);
    const configuredExpiry = app.config.identityStorage?.downloadUrlExpirySeconds;
    expect(configuredExpiry).toBeDefined();
    expect(signedPhoto.searchParams.get('X-Amz-Expires')).toBe(String(configuredExpiry));

    const membership = await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: withPhoto.id }).first('created_at');
    expect(photoRow?.joinedAt).toEqual(new Date(membership.created_at).toISOString());

    const ownerRow = response.body.data.find((item) => item.name === 'Owner Shape');
    expect(ownerRow?.isOwner).toBe(true);
    expect(ownerRow?.photoUrl).toBeNull();

    // Remuneration does not exist in this module and must never appear.
    expect(JSON.stringify(response.body)).not.toMatch(/salar|remunera|salary|compensation/i);
  });

  it('#95: an identity key that cannot be signed degrades to photoUrl null with a key-free warning', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Bad Photo', 'bad-photo', 'Owner Bad Photo');
    const withInvalidPhoto = await addMember(agencyId, { name: 'Foto Inválida', emailLabel: 'bad-photo-member', roleId: presetRoleIds.production });
    // No known image extension: `presignGetObject` refuses it, which used to fail the whole page.
    const invalidKey = `users/${withInvalidPhoto.id}/avatar`;
    await app.pool.query('update auth."user" set image = $1 where id = $2', [invalidKey, withInvalidPhoto.id]);

    const before = logs.lines().length;
    const response = await getCollaborators(await loginCookie(ownerUser), agencyId);
    expect(response.status).toBe(200);
    const row = response.body.data.find((item) => item.name === 'Foto Inválida');
    expect(row?.photoUrl).toBeNull();

    const during = logs.lines().slice(before).join('\n');
    expect(during).toContain('IDENTITY_PHOTO_PRESIGN_FAILED');
    // The key carries a user id; the warning must never include it.
    expect(during).not.toContain(invalidKey);
    expect(during).not.toContain(withInvalidPhoto.id);
  });

  it('#96: the detail is exactly the listing item for one membership', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Detail', 'detail', 'Owner Detail');
    const person = await addMember(agencyId, { name: 'Detalhe Pessoa', emailLabel: 'detail-person', roleId: presetRoleIds.production, jobTitle: 'Editor de Vídeo' });
    const membershipId = await membershipIdOf(agencyId, person.id);
    const cookie = await loginCookie(ownerUser);

    const list = await getCollaborators(cookie, agencyId);
    const fromList = list.body.data.find((item) => item.membershipId === membershipId);
    const detail = await getCollaboratorDetail(cookie, agencyId, membershipId);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(fromList);
    expect(Object.keys(detail.body).sort()).toEqual(
      ['email', 'isOwner', 'jobTitle', 'joinedAt', 'membershipId', 'name', 'photoUrl', 'role', 'status'].sort()
    );
    expect(JSON.stringify(detail.body)).not.toMatch(/salar|remunera|salary|compensation/i);
  });

  it('#226: the detail rejects an unknown query parameter, like the listing', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Detail Query', 'detail-query', 'Owner Detail Query');
    const person = await addMember(agencyId, { name: 'Pessoa Query', emailLabel: 'detail-query-person', roleId: presetRoleIds.production });
    const membershipId = await membershipIdOf(agencyId, person.id);
    const cookie = await loginCookie(ownerUser);

    const accepted = await app.app.inject({
      method: 'GET',
      url: `/agencies/${agencyId}/collaborators/${membershipId}`,
      headers: { ...origin, cookie }
    });
    expect(accepted.statusCode).toBe(200);

    const rejected = await app.app.inject({
      method: 'GET',
      url: `/agencies/${agencyId}/collaborators/${membershipId}?x=1`,
      headers: { ...origin, cookie }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('#96: a membership of another agency answers the same 404 and leaks no user data', async () => {
    const alpha = await createAgencyWithOwner('Colab BOLA Alfa', 'bola-alpha', 'Owner BOLA Alfa');
    const beta = await createAgencyWithOwner('Colab BOLA Beta', 'bola-beta', 'Owner BOLA Beta');
    // The viewer belongs to BOTH agencies, so `agency_memberships_select` shows B's link and only
    // the query's own agency filter can keep it out (issue #186 lesson).
    const viewer = await addMember(alpha.agencyId, { name: 'Viewer BOLA', emailLabel: 'bola-viewer', roleId: presetRoleIds.admin });
    await addAgencyMembership(beta.agencyId, viewer.id, presetRoleIds.admin);
    const target = await addMember(alpha.agencyId, { name: 'Pessoa Alvo', emailLabel: 'bola-target', roleId: presetRoleIds.production });
    await addAgencyMembership(beta.agencyId, target.id, presetRoleIds.production);
    const foreignMembershipId = await membershipIdOf(beta.agencyId, target.id);
    const cookie = await loginCookie(viewer);

    const foreign = await getCollaboratorDetail(cookie, alpha.agencyId, foreignMembershipId);
    const nonexistent = await getCollaboratorDetail(cookie, alpha.agencyId, randomUUID());
    const malformed = await getCollaboratorDetail(cookie, alpha.agencyId, 'not-a-uuid');

    expect(foreign.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(foreign.body.error).toEqual(nonexistent.body.error);
    expect(malformed.body.error).toEqual(foreign.body.error);
    expect(foreign.body.error).toEqual({ code: 'NOT_FOUND', message: 'Collaborator not found.' });
    // The foreign link's owner is never disclosed through this route.
    expect(JSON.stringify(foreign.body)).not.toContain(target.email);
    expect(JSON.stringify(foreign.body)).not.toContain('Pessoa Alvo');
  });

  it('#96: a removed link is not revealed by the detail', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Detail Removed', 'detail-removed', 'Owner Detail Removed');
    const removed = await addMember(agencyId, { name: 'Pessoa Removida Detalhe', emailLabel: 'detail-removed-person', roleId: presetRoleIds.production, status: 'removed' });
    const response = await getCollaboratorDetail(await loginCookie(ownerUser), agencyId, await membershipIdOf(agencyId, removed.id));
    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({ code: 'NOT_FOUND', message: 'Collaborator not found.' });
  });

  it('#96: without colaborador.visualizar the detail answers 403', async () => {
    const { agencyId } = await createAgencyWithOwner('Colab Detail Authz', 'detail-authz');
    const person = await addMember(agencyId, { name: 'Pessoa Detalhe Authz', emailLabel: 'detail-authz-person', roleId: presetRoleIds.production });
    const deniedRole = await createCustomRole(agencyId, ['cliente.visualizar']);
    const denied = await addMember(agencyId, { name: 'Pessoa Negada Detalhe', emailLabel: 'detail-authz-denied', roleId: deniedRole });

    const response = await getCollaboratorDetail(await loginCookie(denied), agencyId, await membershipIdOf(agencyId, person.id));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('#96: a caller without access to the agency gets the agency 404', async () => {
    const { agencyId } = await createAgencyWithOwner('Colab Detail No Access', 'detail-no-access');
    const other = await createAgencyWithOwner('Colab Detail No Access Other', 'detail-no-access-other');
    const outsider = await addMember(other.agencyId, { name: 'Outsider Detalhe', emailLabel: 'detail-outsider', roleId: presetRoleIds.admin });

    const response = await getCollaboratorDetail(await loginCookie(outsider), agencyId, randomUUID());
    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({ code: 'NOT_FOUND', message: 'Agency not found.' });
  });

  describe('job titles of the agency (issue #218)', () => {
    it('returns only the route agency titles for a viewer linked to both', async () => {
      const alpha = await createAgencyWithOwner('Cargos Alfa', 'jobs-alpha', 'Owner Cargos Alfa');
      const beta = await createAgencyWithOwner('Cargos Beta', 'jobs-beta', 'Owner Cargos Beta');
      // The same person belongs to BOTH agencies: `agency_memberships_select` shows both, so only
      // the query's own agency filter separates them (issue #186 lesson).
      const viewer = await addMember(alpha.agencyId, { name: 'Viewer Cargos', emailLabel: 'jobs-viewer', roleId: presetRoleIds.admin, jobTitle: 'Gestora de contas' });
      await addAgencyMembership(beta.agencyId, viewer.id, presetRoleIds.admin, 'Diretor de arte');
      await addMember(alpha.agencyId, { name: 'Ana Alfa Cargos', emailLabel: 'jobs-ana', roleId: presetRoleIds.production, jobTitle: 'Editor de Vídeo' });
      await addMember(beta.agencyId, { name: 'Zeca Beta Cargos', emailLabel: 'jobs-zeca', roleId: presetRoleIds.production, jobTitle: 'Redator' });
      const cookie = await loginCookie(viewer);

      const alphaTitles = await getJobTitles(cookie, alpha.agencyId);
      expect(alphaTitles.status).toBe(200);
      expect(alphaTitles.body.data).toEqual(['Editor de Vídeo', 'Gestora de contas']);

      const betaTitles = await getJobTitles(cookie, beta.agencyId);
      expect(betaTitles.status).toBe(200);
      expect(betaTitles.body.data).toEqual(['Diretor de arte', 'Redator']);
    });

    it('never counts a removed link', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos Removidos', 'jobs-removed', 'Owner Cargos Removidos');
      await addMember(agencyId, { name: 'Ativo Cargo', emailLabel: 'jobs-active', roleId: presetRoleIds.production, jobTitle: 'Cargo Ativo' });
      await addMember(agencyId, { name: 'Removido Cargo', emailLabel: 'jobs-removed-person', roleId: presetRoleIds.production, jobTitle: 'Cargo Removido', status: 'removed' });

      const response = await getJobTitles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(['Cargo Ativo']);
      expect(response.body.data).not.toContain('Cargo Removido');
    });

    it('collapses duplicates and surrounding spaces, dropping blanks and nulls', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos Duplicados', 'jobs-dupes', 'Owner Cargos Duplicados');
      await addMember(agencyId, { name: 'Pessoa Um', emailLabel: 'jobs-dup-1', roleId: presetRoleIds.production, jobTitle: 'Editor de Vídeo' });
      await addMember(agencyId, { name: 'Pessoa Dois', emailLabel: 'jobs-dup-2', roleId: presetRoleIds.production, jobTitle: '  Editor de Vídeo  ' });
      await addMember(agencyId, { name: 'Pessoa Três', emailLabel: 'jobs-dup-3', roleId: presetRoleIds.production, jobTitle: 'Designer' });
      await addMember(agencyId, { name: 'Pessoa Quatro', emailLabel: 'jobs-dup-4', roleId: presetRoleIds.production, jobTitle: '   ' });
      await addMember(agencyId, { name: 'Pessoa Cinco', emailLabel: 'jobs-dup-5', roleId: presetRoleIds.production, jobTitle: null });

      const response = await getJobTitles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      // Trimmed duplicates fold into one, the blank and the null are absent, and the order is A-Z.
      expect(response.body.data).toEqual(['Designer', 'Editor de Vídeo']);
    });

    it('caps the list at 200 values, alphabetically', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos Cap', 'jobs-cap', 'Owner Cargos Cap');
      const bare = await insertBareUsers(205, 'jobs-cap');
      await owner.knex('agency_memberships').insert(bare.map((userId, index) => ({
        agency_id: agencyId, user_id: userId, role_id: presetRoleIds.production, job_title: `Cargo ${String(index + 1).padStart(3, '0')}`
      })));

      const response = await getJobTitles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(200);
      expect(response.body.data[0]).toBe('Cargo 001');
      expect(response.body.data[199]).toBe('Cargo 200');
    });

    it('refuses a member without colaborador.visualizar with 403, and an outsider with the agency 404', async () => {
      const { agencyId } = await createAgencyWithOwner('Cargos Authz', 'jobs-authz');
      const visualizadorRole = await createCustomRole(agencyId, ['colaborador.visualizar']);
      const deniedRole = await createCustomRole(agencyId, ['cliente.visualizar']);
      const allowed = await addMember(agencyId, { name: 'Permitida Cargos', emailLabel: 'jobs-authz-allowed', roleId: visualizadorRole });
      const denied = await addMember(agencyId, { name: 'Negada Cargos', emailLabel: 'jobs-authz-denied', roleId: deniedRole });

      const allowedResponse = await getJobTitles(await loginCookie(allowed), agencyId);
      expect(allowedResponse.status).toBe(200);
      expect(allowedResponse.body).toEqual({ data: [] });

      const deniedResponse = await getJobTitles(await loginCookie(denied), agencyId);
      expect(deniedResponse.status).toBe(403);
      expect(deniedResponse.body.error.code).toBe('FORBIDDEN');

      const { agencyId: otherAgencyId } = await createAgencyWithOwner('Cargos Authz Other', 'jobs-authz-other');
      const outsider = await addMember(otherAgencyId, { name: 'De Fora Cargos', emailLabel: 'jobs-authz-outsider', roleId: presetRoleIds.admin });
      const outsiderCookie = await loginCookie(outsider);

      const noAccess = await getJobTitles(outsiderCookie, agencyId);
      const nonexistent = await getJobTitles(outsiderCookie, randomUUID());
      expect(noAccess.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      expect(noAccess.body.error).toEqual(nonexistent.body.error);
      expect(noAccess.body.error).toEqual({ code: 'NOT_FOUND', message: 'Agency not found.' });

      const unauthenticated = await getJobTitles(undefined, agencyId);
      expect(unauthenticated.status).toBe(401);
    });

    it('is matched as the literal path, never as a membership id', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos Order', 'jobs-order', 'Owner Cargos Order');
      // The detail route answers 404 "Collaborator not found." for a non-UUID membership id; a 200
      // here proves the literal route won the match even though it is a sibling of that param route.
      const response = await getJobTitles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
    });

    it('#226: rejects an unknown query parameter, like the detail and the listing', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos Query', 'jobs-query', 'Owner Cargos Query');
      const cookie = await loginCookie(ownerUser);

      const accepted = await app.app.inject({
        method: 'GET',
        url: `/agencies/${agencyId}/collaborators/job-titles`,
        headers: { ...origin, cookie }
      });
      expect(accepted.statusCode).toBe(200);

      const rejected = await app.app.inject({
        method: 'GET',
        url: `/agencies/${agencyId}/collaborators/job-titles?x=1`,
        headers: { ...origin, cookie }
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    });
  });
});
