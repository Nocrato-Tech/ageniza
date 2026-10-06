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
    contact_phone: input.contactPhone ?? null
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

    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance']).select('id', 'key');
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
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    // Includes clients created by the routes (POST), whose ids are not tracked here.
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
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

  it('rejects control, bidi and invisible characters in names and requires a letter or number', async () => {
    const suffix = randomUUID();
    expect((await postClient(adminCookie, agencyA, { name: `Tab\tName ${suffix}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: `Nul\u0000Name ${suffix}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: 'a'.repeat(10_000) })).statusCode).toBe(400);

    // Each invisible character below would create an active homonym that renders identically to
    // an existing name -- a zero-width space, a bidi override and the Hangul filler.
    expect((await postClient(adminCookie, agencyA, { name: `Café\u200bCentral ${suffix}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: `Café\u202eCentral ${suffix}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: `Café\u3164Central ${suffix}` })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: '★★★' })).statusCode).toBe(400);
    expect((await postClient(adminCookie, agencyA, { name: '\u00a0\u00a0' })).statusCode).toBe(400);

    // The joiners are accepted only between letters, combining marks or pictographs.
    expect((await postClient(adminCookie, agencyA, { name: `Café\u200cCentral ${suffix}` })).statusCode).toBe(201);
    expect((await postClient(adminCookie, agencyA, { name: `\u200dCafé ${suffix}` })).statusCode).toBe(400);

    // NBSP is a space, not an invisible format character: inside the name it stays.
    expect((await postClient(adminCookie, agencyA, { name: `Café\u00a0Central ${suffix}` })).statusCode).toBe(201);
  });

  it('applies the same name rule to the PATCH: name, contact fields and legalName', async () => {
    const clientId = await createClient({ agencyId: agencyA });
    expect((await patchClient(adminCookie, agencyA, clientId, { name: `Padaria\u200bCentral ${randomUUID()}` })).statusCode).toBe(400);
    expect((await patchClient(adminCookie, agencyA, clientId, { contactName: 'Maria\u200bSouza' })).statusCode).toBe(400);
    expect((await patchClient(adminCookie, agencyA, clientId, { contactPhone: '+55 11 90000-0000\u202e' })).statusCode).toBe(400);
    expect((await patchClient(adminCookie, agencyA, clientId, { legalName: 'Padaria\u200bCentral Ltda' })).statusCode).toBe(400);

    const accepted = await patchClient(managerCookie, agencyA, clientId, { contactName: 'Maria Souza', contactPhone: '+55 11 90000-0000' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ contactName: 'Maria Souza', contactPhone: '+55 11 90000-0000' });
  });

  it('stores an empty legalName, segment or contact as null instead of an empty string', async () => {
    const clientId = await createClient({ agencyId: agencyA, legalName: 'Original Ltda' });
    const padded = await patchClient(adminCookie, agencyA, clientId, { legalName: '   ', segment: '', contactName: '\u00a0', contactPhone: '  ' });
    expect(padded.statusCode).toBe(200);
    expect(padded.json()).toMatchObject({ legalName: null, segment: null, contactName: null, contactPhone: null });
    await expect(clientRow(clientId)).resolves.toMatchObject({ legal_name: null, segment: null, contact_name: null, contact_phone: null });
  });

  it('caps name, legalName, contactName, segment and contactPhone in UTF-8 bytes, not characters', async () => {
    const clientId = await createClient({ agencyId: agencyA, name: `Bytes ${randomUUID()}` });
    // 129 two-byte characters: 129 UTF-16 units, inside the 256-character cap, but 258 bytes.
    expect((await postClient(adminCookie, agencyA, { name: 'é'.repeat(129) })).statusCode).toBe(400);
    expect((await patchClient(adminCookie, agencyA, clientId, { name: 'é'.repeat(129) })).statusCode).toBe(400);
    expect((await patchClient(adminCookie, agencyA, clientId, { legalName: 'é'.repeat(129) })).statusCode).toBe(400);
    expect((await patchClient(adminCookie, agencyA, clientId, { contactName: 'é'.repeat(129) })).statusCode).toBe(400);
    // 17 two-byte characters: 34 bytes, over the 32-byte phone cap.
    expect((await patchClient(adminCookie, agencyA, clientId, { contactPhone: 'é'.repeat(17) })).statusCode).toBe(400);
    // 61 two-byte characters: 122 bytes, over the 120-byte segment cap.
    expect((await patchClient(adminCookie, agencyA, clientId, { segment: 'é'.repeat(61) })).statusCode).toBe(400);
    // 128 two-byte characters are exactly 256 bytes and pass.
    const accepted = await patchClient(adminCookie, agencyA, clientId, { legalName: 'é'.repeat(128) });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { legalName: string }).legalName).toBe('é'.repeat(128));
  });

  it('answers 400 on an empty PATCH and writes nothing', async () => {
    const clientId = await createClient({ agencyId: agencyA, name: `Intocado ${randomUUID()}` });
    const before = await clientRow(clientId);
    expect((await patchClient(adminCookie, agencyA, clientId, {})).statusCode).toBe(400);
    const after = await clientRow(clientId);
    expect(after?.updated_by).toBe(before?.updated_by);
    expect(new Date(after?.updated_at as Date).getTime()).toBe(new Date(before?.updated_at as Date).getTime());
  });

  it('answers 404 on a PATCH to a client of another agency even for a member of both, and changes nothing', async () => {
    const clientB = await createClient({ agencyId: agencyB, name: `B ${randomUUID()}`, legalName: 'Original B Ltda' });
    const before = await clientRow(clientB);
    const response = await patchClient(dualAdminCookie, agencyA, clientB, { legalName: 'Alterado' });
    expect(response.statusCode).toBe(404);
    const after = await clientRow(clientB);
    expect(after).toMatchObject({ legal_name: 'Original B Ltda', updated_by: before?.updated_by });
    expect(new Date(after?.updated_at as Date).getTime()).toBe(new Date(before?.updated_at as Date).getTime());
  });

  it('signs photoUrl when a key exists, returns null with a warning for an unusable key, and null with no key', async () => {
    const withPhoto = await createClient({ agencyId: agencyA, photoKey: `agencies/${agencyA}/clients/${randomUUID()}/avatar/${randomUUID()}.png` });
    const signed = await getClient(adminCookie, agencyA, withPhoto);
    const photoUrl = (signed.json() as { photoUrl: string }).photoUrl;
    const url = new URL(photoUrl);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');

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
});
