import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
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
import type { DatabaseClient } from '@ageniza/database';
import { createRequireAgencyAccess, requirePermission } from '../tenancy/guards.js';
import { registerClientModule } from './routes.js';

const origin = { origin: TEST_APP_PUBLIC_URL };

const SECTION_KEYS = ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'];

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdAgencyIds = [agencyA, agencyB];
const createdCustomRoleIds: string[] = [];

let admin: TestUserFixture;
let manager: TestUserFixture;
let production: TestUserFixture;
let viewer: TestUserFixture;
let operator: TestUserFixture;
let otherAdmin: TestUserFixture;

let adminCookie: string;
let managerCookie: string;
let productionCookie: string;
let viewerCookie: string;
let operatorCookie: string;
let otherAdminCookie: string;

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

const createClient = async (agencyId: string, status: 'active' | 'archived' = 'active'): Promise<string> => {
  const id = randomUUID();
  await owner.knex('clients').insert({
    id,
    agency_id: agencyId,
    name: `Brand client ${id}`,
    status,
    archived_at: status === 'archived' ? new Date() : null
  });
  return id;
};

const insertPersonaRow = async (clientId: string, status: 'active' | 'archived' = 'active'): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_personas').insert({ id, client_id: clientId, name: `Persona ${id}`, status });
  return id;
};

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

