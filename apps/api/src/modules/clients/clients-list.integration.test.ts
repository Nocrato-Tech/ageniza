import { randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, withAuthenticatedUserTransaction } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  captureLogs,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type CapturedLogs,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { listClients, type ClientTransaction } from './service.js';

// Issue #125 acceptance: `GET /agencies/:agencyId/clients` with the triage order. The suite holds
// the listing contract (#95/#161 copy it) and the SPEC rules this route is the first to exercise:
// a non-alphabetical named `sort`, accent-insensitive search, the optional permission-shaped
// `pendingInvitations`, and tenant isolation with a caller who belongs to both agencies.
const origin = { origin: TEST_APP_PUBLIC_URL };

const SYSTEM_PRESETS = ['admin', 'account_manager', 'production', 'sales', 'finance'] as const;
type SystemPreset = (typeof SYSTEM_PRESETS)[number];

interface ClientListItemJson {
  readonly id: string;
  readonly name: string;
  readonly photoUrl: string | null;
  readonly instagramHandle: string | null;
  readonly status: 'active' | 'archived';
  readonly closingDate: string | null;
  readonly threadsAwaitingAgency: number;
  readonly pendingInvitations?: number;
}

interface PaginationMetaJson {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

interface ClientListJson {
  readonly data: readonly ClientListItemJson[];
  readonly meta: PaginationMetaJson;
}

/** The exact item key set for a member without `cliente.convidar_usuario` (the badge adds one). */
const ITEM_KEYS = ['closingDate', 'id', 'instagramHandle', 'name', 'photoUrl', 'status', 'threadsAwaitingAgency'];

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

let app: TestApp;
const owner = ownerClient();
const logs: CapturedLogs = captureLogs('warn');
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

/** A bare user (no credential account) for comment authorship; never signs in. */
const insertBareUser = async (label: string, name = 'Portal Person'): Promise<string> => {
  const id = randomUUID();
  createdUserIds.push(id);
  await app.pool.query(
    'insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)',
    [id, name, `${label}.${randomUUID().slice(0, 8)}@list-integration.test`]
  );
  return id;
};

const createAgency = async (name: string, ownerUserId: string | null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name, owner_user_id: ownerUserId, status: 'active' });
  return id;
};

const addAgencyMembership = async (agencyId: string, userId: string, roleId: string): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId });
};

/** Agency with an Admin member (preset role), the common fixture of every case. */
const createAgencyWithAdmin = async (
  label: string
): Promise<{ agencyId: string; admin: TestUserFixture; cookie: string }> => {
  const admin = await makeUser(`${label}-admin`, `Admin ${label}`);
  const agencyId = await createAgency(`Agency ${label}`, null);
  await addAgencyMembership(agencyId, admin.id, presetRoleIds.admin);
  return { agencyId, admin, cookie: await loginCookie(admin) };
};

const addMember = async (
  agencyId: string,
  input: { name: string; emailLabel: string; roleId: string }
): Promise<TestUserFixture> => {
  const user = await makeUser(input.emailLabel, input.name);
  await addAgencyMembership(agencyId, user.id, input.roleId);
  return user;
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

const createClient = async (input: {
  readonly agencyId: string;
  readonly id?: string;
  readonly name?: string;
  readonly status?: 'active' | 'archived';
  readonly photoKey?: string | null;
  readonly closingDate?: string | null;
  readonly legalName?: string | null;
  readonly taxId?: string | null;
  readonly instagramHandle?: string | null;
}): Promise<string> => {
  const id = input.id ?? randomUUID();
  await owner.knex('clients').insert({
    id,
    agency_id: input.agencyId,
    name: input.name ?? `Client ${id}`,
    status: input.status ?? 'active',
    archived_at: input.status === 'archived' ? new Date() : null,
    photo_key: input.photoKey ?? null,
    closing_date: input.closingDate ?? null,
    legal_name: input.legalName ?? null,
    tax_id: input.taxId ?? null,
    instagram_handle: input.instagramHandle ?? null
  });
  return id;
};

const addThread = async (clientId: string, openedByUserId: string): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_threads').insert({
    id,
    client_id: clientId,
    section_key: 'branding',
    opened_by: openedByUserId,
    opened_side: 'agency'
  });
  return id;
};

const addComment = async (input: {
  readonly threadId: string;
  readonly clientId: string;
  readonly authorUserId: string;
  readonly side: 'agency' | 'client';
  readonly createdAt: Date;
}): Promise<void> => {
  await owner.knex('client_thread_comments').insert({
    id: randomUUID(),
    thread_id: input.threadId,
    client_id: input.clientId,
    author_user_id: input.authorUserId,
    author_side: input.side,
    body: 'Comment',
    created_at: input.createdAt
  });
};

const addInvitation = async (input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly invitedByUserId: string;
  readonly expiresAt?: Date;
  readonly usedAt?: Date | null;
  readonly revokedAt?: Date | null;
}): Promise<void> => {
  await owner.knex('invitations').insert({
    agency_id: input.agencyId,
    purpose: 'client_invite',
    email: `portal.${randomUUID().slice(0, 8)}@list-integration.test`,
    client_id: input.clientId,
    token_hash: `${randomUUID()}${randomUUID()}`,
    expires_at: input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    invited_by_user_id: input.invitedByUserId,
    used_at: input.usedAt ?? null,
    revoked_at: input.revokedAt ?? null
  });
};

