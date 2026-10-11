import { randomUUID } from 'node:crypto';

import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  captureLogs,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  TEST_IDENTITY_STORAGE_CONFIG,
  type CapturedLogs,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { createIdentityStorageClient } from '../identity-storage/storage-client.js';
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../tenancy/guards.js';
import { CLIENT_PHOTO_RATE_LIMIT } from './policy.js';
import { registerClientModule } from './routes.js';

// Issue #126 acceptance, against the real local database (`pnpm db:migrate`) and the LocalStack
// identity bucket started by `pnpm storage:start`. Every assertion that an object is (or is not)
// stored lists the bucket itself, never the route's own answer.
const origin = { origin: TEST_APP_PUBLIC_URL };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const SVG_BODY = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_BODY = new TextEncoder().encode('<script>alert(1)</script>');

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const image = (signature: readonly number[], size = signature.length): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(signature);
  return bytes;
};
const png = (size?: number): Uint8Array => image(PNG_SIGNATURE, size);
const jpeg = (size?: number): Uint8Array => image(JPEG_SIGNATURE, size);

interface ErrorJson {
  readonly error: { code: string; message: string };
}

interface Reply {
  readonly status: number;
  readonly body: ErrorJson & { photoUrl?: string };
}

let owner: DatabaseClient;
let app: TestApp;
let logs: CapturedLogs;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];

let admin: TestUserFixture;
let manager: TestUserFixture;
let production: TestUserFixture;
let sales: TestUserFixture;
let finance: TestUserFixture;
let viewOnly: TestUserFixture;
let operateOnly: TestUserFixture;
let dualAdmin: TestUserFixture;
let otherAdmin: TestUserFixture;
let portalUser: TestUserFixture;

const cookies = new Map<string, string>();
let roleIds: Record<'admin' | 'account_manager' | 'production' | 'sales' | 'finance', string>;

const identityS3 = (): S3Client => new S3Client({
  region: TEST_IDENTITY_STORAGE_CONFIG.region,
  forcePathStyle: TEST_IDENTITY_STORAGE_CONFIG.forcePathStyle,
  endpoint: TEST_IDENTITY_STORAGE_CONFIG.endpoint,
  credentials: { accessKeyId: TEST_IDENTITY_STORAGE_CONFIG.accessKeyId, secretAccessKey: TEST_IDENTITY_STORAGE_CONFIG.secretAccessKey }
});

const avatarPrefix = (agencyId: string, clientId: string): string => `agencies/${agencyId}/clients/${clientId}/avatar/`;

const listObjects = async (agencyId: string, clientId: string): Promise<string[]> => {
  const response = await identityS3().send(new ListObjectsV2Command({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Prefix: avatarPrefix(agencyId, clientId) }));
  return (response.Contents ?? []).map((object) => object.Key ?? '');
};

const sessionCookieHeader = (set: readonly { name: string; value: string }[]): string =>
  set.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  const cookie = sessionCookieHeader(response.cookies);
  cookies.set(user.id, cookie);
  return cookie;
};

const makeUser = async (label: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: label });
  createdUserIds.push(user.id);
  return user;
};

const addMembership = async (agencyId: string, userId: string, roleId: string): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId });
};

