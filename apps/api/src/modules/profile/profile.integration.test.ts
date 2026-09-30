import { randomUUID } from 'node:crypto';

import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, NotFound, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { raw, withAuthenticatedUserTransaction, createVerifiedUserClaims } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  TEST_IDENTITY_STORAGE_CONFIG,
  TEST_STORAGE_CONFIG,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #101 acceptance tests. Runs against the real local database (`pnpm db:migrate`) and the
// local LocalStack started by `pnpm storage:start`, as the identity-storage suite does.
const origin = { origin: TEST_APP_PUBLIC_URL };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const SVG_BODY = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_BODY = new TextEncoder().encode('<script>alert(1)</script>');

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const png = (size = PNG_SIGNATURE.length): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_SIGNATURE);
  return bytes;
};

const SYSTEM_PRESETS = ['admin', 'account_manager', 'production', 'sales', 'finance'] as const;

interface ApiErrorJson {
  readonly error: { code: string; message: string };
}

let app: TestApp;
const owner = ownerClient();

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];

const identityClient = (): S3Client => new S3Client({
  region: TEST_IDENTITY_STORAGE_CONFIG.region,
  forcePathStyle: TEST_IDENTITY_STORAGE_CONFIG.forcePathStyle,
  endpoint: TEST_IDENTITY_STORAGE_CONFIG.endpoint,
  credentials: { accessKeyId: TEST_IDENTITY_STORAGE_CONFIG.accessKeyId, secretAccessKey: TEST_IDENTITY_STORAGE_CONFIG.secretAccessKey }
});

const mediaClient = (): S3Client => new S3Client({
  region: TEST_STORAGE_CONFIG.region,
  forcePathStyle: TEST_STORAGE_CONFIG.forcePathStyle,
  endpoint: TEST_STORAGE_CONFIG.endpoint,
  credentials: { accessKeyId: TEST_STORAGE_CONFIG.accessKeyId, secretAccessKey: TEST_STORAGE_CONFIG.secretAccessKey }
});

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUserIds.push(user.id);
  return user;
};

/** A user with one owned agency, so `POST /auth/login` is not refused for having zero contexts. */
const makeUserWithOwnAgency = async (emailLabel: string): Promise<TestUserFixture> => {
  const user = await makeUser(emailLabel);
  await createAgency(`Profile Context ${emailLabel}`, user.id);
  return user;
};

const createAgency = async (name: string, ownerUserId: string | null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name, owner_user_id: ownerUserId, status: 'active' });
  return id;
};

const addAgencyMembership = async (agencyId: string, userId: string, roleId: string): Promise<void> => {
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status: 'active' });
};

const createSinglePermissionRole = async (agencyId: string, permissionKey: string): Promise<string> => {
  const id = randomUUID();
  createdRoleIds.push(id);
  await owner.knex('roles').insert({ id, agency_id: agencyId, key: `custom-${id.slice(0, 8)}`, name: 'Custom', is_system: false });
  await owner.knex('role_permissions').insert({ role_id: id, permission_key: permissionKey });
  return id;
};

const readUser = async (userId: string): Promise<{ name: string; email: string; image: string | null }> => {
  const rows = await owner.knex('auth.user').where({ id: userId }).select('name', 'email', 'image');
  return rows[0] as { name: string; email: string; image: string | null };
};

/** Reads the user's photo the way a future listing must: through `agency_memberships`, never a bare
 * `auth."user"` lookup, so the test proves the reference is the same across every agency. */
const readImageThroughMembership = async (userId: string, agencyId: string): Promise<string | null> => {
  const claims = createVerifiedUserClaims({ userId });
  const result = await withAuthenticatedUserTransaction(app.database, claims, (transaction) =>
    raw<{ rows: readonly { image: string | null }[] }>(transaction, `
      select member_user.image
      from auth."user" as member_user
      join public.agency_memberships as membership
        on membership.user_id = member_user.id
       and membership.status = 'active'
      where membership.agency_id = ?::uuid
        and member_user.id = ?::uuid
    `, [agencyId, userId])
  );
  return result.rows[0]?.image ?? null;
};

const listAvatarObjects = async (userId: string): Promise<string[]> => {
  const response = await identityClient().send(new ListObjectsV2Command({
    Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket,
    Prefix: `users/${userId}/avatar/`
  }));
  return (response.Contents ?? []).map((object) => object.Key ?? '');
};

