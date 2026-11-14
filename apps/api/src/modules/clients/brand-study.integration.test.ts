import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
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
import { revokeInsertId } from '../auth/test-support/insert-id-revoked.js';
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../tenancy/guards.js';
import { registerClientModule } from './routes.js';
import { unusedEmailService } from './test-support/email-service.js';

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

const insertPersonaRow = async (clientId: string): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_personas').insert({ id, client_id: clientId, name: `Persona ${id}` });
  return id;
};

/** A conversation of the persona with `comments` messages, written by the owner. */
const insertPersonaConversation = async (clientId: string, personaId: string, comments: number): Promise<{ threadId: string; commentIds: string[] }> => {
  const threadId = randomUUID();
  await owner.knex('client_threads').insert({ id: threadId, client_id: clientId, persona_id: personaId, opened_by: admin.id, opened_side: 'agency' });
  const commentIds: string[] = [];
  for (let index = 0; index < comments; index += 1) {
    const id = randomUUID();
    commentIds.push(id);
    await owner.knex('client_thread_comments').insert({ id, thread_id: threadId, client_id: clientId, author_user_id: admin.id, author_side: 'agency', body: `Mensagem ${index + 1}` });
  }
  return { threadId, commentIds };
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

const deletePersona = async (cookie: string, agencyId: string, clientId: string, personaId: string): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'DELETE', url: `/agencies/${agencyId}/clients/${clientId}/personas/${personaId}`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

/**
 * An app whose transaction rejects any write starting with `failingStatement` with the 42501
 * Postgres raises when a row-level security policy refuses a row. It puts the archive race inside
 * the window between the route's `loadClient` and its write, where the real conflict lives: the
 * route's own status guard has already passed, so only the `catch` can turn the error into 409.
 */
const withRacingApp = async <T>(
  failingStatement: string,
  run: (racingApp: FastifyInstance) => Promise<T>
): Promise<T> => {
  const racingApp = Fastify();
  registerClientModule(racingApp, {
    database: {
      ...app.database,
      transaction: (work: Parameters<DatabaseClient['transaction']>[0]) =>
        app.database.transaction((transaction) => {
          const racing = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === 'raw') {
                return (statement: string, bindings?: readonly unknown[]) =>
                  statement.trim().startsWith(failingStatement)
                    ? Promise.reject(Object.assign(new Error('new row violates row-level security policy'), { code: '42501' }))
                    : target.raw(statement, bindings as never);
              }
              return Reflect.get(target, property, receiver);
            }
          });
          return work(racing as typeof transaction);
        })
    } as DatabaseClient,
    auth: app.auth,
    requireAgencyAccess: createRequireAgencyAccess({ database: app.database }),
    requirePermission,
    requireClientAccess: createRequireClientAccess({ database: app.database }),
    emailService: unusedEmailService,
    photoUrlExpirySeconds: 300
  });
  await racingApp.ready();
  try {
    return await run(racingApp);
  } finally {
    await racingApp.close();
  }
};

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

  // specs/clientes.md section 3: the archetype is one of twelve. The database stores the Portuguese
  // label and the API speaks the English key; each pair is written out by value so neither side can
  // drift together with the constant (issue #464).
  it.each([
    ['innocent', 'Inocente'],
    ['sage', 'Sábio'],
    ['explorer', 'Explorador'],
    ['outlaw', 'Fora-da-lei'],
    ['magician', 'Mago'],
    ['hero', 'Herói'],
    ['lover', 'Amante'],
    ['jester', 'Bobo da corte'],
    ['everyman', 'Cara comum'],
    ['caregiver', 'Cuidador'],
    ['ruler', 'Governante'],
    ['creator', 'Criador']
  ])('stores %s as the label %s and reads the same key back', async (key, label) => {
    const clientId = await createClient(agencyA);
    const written = await putSection(adminCookie, agencyA, clientId, 'archetype', { archetype: key });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ key: 'archetype', archetype: key });

    const row = await owner.knex('client_brand_sections').where({ client_id: clientId, section_key: 'archetype' }).first('archetype');
    expect(row?.archetype).toBe(label);

    const study = await getStudy(adminCookie, agencyA, clientId);
    const archetype = study.json<{ sections: { key: string; archetype: string | null }[] }>().sections.find((section) => section.key === 'archetype');
    expect(archetype?.archetype).toBe(key);
  });

  it('creates a persona without choosing its id, and answers the id of the row (#601)', async () => {
    const clientId = await createClient(agencyA);
    const restoreGrant = await revokeInsertId(owner, ['client_personas']);
    try {
      const created = await postPersona(adminCookie, agencyA, clientId, { name: 'Persona sem id escolhido' });
      expect(created.statusCode).toBe(201);
      const rows = await owner.knex('client_personas').where({ client_id: clientId });
      expect(rows.map((row) => [row.id, row.name])).toEqual([[created.json<{ id: string }>().id, 'Persona sem id escolhido']]);
    } finally {
      await restoreGrant();
    }
  });

  it('counts a persona in filled and stops counting it when it is deleted', async () => {
    const clientId = await createClient(agencyA);
    await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'Marca' });
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(1);

    const created = await postPersona(adminCookie, agencyA, clientId, { name: 'Dona Maria' });
    expect(created.statusCode).toBe(201);
    const personaId = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({ messageCount: 0 });
    expect(created.json()).not.toHaveProperty('status');
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(2);

    expect((await deletePersona(adminCookie, agencyA, clientId, personaId)).statusCode).toBe(204);
    expect((await getStudy(adminCookie, agencyA, clientId)).json<{ filled: number }>().filled).toBe(1);
  });

  it('serves the count of messages of each persona, and deletes the persona with its conversation and nothing of the others (#891)', async () => {
    const clientId = await createClient(agencyA);
    const otherClientId = await createClient(agencyA);
    const personaId = await insertPersonaRow(clientId);
    const siblingId = await insertPersonaRow(clientId);
    const strangerId = await insertPersonaRow(otherClientId);
    const first = await insertPersonaConversation(clientId, personaId, 3);
    const second = await insertPersonaConversation(clientId, personaId, 2);
    const sibling = await insertPersonaConversation(clientId, siblingId, 4);
    const stranger = await insertPersonaConversation(otherClientId, strangerId, 1);
    await insertPersonaConversation(clientId, personaId, 0);

    const before = (await getStudy(adminCookie, agencyA, clientId)).json<{ personas: { id: string; messageCount: number }[] }>().personas;
    expect(Object.fromEntries(before.map((persona) => [persona.id, persona.messageCount]))).toEqual({ [personaId]: 5, [siblingId]: 4 });

    const response = await deletePersona(adminCookie, agencyA, clientId, personaId);
    expect(response.statusCode).toBe(204);

    const after = (await getStudy(adminCookie, agencyA, clientId)).json<{ personas: { id: string; messageCount: number }[] }>().personas;
    expect(after).toEqual([expect.objectContaining({ id: siblingId, messageCount: 4 })]);
    expect(await owner.knex('client_personas').where({ id: personaId }).first('id')).toBeUndefined();
    for (const thread of [first, second]) {
      expect(await owner.knex('client_threads').where({ id: thread.threadId }).first('id')).toBeUndefined();
      expect(await owner.knex('client_thread_comments').whereIn('id', thread.commentIds).count({ total: '*' }).first()).toEqual({ total: '0' });
    }
    for (const thread of [sibling, stranger]) {
      expect(await owner.knex('client_threads').where({ id: thread.threadId }).first('id')).toBeDefined();
      expect(await owner.knex('client_thread_comments').whereIn('id', thread.commentIds).count({ total: '*' }).first()).toEqual({ total: String(thread.commentIds.length) });
    }
    expect(await owner.knex('audit.events').where({ action: 'persona.deleted', target_id: personaId }).select('actor_user_id', 'agency_id')).toEqual([
      { actor_user_id: admin.id, agency_id: agencyA }
    ]);
  });

  it('answers 404 to a second delete of the same persona, and to a conversation that was deleted with it', async () => {
    const clientId = await createClient(agencyA);
    const personaId = await insertPersonaRow(clientId);
    await insertPersonaConversation(clientId, personaId, 1);

    expect((await deletePersona(adminCookie, agencyA, clientId, personaId)).statusCode).toBe(204);
    expect((await deletePersona(adminCookie, agencyA, clientId, personaId)).statusCode).toBe(404);
    expect((await patchPersona(adminCookie, agencyA, clientId, personaId, { name: 'x' })).statusCode).toBe(404);
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
    expect((await deletePersona(productionCookie, agencyA, clientId, personaId)).statusCode).toBe(403);
    expect(await owner.knex('client_personas').where({ id: personaId }).first('id')).toBeDefined();
  });

  it('answers 409 on every write to an archived client, and still reads it', async () => {
    const clientId = await createClient(agencyA, 'archived');
    const personaId = await insertPersonaRow(clientId);

    expect((await getStudy(adminCookie, agencyA, clientId)).statusCode).toBe(200);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'x' })).statusCode).toBe(409);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'x' })).statusCode).toBe(409);
    expect((await patchPersona(adminCookie, agencyA, clientId, personaId, { name: 'x' })).statusCode).toBe(409);
    expect((await deletePersona(adminCookie, agencyA, clientId, personaId)).statusCode).toBe(409);
    expect(await owner.knex('client_personas').where({ id: personaId }).first('id')).toBeDefined();

    await expect(owner.knex('client_brand_sections').where({ client_id: clientId }).select('section_key')).resolves.toEqual([]);
  });

  it('answers 409, never 500, when an archive races the section write (RLS violation)', async () => {
    const clientId = await createClient(agencyA);

    // The route checks the client's status and only then writes. If the archive commits in
    // between, the INSERT hits the RLS `WITH CHECK` and Postgres raises 42501; the route has to
    // translate that into the same 409 an already-archived client gets, never let it become 500.
    await withRacingApp('insert into public.client_brand_sections', async (racingApp) => {
      const response = await racingApp.inject({
        method: 'PUT',
        url: `/agencies/${agencyA}/clients/${clientId}/brand-study/sections/branding`,
        headers: { ...origin, cookie: adminCookie },
        payload: { body: 'Corrida' }
      });
      expect(response.statusCode).toBe(409);
    });
    await expect(owner.knex('client_brand_sections').where({ client_id: clientId }).select('section_key')).resolves.toEqual([]);
  });

  it.each([
    {
      label: 'POST persona',
      failingStatement: 'insert into public.client_personas',
      initialStatus: null,
      method: 'POST' as const,
      path: (clientId: string) => `/agencies/${agencyA}/clients/${clientId}/personas`,
      payload: { name: 'Corrida' }
    },
    {
      label: 'PATCH persona',
      failingStatement: 'update public.client_personas',
      initialStatus: 'active' as const,
      method: 'PATCH' as const,
      path: (clientId: string, personaId: string) => `/agencies/${agencyA}/clients/${clientId}/personas/${personaId}`,
      payload: { name: 'Corrida' }
    },
    {
      label: 'DELETE persona',
      failingStatement: 'delete from public.client_personas',
      initialStatus: 'active' as const,
      method: 'DELETE' as const,
      path: (clientId: string, personaId: string) => `/agencies/${agencyA}/clients/${clientId}/personas/${personaId}`,
      payload: undefined
    }
  ])('answers 409, never 500, when an archive races $label (RLS violation)', async (testCase) => {
    const clientId = await createClient(agencyA);
    const personaId = testCase.initialStatus === null ? '' : await insertPersonaRow(clientId);
    const before = testCase.initialStatus === null
      ? undefined
      : await owner.knex('client_personas').where({ id: personaId }).first('name', 'status', 'updated_at');

    await withRacingApp(testCase.failingStatement, async (racingApp) => {
      const response = await racingApp.inject({
        method: testCase.method,
        url: testCase.path(clientId, personaId),
        headers: { ...origin, cookie: adminCookie },
        payload: testCase.payload
      });
      expect(response.statusCode).toBe(409);
    });

    if (before === undefined) {
      await expect(owner.knex('client_personas').where({ client_id: clientId }).select('id')).resolves.toEqual([]);
      return;
    }
    // The 409 alone would also come back from a write that happened: the row itself has to be intact.
    const after = await owner.knex('client_personas').where({ id: personaId }).first('name', 'status', 'updated_at');
    expect(after).toMatchObject({ name: before.name, status: before.status });
    expect(new Date(after?.updated_at as Date).getTime()).toBe(new Date(before.updated_at as Date).getTime());
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
    expect((await deletePersona(adminCookie, agencyA, clientB, personaOfA)).statusCode).toBe(404);
    expect(await owner.knex('client_personas').where({ id: personaOfA }).first('id')).toBeDefined();
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
      expect((await deletePersona(adminCookie, agencyA, clientA1, personaId)).statusCode).toBe(404);

      // The 404 alone would also come back after a write that reached the wrong persona: the row
      // itself has to be intact. Without `client_id` in the WHERE, the same-agency persona (A2)
      // is renamed and deleted even though the response says 404.
      const after = await owner.knex('client_personas').where({ id: personaId }).first('name', 'status', 'updated_at');
      expect(after).toMatchObject({ name: before?.name, status: before?.status });
      expect(new Date(after?.updated_at as Date).getTime()).toBe(new Date(before?.updated_at as Date).getTime());
    }
    expect((await patchPersona(adminCookie, agencyA, clientA1, 'not-a-uuid', { name: 'x' })).statusCode).toBe(404);
    expect((await deletePersona(adminCookie, agencyA, clientA1, 'not-a-uuid')).statusCode).toBe(404);
    expect((await getStudy(adminCookie, agencyA, 'not-a-uuid')).statusCode).toBe(404);
    expect((await putSection(adminCookie, agencyA, 'not-a-uuid', 'branding', { body: 'x' })).statusCode).toBe(404);
    expect((await postPersona(adminCookie, agencyA, 'not-a-uuid', { name: 'x' })).statusCode).toBe(404);
  });

  it('rejects extra fields (BOPLA) and control characters', async () => {
    const clientId = await createClient(agencyA);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'x', colors: [] })).statusCode).toBe(400);
    expect((await putSection(adminCookie, agencyA, clientId, 'branding', { body: 'Nul\u0000byte' })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'x', status: 'archived' })).statusCode).toBe(400);
    expect((await postPersona(adminCookie, agencyA, clientId, { name: 'x', messageCount: 9 })).statusCode).toBe(400);
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

  it('answers 400, never 500, to a lone surrogate in a color name, and stores nothing (#484)', async () => {
    const clientId = await createClient(agencyA);
    // The escape reaches the server as written on the wire, the way a client would send it.
    const wire = (name: string) => `{"colors":[{"name":"${name}","hex":"#FFFFFF"}]}`;
    const put = async (payload: string): Promise<InjectResponse> =>
      (await app.app.inject({
        method: 'PUT',
        url: `/agencies/${agencyA}/clients/${clientId}/brand-study/sections/colors`,
        headers: { ...origin, cookie: adminCookie, 'content-type': 'application/json' },
        payload
      })) as unknown as InjectResponse;

    for (const name of ['x\\ud800', 'x\\udc00', '\\ud83dx', '\\ude00\\ud83d']) {
      const response = await put(wire(name));
      expect(response.statusCode, name).toBe(400);
      expect(response.json(), name).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const study = (await getStudy(adminCookie, agencyA, clientId)).json<{ sections: { key: string; colors: unknown }[] }>();
    expect(study.sections.find((section) => section.key === 'colors')?.colors).toBeNull();

    const pair = await put(wire('Sol \\ud83d\\ude00'));
    expect(pair.statusCode).toBe(200);
    expect(pair.json()).toMatchObject({ colors: [{ name: 'Sol 😀', hex: '#FFFFFF' }] });
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
    expect((await deletePersona(viewerCookie, agencyA, clientId, personaId)).statusCode).toBe(403);
    expect(await owner.knex('client_personas').where({ id: personaId }).first('id')).toBeDefined();
  });

  it('enforces BFLA with a one-permission custom role: operar writes, the read is 403', async () => {
    const clientId = await createClient(agencyA);

    expect((await getStudy(operatorCookie, agencyA, clientId)).statusCode).toBe(403);
    expect((await putSection(operatorCookie, agencyA, clientId, 'branding', { body: 'Operador' })).statusCode).toBe(200);
    const created = await postPersona(operatorCookie, agencyA, clientId, { name: 'Persona do operador' });
    expect(created.statusCode).toBe(201);
    const personaId = created.json<{ id: string }>().id;
    expect((await patchPersona(operatorCookie, agencyA, clientId, personaId, { name: 'Editada' })).statusCode).toBe(200);
    expect((await deletePersona(operatorCookie, agencyA, clientId, personaId)).statusCode).toBe(204);
    expect(await owner.knex('client_personas').where({ id: personaId }).first('id')).toBeUndefined();
  });
});
