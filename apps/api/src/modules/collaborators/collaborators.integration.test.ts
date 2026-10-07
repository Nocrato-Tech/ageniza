import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CollaboratorJobTitlesResponseSchema } from '@ageniza/contracts';

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
  readonly isSelf: boolean;
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

interface AgencyRoleJson {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

interface AgencyRolesJson {
  readonly data: readonly AgencyRoleJson[];
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

const getRoles = async (
  cookie: string | undefined,
  agencyId: string
): Promise<{ status: number; body: AgencyRolesJson & ApiErrorJson }> => {
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/roles`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<AgencyRolesJson & ApiErrorJson>() };
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

    // `isSelf` (issue #286) is the one field that legitimately differs: each viewer sees their own
    // link marked. Everything else is compared as it was, and the mark is checked for each viewer.
    const withoutSelf = (body: CollaboratorListJson) => ({ ...body, data: body.data.map((item) => ({ ...item, isSelf: false })) });
    const expected = await getCollaborators(await loginCookie(viewers[0]!), agencyId);
    expect(expected.status).toBe(200);
    expect(expected.body.meta.totalItems).toBe(6);
    for (const viewer of viewers) {
      const response = await getCollaborators(await loginCookie(viewer), agencyId);
      expect(response.status).toBe(200);
      expect(withoutSelf(response.body)).toEqual(withoutSelf(expected.body));
      expect(response.body.data.filter((item) => item.isSelf).map((item) => item.membershipId)).toEqual([await membershipIdOf(agencyId, viewer.id)]);
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

  // Issue #355: the order folds accents and case before comparing, so it does not depend on the
  // database collation; ties are held by the membership id, as everywhere else in the listing.
  it('#355: orders by name ignoring accents and case, with the membership id as tie-break', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Ordering Accents', 'ordering-accents', 'Owner Ordering Accent');
    const membershipId = (suffix: number): string => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    const people = [
      { name: 'Ágata', suffix: 1 },
      { name: 'álvaro', suffix: 2 },
      { name: 'Beatriz', suffix: 3 },
      { name: 'Édson', suffix: 4 },
      { name: 'eduardo', suffix: 5 },
      // `Ana` folds to the same `ana` as `ana`; the id (06 < 07) is what holds their order, where
      // the raw database collation would put `ana` first — which is exactly what this test refuses.
      { name: 'Ana', suffix: 6 },
      { name: 'ana', suffix: 7 }
    ];
    for (const person of people) {
      await addMemberWithMembershipId(agencyId, {
        membershipId: membershipId(person.suffix),
        name: person.name,
        emailLabel: `ordering-accents-${person.suffix}`,
        roleId: presetRoleIds.production
      });
    }

    const response = await getCollaborators(await loginCookie(ownerUser), agencyId);
    expect(response.status).toBe(200);
    // Folded: agata, alvaro, ana, ana, beatriz, edson, eduardo, owner ordering accent.
    expect(names(response.body)).toEqual(['Ágata', 'álvaro', 'Ana', 'ana', 'Beatriz', 'Édson', 'eduardo', 'Owner Ordering Accent']);
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

  it('#95/#98: removed links never appear by default, and status=removed is for whoever may remove or reactivate', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Removed', 'removed', 'Owner Removed');
    const production = await addMember(agencyId, { name: 'Pessoa Produção', emailLabel: 'removed-production', roleId: presetRoleIds.production });
    const onlyVisualizar = await createCustomRole(agencyId, ['colaborador.visualizar']);
    const customRole = await addMember(agencyId, { name: 'Pessoa Papel Personalizado', emailLabel: 'removed-custom', roleId: onlyVisualizar });
    await addMember(agencyId, { name: 'Pessoa Removida', emailLabel: 'removed-gone', roleId: presetRoleIds.production, status: 'removed' });

    // Produção and a custom role that only holds `colaborador.visualizar` may not reveal removed
    // links (SPEC §5, rule 9): 403, and the default and `active` lists never show them either. The
    // Owner may, and so may the roles of the removal suite (`collaborators-removal.integration.test.ts`).
    for (const user of [production, customRole]) {
      const cookie = await loginCookie(user);
      const defaultList = await getCollaborators(cookie, agencyId);
      expect(defaultList.status).toBe(200);
      expect(names(defaultList.body)).not.toContain('Pessoa Removida');

      const refused = await getCollaborators(cookie, agencyId, { status: 'removed' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');

      const active = await getCollaborators(cookie, agencyId, { status: 'active' });
      expect(active.status).toBe(200);
      expect(names(active.body)).not.toContain('Pessoa Removida');
    }

    const ownerCookie = await loginCookie(ownerUser);
    const ownerDefault = await getCollaborators(ownerCookie, agencyId);
    expect(names(ownerDefault.body)).not.toContain('Pessoa Removida');
    const ownerRemoved = await getCollaborators(ownerCookie, agencyId, { status: 'removed' });
    expect(ownerRemoved.status).toBe(200);
    expect(names(ownerRemoved.body)).toEqual(['Pessoa Removida']);
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

  it('#95: the response carries only the allowed fields, with a signed photo URL and the membership date', async () => {
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
      ['email', 'isOwner', 'isSelf', 'jobTitle', 'joinedAt', 'membershipId', 'name', 'photoUrl', 'role', 'status'].sort()
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
      ['email', 'isOwner', 'isSelf', 'jobTitle', 'joinedAt', 'membershipId', 'name', 'photoUrl', 'role', 'status'].sort()
    );
    expect(JSON.stringify(detail.body)).not.toMatch(/salar|remunera|salary|compensation/i);
  });

  describe('isSelf says whether the link is the signed-in person\'s own (issue #286)', () => {
    const selfIds = (body: CollaboratorListJson): string[] => body.data.filter((item) => item.isSelf).map((item) => item.membershipId);

    it('is true only on the own link, in the listing and in the detail, for a person linked to two agencies', async () => {
      const a = await createAgencyWithOwner('Colab Self A', 'self-a', 'Owner Self A');
      const b = await createAgencyWithOwner('Colab Self B', 'self-b', 'Owner Self B');
      // One permission only: the viewer reads the team and nothing else, so no other grant explains what they see.
      const viewer = await addMember(a.agencyId, { name: 'Pessoa Dupla', emailLabel: 'self-viewer', roleId: await createCustomRole(a.agencyId, ['colaborador.visualizar']) });
      await addAgencyMembership(b.agencyId, viewer.id, await createCustomRole(b.agencyId, ['colaborador.visualizar']));
      const peerA = await addMemberWithMembershipId(a.agencyId, { membershipId: randomUUID(), name: 'Colega A', emailLabel: 'self-peer-a', roleId: presetRoleIds.production });
      await addMemberWithMembershipId(b.agencyId, { membershipId: randomUUID(), name: 'Colega B', emailLabel: 'self-peer-b', roleId: presetRoleIds.production });
      const viewerInA = await membershipIdOf(a.agencyId, viewer.id);
      const viewerInB = await membershipIdOf(b.agencyId, viewer.id);
      expect(viewerInA).not.toBe(viewerInB);
      const cookie = await loginCookie(viewer);

      const listA = await getCollaborators(cookie, a.agencyId);
      expect(listA.status).toBe(200);
      expect(listA.body.data.map((item) => [item.name, item.isSelf])).toEqual([['Colega A', false], ['Owner Self A', false], ['Pessoa Dupla', true]]);
      expect(selfIds(listA.body)).toEqual([viewerInA]);

      // The same person in the other agency: the answer follows the agency asked, with that link's id.
      const listB = await getCollaborators(cookie, b.agencyId);
      expect(listB.status).toBe(200);
      expect(listB.body.data.map((item) => [item.name, item.isSelf])).toEqual([['Colega B', false], ['Owner Self B', false], ['Pessoa Dupla', true]]);
      expect(selfIds(listB.body)).toEqual([viewerInB]);

      const ownDetail = await getCollaboratorDetail(cookie, a.agencyId, viewerInA);
      expect(ownDetail.status).toBe(200);
      expect(ownDetail.body.isSelf).toBe(true);
      const ownDetailB = await getCollaboratorDetail(cookie, b.agencyId, viewerInB);
      expect(ownDetailB.status).toBe(200);
      expect(ownDetailB.body.isSelf).toBe(true);
      const ownerDetail = await getCollaboratorDetail(cookie, a.agencyId, await membershipIdOf(a.agencyId, a.ownerUser.id));
      expect(ownerDetail.status).toBe(200);
      expect(ownerDetail.body.isOwner).toBe(true);
      expect(ownerDetail.body.isSelf).toBe(false);
      const peerDetail = await getCollaboratorDetail(cookie, a.agencyId, await membershipIdOf(a.agencyId, peerA));
      expect(peerDetail.status).toBe(200);
      expect(peerDetail.body.isSelf).toBe(false);

      // A link of the other agency is still a 404 here, with no `isSelf` to reveal anything.
      const crossed = await getCollaboratorDetail(cookie, a.agencyId, viewerInB);
      expect(crossed.status).toBe(404);
      expect(JSON.stringify(crossed.body)).not.toContain('isSelf');
    });

    it('is false on every link for the Owner who has no link at all, strictly false and never absent', async () => {
      const ownerUser = await makeUser('self-ownerless-owner', 'Dona Sem Vínculo');
      const agencyId = await createAgency('Colab Self Ownerless', ownerUser.id);
      await addMember(agencyId, { name: 'Colega Um', emailLabel: 'self-ownerless-1', roleId: presetRoleIds.production });
      await addMemberWithMembershipId(agencyId, { membershipId: randomUUID(), name: 'Colega Dois', emailLabel: 'self-ownerless-2', roleId: presetRoleIds.finance });
      expect(await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: ownerUser.id }).count<Array<{ count: string }>>('id as count')).toEqual([{ count: '0' }]);
      const cookie = await loginCookie(ownerUser);

      const list = await getCollaborators(cookie, agencyId);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(2);
      for (const item of list.body.data) {
        expect(item.isSelf).toBe(false);
        const detail = await getCollaboratorDetail(cookie, agencyId, item.membershipId);
        expect(detail.status).toBe(200);
        expect(detail.body.isSelf).toBe(false);
      }
    });

    it('follows the session user, not the e-mail: a changed e-mail keeps the own link recognized', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Self Email', 'self-email', 'Owner Self Email');
      const viewer = await addMember(agencyId, { name: 'Troca de E-mail', emailLabel: 'self-email-viewer', roleId: await createCustomRole(agencyId, ['colaborador.visualizar']) });
      const cookie = await loginCookie(viewer);
      const ownerMembershipId = await membershipIdOf(agencyId, ownerUser.id);
      const viewerMembershipId = await membershipIdOf(agencyId, viewer.id);

      // The operation swaps the e-mail of the signed-in person after the session was issued.
      await app.pool.query('update auth."user" set email = $1 where id = $2', [`trocado.${randomUUID().slice(0, 8)}@collab-integration.test`, viewer.id]);

      const list = await getCollaborators(cookie, agencyId);
      expect(list.status).toBe(200);
      expect(selfIds(list.body)).toEqual([viewerMembershipId]);
      expect(list.body.data.find((item) => item.membershipId === ownerMembershipId)?.isSelf).toBe(false);
      expect((await getCollaboratorDetail(cookie, agencyId, viewerMembershipId)).body.isSelf).toBe(true);
    });

    it('never exposes the user id of anyone, in the listing or in the detail', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Self Identifier', 'self-nouid', 'Owner Self Identifier');
      const viewer = await addMember(agencyId, { name: 'Sem Identificador', emailLabel: 'self-nouid-viewer', roleId: await createCustomRole(agencyId, ['colaborador.visualizar']) });
      const cookie = await loginCookie(viewer);

      const list = await getCollaborators(cookie, agencyId);
      const detail = await getCollaboratorDetail(cookie, agencyId, await membershipIdOf(agencyId, viewer.id));
      for (const body of [JSON.stringify(list.body), JSON.stringify(detail.body)]) {
        expect(body).not.toContain(viewer.id);
        expect(body).not.toContain(ownerUser.id);
        expect(body).not.toMatch(/user_?id/i);
      }
    });
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

  it('#96/#98: a removed link is not revealed by the detail to whoever may not see removed links', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Colab Detail Removed', 'detail-removed', 'Owner Detail Removed');
    const removed = await addMember(agencyId, { name: 'Pessoa Removida Detalhe', emailLabel: 'detail-removed-person', roleId: presetRoleIds.production, status: 'removed' });
    const production = await addMember(agencyId, { name: 'Pessoa Produção Detalhe', emailLabel: 'detail-removed-production', roleId: presetRoleIds.production });
    const membershipId = await membershipIdOf(agencyId, removed.id);

    const hidden = await getCollaboratorDetail(await loginCookie(production), agencyId, membershipId);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toEqual({ code: 'NOT_FOUND', message: 'Collaborator not found.' });

    // The Owner sees it, with the status that says it is removed.
    const revealed = await getCollaboratorDetail(await loginCookie(ownerUser), agencyId, membershipId);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ membershipId, status: 'removed' });
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

  // Issue #225. The response schema trims and bounds job_title in UTF-16 units with JavaScript's
  // whitespace set, and the column used to accept any text: one row with only a tab, only a NBSP,
  // only U+FEFF or over 256 units made every read of the agency a 500. The DB now stores the
  // normalized form and refuses the rest, so the reads keep answering 200 and agree with the contract.
  it('#225: the forms that used to 500 the reads are refused or normalized, like the contract', async () => {
    const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos CHECK', 'jobs-check', 'Owner Cargos CHECK');
    const bare = await insertBareUsers(5, 'jobs-check');
    const emoji129 = '😀'.repeat(129);
    const padded = `A${' '.repeat(300)}B`;
    const zwnbsp = '\uFEFF';

    // The contract itself rejects the over-limit forms the old CHECK accepted.
    expect(CollaboratorJobTitlesResponseSchema.safeParse({ data: [emoji129] }).success).toBe(false);
    expect(CollaboratorJobTitlesResponseSchema.safeParse({ data: [padded] }).success).toBe(false);

    const insert = (index: number, jobTitle: string) => owner.knex('agency_memberships').insert({
      agency_id: agencyId, user_id: bare[index]!, role_id: presetRoleIds.production, job_title: jobTitle, status: 'active'
    });
    const storedTitle = async (index: number): Promise<string | null> => {
      const row = await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: bare[index]! }).first('job_title');
      return (row?.job_title as string | null | undefined) ?? null;
    };

    // Refused: 129 emoji (258 UTF-16 units), A + 300 spaces + B and 257 ASCII -- no valid stored form.
    await expect(insert(0, emoji129)).rejects.toThrow(/agency_memberships_job_title_format/);
    await expect(insert(1, padded)).rejects.toThrow(/agency_memberships_job_title_format/);
    await expect(insert(2, 'a'.repeat(257))).rejects.toThrow(/agency_memberships_job_title_format/);

    // Normalized: a tab and U+FEFF are whitespace for the contract's trim, so the stored value is
    // null, which the nullable schema accepts -- the read can no longer 500 on them.
    await insert(3, '\t');
    await insert(4, zwnbsp);
    expect(await storedTitle(3)).toBeNull();
    expect(await storedTitle(4)).toBeNull();

    const cookie = await loginCookie(ownerUser);
    const listing = await getCollaborators(cookie, agencyId);
    expect(listing.status).toBe(200);
    const titles = await getJobTitles(cookie, agencyId);
    expect(titles.status).toBe(200);
    // Everything the DB accepts is valid for the contract, so no read can 500 on it.
    expect(CollaboratorJobTitlesResponseSchema.safeParse({ data: titles.body.data }).success).toBe(true);
    const detail = await getCollaboratorDetail(cookie, agencyId, await membershipIdOf(agencyId, ownerUser.id));
    expect(detail.status).toBe(200);
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

    it('collapses duplicates and surrounding spaces, rejects blanks and drops nulls', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Cargos Duplicados', 'jobs-dupes', 'Owner Cargos Duplicados');
      await addMember(agencyId, { name: 'Pessoa Um', emailLabel: 'jobs-dup-1', roleId: presetRoleIds.production, jobTitle: 'Editor de Vídeo' });
      await addMember(agencyId, { name: 'Pessoa Dois', emailLabel: 'jobs-dup-2', roleId: presetRoleIds.production, jobTitle: '  Editor de Vídeo  ' });
      await addMember(agencyId, { name: 'Pessoa Três', emailLabel: 'jobs-dup-3', roleId: presetRoleIds.production, jobTitle: 'Designer' });
      // Issue #225: the trigger stores a blanks-only title as null, which the listing drops like any
      // null; the value never reaches the job-titles output.
      await addMember(agencyId, { name: 'Pessoa Quatro', emailLabel: 'jobs-dup-4', roleId: presetRoleIds.production, jobTitle: '   ' });
      await addMember(agencyId, { name: 'Pessoa Cinco', emailLabel: 'jobs-dup-5', roleId: presetRoleIds.production, jobTitle: null });

      const response = await getJobTitles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      // Trimmed duplicates fold into one and blanks/nulls stay absent.
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

  describe('assignable roles of the agency (issue #287)', () => {
    // `listAgencyRoles` orders by `key` with `collate "C"` (byte order) and breaks ties by id, so
    // these ASCII keys are a plain byte-order sequence.
    const systemPresets = (withAdmin: boolean): AgencyRoleJson[] => {
      const presets: AgencyRoleJson[] = [
        { id: presetRoleIds.account_manager, key: 'account_manager', name: 'Gestor de conta' },
        { id: presetRoleIds.finance, key: 'finance', name: 'Financeiro' },
        { id: presetRoleIds.production, key: 'production', name: 'Produção' },
        { id: presetRoleIds.sales, key: 'sales', name: 'Vendas' }
      ];
      if (withAdmin) presets.unshift({ id: presetRoleIds.admin, key: 'admin', name: 'Admin' });
      return presets;
    };

    it('returns every assignable role with its id for the Owner, admin included, ordered by key', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Papéis Owner', 'roles-owner');
      const customRoleId = await createCustomRole(agencyId, ['colaborador.convidar']);
      await owner.knex('roles').update({ name: 'Papel da casa' }).where({ id: customRoleId });

      const response = await getRoles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        ...systemPresets(true),
        { id: customRoleId, key: `custom-${customRoleId.slice(0, 8)}`, name: 'Papel da casa' }
      ].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    });

    it('lets the Owner with owner_user_id and no membership row at all read the list (issue #313)', async () => {
      // `createAgencyWithOwner` always attaches the `admin` preset, so the ownership bypass of
      // `requireAnyPermission` had no HTTP case: this caller has no membership row, hence no role
      // and no permission, and still reads the list -- admin included -- by possession.
      const bareOwner = await makeUser('roles-bare-owner');
      const agencyId = await createAgency('Papéis Owner Sem Vínculo', bareOwner.id);

      const response = await getRoles(await loginCookie(bareOwner), agencyId);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(
        [...systemPresets(true)].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      );
    });

    it('hides the admin role from everyone but the Owner, even an admin-preset member', async () => {
      const { agencyId } = await createAgencyWithOwner('Papéis Admin', 'roles-admin');
      const adminMember = await addMember(agencyId, { name: 'Pessoa Admin Papéis', emailLabel: 'roles-admin-member', roleId: presetRoleIds.admin });

      const response = await getRoles(await loginCookie(adminMember), agencyId);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(systemPresets(false));
      expect(response.body.data.map((role) => role.id)).not.toContain(presetRoleIds.admin);
    });

    it('hides an agency-scoped role whose key is literally admin, from everyone but the Owner', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Papéis Admin Escopado', 'roles-scoped-admin');
      const scopedAdminRoleId = randomUUID();
      createdRoleIds.push(scopedAdminRoleId);
      await owner.knex('roles').insert({ id: scopedAdminRoleId, agency_id: agencyId, key: 'admin', name: 'Admin da casa', is_system: false });
      const adminMember = await addMember(agencyId, { name: 'Pessoa Admin Papéis', emailLabel: 'roles-scoped-admin-member', roleId: presetRoleIds.admin });

      const memberResponse = await getRoles(await loginCookie(adminMember), agencyId);
      expect(memberResponse.status).toBe(200);
      expect(memberResponse.body.data.map((role) => role.id)).not.toContain(scopedAdminRoleId);

      const ownerResponse = await getRoles(await loginCookie(ownerUser), agencyId);
      expect(ownerResponse.status).toBe(200);
      expect(ownerResponse.body.data.map((role) => role.id)).toContain(scopedAdminRoleId);
    });

    it('never mixes another agency\'s custom roles into the list, even for a member of both', async () => {
      const { agencyId } = await createAgencyWithOwner('Papéis Dupla', 'roles-dual-a');
      const { agencyId: otherAgencyId } = await createAgencyWithOwner('Papéis Dupla B', 'roles-dual-b');
      const ownRoleId = await createCustomRole(agencyId, ['colaborador.alterar_papel']);
      const otherRoleId = await createCustomRole(otherAgencyId, ['colaborador.alterar_papel']);
      // The viewer holds a one-permission custom role in BOTH agencies, and `roles_select` shows
      // the roles of both: only the query's own agency filter keeps each list scoped (review of
      // #293, finding 1).
      const viewer = await addMember(agencyId, { name: 'Dupla Papéis', emailLabel: 'roles-dual-viewer', roleId: ownRoleId });
      await addAgencyMembership(otherAgencyId, viewer.id, otherRoleId);

      const aResponse = await getRoles(await loginCookie(viewer), agencyId);
      expect(aResponse.status).toBe(200);
      expect(aResponse.body.data.map((role) => role.id)).toContain(ownRoleId);
      expect(aResponse.body.data.map((role) => role.id)).not.toContain(otherRoleId);
      expect(aResponse.body.data.map((role) => role.key)).not.toContain(`custom-${otherRoleId.slice(0, 8)}`);

      const bResponse = await getRoles(await loginCookie(viewer), otherAgencyId);
      expect(bResponse.status).toBe(200);
      expect(bResponse.body.data.map((role) => role.id)).toContain(otherRoleId);
      expect(bResponse.body.data.map((role) => role.id)).not.toContain(ownRoleId);
    });

    it('accepts a custom role with only colaborador.convidar, and one with only colaborador.alterar_papel', async () => {
      const { agencyId } = await createAgencyWithOwner('Papéis Perms', 'roles-perms');
      const convidarRoleId = await createCustomRole(agencyId, ['colaborador.convidar']);
      const alterarPapelRoleId = await createCustomRole(agencyId, ['colaborador.alterar_papel']);
      const convidarMember = await addMember(agencyId, { name: 'Convidante Papéis', emailLabel: 'roles-perms-convidar', roleId: convidarRoleId });
      const alterarPapelMember = await addMember(agencyId, { name: 'Alterador Papéis', emailLabel: 'roles-perms-alterar', roleId: alterarPapelRoleId });

      for (const member of [convidarMember, alterarPapelMember]) {
        const response = await getRoles(await loginCookie(member), agencyId);
        expect(response.status).toBe(200);
        const keys = response.body.data.map((role) => role.key);
        const ids = response.body.data.map((role) => role.id);
        for (const preset of ['account_manager', 'finance', 'production', 'sales']) expect(keys).toContain(preset);
        expect(keys).not.toContain('admin');
        // The agency's own custom roles are assignable, so they appear with their ids too.
        expect(ids).toEqual(expect.arrayContaining([convidarRoleId, alterarPapelRoleId]));
        for (const role of response.body.data) {
          expect(role).toEqual({ id: expect.any(String), key: expect.any(String), name: expect.any(String) });
        }
      }
    });

    it('refuses a member with neither permission with 403', async () => {
      const { agencyId } = await createAgencyWithOwner('Papéis Negados', 'roles-denied');
      const noPermissionRoleId = await createCustomRole(agencyId, []);
      const member = await addMember(agencyId, { name: 'Sem Permissão Papéis', emailLabel: 'roles-denied-member', roleId: noPermissionRoleId });

      const response = await getRoles(await loginCookie(member), agencyId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a member with a sole permission outside the accepted pair, and only that one', async () => {
      const { agencyId } = await createAgencyWithOwner('Papéis 403', 'roles-403');
      const visualizarRoleId = await createCustomRole(agencyId, ['colaborador.visualizar']);
      const cancelarRoleId = await createCustomRole(agencyId, ['convite.cancelar']);
      const visualizarMember = await addMember(agencyId, { name: 'Só Visualiza Papéis', emailLabel: 'roles-403-visualizar', roleId: visualizarRoleId });
      const cancelarMember = await addMember(agencyId, { name: 'Só Cancela Papéis', emailLabel: 'roles-403-cancelar', roleId: cancelarRoleId });

      // One permission outside `convidar`/`alterar_papel` must not open the list: the accepted pair
      // is fixed over HTTP, so a guard widened to, say, `colaborador.visualizar` turns this red
      // (review of #293, Lupa, blocker; issue #308).
      for (const member of [visualizarMember, cancelarMember]) {
        const response = await getRoles(await loginCookie(member), agencyId);
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('orders by byte value, not the database collation', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Papéis Colação', 'roles-collation');
      const betaId = randomUUID();
      const alphaId = randomUUID();
      createdRoleIds.push(betaId, alphaId);
      await owner.knex('roles').insert([
        { id: betaId, agency_id: agencyId, key: 'Beta', name: 'Beta', is_system: false },
        { id: alphaId, agency_id: agencyId, key: 'alpha', name: 'Alpha', is_system: false }
      ]);

      const response = await getRoles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      const keys = response.body.data.map((role) => role.key);
      // Byte order puts 'B' (0x42) before 'a' (0x61); the en_US.utf8 collation of the local
      // database would invert them, so only `collate "C"` keeps this order.
      expect(keys.indexOf('Beta')).toBeGreaterThan(-1);
      expect(keys.indexOf('alpha')).toBeGreaterThan(-1);
      expect(keys.indexOf('Beta')).toBeLessThan(keys.indexOf('alpha'));
    });

    it('breaks a same-key tie by id, across the system and the agency scope', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Papéis Desempate', 'roles-tiebreak');
      // A scoped `admin` with an id *smaller* than the seeded system admin's: the row is inserted
      // after the seed, so without the `role.id` tie-break the stable sort keeps it behind; with
      // `, role.id asc` it must lead.
      let scopedAdminId = randomUUID();
      while (scopedAdminId >= presetRoleIds.admin) scopedAdminId = randomUUID();
      createdRoleIds.push(scopedAdminId);
      await owner.knex('roles').insert({ id: scopedAdminId, agency_id: agencyId, key: 'admin', name: 'Admin da casa', is_system: false });

      const response = await getRoles(await loginCookie(ownerUser), agencyId);
      expect(response.status).toBe(200);
      const ids = response.body.data.map((role) => role.id);
      expect(ids).toEqual(expect.arrayContaining([presetRoleIds.admin, scopedAdminId]));
      expect(ids.indexOf(scopedAdminId)).toBeLessThan(ids.indexOf(presetRoleIds.admin));
    });

    it('never reveals roles of an agency the caller does not belong to, nor a nonexistent one', async () => {
      const { agencyId } = await createAgencyWithOwner('Papéis Escopo', 'roles-scope');
      const { agencyId: otherAgencyId } = await createAgencyWithOwner('Papéis Outra', 'roles-scope-other');
      await createCustomRole(otherAgencyId, ['colaborador.alterar_papel']);
      const outsider = await addMember(otherAgencyId, { name: 'De Fora Papéis', emailLabel: 'roles-scope-outsider', roleId: presetRoleIds.admin });

      const noAccess = await getRoles(await loginCookie(outsider), agencyId);
      const nonexistent = await getRoles(await loginCookie(outsider), randomUUID());
      expect(noAccess.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      expect(noAccess.body.error).toEqual(nonexistent.body.error);
      expect(noAccess.body.error).toEqual({ code: 'NOT_FOUND', message: 'Agency not found.' });

      const unauthenticated = await getRoles(undefined, agencyId);
      expect(unauthenticated.status).toBe(401);
    });

    it('#226: rejects an unknown query parameter, and accepts only the strict shape', async () => {
      const { agencyId, ownerUser } = await createAgencyWithOwner('Papéis Query', 'roles-query');
      const cookie = await loginCookie(ownerUser);

      const accepted = await app.app.inject({
        method: 'GET',
        url: `/agencies/${agencyId}/roles`,
        headers: { ...origin, cookie }
      });
      expect(accepted.statusCode).toBe(200);

      const rejected = await app.app.inject({
        method: 'GET',
        url: `/agencies/${agencyId}/roles?x=1`,
        headers: { ...origin, cookie }
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    });
  });
});