const getClients = async (
  cookie: string | undefined,
  agencyId: string,
  query: Record<string, string | number> = {}
): Promise<{ status: number; body: ClientListJson & ApiErrorJson }> => {
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)] as [string, string]));
  const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
  const response = await app.app.inject({
    method: 'GET',
    url: `/agencies/${agencyId}/clients${suffix}`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.json<ClientListJson & ApiErrorJson>() };
};

const names = (body: ClientListJson): string[] => body.data.map((item) => item.name);
const ids = (body: ClientListJson): string[] => body.data.map((item) => item.id);

describe('clients listing (issue #125)', () => {
  beforeAll(async () => {
    app = await buildTestApp({ sender: createFakeEmailSender(), logger: logs.logger });
    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', [...SYSTEM_PRESETS]).select('id', 'key');
    presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<SystemPreset, string>;
    for (const preset of SYSTEM_PRESETS) {
      if (presetRoleIds[preset] === undefined) throw new Error(`System role seed is missing: ${preset}`);
    }
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('#125: the five presets read the same list, only the agency in the URL, and a member of another is 404', async () => {
    const { agencyId, admin } = await createAgencyWithAdmin('presets');
    const members: TestUserFixture[] = [admin];
    for (const preset of ['account_manager', 'production', 'sales', 'finance'] as const) {
      members.push(await addMember(agencyId, { name: `Pessoa ${preset}`, emailLabel: `presets-${preset}`, roleId: presetRoleIds[preset] }));
    }

    const clientsInA = [
      await createClient({ agencyId, name: 'Alfa Presets' }),
      await createClient({ agencyId, name: 'Beta Presets', closingDate: '2026-12-31' }),
      await createClient({ agencyId, name: 'Gama Presets' })
    ];
    await createClient({ agencyId, name: 'Arquivado Presets', status: 'archived' });

    const other = await createAgencyWithAdmin('presets-other');
    const clientInB = await createClient({ agencyId: other.agencyId, name: 'Cliente da Outra' });

    // The caller belongs to BOTH agencies on purpose: RLS alone would show both, so the route's
    // explicit agency filter is what this asserts (issue #186 lesson).
    const dual = await makeUser('presets-dual', 'Dual Admin');
    await addAgencyMembership(agencyId, dual.id, presetRoleIds.admin);
    await addAgencyMembership(other.agencyId, dual.id, presetRoleIds.admin);

    for (const member of members) {
      const cookie = await loginCookie(member);
      const response = await getClients(cookie, agencyId);
      expect(response.status).toBe(200);
      expect(response.body.meta.totalItems).toBe(3);
      expect(ids(response.body).sort()).toEqual([...clientsInA].sort());
      expect(ids(response.body)).not.toContain(clientInB);
      // The exact item shape: Admin's preset carries `cliente.convidar_usuario`, so only its items
      // gain `pendingInvitations`; the other four presets never see the key.
      const keys = Object.keys(response.body.data[0]!).sort();
      expect(keys).toEqual(member === admin ? [...ITEM_KEYS, 'pendingInvitations'].sort() : ITEM_KEYS);
    }

    const dualCookie = await loginCookie(dual);
    const listA = await getClients(dualCookie, agencyId);
    expect(listA.body.meta.totalItems).toBe(3);
    expect(ids(listA.body)).not.toContain(clientInB);
    const listB = await getClients(dualCookie, other.agencyId);
    expect(listB.body.meta.totalItems).toBe(1);
    expect(ids(listB.body)).toEqual([clientInB]);

    // The search must respect the agency in the URL too, not just the RLS scope.
    const searchBFromA = await getClients(dualCookie, agencyId, { search: 'Outra' });
    expect(searchBFromA.body.meta.totalItems).toBe(0);

    // A member of another agency, and a portal person of a client (no agency membership), 404.
    const otherCookie = await loginCookie(other.admin);
    expect((await getClients(otherCookie, agencyId)).status).toBe(404);
    const portal = await makeUser('presets-portal', 'Portal Person');
    await owner.knex('client_memberships').insert({ client_id: clientsInA[0], user_id: portal.id });
    expect((await getClients(await loginCookie(portal), agencyId)).status).toBe(404);
  }, 30_000);

  it('#125: default is 20 per page, active only; pageSize=500 is capped at 100 and a huge page is 400, never 500', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('cap');

    const bulk = Array.from({ length: 105 }, (_, index) => ({
      id: randomUUID(),
      agency_id: agencyId,
      name: `Cli Cap ${String(index + 1).padStart(3, '0')}`
    }));
    await owner.knex('clients').insert(bulk);
    await createClient({ agencyId, name: 'Cli Cap Arquivado', status: 'archived' });

    const first = await getClients(cookie, agencyId);
    expect(first.status).toBe(200);
    expect(first.body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 105, totalPages: 6 });
    expect(first.body.data).toHaveLength(20);
    expect(first.body.data.every((item) => item.status === 'active')).toBe(true);

    const second = await getClients(cookie, agencyId, { page: 2 });
    expect(second.status).toBe(200);
    const firstIds = new Set(first.body.data.map((item) => item.id));
    expect(second.body.data.every((item) => !firstIds.has(item.id))).toBe(true);

    const capped = await getClients(cookie, agencyId, { pageSize: 500 });
    expect(capped.status).toBe(200);
    expect(capped.body.meta.pageSize).toBe(100);
    expect(capped.body.meta.totalItems).toBe(105);
    expect(capped.body.data).toHaveLength(100);

    // A page beyond the data is an empty page with the true total, not an error.
    const beyond = await getClients(cookie, agencyId, { page: 999_999_999_999 });
    expect(beyond.status).toBe(200);
    expect(beyond.body.data).toHaveLength(0);
    expect(beyond.body.meta.totalItems).toBe(105);

    // A huge `page` that cannot be represented safely is a 400, never a 500 from an overflowing
    // OFFSET (pagination.ts `.safe()`); zero and fractions are 400 too.
    for (const page of ['0', '-1', '1.5', '1e20', 'abc']) {
      const response = await getClients(cookie, agencyId, { page });
      expect(response.status, `page=${page}`).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const pageSize of ['0', '-1', '1e20']) {
      const response = await getClients(cookie, agencyId, { pageSize });
      expect(response.status, `pageSize=${pageSize}`).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('#125: attention keeps awaiting clients ahead across the page boundary, without loss or repetition', async () => {
    const { agencyId, admin, cookie } = await createAgencyWithAdmin('attention-pages');
    const portal = await insertBareUser('attention-pages-portal');

    // 60 clients; the two awaiting ones sit at positions 2 and 21 by name, so without the triage
    // the second would fall on page 2. The triage pulls both to the front of page 1 and the exact
    // expected order below proves pages 1+2 are contiguous and disjoint.
    const allNames = Array.from({ length: 60 }, (_, index) => `Cli Page ${String(index + 1).padStart(3, '0')}`);
    const awaitingNames = new Set(['Cli Page 002', 'Cli Page 021']);
    for (const name of awaitingNames) {
      const clientId = await createClient({ agencyId, name });
      const thread = await addThread(clientId, admin.id);
      await addComment({ threadId: thread, clientId, authorUserId: portal, side: 'client', createdAt: new Date('2026-01-01T10:00:00.000Z') });
    }
    const bulk = allNames.filter((name) => !awaitingNames.has(name)).map((name) => ({
      id: randomUUID(),
      agency_id: agencyId,
      name
    }));
    await owner.knex('clients').insert(bulk);

    const first = await getClients(cookie, agencyId);
    const second = await getClients(cookie, agencyId, { page: 2 });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data).toHaveLength(20);
    expect(second.body.data).toHaveLength(20);
    const expected = [...allNames.filter((name) => awaitingNames.has(name)), ...allNames.filter((name) => !awaitingNames.has(name))].slice(0, 40);
    expect([...names(first.body), ...names(second.body)]).toEqual(expected);
    expect(first.body.data.slice(0, 2).map((item) => item.threadsAwaitingAgency)).toEqual([1, 1]);
    expect(second.body.data.map((item) => item.threadsAwaitingAgency)).toEqual(new Array(20).fill(0));
  });

  it('#125: attention puts an awaiting thread first, then name ascending; name:asc ignores the triage', async () => {
    const { agencyId, admin, cookie } = await createAgencyWithAdmin('order');
    const portal = await insertBareUser('order-portal');

    await createClient({ agencyId, name: 'Alfa Sem Thread' });
    const zeta = await createClient({ agencyId, name: 'Zeta Com Thread' });
    await createClient({ agencyId, name: 'Beta Sem Thread' });
    const gama = await createClient({ agencyId, name: 'Gama Resolvida' });
    const delta = await createClient({ agencyId, name: 'Delta Reaberta' });
    const hotel = await createClient({ agencyId, name: 'Hotel Respondida' });
    const icaro = await createClient({ agencyId, name: 'Icaro Resolvida' });

    // Zeta: open thread whose last comment is the client's -> awaiting the agency.
    const zetaThread = await addThread(zeta, admin.id);
    await addComment({ threadId: zetaThread, clientId: zeta, authorUserId: admin.id, side: 'agency', createdAt: new Date('2026-01-01T10:00:00.000Z') });
    await addComment({ threadId: zetaThread, clientId: zeta, authorUserId: portal, side: 'client', createdAt: new Date('2026-01-01T11:00:00.000Z') });

    // Hotel: OPEN thread whose last comment is the agency's -> the agency already answered, so it
    // is NOT awaiting. This is the state a mutation dropping the "client side" condition misses.
    const hotelThread = await addThread(hotel, admin.id);
    await addComment({ threadId: hotelThread, clientId: hotel, authorUserId: admin.id, side: 'agency', createdAt: new Date('2026-01-01T10:00:00.000Z') });

    // Gama: the agency answered and then resolved -> neither awaiting nor reopened.
    const gamaThread = await addThread(gama, admin.id);
    await addComment({ threadId: gamaThread, clientId: gama, authorUserId: admin.id, side: 'agency', createdAt: new Date('2026-01-01T10:00:00.000Z') });
    await owner.knex('client_threads').where({ id: gamaThread }).update({ resolved_at: new Date('2026-01-01T11:00:00.000Z') });

    // Icaro: the client commented LAST and the agency resolved AFTER that comment -> closed by
    // `openThreadSql` alone, since the latest-comment side alone would count it (SPEC "resolvida
    // não conta"). This is the only case that isolates the open-thread filter.
    const icaroThread = await addThread(icaro, admin.id);
    await addComment({ threadId: icaroThread, clientId: icaro, authorUserId: admin.id, side: 'agency', createdAt: new Date('2026-01-01T10:00:00.000Z') });
    await addComment({ threadId: icaroThread, clientId: icaro, authorUserId: portal, side: 'client', createdAt: new Date('2026-01-01T11:00:00.000Z') });
    await owner.knex('client_threads').where({ id: icaroThread }).update({ resolved_at: new Date('2026-01-01T12:00:00.000Z') });

    // Delta: resolved, then the client commented after -> reopened, awaiting again.
    const deltaThread = await addThread(delta, admin.id);
    await addComment({ threadId: deltaThread, clientId: delta, authorUserId: admin.id, side: 'agency', createdAt: new Date('2026-01-01T10:00:00.000Z') });
    await owner.knex('client_threads').where({ id: deltaThread }).update({ resolved_at: new Date('2026-01-01T11:00:00.000Z') });
    await addComment({ threadId: deltaThread, clientId: delta, authorUserId: portal, side: 'client', createdAt: new Date('2026-01-01T12:00:00.000Z') });

    const attention = await getClients(cookie, agencyId);
    expect(attention.status).toBe(200);
    expect(attention.body.meta.pageSize).toBe(20);
    expect(names(attention.body)).toEqual([
      'Delta Reaberta',
      'Zeta Com Thread',
      'Alfa Sem Thread',
      'Beta Sem Thread',
      'Gama Resolvida',
      'Hotel Respondida',
      'Icaro Resolvida'
    ]);
    expect(attention.body.data.map((item) => item.threadsAwaitingAgency)).toEqual([1, 1, 0, 0, 0, 0, 0]);

    const byName = await getClients(cookie, agencyId, { sort: 'name:asc' });
    expect(byName.status).toBe(200);
    expect(names(byName.body)).toEqual([
      'Alfa Sem Thread',
      'Beta Sem Thread',
      'Delta Reaberta',
      'Gama Resolvida',
      'Hotel Respondida',
      'Icaro Resolvida',
      'Zeta Com Thread'
    ]);
  });

  it('#125: equal names (accent folding) are ordered by id, so pagination is stable', async () => {
    const { agencyId, admin, cookie } = await createAgencyWithAdmin('tiebreak');
    const portal = await insertBareUser('tiebreak-portal');
    await createClient({ agencyId, name: 'Alfa Qualquer' });

    const [lowId, highId] = [randomUUID(), randomUUID()].sort();
    // The two names fold to the same search form; the unique index allows both because it only
    // lowercases. Insert the higher id first so dropping the `id` tie-break cannot pass by luck.
    await createClient({ agencyId, id: highId!, name: 'Avila' });
    await createClient({ agencyId, id: lowId!, name: 'Ávila' });

    // The client whose last comment is the client's must come before 'Alfa Qualquer' too.
    const thread = await addThread(lowId!, admin.id);
    await addComment({ threadId: thread, clientId: lowId!, authorUserId: portal, side: 'client', createdAt: new Date('2026-01-01T10:00:00.000Z') });

    const byName = await getClients(cookie, agencyId, { search: 'avila', sort: 'name:asc' });
    expect(byName.status).toBe(200);
    expect(names(byName.body)).toEqual(['Ávila', 'Avila']);
    expect(ids(byName.body)).toEqual([lowId, highId]);

    // Under attention the same pair keeps the id order after the awaiting client.
    const attention = await getClients(cookie, agencyId, { search: 'avila' });
    expect(ids(attention.body)).toEqual([lowId, highId]);
    expect(attention.body.data[0]?.threadsAwaitingAgency).toBe(1);
    expect(attention.body.data[1]?.threadsAwaitingAgency).toBe(0);
  });

  it('#367: the order compares the folded name byte by byte -- space, hyphen, digit and accent -- in both sorts', async () => {
    const { agencyId, admin, cookie } = await createAgencyWithAdmin('byte-order');
    const portal = await insertBareUser('byte-order-portal');
    const inserted = ['Ana2', 'Anaïs', 'Ana Zélia', 'Édson', 'Anabela', 'Ana-Lúcia', 'Eduardo', 'Ana Maria', 'Ágata Costa', 'Ana Beatriz', 'Beatriz Álvares'];
    const clientIds = new Map<string, string>();
    for (const name of inserted) clientIds.set(name, await createClient({ agencyId, name }));

    // The folded names are 'agata costa' < 'ana beatriz' < 'ana maria' < 'ana zelia' < 'ana-lucia' <
    // 'ana2' < 'anabela' < 'anais' < 'beatriz alvares' < 'edson' < 'eduardo'. The database collation
    // (en_US) puts 'ana2' first and 'ana-lucia' after 'ana zelia' instead.
    const expected = ['Ágata Costa', 'Ana Beatriz', 'Ana Maria', 'Ana Zélia', 'Ana-Lúcia', 'Ana2', 'Anabela', 'Anaïs', 'Beatriz Álvares', 'Édson', 'Eduardo'];

    const byName = await getClients(cookie, agencyId, { sort: 'name:asc' });
    expect(byName.status).toBe(200);
    expect(names(byName.body)).toEqual(expected);

    const attention = await getClients(cookie, agencyId);
    expect(names(attention.body)).toEqual(expected);

    // The triage only moves the awaiting client to the front: the rest keeps the byte order.
    const awaiting = clientIds.get('Eduardo')!;
    const thread = await addThread(awaiting, admin.id);
    await addComment({ threadId: thread, clientId: awaiting, authorUserId: portal, side: 'client', createdAt: new Date('2026-01-01T10:00:00.000Z') });
    const triaged = await getClients(cookie, agencyId);
    expect(names(triaged.body)).toEqual(['Eduardo', ...expected.filter((name) => name !== 'Eduardo')]);
  });

  describe('#310: the count and the page come from one statement', () => {
    /**
     * Runs `listClients` in an authenticated transaction whose statements are counted, and calls
     * `afterFirstStatement` once the first one has returned: a write committed there is visible to
     * any later statement of the same READ COMMITTED transaction, and to none of the first.
     */
    const listWithWriteBetweenStatements = async (
      adminId: string,
      agencyId: string,
      filters: Parameters<typeof listClients>[2],
      pagination: { pageSize: number; offset: number },
      afterFirstStatement: () => Promise<void>
    ): Promise<{ page: Awaited<ReturnType<typeof listClients>>; statements: number }> => {
      let statements = 0;
      const page = await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: adminId }), (transaction) => {
        const observed = new Proxy(transaction, {
          get: (target, property, receiver) => {
            if (property !== 'raw') return Reflect.get(target, property, receiver) as unknown;
            return async (...args: Parameters<typeof transaction.raw>): Promise<unknown> => {
              const result = await transaction.raw(...args);
              statements += 1;
              if (statements === 1) await afterFirstStatement();
              return result;
            };
          }
        }) as ClientTransaction;
        return listClients(observed, agencyId, filters, pagination);
      });
      return { page, statements };
    };

    for (const sort of ['attention', 'name:asc'] as const) {
      it(`${sort}: a client created after the page was read is in neither data nor totalItems`, async () => {
        const { agencyId, admin } = await createAgencyWithAdmin(`snapshot-${sort.slice(0, 4)}`);
        for (const name of ['Alfa', 'Beta', 'Gama']) await createClient({ agencyId, name });

        const { page, statements } = await listWithWriteBetweenStatements(
          admin.id,
          agencyId,
          { status: 'active', sort, includePendingInvitations: false },
          { pageSize: 20, offset: 0 },
          async () => { await createClient({ agencyId, name: 'Delta Concorrente' }); }
        );

        expect(statements).toBe(1);
        expect(page.items.map((item) => item.name)).toEqual(['Alfa', 'Beta', 'Gama']);
        expect(page.totalItems).toBe(3);
      });
    }

    it('an empty first page is totalItems 0 without a second query', async () => {
      const { agencyId, admin, cookie } = await createAgencyWithAdmin('snapshot-empty');
      const { page, statements } = await listWithWriteBetweenStatements(
        admin.id,
        agencyId,
        { status: 'active', sort: 'attention', includePendingInvitations: true },
        { pageSize: 20, offset: 0 },
        async () => { await createClient({ agencyId, name: 'Nascido Depois' }); }
      );
      expect(statements).toBe(1);
      expect(page).toEqual({ items: [], totalItems: 0 });

      const response = await getClients(cookie, agencyId);
      expect(response.body.meta).toMatchObject({ totalItems: 1, totalPages: 1 });
    });

    it('a page past the end still reports the real total and an empty list', async () => {
      const { agencyId, cookie } = await createAgencyWithAdmin('snapshot-past-end');
      for (const name of ['Alfa', 'Beta', 'Gama']) await createClient({ agencyId, name });

      const response = await getClients(cookie, agencyId, { page: 2, pageSize: 3 });
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta).toMatchObject({ page: 2, pageSize: 3, totalItems: 3, totalPages: 1 });
    });

    it('a search with results and a page past the end reports the filtered total; one without results is empty and 0', async () => {
      const { agencyId, cookie } = await createAgencyWithAdmin('snapshot-search-past-end');
      for (const name of ['Alfa', 'Beta', 'Gama']) await createClient({ agencyId, name });

      const pastEnd = await getClients(cookie, agencyId, { search: 'alfa', page: 2, pageSize: 3 });
      expect(pastEnd.status).toBe(200);
      expect(pastEnd.body.data).toEqual([]);
      expect(pastEnd.body.meta).toMatchObject({ page: 2, pageSize: 3, totalItems: 1, totalPages: 1 });

      const noMatch = await getClients(cookie, agencyId, { search: 'zzz', page: 2, pageSize: 3 });
      expect(noMatch.status).toBe(200);
      expect(noMatch.body.data).toEqual([]);
      expect(noMatch.body.meta).toMatchObject({ page: 2, pageSize: 3, totalItems: 0, totalPages: 0 });
    });

    it('totalItems counts the whole filtered set, not the page', async () => {
      const { agencyId, cookie } = await createAgencyWithAdmin('snapshot-total');
      for (const name of ['Alfa Um', 'Alfa Dois', 'Alfa Tres', 'Beta']) await createClient({ agencyId, name });

      const response = await getClients(cookie, agencyId, { search: 'alfa', pageSize: 2, page: 2 });
      expect(names(response.body)).toEqual(['Alfa Um']);
      expect(response.body.meta).toMatchObject({ totalItems: 3, totalPages: 2 });
    });
  });

  it('#125: the accent fold does not depend on lower() folding uppercase (Édson before Eduardo)', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('locale');
    await createClient({ agencyId, name: 'Eduardo' });
    await createClient({ agencyId, name: 'Édson' });

    // Under a database locale where `lower('É')` stays 'É' (collation C), only folding the
    // uppercase accented letters keeps 'edson' < 'eduardo'; without them 'É' sorts after 'e'.
    const byName = await getClients(cookie, agencyId, { sort: 'name:asc' });
    expect(names(byName.body)).toEqual(['Édson', 'Eduardo']);

    const bySearch = await getClients(cookie, agencyId, { search: 'edson' });
    expect(names(bySearch.body)).toEqual(['Édson']);
  });

  it('#125: attention means "has an awaiting thread", not how many: one never outweighs a name', async () => {
    const { agencyId, admin, cookie } = await createAgencyWithAdmin('attention-count');
    const portal = await insertBareUser('attention-count-portal');
    const alfa = await createClient({ agencyId, name: 'Alfa Uma Thread' });
    const zeta = await createClient({ agencyId, name: 'Zeta Duas Threads' });

    for (const [clientId, count] of [[alfa, 1], [zeta, 2]] as const) {
      for (let index = 0; index < count; index += 1) {
        const thread = await addThread(clientId, admin.id);
        await addComment({
          threadId: thread,
          clientId,
          authorUserId: portal,
          side: 'client',
          createdAt: new Date(`2026-01-0${index + 1}T10:00:00.000Z`)
        });
      }
    }

    const response = await getClients(cookie, agencyId);
    expect(names(response.body)).toEqual(['Alfa Uma Thread', 'Zeta Duas Threads']);
    expect(response.body.data.map((item) => item.threadsAwaitingAgency)).toEqual([1, 2]);
  });

  it('#125: search matches name, razão social and @ without case or accent, and never CNPJ', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('search');
    const byName = await createClient({ agencyId, name: 'Pãdaria Aurora' });
    const byLegalName = await createClient({ agencyId, name: 'Alfa Comércio', legalName: 'Padaria Central Ltda', taxId: '12345678000190' });
    const byHandle = await createClient({ agencyId, name: 'Beta Digital', instagramHandle: 'padariacentral' });
    const accented = await createClient({ agencyId, name: 'João Café' });
    await createClient({ agencyId, name: 'Gama Sem Nada' });

    const padaria = await getClients(cookie, agencyId, { search: 'padaria' });
    expect(padaria.status).toBe(200);
    // Name, razão social AND @ all match: the handle `padariacentral` contains the term too.
    expect(padaria.body.meta.totalItems).toBe(3);
    expect(ids(padaria.body).sort()).toEqual([byName, byLegalName, byHandle].sort());

    const padariaUpper = await getClients(cookie, agencyId, { search: 'PADARIA' });
    expect(ids(padariaUpper.body).sort()).toEqual([byName, byLegalName, byHandle].sort());

    const legalNameOnly = await getClients(cookie, agencyId, { search: 'padaria central' });
    expect(ids(legalNameOnly.body)).toEqual([byLegalName]);

    const handle = await getClients(cookie, agencyId, { search: 'padariacentral' });
    expect(ids(handle.body)).toEqual([byHandle]);

    // The SPEC's search box says "@" but the handle is stored without it: a typed `@handle` means
    // the handle and must find the same client.
    const handleWithAt = await getClients(cookie, agencyId, { search: '@padariacentral' });
    expect(ids(handleWithAt.body)).toEqual([byHandle]);

    // A lone `@` is not a handle search: the guard keeps it on the one-character term, so it
    // never becomes a wildcard matching every client with a handle.
    const loneAt = await getClients(cookie, agencyId, { search: '@' });
    expect(loneAt.body.meta.totalItems).toBe(0);
    expect(loneAt.body.data).toHaveLength(0);

    // The term is folded too: no accent in the search still finds the accented name.
    const unaccentedTerm = await getClients(cookie, agencyId, { search: 'joao cafe' });
    expect(ids(unaccentedTerm.body)).toEqual([accented]);
    const accentedTerm = await getClients(cookie, agencyId, { search: 'joão café' });
    expect(ids(accentedTerm.body)).toEqual([accented]);

    // A name stored decomposed (NFD, 'pa' + combining tilde + 'o') folds like the composed form.
    const decomposed = await createClient({ agencyId, name: 'P\u0061\u0303o NFD' });
    const decomposedTerm = await getClients(cookie, agencyId, { search: 'pao' });
    expect(ids(decomposedTerm.body)).toEqual([decomposed]);

    // NFD with a cedilla ('c' + U+0327) and a tilde ('a' + U+0303): the fold removes the
    // combining marks, so the unaccented search finds the decomposed name.
    const decomposedCedilla = await createClient({ agencyId, name: 'Comunicac\u0327a\u0303o NFD' });
    const cedillaTerm = await getClients(cookie, agencyId, { search: 'comunicacao' });
    expect(ids(cedillaTerm.body)).toEqual([decomposedCedilla]);

    // `taxId` is not a declared search field: a CNPJ fragment finds nothing.
    const cnpj = await getClients(cookie, agencyId, { search: '12345' });
    expect(cnpj.body.meta.totalItems).toBe(0);
    expect(cnpj.body.data).toHaveLength(0);

    // `%` and `_` are LIKE metacharacters; escaped, they are literal and match nothing here. A
    // mutation that drops the escaping returns every row.
    for (const search of ['%', '_']) {
      const wildcard = await getClients(cookie, agencyId, { search });
      expect(wildcard.body.meta.totalItems, `search=${search}`).toBe(0);
      expect(wildcard.body.data).toHaveLength(0);
    }
  });

  it('#125: status=archived returns only archived, and the default never mixes them', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('archived');
    const active = [
      await createClient({ agencyId, name: 'Ativo Um' }),
      await createClient({ agencyId, name: 'Ativo Dois' })
    ];
    const archived = [
      await createClient({ agencyId, name: 'Arquivado Um', status: 'archived' }),
      await createClient({ agencyId, name: 'Arquivado Dois', status: 'archived' })
    ];

    const archivedList = await getClients(cookie, agencyId, { status: 'archived' });
    expect(archivedList.status).toBe(200);
    expect(archivedList.body.meta.totalItems).toBe(2);
    expect(ids(archivedList.body).sort()).toEqual([...archived].sort());
    expect(archivedList.body.data.every((item) => item.status === 'archived')).toBe(true);

    const activeList = await getClients(cookie, agencyId, { status: 'active' });
    expect(ids(activeList.body).sort()).toEqual([...active].sort());

    const defaultList = await getClients(cookie, agencyId);
    expect(ids(defaultList.body).sort()).toEqual([...active].sort());

    // The status filter composes with search: the term still applies inside the archived scope.
    const archivedSearch = await getClients(cookie, agencyId, { status: 'archived', search: 'Arquivado' });
    expect(archivedSearch.status).toBe(200);
    expect(archivedSearch.body.meta.totalItems).toBe(2);
    expect(ids(archivedSearch.body).sort()).toEqual([...archived].sort());
    const archivedSearchActive = await getClients(cookie, agencyId, { status: 'archived', search: 'Ativo' });
    expect(archivedSearchActive.body.meta.totalItems).toBe(0);
  });

  it('#125: pendingInvitations appears only with cliente.convidar_usuario, omitted instead of zeroed', async () => {
    const { agencyId, admin, cookie: adminCookie } = await createAgencyWithAdmin('invites');
    const manager = await addMember(agencyId, { name: 'Gestora Convites', emailLabel: 'invites-manager', roleId: presetRoleIds.account_manager });
    const viewerRole = await createCustomRole(agencyId, ['cliente.visualizar']);
    const viewer = await addMember(agencyId, { name: 'Vidente Convites', emailLabel: 'invites-viewer', roleId: viewerRole });
    const convidarOnlyRole = await createCustomRole(agencyId, ['cliente.convidar_usuario']);
    const convidarOnly = await addMember(agencyId, { name: 'Convidador Convites', emailLabel: 'invites-invite-only', roleId: convidarOnlyRole });

    const withPending = await createClient({ agencyId, name: 'Com Convite' });
    const withoutPending = await createClient({ agencyId, name: 'Sem Convite' });
    const now = Date.now();
    await addInvitation({ agencyId, clientId: withPending, invitedByUserId: admin.id, expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1_000) });
    // Only the first is pending: used, revoked and expired do not count.
    await addInvitation({ agencyId, clientId: withPending, invitedByUserId: admin.id, usedAt: new Date(now - 1_000) });
    await addInvitation({ agencyId, clientId: withPending, invitedByUserId: admin.id, revokedAt: new Date(now - 1_000) });
    await addInvitation({ agencyId, clientId: withPending, invitedByUserId: admin.id, expiresAt: new Date(now - 1_000) });

    const adminList = await getClients(adminCookie, agencyId);
    const adminPending = adminList.body.data.find((item) => item.id === withPending);
    const adminWithout = adminList.body.data.find((item) => item.id === withoutPending);
    expect(adminPending?.pendingInvitations).toBe(1);
    // Present and zero for the Admin -- this is what proves the field is omitted, not zeroed, for
    // the others below.
    expect(adminWithout?.pendingInvitations).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(adminWithout, 'pendingInvitations')).toBe(true);

    // The Owner with no membership at all still sees the badge: `tenant.isOwner` opens the count
    // without any role, and `has_agency_permission` grants ownership alone.
    const agencyOwner = await makeUser('invites-owner', 'Dona Sem Papel');
    const ownedAgencyId = await createAgency('Agency invites-owner', agencyOwner.id);
    const ownedWithPending = await createClient({ agencyId: ownedAgencyId, name: 'Com Convite do Dono' });
    const ownedWithoutPending = await createClient({ agencyId: ownedAgencyId, name: 'Sem Convite do Dono' });
    await addInvitation({ agencyId: ownedAgencyId, clientId: ownedWithPending, invitedByUserId: agencyOwner.id });
    const ownerList = await getClients(await loginCookie(agencyOwner), ownedAgencyId);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.data.find((item) => item.id === ownedWithPending)?.pendingInvitations).toBe(1);
    expect(ownerList.body.data.find((item) => item.id === ownedWithoutPending)?.pendingInvitations).toBe(0);
    expect(ownerList.body.data.every((item) => Object.prototype.hasOwnProperty.call(item, 'pendingInvitations'))).toBe(true);

    for (const user of [manager, viewer]) {
      const list = await getClients(await loginCookie(user), agencyId);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(2);
      for (const item of list.body.data) {
        expect(Object.prototype.hasOwnProperty.call(item, 'pendingInvitations'), `${user.name} ${item.name}`).toBe(false);
      }
    }

    // `cliente.convidar_usuario` alone does not open the listing: the permission is the named one.
    const convidarOnlyList = await getClients(await loginCookie(convidarOnly), agencyId);
    expect(convidarOnlyList.status).toBe(403);
    expect(convidarOnlyList.body.error.code).toBe('FORBIDDEN');
  }, 20_000);

  it('#125: the query is strict -- an undeclared parameter, an invalid value or a control byte is 400, never a logged 500', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('strict');
    const before = logs.lines().length;

    const invalid: readonly Record<string, string>[] = [
      { unknown: '1' },
      { status: 'removed' },
      { status: 'ACTIVE' },
      { sort: 'threads' },
      { sort: 'attention:desc' },
      { search: '' },
      { page: '0' },
      { pageSize: '0' }
    ];
    for (const query of invalid) {
      const response = await getClients(cookie, agencyId, query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const hostile: readonly Record<string, string>[] = [
      { search: '\u0000' },
      { search: 'ana\u0001maria' },
      { sort: 'a\u0000b' }
    ];
    for (const query of hostile) {
      const response = await getClients(cookie, agencyId, query);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const during = logs.lines().slice(before).join('\n');
    expect(during).not.toContain('"level":50');
    expect(during).not.toContain('INTERNAL_ERROR');
  });

  it('#125: photoUrl signs a stored key, degrades a broken one to null with a warning, and closingDate is a plain date', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('photo');
    const withPhotoId = randomUUID();
    const ownKey = `agencies/${agencyId}/clients/${withPhotoId}/avatar/${randomUUID()}.png`;
    const withPhoto = await createClient({
      id: withPhotoId,
      agencyId,
      name: 'Com Foto',
      photoKey: ownKey,
      closingDate: '2026-12-31'
    });
    const brokenPhoto = await createClient({ agencyId, name: 'Foto Quebrada', photoKey: 'not-a-real-key' });
    await createClient({ agencyId, name: 'Sem Foto' });

    const list = await getClients(cookie, agencyId, { pageSize: 100 });
    expect(list.status).toBe(200);
    const signed = list.body.data.find((item) => item.id === withPhoto);
    expect(typeof signed?.photoUrl).toBe('string');
    expect(new URL(signed!.photoUrl!).pathname.endsWith(ownKey)).toBe(true);
    expect(signed?.closingDate).toBe('2026-12-31');
    expect(list.body.data.find((item) => item.id === brokenPhoto)?.photoUrl).toBeNull();

    const before = logs.lines().length;
    const after = await getClients(cookie, agencyId, { pageSize: 100, search: 'quebrada' });
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0]?.photoUrl).toBeNull();
    expect(logs.lines().slice(before).join('\n')).toContain('CLIENT_PHOTO_URL_FAILED');
  });

  it('#311: the list signs a stored photo key only when it is an avatar key of that agency and client', async () => {
    const { agencyId, cookie } = await createAgencyWithAdmin('photoforeign');
    const foreignKeys = [
      `agencies/${agencyId}/clients/${randomUUID()}/avatar/${randomUUID()}.png`,
      `agencies/${randomUUID()}/clients/${randomUUID()}/avatar/${randomUUID()}.png`,
      `users/${randomUUID()}/avatar/${randomUUID()}.png`
    ];
    const ids: string[] = [];
    for (const [index, photoKey] of foreignKeys.entries()) {
      ids.push(await createClient({ agencyId, name: `Chave Alheia ${index}`, photoKey }));
    }

    const before = logs.lines().length;
    const list = await getClients(cookie, agencyId, { pageSize: 100 });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(foreignKeys.length);
    for (const id of ids) expect(list.body.data.find((item) => item.id === id)?.photoUrl).toBeNull();
    const during = logs.lines().slice(before).join('\n');
    expect(during).toContain('CLIENT_PHOTO_URL_FAILED');
    for (const foreignKey of foreignKeys) expect(during).not.toContain(foreignKey);
  });
});
