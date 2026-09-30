import { randomUUID } from 'node:crypto';

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
import type { DatabaseClient } from '@ageniza/database';

const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let logs: CapturedLogs;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdAgencyIds = [agencyA, agencyB];
const createdCustomRoleIds: string[] = [];

let admin: TestUserFixture;
let manager: TestUserFixture;
let production: TestUserFixture;
let sales: TestUserFixture;
let finance: TestUserFixture;
let viewer: TestUserFixture;
let dualAdmin: TestUserFixture;
let otherAdmin: TestUserFixture;
let portalUser: TestUserFixture;

let adminCookie: string;
let managerCookie: string;
let productionCookie: string;
let salesCookie: string;
let financeCookie: string;
let viewerCookie: string;
let dualAdminCookie: string;
let otherAdminCookie: string;
let portalCookie: string;

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (label: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: label });
  createdUserIds.push(user.id);
  return user;
};

const insertMembership = async (agencyId: string, userId: string, roleId: string): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId });
};

const createClient = async (input: {
  readonly agencyId?: string;
  readonly name?: string;
  readonly status?: 'active' | 'archived';
  readonly photoKey?: string | null;
  readonly closingDate?: string | null;
  readonly legalName?: string | null;
  readonly taxId?: string | null;
  readonly contactPhone?: string | null;
  readonly instagramHandle?: string | null;
}): Promise<string> => {
  const id = randomUUID();
  await owner.knex('clients').insert({
    id,
    agency_id: input.agencyId ?? agencyA,
    name: input.name ?? `Client ${id}`,
    status: input.status ?? 'active',
    archived_at: input.status === 'archived' ? new Date() : null,
    photo_key: input.photoKey ?? null,
    closing_date: input.closingDate ?? null,
    legal_name: input.legalName ?? null,
    tax_id: input.taxId ?? null,
    contact_phone: input.contactPhone ?? null,
    instagram_handle: input.instagramHandle ?? null
  });
  return id;
};

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

const postClient = async (cookie: string, agencyId: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const getClient = async (cookie: string, agencyId: string, clientId: string): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients/${clientId}`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

const patchClient = async (cookie: string, agencyId: string, clientId: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'PATCH', url: `/agencies/${agencyId}/clients/${clientId}`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const clientRow = (clientId: string) => owner.knex('clients').where({ id: clientId }).first();

// ---- #125 fixtures -------------------------------------------------------------------------

interface ClientListJson {
  readonly data: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly photoUrl: string | null;
    readonly instagramHandle: string | null;
    readonly status: 'active' | 'archived';
    readonly closingDate: string | null;
    readonly threadsAwaitingAgency: number;
    readonly pendingInvitations?: number;
  }>;
  readonly meta: { readonly page: number; readonly pageSize: number; readonly totalItems: number; readonly totalPages: number };
}

let systemRoleIds: Record<string, string>;
let ownerC: TestUserFixture;
let viewerC: TestUserFixture;
let nonViewerC: TestUserFixture;
let ownerCCookie: string;
let viewerCCookie: string;
let nonViewerCCookie: string;

const systemRoleId = (key: string): string => {
  const id = systemRoleIds[key];
  if (id === undefined) throw new Error(`Missing system role ${key}.`);
  return id;
};

const makeAgencyRole = async (agencyId: string, permissionKeys: readonly string[]): Promise<string> => {
  const roleId = randomUUID();
  createdCustomRoleIds.push(roleId);
  await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `role-${roleId}`, name: 'Papel da carteira', is_system: false });
  if (permissionKeys.length > 0) {
    await owner.knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: roleId, permission_key })));
  }
  return roleId;
};

/** A fresh agency where `admin`, `ownerC`, `viewerC` (visualizar) and `nonViewerC` (operar) are members. */
const createListingAgency = async (options: { readonly withPresets?: boolean } = {}): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name: `Carteira ${id}`, owner_user_id: ownerC.id });
  const viewerRole = await makeAgencyRole(id, ['cliente.visualizar']);
  const noViewRole = await makeAgencyRole(id, ['cliente.operar']);
  const memberships = [
    { agency_id: id, user_id: ownerC.id, role_id: systemRoleId('admin') },
    { agency_id: id, user_id: admin.id, role_id: systemRoleId('admin') },
    { agency_id: id, user_id: viewerC.id, role_id: viewerRole },
    { agency_id: id, user_id: nonViewerC.id, role_id: noViewRole }
  ];
  if (options.withPresets === true) {
    memberships.push(
      { agency_id: id, user_id: manager.id, role_id: systemRoleId('account_manager') },
      { agency_id: id, user_id: production.id, role_id: systemRoleId('production') },
      { agency_id: id, user_id: sales.id, role_id: systemRoleId('sales') },
      { agency_id: id, user_id: finance.id, role_id: systemRoleId('finance') }
    );
  }
  await owner.knex('agency_memberships').insert(memberships);
  return id;
};

const requestClients = async (cookie: string, agencyId: string, query: Record<string, string> = {}): Promise<InjectResponse> => {
  const search = new URLSearchParams(Object.entries(query));
  const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
  return (await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients${suffix}`, headers: { ...origin, cookie } })) as unknown as InjectResponse;
};