const getStudy = async (cookie: string, agencyId: string, clientId: string): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients/${clientId}/brand-study`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

const putSection = async (cookie: string, agencyId: string, clientId: string, sectionKey: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'PUT', url: `/agencies/${agencyId}/clients/${clientId}/brand-study/sections/${sectionKey}`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const postPersona = async (cookie: string, agencyId: string, clientId: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients/${clientId}/personas`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const patchPersona = async (cookie: string, agencyId: string, clientId: string, personaId: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'PATCH', url: `/agencies/${agencyId}/clients/${clientId}/personas/${personaId}`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const personaStatus = async (cookie: string, agencyId: string, clientId: string, personaId: string, action: 'archive' | 'unarchive'): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients/${clientId}/personas/${personaId}/${action}`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

describe('CLIENTS brand-study and personas HTTP module (#127)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    admin = await makeUser('brand-admin');
    manager = await makeUser('brand-manager');
    production = await makeUser('brand-production');
    viewer = await makeUser('brand-viewer');
    operator = await makeUser('brand-operator');
    otherAdmin = await makeUser('brand-other-admin');

    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production']).select('id', 'key');
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Brand Agency A', owner_user_id: null },
      { id: agencyB, name: 'Brand Agency B', owner_user_id: null }
    ]);

    const viewOnlyRoleId = randomUUID();
    createdCustomRoleIds.push(viewOnlyRoleId);
    await owner.knex('roles').insert({ id: viewOnlyRoleId, agency_id: agencyA, key: `only-view-${viewOnlyRoleId}`, name: 'Só visualizar', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: viewOnlyRoleId, permission_key: 'cliente.visualizar' });

    const operateOnlyRoleId = randomUUID();
    createdCustomRoleIds.push(operateOnlyRoleId);
    await owner.knex('roles').insert({ id: operateOnlyRoleId, agency_id: agencyA, key: `only-operate-${operateOnlyRoleId}`, name: 'Só operar', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: operateOnlyRoleId, permission_key: 'cliente.operar' });

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: admin.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: manager.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: production.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: viewer.id, role_id: viewOnlyRoleId },
      { agency_id: agencyA, user_id: operator.id, role_id: operateOnlyRoleId },
      { agency_id: agencyB, user_id: otherAdmin.id, role_id: roleId('admin') }
    ]);

    adminCookie = await login(admin);
    managerCookie = await login(manager);
    productionCookie = await login(production);
    viewerCookie = await login(viewer);
    operatorCookie = await login(operator);
    otherAdminCookie = await login(otherAdmin);
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
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

  it('returns the seven fixed sections and filled = 0 for an empty client', async () => {
    const clientId = await createClient(agencyA);
    const response = await getStudy(adminCookie, agencyA, clientId);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ filled: number; sections: { key: string; body: unknown; colors: unknown; archetype: unknown; updatedBy: unknown; updatedAt: unknown }[]; personas: unknown[] }>();
    expect(body.filled).toBe(0);
    expect(body.sections.map((section) => section.key)).toEqual(SECTION_KEYS);
    for (const section of body.sections) {
      expect(section).toMatchObject({ body: null, colors: null, archetype: null, updatedBy: null, updatedAt: null });
    }
    expect(body.personas).toEqual([]);
  });

  it('rejects a body of another section, an unknown archetype and PUT on personas', async () => {
    const clientId = await createClient(agencyA);
    expect((await putSection(adminCookie, agencyA, clientId, 'tone_of_voice', { colors: [{ name: 'Branco', hex: '#FFFFFF' }] })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { archetype: 'caregiver' })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'archetype', { archetype: 'wizard' })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'personas', { body: 'x' })).statusCode).toBe(400);
  });

  it('rejects a malformed color hex', async () => {
    const clientId = await createClient(agencyA);
    expect((await putSection(adminCookie, agencyA, clientId, 'colors', { colors: [{ name: 'Branco', hex: '#FFF' }] })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'colors', { colors: [{ name: 'Branco', hex: '#FFFFFF' }] })).statusCode).toBe(200);
  });

  it('round-trips a section and the archetype as the English key', async () => {
    const clientId = await createClient(agencyA);
    const written = await putSection(adminCookie, agencyA, clientId, 'archetype', { archetype: 'caregiver' });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ key: 'archetype', archetype: 'caregiver' });

    const study = await getStudy(adminCookie, agencyA, clientId);
    const archetype = study.json<{ sections: { key: string; archetype: string | null }[] }>().sections.find((section) => section.key === 'archetype');
    expect(archetype?.archetype).toBe('caregiver');

    const text = await putSection(adminCookie, agencyA, clientId, 'tone_of_voice', { body: 'Próxima e acolhedora.' });
    expect(text.statusCode).toBe(200);
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(2);
  });

  it('counts an active persona in filled and stops counting it when archived', async () => {
    const clientId = await createClient(agencyA);
    await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'Marca' });
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(1);

    const created = await postPersona(adminCookie, agencyA, clientId, { name: 'Dona Maria' });
    expect(created.statusCode).toBe(201);
    const personaId = created.json<{ id: string; status: string }>().id;
    expect(created.json<{ status: string }>().status).toBe('active');
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(2);

    expect((await personaStatus(adminCookie, agencyA, clientId, personaId, 'archive')).statusCode).toBe(200);
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(1);

    expect((await personaStatus(adminCookie, agencyA, clientId, personaId, 'unarchive')).statusCode).toBe(200);
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(2);
  });

  it('keeps an archived persona in the agency GET and returns it on unarchive', async () => {
    const clientId = await createClient(agencyA);
    const personaId = await insertPersonaRow(clientId, 'active');
    await personaStatus(adminCookie, agencyA, clientId, personaId, 'archive');

    const archived = await getStudy(adminCookie, agencyA, clientId);
    expect(archived.json<{ personas: { id: string; status: string }[] }>().personas).toContainEqual(
      expect.objectContaining({ id: personaId, status: 'archived' })
    );

    const restored = await personaStatus(adminCookie, agencyA, clientId, personaId, 'unarchive');
    expect(restored.json()).toMatchObject({ id: personaId, status: 'active' });
  });

  it('edits a persona and clears a field with null', async () => {
    const clientId = await createClient(agencyA);
    const created = await postPersona(adminCookie, agencyA, clientId, { name: 'Lucas', description: 'Jovem' });
    const personaId = created.json<{ id: string }>().id;

    const edited = await patchPersona(adminCookie, agencyA, clientId, personaId, { name: 'Lucas Silva', description: null });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: 'Lucas Silva', description: null });
  });

  it('rejects an empty persona PATCH body', async () => {
    const clientId = await createClient(agencyA);
    const personaId = await insertPersonaRow(clientId);
    expect((await patchPersona(adminCookie, agencyA, clientId, personaId, {})).statusCode).toBe(400);
  });

  it('lets account_manager write and production only read', async () => {
    const clientId = await createClient(agencyA);
    expect((await putSection(managerCookie, agencyA, clientId, 'branding', { body: 'Gestor' })).statusCode).toBe(200);
    expect((await postPersona(managerCookie, agencyA, clientId, { name: 'Persona do gestor' })).statusCode).toBe(201);
    const personaId = await insertPersonaRow(clientId);

    expect((await getStudy(productionCookie, agencyA, clientId)).statusCode).toBe(200);
    expect((await putSection(productionCookie, agencyA, clientId, 'branding', { body: 'x' })).statusCode).toBe(403);
    expect((await postPersona(productionCookie, agencyA, clientId, { name: 'x' })).statusCode).toBe(403);
    expect((await patchPersona(productionCookie, agencyA, clientId, personaId, { name: 'x' })).statusCode).toBe(403);
    expect((await personaStatus(productionCookie, agencyA, clientId, personaId, 'archive')).statusCode).toBe(403);
    expect((await personaStatus(productionCookie, agencyA, clientId, personaId, 'unarchive')).statusCode).toBe(403);
  });

  it('answers 409 on every write to an archived client, and still reads it', async () => {
    const clientId = await createClient(agencyA, 'archived');
    const personaId = await insertPersonaRow(clientId);

    expect((await getStudy(adminCookie, agencyA, clientId)).statusCode).toBe(200);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'x' })).statusCode).toBe(409);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'x' })).statusCode).toBe(409);
    expect((await patchPersona(adminCookie, agencyA, clientId, personaId, { name: 'x' })).statusCode).toBe(409);
    expect((await personaStatus(adminCookie, agencyA, clientId, personaId, 'archive')).statusCode).toBe(409);
    expect((await personaStatus(adminCookie, agencyA, clientId, personaId, 'unarchive')).statusCode).toBe(409);

    await expect(owner.knex('client_brand_sections').where({ client_id: clientId }).select('section_key')).resolves.toEqual([]);
  });

  it('answers 409, never 500, when an archive races the write (RLS violation)', async () => {
    const clientId = await createClient(agencyA);

    // The route checks the client's status and only then writes. If the archive commits in
    // between, the INSERT hits the RLS `WITH CHECK` and Postgres raises 42501; the route has to
    // translate that into the same 409 an already-archived client gets, never let it become 500.
    const racingDatabase = {
      ...app.database,
      transaction: (work: Parameters<DatabaseClient['transaction']>[0]) =>
        app.database.transaction((transaction) => {
          const racing = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === 'raw') {
                return (statement: string, bindings?: readonly unknown[]) =>
                  statement.includes('insert into public.client_brand_sections')
                    ? Promise.reject(Object.assign(new Error('new row violates row-level security policy'), { code: '42501' }))
                    : target.raw(statement, bindings as never);
              }
              return Reflect.get(target, property, receiver);
            }
          });
          return work(racing as typeof transaction);
        })
    } as DatabaseClient;

    const racingApp = Fastify();
    registerClientModule(racingApp, {
      database: racingDatabase,
      auth: app.auth,
      requireAgencyAccess: createRequireAgencyAccess({ database: app.database }),
      requirePermission,
      photoUrlExpirySeconds: 300
    });
    await racingApp.ready();
    try {
      const response = await racingApp.inject({
        method: 'PUT',
        url: `/agencies/${agencyA}/clients/${clientId}/brand-study/sections/branding`,
        headers: { ...origin, cookie: adminCookie },
        payload: { body: 'Corrida' }
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await racingApp.close();
    }
    await expect(owner.knex('client_brand_sections').where({ client_id: clientId }).select('section_key')).resolves.toEqual([]);
  });

  it('records the last writer in updatedBy', async () => {
    const clientId = await createClient(agencyA);
    const byManager = await putSection(managerCookie, agencyA, clientId, 'positioning', { body: 'Posição' });
    expect(byManager.json()).toMatchObject({ updatedBy: { id: manager.id, name: manager.name } });

    const byAdmin = await putSection(adminCookie, agencyA, clientId, 'positioning', { body: 'Posição revisada' });
    expect(byAdmin.json()).toMatchObject({ updatedBy: { id: admin.id, name: admin.name } });

    const persona = await postPersona(managerCookie, agencyA, clientId, { name: 'Com updatedBy' });
    expect(persona.json()).toMatchObject({ updatedBy: { id: manager.id, name: manager.name } });
  });

  it('resolves updatedBy only through an active tie: a removed member reads as null', async () => {
    const clientId = await createClient(agencyA);
    const writer = await makeUser('brand-removed-writer');
    const managerRole = await owner.knex('roles').whereNull('agency_id').where({ key: 'account_manager' }).first('id');
    await owner.knex('agency_memberships').insert({ agency_id: agencyA, user_id: writer.id, role_id: managerRole?.id });
    const writerCookie = await login(writer);

    const written = await putSection(writerCookie, agencyA, clientId, 'branding', { body: 'Escrito antes de sair' });
    expect(written.json()).toMatchObject({ updatedBy: { id: writer.id, name: writer.name } });

    // The row keeps pointing at the writer, but a removed membership is no longer a tie: reading
    // the name would expose someone the agency no longer employs.
    await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: writer.id }).update({ status: 'removed' });

    const study = await getStudy(adminCookie, agencyA, clientId);
    const section = study.json<{ sections: { key: string; updatedBy: unknown }[] }>().sections.find((candidate) => candidate.key === 'branding');
    expect(section?.updatedBy).toBeNull();
  });

  it('answers 404 for a client of another agency on every read and write', async () => {
    const clientA = await createClient(agencyA);
    const clientB = await createClient(agencyB);
    const personaOfA = await insertPersonaRow(clientA);

    expect((await getStudy(adminCookie, agencyA, clientB)).statusCode).toBe(404);
    expect((await putSection(adminCookie, agencyA, clientB, 'branding', { body: 'x' })).statusCode).toBe(404);
    expect((await postPersona(adminCookie, agencyA, clientB, { name: 'x' })).statusCode).toBe(404);
    expect((await patchPersona(adminCookie, agencyA, clientB, personaOfA, { name: 'x' })).statusCode).toBe(404);
    expect((await personaStatus(adminCookie, agencyA, clientB, personaOfA, 'archive')).statusCode).toBe(404);
    expect((await personaStatus(adminCookie, agencyA, clientB, personaOfA, 'unarchive')).statusCode).toBe(404);
    // A member of agency B reaching agency A's route is the same 404 as everywhere.
    expect((await getStudy(otherAdminCookie, agencyA, clientA)).statusCode).toBe(404);
  });

  it('answers 404 for a persona of another client, same agency or not, and for malformed ids', async () => {
    const clientA1 = await createClient(agencyA);
    const clientA2 = await createClient(agencyA);
    const clientB = await createClient(agencyB);
    const personaOfA2 = await insertPersonaRow(clientA2);
    const personaOfB = await insertPersonaRow(clientB);

    for (const personaId of [personaOfA2, personaOfB]) {
      const before = await owner.knex('client_personas').where({ id: personaId }).first('name', 'status', 'updated_at');
      expect((await patchPersona(adminCookie, agencyA, clientA1, personaId, { name: 'Renomeada' })).statusCode).toBe(404);
      expect((await personaStatus(adminCookie, agencyA, clientA1, personaId, 'archive')).statusCode).toBe(404);
      expect((await personaStatus(adminCookie, agencyA, clientA1, personaId, 'unarchive')).statusCode).toBe(404);

      // The 404 alone would also come back after a write that reached the wrong persona: the row
      // itself has to be intact. Without `client_id` in the WHERE, the same-agency persona (A2)
      // is renamed and archived even though the response says 404.
      const after = await owner.knex('client_personas').where({ id: personaId }).first('name', 'status', 'updated_at');
      expect(after).toMatchObject({ name: before?.name, status: before?.status });
      expect(new Date(after?.updated_at as Date).getTime()).toBe(new Date(before?.updated_at as Date).getTime());
    }
    expect((await patchPersona(adminCookie, agencyA, clientA1, 'not-a-uuid', { name: 'x' })).statusCode).toBe(404);
    expect((await personaStatus(adminCookie, agencyA, clientA1, 'not-a-uuid', 'archive')).statusCode).toBe(404);
    expect((await getStudy(adminCookie, agencyA, 'not-a-uuid')).statusCode).toBe(404);
    expect((await putSection(adminCookie, agencyA, 'not-a-uuid', 'branding', { body: 'x' })).statusCode).toBe(404);
    expect((await postPersona(adminCookie, agencyA, 'not-a-uuid', { name: 'x' })).statusCode).toBe(404);
  });

  it('rejects extra fields (BOPLA) and control characters', async () => {
    const clientId = await createClient(agencyA);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'x', colors: [] })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'Nul\u0000byte' })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'x', status: 'archived' })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'x', updatedBy: admin.id })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'Tab\tName' })).statusCode).toBe(400);
    const personaId = await insertPersonaRow(clientId);
    expect((await patchPersona(adminCookie, agencyA, clientId, personaId, { status: 'archived' })).statusCode).toBe(400);

    const tooManyColors = Array.from({ length: 25 }, (_, index) => ({ name: `Cor ${index}`, hex: '#FFFFFF' }));
    expect((await putSection(adminCookie, agencyA, clientId, 'colors', { colors: tooManyColors })).statusCode).toBe(400);
  });

  it('rejects giant text in UTF-8 bytes and whitespace-only text', async () => {
    const clientId = await createClient(agencyA);

    // The limit is bytes, not characters: 'é' takes two, so 19998 'a' + 'é' is exactly 20000.
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: `${'a'.repeat(19999)}é` })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: `${'a'.repeat(19998)}é` })).statusCode).toBe(200);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'a'.repeat(20001) })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'a'.repeat(20000) })).statusCode).toBe(200);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'é'.repeat(10001) })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: '   ' })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: '\u00a0\u00a0' })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'Nul\u0000byte' })).statusCode).toBe(400);
    const padded = await putSection(adminCookie, agencyA, clientId, 'observations', { body: '  Observação  ' });
    expect(padded.json()).toMatchObject({ body: 'Observação' });

    // Persona name crosses the boundary the same way: 118 'a' + 'é' is 120 bytes, +1 'a' is 121.
    expect((await postPersona(adminCookie, agencyA, clientId, { name: `${'a'.repeat(119)}é` })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: `${'a'.repeat(118)}é` })).statusCode).toBe(201);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'n'.repeat(121) })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'é'.repeat(61) })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'n'.repeat(120) })).statusCode).toBe(201);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: '   ' })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'Válida', description: 'd'.repeat(5001) })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'Válida', description: 'Nul\u0000byte' })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'colors', { colors: [{ name: 'n'.repeat(61), hex: '#FFFFFF' }] })).statusCode).toBe(400);
  });

  it('accepts multiline text with accents and returns it unchanged', async () => {
    const clientId = await createClient(agencyA);
    const body = 'Primeira linha\nSegunda linha\r\n\tCom tab e acentuação çãõ.';
    const written = await putSection(adminCookie, agencyA, clientId, 'branding', { body });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ body });

    const section = (await getStudy(adminCookie, agencyA, clientId))
      .json<{ sections: { key: string; body: string | null }[] }>().sections.find((candidate) => candidate.key === 'branding');
    expect(section?.body).toBe(body);

    const created = await postPersona(adminCookie, agencyA, clientId, {
      name: 'Multilinha',
      description: 'Dores:\n- preço\n- prazo',
      pains: '\tindisponibilidade'
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ description: 'Dores:\n- preço\n- prazo', pains: '\tindisponibilidade' });

    const personaId = created.json<{ id: string }>().id;
    const patched = await patchPersona(adminCookie, agencyA, clientId, personaId, { objections: 'Objeção 1\r\nObjeção 2' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ objections: 'Objeção 1\r\nObjeção 2' });
  });

  it('enforces BFLA with a one-permission custom role: visualizar reads, every write 403', async () => {
    const clientId = await createClient(agencyA);
    const personaId = await insertPersonaRow(clientId);

    expect((await getStudy(viewerCookie, agencyA, clientId)).statusCode).toBe(200);
    expect((await putSection(viewerCookie, agencyA, clientId, 'branding', { body: 'x' })).statusCode).toBe(403);
    expect((await postPersona(viewerCookie, agencyA, clientId, { name: 'x' })).statusCode).toBe(403);
    expect((await patchPersona(viewerCookie, agencyA, clientId, personaId, { name: 'x' })).statusCode).toBe(403);
    expect((await personaStatus(viewerCookie, agencyA, clientId, personaId, 'archive')).statusCode).toBe(403);
    expect((await personaStatus(viewerCookie, agencyA, clientId, personaId, 'unarchive')).statusCode).toBe(403);
  });

  it('enforces BFLA with a one-permission custom role: operar writes, the read is 403', async () => {
    const clientId = await createClient(agencyA);

    expect((await getStudy(operatorCookie, agencyA, clientId)).statusCode).toBe(403);
    expect((await putSection(operatorCookie, agencyA, clientId, 'branding', { body: 'Operador' })).statusCode).toBe(200);
    const created = await postPersona(operatorCookie, agencyA, clientId, { name: 'Persona do operador' });
    expect(created.statusCode).toBe(201);
    const personaId = created.json<{ id: string }>().id;
    expect((await patchPersona(operatorCookie, agencyA, clientId, personaId, { name: 'Editada' })).statusCode).toBe(200);
    expect((await personaStatus(operatorCookie, agencyA, clientId, personaId, 'archive')).statusCode).toBe(200);
    expect((await personaStatus(operatorCookie, agencyA, clientId, personaId, 'unarchive')).statusCode).toBe(200);
  });
});