const singlePermissionRole = async (permissionKey: string): Promise<string> => {
  const id = randomUUID();
  createdRoleIds.push(id);
  await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${permissionKey}-${id.slice(0, 8)}`, name: `Só ${permissionKey}`, is_system: false });
  await owner.knex('role_permissions').insert({ role_id: id, permission_key: permissionKey });
  return id;
};

/** A fresh account-manager of agency A: the rate limit is per user, so tests that burst use their own. */
const makeOperator = async (label: string): Promise<{ user: TestUserFixture; cookie: string }> => {
  const user = await makeUser(label);
  await addMembership(agencyA, user.id, roleIds.account_manager);
  return { user, cookie: await login(user) };
};

const createClient = async (input: { agencyId?: string; status?: 'active' | 'archived'; photoKey?: string | null } = {}): Promise<string> => {
  const id = randomUUID();
  await owner.knex('clients').insert({
    id,
    agency_id: input.agencyId ?? agencyA,
    name: `Photo Client ${id}`,
    status: input.status ?? 'active',
    archived_at: input.status === 'archived' ? new Date() : null,
    photo_key: input.photoKey ?? null
  });
  return id;
};

const clientRow = (clientId: string) => owner.knex('clients').where({ id: clientId }).first<{ photo_key: string | null; updated_by: string | null }>();

const putPhoto = async (cookie: string | undefined, agencyId: string, clientId: string, payload: unknown): Promise<Reply> => {
  const response = await app.app.inject({
    method: 'PUT',
    url: `/agencies/${agencyId}/clients/${clientId}/photo`,
    headers: cookie === undefined ? origin : { ...origin, cookie },
    payload: payload as never
  });
  return { status: response.statusCode, body: response.statusCode === 204 ? ({} as Reply['body']) : response.json() };
};

const deletePhoto = async (cookie: string | undefined, agencyId: string, clientId: string): Promise<Reply> => {
  const response = await app.app.inject({
    method: 'DELETE',
    url: `/agencies/${agencyId}/clients/${clientId}/photo`,
    headers: cookie === undefined ? origin : { ...origin, cookie }
  });
  return { status: response.statusCode, body: response.statusCode === 204 ? ({} as Reply['body']) : response.json() };
};

const cookieOf = (user: TestUserFixture): string => {
  const cookie = cookies.get(user.id);
  if (cookie === undefined) throw new Error('missing cookie');
  return cookie;
};

describe('client photo (issue #126)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    logs = captureLogs();
    app = await buildTestApp({ sender: createFakeEmailSender(), logger: logs.logger });

    admin = await makeUser('photo-admin');
    manager = await makeUser('photo-manager');
    production = await makeUser('photo-production');
    sales = await makeUser('photo-sales');
    finance = await makeUser('photo-finance');
    viewOnly = await makeUser('photo-view-only');
    operateOnly = await makeUser('photo-operate-only');
    dualAdmin = await makeUser('photo-dual-admin');
    otherAdmin = await makeUser('photo-other-admin');
    portalUser = await makeUser('photo-portal');

    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance']).select('id', 'key');
    roleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as typeof roleIds;

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Photo Agency A', owner_user_id: null },
      { id: agencyB, name: 'Photo Agency B', owner_user_id: null }
    ]);
    await addMembership(agencyA, admin.id, roleIds.admin);
    await addMembership(agencyA, manager.id, roleIds.account_manager);
    await addMembership(agencyA, production.id, roleIds.production);
    await addMembership(agencyA, sales.id, roleIds.sales);
    await addMembership(agencyA, finance.id, roleIds.finance);
    await addMembership(agencyA, viewOnly.id, await singlePermissionRole('cliente.visualizar'));
    await addMembership(agencyA, operateOnly.id, await singlePermissionRole('cliente.operar'));
    await addMembership(agencyA, dualAdmin.id, roleIds.admin);
    await addMembership(agencyB, dualAdmin.id, roleIds.admin);
    await addMembership(agencyB, otherAdmin.id, roleIds.admin);

    // The portal person has a client vínculo and no agency membership; they hold no context otherwise
    // and need a membership of some kind for `/auth/login`, so they get the client vínculo below.
    const portalClient = await createClient();
    await owner.knex('client_memberships').insert({ client_id: portalClient, user_id: portalUser.id });

    for (const user of [admin, manager, production, sales, finance, viewOnly, operateOnly, dualAdmin, otherAdmin, portalUser]) await login(user);
  }, 60_000);

  afterAll(async () => {
    const agencyIds = [agencyA, agencyB];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    const s3 = identityS3();
    for (const agencyId of agencyIds) {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Prefix: `agencies/${agencyId}/` }));
      for (const object of listed.Contents ?? []) {
        await s3.send(new DeleteObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: object.Key ?? '' })).catch(() => undefined);
      }
    }
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('stores the photo under the client prefix, signs a short URL that serves the bytes, and replaces the previous object', async () => {
    const clientId = await createClient();
    const first = await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(png()) });
    expect(first.status).toBe(200);

    const row = await clientRow(clientId);
    expect(row?.photo_key).toMatch(new RegExp(`^agencies/${agencyA}/clients/${clientId}/avatar/[0-9a-f-]{36}\\.png$`));
    expect(row?.updated_by).toBe(manager.id);
    expect(await listObjects(agencyA, clientId)).toEqual([row?.photo_key]);

    const signed = new URL(first.body.photoUrl!);
    expect(signed.searchParams.get('X-Amz-Expires')).toBe(String(TEST_IDENTITY_STORAGE_CONFIG.downloadUrlExpirySeconds));
    expect(signed.searchParams.get('response-content-type')).toBe('image/png');
    expect(signed.searchParams.get('response-content-disposition')).toBe('inline');
    const fetched = await fetch(first.body.photoUrl!);
    expect(fetched.ok).toBe(true);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(png());

    // Replacing with another type leaves no object of the previous extension behind.
    const second = await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(jpeg(24)) });
    expect(second.status).toBe(200);
    const replaced = await clientRow(clientId);
    expect(replaced?.photo_key).toMatch(/\.jpg$/);
    expect(replaced?.photo_key).not.toBe(row?.photo_key);
    expect(await listObjects(agencyA, clientId)).toEqual([replaced?.photo_key]);

    // Every read signs the same reference: the detail now carries a URL that serves the new bytes.
    const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyA}/clients/${clientId}`, headers: { ...origin, cookie: cookieOf(manager) } });
    const detailUrl = detail.json<{ photoUrl: string | null }>().photoUrl;
    expect(detailUrl).not.toBeNull();
    expect(new URL(detailUrl!).pathname).toContain(replaced?.photo_key);
  });

  it('removes the object and clears the reference on DELETE, and a second DELETE is still 204', async () => {
    const clientId = await createClient();
    expect((await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(png()) })).status).toBe(200);
    expect(await listObjects(agencyA, clientId)).toHaveLength(1);

    const removed = await deletePhoto(cookieOf(manager), agencyA, clientId);
    expect(removed.status).toBe(204);
    expect((await clientRow(clientId))?.photo_key).toBeNull();
    expect(await listObjects(agencyA, clientId)).toEqual([]);

    expect((await deletePhoto(cookieOf(manager), agencyA, clientId)).status).toBe(204);
    const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyA}/clients/${clientId}`, headers: { ...origin, cookie: cookieOf(manager) } });
    expect(detail.json<{ photoUrl: string | null }>().photoUrl).toBeNull();
  });

  it('allows cliente.operar (account_manager, admin and a role holding only that key) and refuses everyone else with 403, changing nothing', async () => {
    for (const user of [admin, manager, operateOnly]) {
      const clientId = await createClient();
      expect((await putPhoto(cookieOf(user), agencyA, clientId, { imageBase64: base64(png()) })).status, 'PUT').toBe(200);
      expect((await deletePhoto(cookieOf(user), agencyA, clientId)).status, 'DELETE').toBe(204);
    }

    const clientId = await createClient();
    const seeded = await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(png()) });
    expect(seeded.status).toBe(200);
    const keyBefore = (await clientRow(clientId))?.photo_key;
    const objectsBefore = await listObjects(agencyA, clientId);

    for (const user of [production, sales, finance, viewOnly]) {
      const put = await putPhoto(cookieOf(user), agencyA, clientId, { imageBase64: base64(jpeg()) });
      expect(put.status, `PUT as ${user.email}`).toBe(403);
      expect(put.body.error.code).toBe('FORBIDDEN');
      expect((await deletePhoto(cookieOf(user), agencyA, clientId)).status, `DELETE as ${user.email}`).toBe(403);
    }
    expect((await clientRow(clientId))?.photo_key).toBe(keyBefore);
    expect(await listObjects(agencyA, clientId)).toEqual(objectsBefore);

    expect((await putPhoto(undefined, agencyA, clientId, { imageBase64: base64(png()) })).status).toBe(401);
    expect((await deletePhoto(undefined, agencyA, clientId)).status).toBe(401);
  });

  it('refuses SVG, HTML and unknown bytes by content (415), and any declared label or extra field (400), storing nothing', async () => {
    const clientId = await createClient();
    for (const body of [SVG_BODY, HTML_BODY, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]) {
      const response = await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(body) });
      expect(response.status).toBe(415);
      expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    expect(await listObjects(agencyA, clientId)).toEqual([]);
    expect((await clientRow(clientId))?.photo_key).toBeNull();

    // A declared type, a key, an agency or a client id in the body are not part of the contract.
    for (const extra of [{ contentType: 'image/png' }, { key: 'agencies/x/y.png' }, { agencyId: agencyB }, { clientId: randomUUID() }, { photoKey: 'x.png' }]) {
      const response = await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(HTML_BODY), ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    for (const invalid of [{}, { imageBase64: '' }, { imageBase64: 'not base64 !!' }, { imageBase64: 42 }]) {
      expect((await putPhoto(cookieOf(manager), agencyA, clientId, invalid)).status, JSON.stringify(invalid)).toBe(400);
    }
    expect(await listObjects(agencyA, clientId)).toEqual([]);
  });

  it('refuses an image over the size limit (413) and declares its own body limit, storing nothing', async () => {
    const operator = await makeOperator('photo-size-operator');
    const clientId = await createClient();
    const max = TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes;

    const oversized = await putPhoto(operator.cookie, agencyA, clientId, { imageBase64: base64(png(max + 1)) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await listObjects(agencyA, clientId)).toEqual([]);

    // 2 MiB is above the global 1 MiB body limit: accepting it proves the route's own limit is in
    // effect, and refusing the next one proves Fastify's parser enforces it before any handler.
    const accepted = await putPhoto(operator.cookie, agencyA, clientId, { imageBase64: base64(png(2 * 1024 * 1024)) });
    expect(accepted.status).toBe(200);
    const objectsAfterAccepted = await listObjects(agencyA, clientId);
    expect(objectsAfterAccepted).toHaveLength(1);

    const rejected = await app.app.inject({
      method: 'PUT',
      url: `/agencies/${agencyA}/clients/${clientId}/photo`,
      headers: { ...origin, 'content-type': 'application/json', cookie: operator.cookie },
      payload: `{"imageBase64":"${'A'.repeat(7_000_000)}"}`
    });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json<ErrorJson>().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await listObjects(agencyA, clientId)).toEqual(objectsAfterAccepted);
  });

  it('answers a malformed or empty JSON body with 400 and no error log', async () => {
    const clientId = await createClient();
    const before = logs.lines().length;
    for (const payload of ['{"imageBase64":', '']) {
      const response = await app.app.inject({
        method: 'PUT',
        url: `/agencies/${agencyA}/clients/${clientId}/photo`,
        headers: { ...origin, 'content-type': 'application/json', cookie: cookieOf(manager) },
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorJson>().error.code).toBe('INVALID_BODY');
    }
    expect(logs.lines().slice(before).filter((line) => line.includes('"level":50'))).toEqual([]);
    expect(await listObjects(agencyA, clientId)).toEqual([]);
  });

  it('refuses an archived client with 409 on PUT and DELETE, writing no object and keeping the reference', async () => {
    const existingKey = `agencies/${agencyA}/clients/PLACEHOLDER/avatar/${randomUUID()}.png`;
    const clientId = await createClient({ status: 'archived' });
    const key = existingKey.replace('PLACEHOLDER', clientId);
    await owner.knex('clients').where({ id: clientId }).update({ photo_key: key });
    await identityS3().send(new PutObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: key, Body: png(), ContentType: 'image/png' }));

    const put = await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(jpeg()) });
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe('CLIENT_ARCHIVED');
    const removal = await deletePhoto(cookieOf(manager), agencyA, clientId);
    expect(removal.status).toBe(409);
    expect(removal.body.error.code).toBe('CLIENT_ARCHIVED');

    expect((await clientRow(clientId))?.photo_key).toBe(key);
    expect(await listObjects(agencyA, clientId)).toEqual([key]);
  });

  it('never even uploads for an archived or absent client: the check runs before the bucket is touched', async () => {
    const archived = await createClient({ status: 'archived' });
    const real = createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG);
    let uploads = 0;
    const spyApp = Fastify();
    registerClientModule(spyApp, {
      database: app.database,
      auth: app.auth,
      requireAgencyAccess: createRequireAgencyAccess({ database: app.database }),
      requirePermission,
      requireClientAccess: createRequireClientAccess({ database: app.database }),
      identityStorage: { ...real, uploadIdentityImage: (input) => { uploads += 1; return real.uploadIdentityImage(input); } },
      photoUrlExpirySeconds: TEST_IDENTITY_STORAGE_CONFIG.downloadUrlExpirySeconds,
      photoMaxImageBytes: TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes
    });
    await spyApp.ready();
    try {
      for (const clientId of [archived, randomUUID()]) {
        const response = await spyApp.inject({
          method: 'PUT',
          url: `/agencies/${agencyA}/clients/${clientId}/photo`,
          headers: { ...origin, cookie: cookieOf(manager) },
          payload: { imageBase64: base64(png()) }
        });
        expect([404, 409]).toContain(response.statusCode);
      }
      expect(uploads).toBe(0);
    } finally {
      await spyApp.close();
    }
  });

  it('cleans up the uploaded object when the client is archived between the check and the commit', async () => {
    const clientId = await createClient();
    const database = app.database;
    let calls = 0;
    // The first transaction is the pre-check; the archive lands right before the commit transaction.
    const racingDatabase = {
      ...database,
      transaction: async (work: Parameters<DatabaseClient['transaction']>[0]) => {
        calls += 1;
        if (calls === 2) {
          await owner.knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
        }
        return database.transaction(work);
      }
    } as unknown as DatabaseClient;

    const raceApp = Fastify();
    registerClientModule(raceApp, {
      database: racingDatabase,
      auth: app.auth,
      requireAgencyAccess: createRequireAgencyAccess({ database }),
      requirePermission,
      requireClientAccess: createRequireClientAccess({ database }),
      identityStorage: createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG),
      photoUrlExpirySeconds: TEST_IDENTITY_STORAGE_CONFIG.downloadUrlExpirySeconds,
      photoMaxImageBytes: TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes
    });
    await raceApp.ready();
    try {
      const response = await raceApp.inject({
        method: 'PUT',
        url: `/agencies/${agencyA}/clients/${clientId}/photo`,
        headers: { ...origin, cookie: cookieOf(manager) },
        payload: { imageBase64: base64(png()) }
      });
      expect(response.statusCode).toBe(409);
      expect(calls).toBe(2);
      expect(await listObjects(agencyA, clientId)).toEqual([]);
      expect((await clientRow(clientId))?.photo_key).toBeNull();
    } finally {
      await raceApp.close();
    }
  });

  it('deletes the object it just wrote when the reference cannot be committed', async () => {
    const clientId = await createClient();
    const database = app.database;
    let calls = 0;
    const failingDatabase = {
      ...database,
      transaction: async (work: Parameters<DatabaseClient['transaction']>[0]) => {
        calls += 1;
        if (calls === 2) throw new Error('simulated commit failure');
        return database.transaction(work);
      }
    } as unknown as DatabaseClient;

    const failingApp = Fastify();
    registerClientModule(failingApp, {
      database: failingDatabase,
      auth: app.auth,
      requireAgencyAccess: createRequireAgencyAccess({ database }),
      requirePermission,
      requireClientAccess: createRequireClientAccess({ database }),
      identityStorage: createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG),
      photoUrlExpirySeconds: TEST_IDENTITY_STORAGE_CONFIG.downloadUrlExpirySeconds,
      photoMaxImageBytes: TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes
    });
    await failingApp.ready();
    try {
      const response = await failingApp.inject({
        method: 'PUT',
        url: `/agencies/${agencyA}/clients/${clientId}/photo`,
        headers: { ...origin, cookie: cookieOf(manager) },
        payload: { imageBase64: base64(png()) }
      });
      expect(response.statusCode).toBe(500);
      expect(await listObjects(agencyA, clientId)).toEqual([]);
      expect((await clientRow(clientId))?.photo_key).toBeNull();
    } finally {
      await failingApp.close();
    }
  });

  it('keeps one object under 20 concurrent uploads for the same client', async () => {
    const operator = await makeOperator('photo-concurrent-operator');
    const clientId = await createClient();
    // Without the row lock every transaction reads the same previous key and all but one object leaks.
    const responses = await Promise.all(Array.from({ length: 20 }, () => putPhoto(operator.cookie, agencyA, clientId, { imageBase64: base64(png(64)) })));
    for (const response of responses) expect(response.status).toBe(200);

    const objects = await listObjects(agencyA, clientId);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toBe((await clientRow(clientId))?.photo_key);
  });

  it('rate limits uploads per user', async () => {
    const operator = await makeOperator('photo-rate-operator');
    const clientId = await createClient();
    for (let index = 0; index < CLIENT_PHOTO_RATE_LIMIT.max; index += 1) {
      expect((await putPhoto(operator.cookie, agencyA, clientId, { imageBase64: base64(png()) })).status, `request ${index + 1}`).toBe(200);
    }
    const limited = await putPhoto(operator.cookie, agencyA, clientId, { imageBase64: base64(png()) });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(await listObjects(agencyA, clientId)).toHaveLength(1);
  });

  it('never counts the photo in the agency media storage or quota', async () => {
    const clientId = await createClient();
    const quotaBefore = await owner.knex('agency_storage_quotas').where({ agency_id: agencyA }).select('*');
    expect((await putPhoto(cookieOf(manager), agencyA, clientId, { imageBase64: base64(png()) })).status).toBe(200);
    expect(await owner.knex('agency_storage_quotas').where({ agency_id: agencyA }).select('*')).toEqual(quotaBefore);
    expect(await owner.knex('media_assets').where({ agency_id: agencyA }).count<{ count: string }[]>('* as count')).toEqual([{ count: '0' }]);
  });

  describe('isolation between agencies and clients (BOLA)', () => {
    it('answers the same 404 for a client of another agency, even for someone who belongs to both, and touches nothing', async () => {
      const clientOfB = await createClient({ agencyId: agencyB });
      const seededKey = `agencies/${agencyB}/clients/${clientOfB}/avatar/${randomUUID()}.png`;
      await owner.knex('clients').where({ id: clientOfB }).update({ photo_key: seededKey });
      await identityS3().send(new PutObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: seededKey, Body: png(), ContentType: 'image/png' }));
      const clientOfA = await createClient();

      // dualAdmin holds cliente.operar in A *and* in B, so only the agency scoping can stop this.
      const crossed = await putPhoto(cookieOf(dualAdmin), agencyA, clientOfB, { imageBase64: base64(jpeg()) });
      const absent = await putPhoto(cookieOf(dualAdmin), agencyA, randomUUID(), { imageBase64: base64(jpeg()) });
      expect(crossed.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(crossed.body.error).toEqual(absent.body.error);
      expect((await deletePhoto(cookieOf(dualAdmin), agencyA, clientOfB)).status).toBe(404);

      // Someone with no membership in A at all, aimed at A's client, and at B's through B.
      expect((await putPhoto(cookieOf(otherAdmin), agencyA, clientOfA, { imageBase64: base64(png()) })).status).toBe(404);
      expect((await deletePhoto(cookieOf(otherAdmin), agencyA, clientOfA)).status).toBe(404);
      expect((await putPhoto(cookieOf(otherAdmin), agencyB, clientOfA, { imageBase64: base64(png()) })).status).toBe(404);

      expect((await clientRow(clientOfB))?.photo_key).toBe(seededKey);
      expect(await listObjects(agencyB, clientOfB)).toEqual([seededKey]);
      expect(await listObjects(agencyA, clientOfB)).toEqual([]);
      expect((await clientRow(clientOfA))?.photo_key).toBeNull();
      expect(await listObjects(agencyA, clientOfA)).toEqual([]);
    });

    it('changes only the addressed client, and builds every key from the route ids', async () => {
      const first = await createClient();
      const second = await createClient();
      expect((await putPhoto(cookieOf(manager), agencyA, second, { imageBase64: base64(png()) })).status).toBe(200);
      const secondKey = (await clientRow(second))?.photo_key;

      expect((await putPhoto(cookieOf(manager), agencyA, first, { imageBase64: base64(jpeg()) })).status).toBe(200);
      expect((await deletePhoto(cookieOf(manager), agencyA, first)).status).toBe(204);

      expect((await clientRow(second))?.photo_key).toBe(secondKey);
      expect(await listObjects(agencyA, second)).toEqual([secondKey]);
      expect(await listObjects(agencyA, first)).toEqual([]);
    });

    // Issue #436 (review of #431). A UUID in capitals reaches the same row, but the readers sign only
    // the key built from the row's lowercase ids: a key built from the URL's capitals would be an
    // object nobody signs and nobody deletes. Every call site is exercised on its own.
    describe('ids in capitals in the URL name the same row and the same lowercase keys (#436)', () => {
      // The photo rate limit is per user: a fresh operator keeps these bursts off the shared manager.
      let operatorCookie = '';
      beforeEach(async () => {
        operatorCookie = (await makeOperator('photo-capitals-operator')).cookie;
      });

      const lowerKeyPattern = (clientId: string): RegExp => new RegExp(`^agencies/${agencyA}/clients/${clientId}/avatar/[0-9a-f-]{36}\\.png$`);

      const seedPhoto = async (clientId: string): Promise<string> => {
        expect((await putPhoto(operatorCookie, agencyA, clientId, { imageBase64: base64(png()) })).status).toBe(200);
        return (await clientRow(clientId))!.photo_key!;
      };

      /** The module over a database whose `call`-th transaction first runs `before` (or throws), like the races above. */
      const withTransactionHook = async (
        hook: { readonly call: number; readonly before?: () => Promise<void>; readonly fail?: boolean },
        run: (hooked: ReturnType<typeof Fastify>) => Promise<void>
      ): Promise<void> => {
        const database = app.database;
        let calls = 0;
        const hookedDatabase = {
          ...database,
          transaction: async (work: Parameters<DatabaseClient['transaction']>[0]) => {
            calls += 1;
            if (calls === hook.call) {
              if (hook.fail === true) throw new Error('simulated commit failure');
              await hook.before?.();
            }
            return database.transaction(work);
          }
        } as unknown as DatabaseClient;
        const hooked = Fastify();
        registerClientModule(hooked, {
          database: hookedDatabase,
          auth: app.auth,
          requireAgencyAccess: createRequireAgencyAccess({ database }),
          requirePermission,
          requireClientAccess: createRequireClientAccess({ database }),
          identityStorage: createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG),
          photoUrlExpirySeconds: TEST_IDENTITY_STORAGE_CONFIG.downloadUrlExpirySeconds,
          photoMaxImageBytes: TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes
        });
        await hooked.ready();
        try {
          await run(hooked);
        } finally {
          await hooked.close();
        }
      };

      const putInCapitals = (instance: { inject: typeof app.app.inject }, clientId: string) => instance.inject({
        method: 'PUT',
        url: `/agencies/${agencyA.toUpperCase()}/clients/${clientId.toUpperCase()}/photo`,
        headers: { ...origin, cookie: operatorCookie },
        payload: { imageBase64: base64(png()) }
      });

      it('PUT stores the key built from the row ids, and the readers sign it', async () => {
        const clientId = await createClient();
        const response = await putPhoto(operatorCookie, agencyA.toUpperCase(), clientId.toUpperCase(), { imageBase64: base64(png()) });
        expect(response.status).toBe(200);

        const key = (await clientRow(clientId))?.photo_key;
        expect(key).toMatch(lowerKeyPattern(clientId));
        expect(await listObjects(agencyA, clientId)).toEqual([key]);
        expect(await listObjects(agencyA.toUpperCase(), clientId.toUpperCase())).toEqual([]);
        expect(new URL(response.body.photoUrl!).pathname).toContain(key);

        const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyA}/clients/${clientId}`, headers: { ...origin, cookie: operatorCookie } });
        const detailUrl = detail.json<{ photoUrl: string | null }>().photoUrl;
        expect(detailUrl).not.toBeNull();
        expect(new URL(detailUrl!).pathname).toContain(key);
        expect((await fetch(detailUrl!)).ok).toBe(true);
      });

      it('PUT removes the previous object, which a capital-lettered scope would have refused to delete', async () => {
        const clientId = await createClient();
        const previous = await seedPhoto(clientId);

        const response = await putPhoto(operatorCookie, agencyA.toUpperCase(), clientId.toUpperCase(), { imageBase64: base64(png()) });
        expect(response.status).toBe(200);
        const current = (await clientRow(clientId))?.photo_key;
        expect(current).not.toBe(previous);
        expect(await listObjects(agencyA, clientId)).toEqual([current]);
      });

      it('PUT removes the object it just wrote when the client is archived before the commit', async () => {
        const clientId = await createClient();
        await withTransactionHook({
          call: 2,
          before: async () => { await owner.knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() }); }
        }, async (hooked) => {
          expect((await putInCapitals(hooked, clientId)).statusCode).toBe(409);
        });
        expect(await listObjects(agencyA, clientId)).toEqual([]);
        expect((await clientRow(clientId))?.photo_key).toBeNull();
      });

      it('PUT removes the object it just wrote when the reference cannot be committed', async () => {
        const clientId = await createClient();
        await withTransactionHook({ call: 2, fail: true }, async (hooked) => {
          expect((await putInCapitals(hooked, clientId)).statusCode).toBe(500);
        });
        expect(await listObjects(agencyA, clientId)).toEqual([]);
        expect((await clientRow(clientId))?.photo_key).toBeNull();
      });

      it('DELETE clears the reference and removes the object', async () => {
        const clientId = await createClient();
        await seedPhoto(clientId);

        const removed = await deletePhoto(operatorCookie, agencyA.toUpperCase(), clientId.toUpperCase());
        expect(removed.status).toBe(204);
        expect((await clientRow(clientId))?.photo_key).toBeNull();
        expect(await listObjects(agencyA, clientId)).toEqual([]);
      });
    });

    it('treats a malformed or traversal client id as the same 404, never reaching storage', async () => {
      for (const clientId of ['not-a-uuid', '..%2F..%2Fother', `${randomUUID()}%2F..%2F`, '0']) {
        const response = await app.app.inject({
          method: 'PUT',
          url: `/agencies/${agencyA}/clients/${clientId}/photo`,
          headers: { ...origin, cookie: cookieOf(manager) },
          payload: { imageBase64: base64(png()) }
        });
        expect(response.statusCode, clientId).toBe(404);
        expect((await deletePhoto(cookieOf(manager), agencyA, clientId)).status, clientId).toBe(404);
      }
    });

    it('gives the portal person no way in: the agency photo routes answer 404 even for their own client', async () => {
      const own = await owner.knex('client_memberships').where({ user_id: portalUser.id }).first<{ client_id: string }>('client_id');
      expect((await putPhoto(cookieOf(portalUser), agencyA, own!.client_id, { imageBase64: base64(png()) })).status).toBe(404);
      expect((await deletePhoto(cookieOf(portalUser), agencyA, own!.client_id)).status).toBe(404);
      expect(await listObjects(agencyA, own!.client_id)).toEqual([]);
    });

    it('never deletes an object a tampered reference points at, in another client or another agency', async () => {
      const victim = await createClient({ agencyId: agencyB });
      const victimKey = `agencies/${agencyB}/clients/${victim}/avatar/${randomUUID()}.png`;
      await identityS3().send(new PutObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: victimKey, Body: png(), ContentType: 'image/png' }));
      const sibling = await createClient();
      const siblingKey = `agencies/${agencyA}/clients/${sibling}/avatar/${randomUUID()}.png`;
      await identityS3().send(new PutObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: siblingKey, Body: png(), ContentType: 'image/png' }));

      for (const foreignKey of [victimKey, siblingKey, `agencies/${agencyA}/clients/${randomUUID()}/../${sibling}/avatar/x.png`, 'users/anyone/avatar/x.png']) {
        const target = await createClient();
        await owner.knex('clients').where({ id: target }).update({ photo_key: foreignKey });

        expect((await putPhoto(cookieOf(manager), agencyA, target, { imageBase64: base64(png()) })).status).toBe(200);
        await owner.knex('clients').where({ id: target }).update({ photo_key: foreignKey });
        expect((await deletePhoto(cookieOf(manager), agencyA, target)).status).toBe(204);

        expect((await clientRow(target))?.photo_key).toBeNull();
        expect(await listObjects(agencyB, victim)).toEqual([victimKey]);
        expect(await listObjects(agencyA, sibling)).toEqual([siblingKey]);
      }
      expect(logs.text()).toContain('Refused to delete a client photo key outside the client directory');
    });
  });
});