const patchProfile = async (cookie: string | undefined, payload: unknown, url = '/me/profile'): Promise<{ status: number; body: ApiErrorJson & { id?: string; name?: string } }> => {
  const response = await app.app.inject({
    method: 'PATCH',
    url,
    headers: cookie === undefined ? origin : { ...origin, cookie },
    payload: payload as never
  });
  return { status: response.statusCode, body: response.json() };
};

const postPhoto = async (cookie: string | undefined, payload: unknown, url = '/me/photo'): Promise<{ status: number; body: ApiErrorJson & { imageUrl?: string } }> => {
  const response = await app.app.inject({
    method: 'POST',
    url,
    headers: cookie === undefined ? origin : { ...origin, cookie },
    payload: payload as never
  });
  return { status: response.statusCode, body: response.json() };
};

describe('profile module (issue #101)', () => {
  let presetRoleIds: Record<(typeof SYSTEM_PRESETS)[number], string>;

  beforeAll(async () => {
    app = await buildTestApp();
    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', [...SYSTEM_PRESETS]).select('id', 'key');
    presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<(typeof SYSTEM_PRESETS)[number], string>;
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const userIds = [...new Set(createdUserIds)];
    await owner.knex('user_context_preferences').whereIn('user_id', userIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    // Best-effort: remove the avatar objects this suite created so the local bucket stays clean.
    const s3 = identityClient();
    for (const userId of userIds) {
      for (const key of await listAvatarObjects(userId)) {
        await s3.send(new DeleteObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: key })).catch(() => undefined);
      }
    }
    await app.close();
    await owner.close();
  });

  it('#101: a person of any role changes their own name, and exactly that row changes', async () => {
    const user = await makeUser('profile-name-role');
    const agency = await createAgency('Profile Name Agency', null);
    // The strongest authorization case: a custom role with a single, unrelated permission. The
    // profile routes must not require any module permission at all.
    const roleId = await createSinglePermissionRole(agency, 'cliente.visualizar');
    await addAgencyMembership(agency, user.id, roleId);
    const cookie = await loginCookie(user);

    const response = await patchProfile(cookie, { name: '  Nome Editado  ' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: user.id, name: 'Nome Editado' });

    // Trimmed value persisted; one row matched (the session user), and no other account moved.
    expect((await readUser(user.id)).name).toBe('Nome Editado');
    const matching = await owner.knex('auth.user').where({ name: 'Nome Editado' }).count<{ count: string }[]>('* as count');
    expect(Number(matching[0]!.count)).toBe(1);
  });

  it('#101: a client-portal-only person (no agency membership) also edits their own name', async () => {
    const user = await makeUser('profile-name-portal');
    const agencyOwner = await makeUser('profile-name-portal-owner');
    const agency = await createAgency('Profile Portal Agency', agencyOwner.id);
    const clientId = randomUUID();
    await owner.knex('clients').insert({ id: clientId, agency_id: agency, name: 'Portal Client' });
    await owner.knex('client_memberships').insert({ client_id: clientId, user_id: user.id, status: 'active' });
    const cookie = await loginCookie(user);

    const response = await patchProfile(cookie, { name: 'Pessoa do Portal' });
    expect(response.status).toBe(200);
    expect((await readUser(user.id)).name).toBe('Pessoa do Portal');

    await owner.knex('client_memberships').where({ client_id: clientId }).delete();
    await owner.knex('clients').where({ id: clientId }).delete();
  });

  it('#101: an empty or whitespace-only name is rejected with 400, including NBSP and tab', async () => {
    const user = await makeUserWithOwnAgency('profile-name-blank');
    const cookie = await loginCookie(user);
    const before = (await readUser(user.id)).name;

    for (const name of ['', '   ', '\u00a0\u00a0', '\t\t', '\u00a0 \t ', '\n']) {
      const response = await patchProfile(cookie, { name });
      expect(response.status, `name ${JSON.stringify(name)}`).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    // A name over the limit is rejected too.
    const tooLong = await patchProfile(cookie, { name: 'a'.repeat(121) });
    expect(tooLong.status).toBe(400);

    expect((await readUser(user.id)).name).toBe(before);
  });

  it('#101: uploading a photo stores the reference on the user and returns a signed URL that serves the bytes', async () => {
    const user = await makeUserWithOwnAgency('profile-photo-happy');
    const cookie = await loginCookie(user);

    const response = await postPhoto(cookie, { imageBase64: base64(png()) });
    expect(response.status).toBe(200);
    expect(typeof response.body.imageUrl).toBe('string');

    const stored = (await readUser(user.id)).image;
    expect(stored).toMatch(new RegExp(`^users/${user.id}/avatar/[0-9a-f-]{36}\\.png$`));
    expect(await listAvatarObjects(user.id)).toEqual([stored]);

    // The signed URL serves the real bytes with a forced safe content type.
    const fetched = await fetch(response.body.imageUrl!);
    expect(fetched.ok).toBe(true);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(fetched.headers.get('content-disposition')).toBe('inline');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(png());

    // A re-upload changes the reference and deletes the previous object.
    const second = await postPhoto(cookie, { imageBase64: base64(png(20)) });
    expect(second.status).toBe(200);
    const replaced = (await readUser(user.id)).image;
    expect(replaced).not.toBe(stored);
    expect(await listAvatarObjects(user.id)).toEqual([replaced]);
  });

  it('#101: the photo appears for the person in every agency they belong to', async () => {
    const user = await makeUser('profile-photo-two-agencies');
    const agencyA = await createAgency('Profile Photo Agency A', null);
    const agencyB = await createAgency('Profile Photo Agency B', null);
    await addAgencyMembership(agencyA, user.id, presetRoleIds.production);
    await addAgencyMembership(agencyB, user.id, presetRoleIds.sales);
    const cookie = await loginCookie(user);

    const response = await postPhoto(cookie, { imageBase64: base64(png()) });
    expect(response.status).toBe(200);

    const fromA = await readImageThroughMembership(user.id, agencyA);
    const fromB = await readImageThroughMembership(user.id, agencyB);
    expect(fromA).not.toBeNull();
    expect(fromA).toBe(fromB);
    expect(fromA).toBe((await readUser(user.id)).image);
  });

  it('#101: the photo never enters agency storage or quota', async () => {
    const user = await makeUser('profile-photo-no-quota');
    const agency = await createAgency('Profile Photo Quota Agency', null);
    await addAgencyMembership(agency, user.id, presetRoleIds.production);
    const cookie = await loginCookie(user);

    const response = await postPhoto(cookie, { imageBase64: base64(png()) });
    expect(response.status).toBe(200);
    const key = (await readUser(user.id)).image!;

    // Nothing was written to the media bucket or the quota tables.
    await expect(mediaClient().send(new HeadObjectCommand({ Bucket: TEST_STORAGE_CONFIG.bucket, Key: key }))).rejects.toBeInstanceOf(NotFound);
    expect(await owner.knex('media_assets').where({ agency_id: agency }).count<{ count: string }[]>('* as count')).toEqual([{ count: '0' }]);
    expect(await owner.knex('agency_storage_quotas').where({ agency_id: agency }).count<{ count: string }[]>('* as count')).toEqual([{ count: '0' }]);
  });

  it('#101: SVG and HTML are refused by content, nothing is stored, and no declared label is accepted', async () => {
    const user = await makeUserWithOwnAgency('profile-photo-reject');
    const cookie = await loginCookie(user);

    for (const body of [SVG_BODY, HTML_BODY]) {
      const response = await postPhoto(cookie, { imageBase64: base64(body) });
      expect(response.status).toBe(415);
      expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    expect((await readUser(user.id)).image).toBeNull();
    expect(await listAvatarObjects(user.id)).toEqual([]);

    // A declared content type is not part of the contract at all: `.strict()` rejects it, so a
    // client cannot even claim "image/png" over HTML bytes.
    const labelled = await postPhoto(cookie, { imageBase64: base64(HTML_BODY), contentType: 'image/png' });
    expect(labelled.status).toBe(400);
    expect((await readUser(user.id)).image).toBeNull();
  });

  it('#101: an image over the size limit is refused, and nothing is stored', async () => {
    const user = await makeUserWithOwnAgency('profile-photo-too-large');
    const cookie = await loginCookie(user);
    const max = TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes;

    // Decoded size is over the limit but the base64 body still fits the route's own limit, so the
    // storage client's own size check is what refuses it.
    const oversized = await postPhoto(cookie, { imageBase64: base64(png(max + 1)) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await readUser(user.id)).image).toBeNull();
    expect(await listAvatarObjects(user.id)).toEqual([]);
  });

  it('#101: the photo route declares its own body limit -- above the global one it still works, past its own it is 413', async () => {
    const user = await makeUserWithOwnAgency('profile-photo-body-limit');
    const cookie = await loginCookie(user);

    // 2 MiB is well above the global 1 MiB `API_BODY_LIMIT_BYTES`; accepting it proves the route's
    // own bodyLimit is in effect rather than a raised global limit.
    const accepted = await postPhoto(cookie, { imageBase64: base64(png(2 * 1024 * 1024)) });
    expect(accepted.status).toBe(200);

    // Past the route's own limit, Fastify's parser answers 413 before any handler reads the body.
    const oversizedBody = `{"imageBase64":"${'A'.repeat(7_000_000)}"}`;
    const rejected = await app.app.inject({
      method: 'POST',
      url: '/me/photo',
      headers: { ...origin, 'content-type': 'application/json', cookie },
      payload: oversizedBody
    });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json<ApiErrorJson>().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('#101: a userId in the body, the query or the path never becomes the target', async () => {
    const attacker = await makeUserWithOwnAgency('profile-target-attacker');
    const victim = await makeUser('profile-target-victim');
    const cookie = await loginCookie(attacker);
    const victimBefore = await readUser(victim.id);

    // Body: rejected outright by `.strict()`; the victim is untouched.
    const viaBody = await patchProfile(cookie, { name: 'Atacado pelo corpo', userId: victim.id });
    expect(viaBody.status).toBe(400);
    expect((await readUser(victim.id)).name).toBe(victimBefore.name);

    // Query: not read at all; the session user is the target.
    const viaQuery = await patchProfile(cookie, { name: 'Nome do Atacante' }, `/me/profile?userId=${victim.id}`);
    expect(viaQuery.status).toBe(200);
    expect((await readUser(attacker.id)).name).toBe('Nome do Atacante');
    expect((await readUser(victim.id)).name).toBe(victimBefore.name);

    // Path: no such route, so it is a 404 and the victim stays as they were.
    const viaPath = await patchProfile(cookie, { name: 'Atacado pela rota' }, `/me/profile/${victim.id}`);
    expect(viaPath.status).toBe(404);
    expect((await readUser(victim.id)).name).toBe(victimBefore.name);

    // Photo: the same three attempts, with the victim's image kept null throughout.
    const photoViaBody = await postPhoto(cookie, { imageBase64: base64(png()), userId: victim.id });
    expect(photoViaBody.status).toBe(400);
    const photoViaQuery = await postPhoto(cookie, { imageBase64: base64(png()) }, `/me/photo?userId=${victim.id}`);
    expect(photoViaQuery.status).toBe(200);
    const photoViaPath = await postPhoto(cookie, { imageBase64: base64(png()) }, `/me/photo/${victim.id}`);
    expect(photoViaPath.status).toBe(404);

    expect((await readUser(victim.id)).image).toBeNull();
    expect((await readUser(attacker.id)).image).not.toBeNull();
  });

  it('#101: no route in the module edits e-mail', async () => {
    const user = await makeUserWithOwnAgency('profile-email');
    const cookie = await loginCookie(user);
    const before = await readUser(user.id);

    const alone = await patchProfile(cookie, { email: 'trocado@exemplo.test' });
    expect(alone.status).toBe(400);
    const mixed = await patchProfile(cookie, { name: 'Nome', email: 'trocado@exemplo.test' });
    expect(mixed.status).toBe(400);

    expect((await readUser(user.id)).email).toBe(before.email);
  });

  it('#101: without a session both routes answer 401', async () => {
    expect((await patchProfile(undefined, { name: 'Sem sessão' })).status).toBe(401);
    expect((await postPhoto(undefined, { imageBase64: base64(png()) })).status).toBe(401);
  });

  it('#101: a malformed body answers 400, never 500', async () => {
    const user = await makeUserWithOwnAgency('profile-malformed');
    const cookie = await loginCookie(user);

    const malformedProfile = await app.app.inject({
      method: 'PATCH', url: '/me/profile', headers: { ...origin, 'content-type': 'application/json', cookie }, payload: '{"name":'
    });
    expect(malformedProfile.statusCode).toBe(400);
    expect(malformedProfile.json<ApiErrorJson>().error.code).toBe('INVALID_BODY');

    const malformedPhoto = await app.app.inject({
      method: 'POST', url: '/me/photo', headers: { ...origin, 'content-type': 'application/json', cookie }, payload: '{"imageBase64":'
    });
    expect(malformedPhoto.statusCode).toBe(400);
    expect(malformedPhoto.json<ApiErrorJson>().error.code).toBe('INVALID_BODY');
  });
});
