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
import { DOCUMENTED_ROUTES } from '../api-docs/catalog.js';
import type { DatabaseClient } from '@ageniza/database';

// Issue #126, security review of PR #301: the photo routes must not gate the rest of the module.
// A future merge that puts any other client route after the photo block would silently drop it
// wherever identity storage is not configured; this suite mounts the app without storage and
// proves the non-photo routes still exist and the photo ones are simply absent (generic 404).
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let logs: CapturedLogs;

const agencyId = randomUUID();
const createdUserIds: string[] = [];

let manager: TestUserFixture;
let managerCookie: string;

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const createClient = async (): Promise<string> => {
  const id = randomUUID();
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: `No-storage client ${id}` });
  return id;
};

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

const get = async (url: string): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'GET', url, headers: { ...origin, cookie: managerCookie } })) as unknown as InjectResponse;

// Every clients route except the photo ones, straight from the api-docs catalog (issue #182): the
// photo block is the only part that depends on identity storage, so each of these must answer with
// the app mounted without it, wherever a future merge places them. A new documented route enters
// this list by itself.
const nonPhotoClientRoutes = DOCUMENTED_ROUTES.filter(
  (route) => route.module === 'clients' && !route.path.endsWith('/photo')
);

const payloadFor = (method: string, path: string): Record<string, unknown> | undefined => {
  if (method === 'post' && path.endsWith('/clients')) return { name: `No-storage created ${randomUUID()}` };
  if (method === 'patch' && path.endsWith('/:clientId')) return { segment: 'Alimentação' };
  if (method === 'put' && path.endsWith('/:sectionKey')) return { body: 'Marca sem storage' };
  if (method === 'post' && path.endsWith('/personas')) return { name: 'Persona sem storage' };
  if (method === 'patch' && path.endsWith('/:personaId')) return { name: 'Persona editada' };
  return undefined;
};

const urlFor = (routePath: string, clientId: string): string =>
  routePath
    .replace(':agencyId', agencyId)
    .replace(':clientId', clientId)
    .replace(':personaId', randomUUID())
    .replace(':sectionKey', 'branding');

describe('CLIENTS module without identity storage (#126/#282/#291)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    logs = captureLogs();
    app = await buildTestApp({ sender: createFakeEmailSender(), logger: logs.logger, config: { identityStorage: undefined } });

    manager = await insertTestUser(app.pool, app.auth, { emailLabel: 'clients-no-storage-manager' });
    createdUserIds.push(manager.id);
    const role = await owner.knex('roles').whereNull('agency_id').where({ key: 'account_manager' }).first<{ id: string }>('id');
    if (role === undefined) throw new Error('Missing system role account_manager.');
    await owner.knex('agencies').insert({ id: agencyId, name: 'No-storage Agency', owner_user_id: null });
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: manager.id, role_id: role.id });

    managerCookie = await login(manager);
  });

  afterAll(async () => {
    await owner.knex('audit.events').where({ agency_id: agencyId }).delete();
    const clientIds = await owner.knex('clients').where({ agency_id: agencyId }).pluck('id');
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
    await owner.knex('agencies').where({ id: agencyId }).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('keeps the carteira of #291 registered and serving', async () => {
    const clientId = await createClient();
    const response = await get(`/agencies/${agencyId}/clients`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { id: string; photoUrl: string | null }[] }>();
    expect(body.data).toContainEqual(expect.objectContaining({ id: clientId, photoUrl: null }));
  });

  it('keeps the brand study and personas of #282 registered and serving', async () => {
    const clientId = await createClient();

    const study = await get(`/agencies/${agencyId}/clients/${clientId}/brand-study`);
    expect(study.statusCode).toBe(200);
    expect(study.json()).toMatchObject({ filled: 0, sections: expect.any(Array), personas: [] });

    const section = await app.app.inject({
      method: 'PUT',
      url: `/agencies/${agencyId}/clients/${clientId}/brand-study/sections/branding`,
      headers: { ...origin, cookie: managerCookie },
      payload: { body: 'Marca sem storage' }
    });
    expect(section.statusCode).toBe(200);

    const persona = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/clients/${clientId}/personas`,
      headers: { ...origin, cookie: managerCookie },
      payload: { name: 'Persona sem storage' }
    });
    expect(persona.statusCode).toBe(201);
  });

  it('answers the same generic 404 for the photo routes, never a 500 or a config leak', async () => {
    const clientId = await createClient();
    const logsBefore = logs.text().length;

    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await app.app.inject({
        method,
        url: `/agencies/${agencyId}/clients/${clientId}/photo`,
        headers: { ...origin, cookie: managerCookie },
        payload: method === 'PUT' ? { imageBase64: 'AAAA' } : undefined
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'Route not found' },
        meta: { requestId: expect.any(String) }
      });
    }

    expect(logs.text().slice(logsBefore)).not.toContain('CLIENT_PHOTO');
  });

  it('registers every non-photo route of the module without storage, derived from the catalog', async () => {
    // A floor so an empty filter can never make this test vacuously green.
    expect(nonPhotoClientRoutes.length).toBeGreaterThanOrEqual(10);

    const clientId = await createClient();
    const missing: string[] = [];
    for (const route of nonPhotoClientRoutes) {
      const payload = payloadFor(route.method, route.path);
      const response = await app.app.inject({
        method: route.method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: urlFor(route.path, clientId),
        headers: { ...origin, cookie: managerCookie },
        ...(payload === undefined ? {} : { payload })
      });
      // Read the body only on 404: a future route that answers 204 has no body to parse.
      const routeIsMissing = response.statusCode === 404
        && response.json<{ error?: { message?: string } }>().error?.message === 'Route not found';
      if (routeIsMissing || response.statusCode === 500) {
        missing.push(`${route.method.toUpperCase()} ${route.path} -> ${response.statusCode}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