const idsOf = (response: InjectResponse): string[] => response.json<ClientListJson>().data.map((item) => item.id);
const namesOf = (response: InjectResponse): string[] => response.json<ClientListJson>().data.map((item) => item.name);
const itemOf = (response: InjectResponse, clientId: string): ClientListJson['data'][number] => {
  const item = response.json<ClientListJson>().data.find((candidate) => candidate.id === clientId);
  if (item === undefined) throw new Error(`Client ${clientId} is not on the page.`);
  return item;
};

/** Opens a thread on a client with backdated comments, optionally resolved. */
const insertThread = async (input: {
  readonly clientId: string;
  readonly comments: ReadonlyArray<{ readonly side: 'agency' | 'client'; readonly at: string }>;
  readonly resolvedAt?: string;
}): Promise<string> => {
  const threadId = randomUUID();
  const firstSide = input.comments[0]?.side ?? 'agency';
  await owner.knex('client_threads').insert({
    id: threadId,
    client_id: input.clientId,
    section_key: 'branding',
    opened_by: firstSide === 'client' ? portalUser.id : admin.id,
    opened_side: firstSide
  });
  for (const comment of input.comments) {
    await owner.knex.raw(
      `insert into public.client_thread_comments (id, thread_id, client_id, author_user_id, author_side, body, created_at) values (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), threadId, input.clientId, comment.side === 'client' ? portalUser.id : admin.id, comment.side, 'comentário', comment.at]
    );
  }
  if (input.resolvedAt !== undefined) {
    // Only resolved_at: setting resolved_by would fire the resolve trigger and stamp it to now().
    await owner.knex('client_threads').where({ id: threadId }).update({ resolved_at: input.resolvedAt });
  }
  return threadId;
};

const insertPortalInvitation = async (input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
  readonly revokedAt?: Date;
}): Promise<void> => {
  await owner.knex('invitations').insert({
    agency_id: input.agencyId,
    purpose: 'client_invite',
    email: input.email.toLowerCase(),
    client_id: input.clientId,
    token_hash: randomUUID().replace(/-/g, ''),
    expires_at: input.expiresAt,
    used_at: input.usedAt ?? null,
    revoked_at: input.revokedAt ?? null
  });
};


describe('CLIENTS HTTP module (#124)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    logs = captureLogs();
    app = await buildTestApp({ sender: createFakeEmailSender(), logger: logs.logger });

    admin = await makeUser('clients-admin');
    manager = await makeUser('clients-manager');
    production = await makeUser('clients-production');
    sales = await makeUser('clients-sales');
    finance = await makeUser('clients-finance');
    viewer = await makeUser('clients-viewer');
    dualAdmin = await makeUser('clients-dual-admin');
    otherAdmin = await makeUser('clients-other-admin');
    portalUser = await makeUser('clients-portal');
    ownerC = await makeUser('clients-owner-c');
    viewerC = await makeUser('clients-viewer-c');
    nonViewerC = await makeUser('clients-no-view-c');

    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance']).select('id', 'key');
    systemRoleIds = Object.fromEntries(roles.map((role) => [role.key as string, role.id as string]));
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Clients Agency A', owner_user_id: null },
      { id: agencyB, name: 'Clients Agency B', owner_user_id: null }
    ]);

    const customRoleId = randomUUID();
    createdCustomRoleIds.push(customRoleId);
    await owner.knex('roles').insert({ id: customRoleId, agency_id: agencyA, key: `only-view-${customRoleId}`, name: 'Só visualizar', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: customRoleId, permission_key: 'cliente.visualizar' });
    await insertMembership(agencyA, admin.id, roleId('admin'));
    await insertMembership(agencyA, manager.id, roleId('account_manager'));
    await insertMembership(agencyA, production.id, roleId('production'));
    await insertMembership(agencyA, sales.id, roleId('sales'));
    await insertMembership(agencyA, finance.id, roleId('finance'));
    await insertMembership(agencyA, viewer.id, customRoleId);
    await insertMembership(agencyA, dualAdmin.id, roleId('admin'));
    await insertMembership(agencyB, dualAdmin.id, roleId('admin'));
    await insertMembership(agencyB, otherAdmin.id, roleId('admin'));

    // #125 actors need a context to log in before any listing agency exists: a home agency where
    // each holds the permission the listing tests exercise.
    const homeAgency = randomUUID();
    createdAgencyIds.push(homeAgency);
    await owner.knex('agencies').insert({ id: homeAgency, name: 'Clients Home', owner_user_id: ownerC.id });
    const homeViewerRole = await makeAgencyRole(homeAgency, ['cliente.visualizar']);
    const homeNoViewRole = await makeAgencyRole(homeAgency, ['cliente.operar']);
    await owner.knex('agency_memberships').insert([
      { agency_id: homeAgency, user_id: ownerC.id, role_id: roleId('admin') },
      { agency_id: homeAgency, user_id: viewerC.id, role_id: homeViewerRole },
      { agency_id: homeAgency, user_id: nonViewerC.id, role_id: homeNoViewRole }
    ]);

    // The portal person has a client vínculo but no agency membership: agency routes must 404.
    const portalClient = await createClient({ agencyId: agencyA });
    await owner.knex('client_memberships').insert({ client_id: portalClient, user_id: portalUser.id });

    adminCookie = await login(admin);
    managerCookie = await login(manager);
    productionCookie = await login(production);
    salesCookie = await login(sales);
    financeCookie = await login(finance);
    viewerCookie = await login(viewer);
    dualAdminCookie = await login(dualAdmin);
    otherAdminCookie = await login(otherAdmin);
    portalCookie = await login(portalUser);
    ownerCCookie = await login(ownerC);
    viewerCCookie = await login(viewerC);
    nonViewerCCookie = await login(nonViewerC);
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    // Includes clients created by the routes (POST), whose ids are not tracked here.
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdCustomRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdCustomRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('creates for admin and account_manager, and forbids production, sales and finance', async () => {
    const created = await postClient(adminCookie, agencyA, { name: 'Padaria Admin' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Padaria Admin', status: 'active', photoUrl: null, closingDate: null, archivedAt: null });

    expect((await postClient(managerCookie, agencyA, { name: 'Padaria Gestor' })).statusCode).toBe(201);

    for (const cookie of [productionCookie, salesCookie, financeCookie]) {
      const response = await postClient(cookie, agencyA, { name: `Denied ${randomUUID()}` });
      expect(response.statusCode).toBe(403);
    }
  });

  it('trims the name and rejects an empty one', async () => {
    const created = await postClient(adminCookie, agencyA, { name: '  Padaria Espaços  ' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Padaria Espaços' });

    expect((await postClient(adminCookie, agencyA, { name: '   ' })).statusCode).toBe(400);
  });

  it('detects an active name through the unique index (case and whitespace) and lets an archived homonym through', async () => {
    const name = `Homônimo ${randomUUID()}`;
    await createClient({ agencyId: agencyA, name });

    const conflicting = await postClient(adminCookie, agencyA, { name: `  ${name.toUpperCase()}  ` });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: { code: 'CLIENT_NAME_IN_USE' } });

    // The index collapses runs of whitespace, so a double internal space is the same name. A
    // pre-flight SELECT with lower(btrim(name)) would miss this and leak a raw 23505.
    const spaced = `Espaço  Interno ${randomUUID()}`;
    await createClient({ agencyId: agencyA, name: spaced });
    expect((await postClient(adminCookie, agencyA, { name: spaced.replace('  ', ' ') })).statusCode).toBe(409);

    await createClient({ agencyId: agencyA, name: `Arquivado ${randomUUID()}`, status: 'archived' });
    const archivedName = (await owner.knex('clients').where({ status: 'archived' }).where('agency_id', agencyA).orderBy('created_at', 'desc').first('name'))?.name as string;
    expect((await postClient(adminCookie, agencyA, { name: archivedName })).statusCode).toBe(201);
  });

  it('gives exactly one 201 and one 409 for two concurrent POSTs with the same name', async () => {
    // The two literals normalize to the same active name (the index collapses the extra space), so
    // only the unique index can decide the race -- a pre-flight SELECT would let both through.
    const name = `Corrida ${randomUUID()}`;
    const variant = name.replace(' ', '  ');
    const [first, second] = await Promise.all([
      postClient(adminCookie, agencyA, { name }),
      postClient(managerCookie, agencyA, { name: variant })
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    await expect(owner.knex('clients').where({ agency_id: agencyA }).whereIn('name', [name, variant]).select('id')).resolves.toHaveLength(1);
  });

  it('reads the detail for every preset and hides a client of another agency, including from a member of both', async () => {
    const clientId = await createClient({ agencyId: agencyA, name: `Leitura ${randomUUID()}`, closingDate: '2026-12-31' });
    for (const cookie of [adminCookie, managerCookie, productionCookie, salesCookie, financeCookie]) {
      const response = await getClient(cookie, agencyA, clientId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: clientId, status: 'active', closingDate: '2026-12-31' });
    }

    // A client that lives in agency B, addressed through agency A: the same 404 for a member of B
    // and for a member of both agencies.
    const clientB = await createClient({ agencyId: agencyB, name: `Outra agência ${randomUUID()}` });
    expect((await getClient(otherAdminCookie, agencyA, clientB)).statusCode).toBe(404);
    expect((await getClient(dualAdminCookie, agencyA, clientB)).statusCode).toBe(404);
    expect((await getClient(adminCookie, agencyA, clientB)).statusCode).toBe(404);
    expect((await getClient(adminCookie, agencyA, randomUUID())).statusCode).toBe(404);
    expect((await getClient(adminCookie, agencyA, 'not-a-uuid')).statusCode).toBe(404);
  });

  it('edits for account_manager and forbids production', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    const edited = await patchClient(managerCookie, agencyA, clientId, { segment: 'Alimentação' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ segment: 'Alimentação' });
    expect((await patchClient(productionCookie, agencyA, clientId, { segment: 'Negado' })).statusCode).toBe(403);
  });

  it('answers 409 on an archived client and changes nothing', async () => {
    const clientId = await createClient({ agencyId: agencyA, name: `Arquivado ${randomUUID()}`, status: 'archived', contactPhone: '+55 11 90000-0000' });
    const response = await patchClient(adminCookie, agencyA, clientId, { contactPhone: '+55 11 91111-1111', segment: 'x' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' } });
    await expect(clientRow(clientId)).resolves.toMatchObject({ contact_phone: '+55 11 90000-0000', segment: null });
  });

  it('normalizes taxId and instagramHandle, clears with null, and rejects a 12-digit taxId', async () => {
    const clientId = await createClient({ agencyId: agencyA });

    const masked = await patchClient(adminCookie, agencyA, clientId, { taxId: '12.345.678/0001-90', instagramHandle: '@padariacentral' });
    expect(masked.statusCode).toBe(200);
    expect(masked.json()).toMatchObject({ taxId: '12345678000190', instagramHandle: 'padariacentral' });

    expect((await patchClient(adminCookie, agencyA, clientId, { taxId: '123456789012' })).statusCode).toBe(400);

    const cleared = await patchClient(adminCookie, agencyA, clientId, { taxId: null, instagramHandle: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ taxId: null, instagramHandle: null });
  });

  it('answers 409 on a PATCH that reuses an active name', async () => {
    const taken = `Tomado ${randomUUID()}`;
    await createClient({ agencyId: agencyA, name: taken });
    const clientId = await createClient({ agencyId: agencyA });
    const response = await patchClient(adminCookie, agencyA, clientId, { name: taken });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CLIENT_NAME_IN_USE' } });
  });

  it('counts brandStudyFilled with personas only when active', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    await owner.knex('client_brand_sections').insert([
      { client_id: clientId, section_key: 'branding', body: 'Marca' },
      { client_id: clientId, section_key: 'positioning', body: null }
    ]);
    await owner.knex.raw(`insert into public.client_brand_sections (client_id, section_key, colors) values (?, 'colors', ?::jsonb)`, [clientId, JSON.stringify([{ nome: 'Vinho', codigo: '#7A1F2B' }])]);
    const activePersona = randomUUID();
    await owner.knex('client_personas').insert([
      { id: activePersona, client_id: clientId, name: 'Ativa' },
      { id: randomUUID(), client_id: clientId, name: 'Arquivada', status: 'archived' }
    ]);

    const filled = await getClient(adminCookie, agencyA, clientId);
    expect(filled.statusCode).toBe(200);
    expect(filled.json()).toMatchObject({ summary: { brandStudyFilled: 3 } });

    await owner.knex('client_personas').where({ id: activePersona }).update({ status: 'archived' });
    const withoutActivePersona = await getClient(adminCookie, agencyA, clientId);
    expect(withoutActivePersona.json()).toMatchObject({ summary: { brandStudyFilled: 2 } });
  });

  it('reopens a resolved thread when a client comments, raising threadsAwaitingAgency', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    const threadId = randomUUID();
    const t0 = new Date('2026-01-01T10:00:00.000Z');
    const t1 = new Date('2026-01-01T11:00:00.000Z');
    const t2 = new Date('2026-01-01T12:00:00.000Z');
    await owner.knex('client_threads').insert({ id: threadId, client_id: clientId, section_key: 'branding', opened_by: admin.id, opened_side: 'agency' });
    await owner.knex.raw(`insert into public.client_thread_comments (id, thread_id, client_id, author_user_id, author_side, body, created_at) values (?, ?, ?, ?, 'agency', 'Resposta', ?)`, [randomUUID(), threadId, clientId, admin.id, t0]);

    const openAnswered = await getClient(adminCookie, agencyA, clientId);
    expect(openAnswered.json()).toMatchObject({ summary: { threadsAwaitingAgency: 0, threadsAnsweredByAgency: 1 } });

    // Only resolved_at: setting resolved_by would fire the resolve trigger and stamp it to now(),
    // which would sit after the backdated client comment below and keep the thread closed.
    await owner.knex('client_threads').where({ id: threadId }).update({ resolved_at: t1 });
    const resolved = await getClient(adminCookie, agencyA, clientId);
    expect(resolved.json()).toMatchObject({ summary: { threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0 } });

    // A client comment after the resolution reopens the thread: resolved_at is now older than the
    // latest comment, so it counts as "aguardando a agência" again.
    await owner.knex.raw(`insert into public.client_thread_comments (id, thread_id, client_id, author_user_id, author_side, body, created_at) values (?, ?, ?, ?, 'client', 'Nova dúvida', ?)`, [randomUUID(), threadId, clientId, portalUser.id, t2]);
    const reopened = await getClient(adminCookie, agencyA, clientId);
    expect(reopened.json()).toMatchObject({ summary: { threadsAwaitingAgency: 1, threadsAnsweredByAgency: 0 } });
  });

  it('counts active portal members', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    const memberA = await makeUser('clients-member-a');
    const memberB = await makeUser('clients-member-b');
    await owner.knex('client_memberships').insert([
      { client_id: clientId, user_id: memberA.id },
      { client_id: clientId, user_id: memberB.id, status: 'removed' }
    ]);
    const response = await getClient(adminCookie, agencyA, clientId);
    expect(response.json()).toMatchObject({ summary: { activePortalMembers: 1 } });
  });

  it('lets a portal person reach no agency route (404)', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    expect((await postClient(portalCookie, agencyA, { name: `Portal ${randomUUID()}` })).statusCode).toBe(404);
    expect((await getClient(portalCookie, agencyA, clientId)).statusCode).toBe(404);
    expect((await patchClient(portalCookie, agencyA, clientId, { segment: 'x' })).statusCode).toBe(404);
  });

  it('enforces BFLA with a one-permission custom role: reads, but cannot write', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    expect((await getClient(viewerCookie, agencyA, clientId)).statusCode).toBe(200);
    expect((await postClient(viewerCookie, agencyA, { name: `Viewer ${randomUUID()}` })).statusCode).toBe(403);
    expect((await patchClient(viewerCookie, agencyA, clientId, { segment: 'x' })).statusCode).toBe(403);
  });

  it('rejects extra fields in the body (BOPLA), never writing status, tenant or stamps', async () => {
    for (const payload of [
      { name: 'x', status: 'archived' },
      { name: 'x', agency_id: agencyB },
      { name: 'x', createdAt: '2020-01-01T00:00:00.000Z' },
      { name: 'x', updatedBy: admin.id }
    ]) {
      expect((await postClient(adminCookie, agencyA, payload)).statusCode).toBe(400);
    }

    const clientId = await createClient({ agencyId: agencyA });
    for (const payload of [
      { status: 'archived' },
      { agency_id: agencyB },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { updatedBy: admin.id }
    ]) {
      expect((await patchClient(adminCookie, agencyA, clientId, payload)).statusCode).toBe(400);
    }
    await expect(clientRow(clientId)).resolves.toMatchObject({ status: 'active', agency_id: agencyA });
  });

  it('rejects control characters, oversized names and accepts NBSP and zero-width text', async () => {
    expect((await postClient(adminCookie, agencyA, { name: `Tab\tName ${randomUUID()}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: `Nul\u0000Name ${randomUUID()}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: 'a'.repeat(10_000) })).statusCode).toBe(400);

    const nbsp = `Café\u00a0Central ${randomUUID()}`;
    expect((await postClient(adminCookie, agencyA, { name: nbsp })).statusCode).toBe(201);
    const zeroWidth = `Café\u200bCentral ${randomUUID()}`;
    expect((await postClient(adminCookie, agencyA, { name: zeroWidth })).statusCode).toBe(201);
  });

  it('signs photoUrl when a key exists, returns null with a warning for an unusable key, and null with no key', async () => {
    const withPhoto = await createClient({ agencyId: agencyA, photoKey: `agencies/${agencyA}/clients/${randomUUID()}/avatar/${randomUUID()}.png` });
    const signed = await getClient(adminCookie, agencyA, withPhoto);
    expect(typeof (signed.json() as { photoUrl?: unknown }).photoUrl).toBe('string');

    const brokenPhoto = await createClient({ agencyId: agencyA, photoKey: 'not-a-real-key' });
    const logsBefore = logs.text().length;
    const broken = await getClient(adminCookie, agencyA, brokenPhoto);
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toMatchObject({ photoUrl: null });
    expect(logs.text().slice(logsBefore)).toContain('CLIENT_PHOTO_URL_FAILED');

    const noPhoto = await createClient({ agencyId: agencyA });
    expect((await getClient(adminCookie, agencyA, noPhoto)).json()).toMatchObject({ photoUrl: null });
  });

  it('returns archived status and archivedAt, and records the session user as updated_by', async () => {
    const archived = await createClient({ agencyId: agencyA, status: 'archived' });
    const response = await getClient(adminCookie, agencyA, archived);
    expect(response.json()).toMatchObject({ status: 'archived' });
    expect((response.json() as { archivedAt: string | null }).archivedAt).not.toBeNull();

    const clientId = await createClient({ agencyId: agencyA });
    await patchClient(managerCookie, agencyA, clientId, { segment: 'Alimentação' });
    await expect(clientRow(clientId)).resolves.toMatchObject({ updated_by: manager.id });
  });

  it('#125: without parameters, 20 active clients, attention order with name as tie-break', async () => {
    const agencyId = await createListingAgency();
    const createdNames: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const name = `Cliente ${String(index).padStart(2, '0')}`;
      await createClient({ agencyId, name });
      createdNames.push(name);
    }

    const response = await requestClients(adminCookie, agencyId);
    expect(response.statusCode).toBe(200);
    const body = response.json<ClientListJson>();
    expect(body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 25, totalPages: 2 });
    expect(body.data).toHaveLength(20);
    expect(body.data.every((item) => item.status === 'active')).toBe(true);
    // No thread awaiting: the attention order falls back to name ascending.
    expect(body.data.map((item) => item.name)).toEqual([...createdNames].sort().slice(0, 20));
  });

  it('#125: a client with a thread awaiting the agency comes first, ahead of an alphabetically earlier one', async () => {
    const agencyId = await createListingAgency();
    await createClient({ agencyId, name: 'Alfa' });
    const zeta = await createClient({ agencyId, name: 'Zeta' });
    await insertThread({ clientId: zeta, comments: [{ side: 'client', at: '2026-01-01T10:00:00.000Z' }] });

    const response = await requestClients(adminCookie, agencyId);
    expect(namesOf(response)).toEqual(['Zeta', 'Alfa']);
    expect(itemOf(response, zeta).threadsAwaitingAgency).toBe(1);

    // sort=name:asc ignores the triage order.
    expect(namesOf(await requestClients(adminCookie, agencyId, { sort: 'name:asc' }))).toEqual(['Alfa', 'Zeta']);
  });

  it('#125: a resolved thread does not count, and a client comment after the resolution reopens it', async () => {
    const agencyId = await createListingAgency();
    const clientId = await createClient({ agencyId, name: 'Resolvida' });
    // The thread is resolved AFTER the client's comment: its latest comment is from the client, but
    // the resolution closes it, so it must not count. This is the case a count that ignores
    // resolved_at would get wrong.
    const threadId = await insertThread({
      clientId,
      comments: [{ side: 'client', at: '2026-01-01T10:00:00.000Z' }],
      resolvedAt: '2026-01-01T11:00:00.000Z'
    });
    expect(itemOf(await requestClients(adminCookie, agencyId), clientId).threadsAwaitingAgency).toBe(0);

    // A new client comment is newer than the resolution: the thread reopens and counts again.
    await owner.knex.raw(
      `insert into public.client_thread_comments (id, thread_id, client_id, author_user_id, author_side, body, created_at) values (?, ?, ?, ?, 'client', 'Nova dúvida', ?)`,
      [randomUUID(), threadId, clientId, portalUser.id, '2026-01-01T12:00:00.000Z']
    );
    expect(itemOf(await requestClients(adminCookie, agencyId), clientId).threadsAwaitingAgency).toBe(1);
  });

  it('#125: search matches name, razão social and @ ignoring case and accent, and never the CNPJ', async () => {
    const agencyId = await createListingAgency();
    const padaria = await createClient({
      agencyId,
      name: 'Padaria Central',
      legalName: 'Pão Dourado Ltda',
      instagramHandle: 'padariacentral',
      taxId: '12345678000199'
    });
    await createClient({ agencyId, name: 'Outro Cliente' });

    expect(idsOf(await requestClients(adminCookie, agencyId, { search: 'padaria' }))).toEqual([padaria]);
    // Accent folding: "pao" finds "Pão Dourado" through the razão social, and an accented query
    // still finds the name.
    expect(idsOf(await requestClients(adminCookie, agencyId, { search: 'pao' }))).toEqual([padaria]);
    expect(idsOf(await requestClients(adminCookie, agencyId, { search: 'PADÁRIA' }))).toEqual([padaria]);
    // The @ handle.
    expect(idsOf(await requestClients(adminCookie, agencyId, { search: 'padariacentral' }))).toEqual([padaria]);
    // The CNPJ is not a searchable field.
    expect((await requestClients(adminCookie, agencyId, { search: '12345' })).json<ClientListJson>().meta.totalItems).toBe(0);
  });

  it('#125: search treats % and _ as literals', async () => {
    const agencyId = await createListingAgency();
    await createClient({ agencyId, name: '100% Alfa' });
    await createClient({ agencyId, name: 'Sem Metacaractere' });

    expect(namesOf(await requestClients(adminCookie, agencyId, { search: '%' }))).toEqual(['100% Alfa']);
    expect((await requestClients(adminCookie, agencyId, { search: '_' })).json<ClientListJson>().meta.totalItems).toBe(0);
  });

  it('#125: status=archived returns only archived clients', async () => {
    const agencyId = await createListingAgency();
    await createClient({ agencyId, name: 'Ativo' });
    const archived = await createClient({ agencyId, name: 'Arquivado', status: 'archived' });

    const response = await requestClients(adminCookie, agencyId, { status: 'archived' });
    expect(idsOf(response)).toEqual([archived]);
    expect(response.json<ClientListJson>().data.every((item) => item.status === 'archived')).toBe(true);
  });

  it('#125: pageSize=500 is limited to 100, with meta.pageSize=100', async () => {
    const agencyId = await createListingAgency();
    for (let index = 0; index < 101; index += 1) {
      await createClient({ agencyId, name: `Muitos ${String(index).padStart(3, '0')}` });
    }

    const response = await requestClients(adminCookie, agencyId, { pageSize: '500' });
    expect(response.json<ClientListJson>().meta.pageSize).toBe(100);
    expect(response.json<ClientListJson>().data).toHaveLength(100);
    expect(response.json<ClientListJson>().meta.totalItems).toBe(101);
  });

  it('#125: pendingInvitations is present for admin and Owner and omitted for the rest', async () => {
    const agencyId = await createListingAgency({ withPresets: true });
    const clientId = await createClient({ agencyId, name: 'Com Convite' });
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    await insertPortalInvitation({ agencyId, clientId, email: 'um@exemplo.test', expiresAt: future });
    await insertPortalInvitation({ agencyId, clientId, email: 'dois@exemplo.test', expiresAt: future });
    // Expired, used and revoked invitations are not pending.
    await insertPortalInvitation({ agencyId, clientId, email: 'expirado@exemplo.test', expiresAt: new Date(Date.now() - 1_000) });
    await insertPortalInvitation({ agencyId, clientId, email: 'usado@exemplo.test', expiresAt: future, usedAt: new Date() });
    await insertPortalInvitation({ agencyId, clientId, email: 'revogado@exemplo.test', expiresAt: future, revokedAt: new Date() });

    expect(itemOf(await requestClients(adminCookie, agencyId), clientId).pendingInvitations).toBe(2);
    expect(itemOf(await requestClients(ownerCCookie, agencyId), clientId).pendingInvitations).toBe(2);
    // account_manager and production do not hold cliente.convidar_usuario: the field is omitted.
    expect('pendingInvitations' in itemOf(await requestClients(managerCookie, agencyId), clientId)).toBe(false);
    expect('pendingInvitations' in itemOf(await requestClients(productionCookie, agencyId), clientId)).toBe(false);
  });

  it('#125: the five presets list and a member of another agency gets 404', async () => {
    const agencyId = await createListingAgency({ withPresets: true });
    await createClient({ agencyId, name: 'Visível' });

    for (const cookie of [adminCookie, managerCookie, productionCookie, salesCookie, financeCookie]) {
      expect((await requestClients(cookie, agencyId)).statusCode).toBe(200);
    }
    // otherAdmin is a member of agency B only; agencyId is a different agency, so the same 404.
    expect((await requestClients(otherAdminCookie, agencyId)).statusCode).toBe(404);
  });

  it('#125: totalItems matches the real count under the filter', async () => {
    const agencyId = await createListingAgency();
    for (let index = 0; index < 7; index += 1) {
      await createClient({ agencyId, name: `Busca Alvo ${index}` });
    }
    await createClient({ agencyId, name: 'Fora do filtro' });

    const response = await requestClients(adminCookie, agencyId, { search: 'alvo' });
    expect(response.json<ClientListJson>().meta.totalItems).toBe(7);
    expect(response.json<ClientListJson>().data).toHaveLength(7);
  });

  it('#125: rejects an overflowing page, an unknown parameter, a bad sort and control characters', async () => {
    const agencyId = await createListingAgency();
    for (const page of ['4e17', '1e20']) {
      expect((await requestClients(adminCookie, agencyId, { page })).statusCode).toBe(400);
    }
    for (const query of [{ taxId: '12345678000199' }, { foo: 'bar' }, { sort: 'name:desc' }, { status: 'removed' }] as ReadonlyArray<Record<string, string>>) {
      expect((await requestClients(adminCookie, agencyId, query)).statusCode).toBe(400);
    }
    expect((await requestClients(adminCookie, agencyId, { search: 'a\u0000b' })).statusCode).toBe(400);
    expect((await requestClients(adminCookie, agencyId, { search: 'ana\u0001maria' })).statusCode).toBe(400);
  });

  it('#125: enforces BFLA with one-permission custom roles', async () => {
    const agencyId = await createListingAgency();
    await createClient({ agencyId, name: 'BFLA' });

    // The admin preset hides a guard with the wrong key; these two roles have exactly one each.
    expect((await requestClients(viewerCCookie, agencyId)).statusCode).toBe(200);
    expect((await requestClients(nonViewerCCookie, agencyId)).statusCode).toBe(403);
  });

  it('#125: the agency filter keeps another agency out of the list', async () => {
    const agencyOne = await createListingAgency();
    const agencyTwo = await createListingAgency();
    const mine = await createClient({ agencyId: agencyOne, name: 'Da agência um' });
    const foreign = await createClient({ agencyId: agencyTwo, name: 'Da agência dois' });

    const response = await requestClients(adminCookie, agencyOne);
    expect(idsOf(response)).toEqual([mine]);
    expect(idsOf(response)).not.toContain(foreign);
    expect(response.json<ClientListJson>().meta.totalItems).toBe(1);
  });

  it('#125: same-name clients page without repetition or loss, held stable by the id tie-break', async () => {
    const agencyId = await createListingAgency();
    const ids = Array.from({ length: 12 }, () => randomUUID());
    // Archived on purpose: the active-name index forbids two active homonyms, but an archived
    // listing can hold many, which is exactly when the id tie-break decides a page boundary.
    // Insert in descending id order, so the heap order is the reverse of the expected tie-break.
    for (const id of [...ids].sort().reverse()) {
      await owner.knex('clients').insert({ id, agency_id: agencyId, name: 'Nome Igual', status: 'archived', archived_at: new Date() });
    }

    const collected: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await requestClients(adminCookie, agencyId, { page: String(page), pageSize: '4', status: 'archived' });
      collected.push(...idsOf(response));
    }
    expect(collected).toHaveLength(12);
    expect(new Set(collected).size).toBe(12);
    expect(collected).toEqual([...ids].sort());
  });
});
