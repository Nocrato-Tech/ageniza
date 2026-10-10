import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@ageniza/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

// Issue #470: when the bucket refuses to sign the key of a photo that is, in fact, the photo of this
// client (or the avatar of a comment author), the page keeps loading: the photo is null, the log
// carries the code and never the key. The key is a valid avatar key on purpose -- a key the module
// bars earlier, by its shape, never reaches the `catch` this suite is about.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let logs: CapturedLogs;

const agencyId = randomUUID();
const clientId = randomUUID();
const threadId = randomUUID();
const photoKey = `agencies/${agencyId}/clients/${clientId}/avatar/${randomUUID()}.png`;
const createdUserIds: string[] = [];
let admin: TestUserFixture;
let portal: TestUserFixture;
let adminCookie: string;
let portalCookie: string;
let adminAvatarKey: string;

/** What the SDK throws when the bucket answers 403: the message names the object, which must not reach the log. */
const bucketRefusal = (key: string): Error =>
  Object.assign(new Error(`Access Denied: ${key}`), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });

const bucket = { refusing: false };

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, cookie: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, cookie },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const agencyClient = `/agencies/${agencyId}/clients/${clientId}`;

/**
 * Runs the request with a healthy bucket, proving the fixture really is signable (a null from a
 * fixture that could never be signed would pass the refusal half for the wrong reason), then with
 * the bucket refusing, and returns what the refused request answered and logged.
 */
const refused = async <T>(
  run: () => Promise<Reply>,
  photoOf: (body: any) => T, // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
  signedKey: string
): Promise<{ readonly reply: Reply; readonly photo: T | undefined; readonly logged: string }> => {
  bucket.refusing = false;
  const healthy = await run();
  expect([200, 201]).toContain(healthy.statusCode);
  expect(String(photoOf(healthy.json()))).toContain(signedKey);

  bucket.refusing = true;
  const before = logs.text().length;
  const reply = await run();
  // A 500 has no body to read the photo from; the status assertion that follows names the failure.
  const photo = reply.statusCode < 300 ? photoOf(reply.json()) : undefined;
  return { reply, photo, logged: logs.text().slice(before) };
};

describe('CLIENTS photo URL when the bucket refuses to sign (#470)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    logs = captureLogs('warn');
    app = await buildTestApp({
      sender: createFakeEmailSender(),
      logger: logs.logger,
      wrapIdentityStorage: (real) => ({
        ...real,
        presignGetObject: async (input) => {
          if (bucket.refusing) throw bucketRefusal(input.key);
          return real.presignGetObject(input);
        }
      })
    });

    admin = await insertTestUser(app.pool, app.auth, { emailLabel: 'photo-refused-admin', name: 'Adriana Admin' });
    portal = await insertTestUser(app.pool, app.auth, { emailLabel: 'photo-refused-portal', name: 'Ana do Portal' });
    createdUserIds.push(admin.id, portal.id);
    adminAvatarKey = `users/${admin.id}/avatar/${randomUUID()}.png`;
    await app.pool.query('update auth."user" set image = $1 where id = $2', [adminAvatarKey, admin.id]);

    const adminRole = await owner.knex('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
    await owner.knex('agencies').insert({ id: agencyId, name: `Photo refused ${agencyId}`, owner_user_id: null });
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: admin.id, role_id: adminRole!.id });
    await owner.knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Photo refused ${clientId}`, photo_key: photoKey });
    await owner.knex('client_memberships').insert({ client_id: clientId, user_id: portal.id });
    await owner.knex('client_threads').insert({ id: threadId, client_id: clientId, section_key: 'branding', opened_by: admin.id, opened_side: 'agency' });
    await owner.knex('client_thread_comments').insert({
      id: randomUUID(),
      thread_id: threadId,
      client_id: clientId,
      author_user_id: admin.id,
      author_side: 'agency',
      body: 'Vamos revisar o branding?',
      created_at: new Date('2026-01-01T10:00:00.000Z')
    });

    adminCookie = await login(admin);
    portalCookie = await login(portal);
  });

  afterEach(() => {
    bucket.refusing = false;
  });

  afterAll(async () => {
    await owner.knex('audit.events').where({ agency_id: agencyId }).delete();
    await owner.knex('client_thread_comments').where({ client_id: clientId }).delete();
    await owner.knex('client_threads').where({ client_id: clientId }).delete();
    await owner.knex('client_memberships').where({ client_id: clientId }).delete();
    await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
    await owner.knex('clients').where({ id: clientId }).delete();
    await owner.knex('agencies').where({ id: agencyId }).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  const expectDegraded = (outcome: { readonly reply: Reply; readonly photo: unknown; readonly logged: string }, code: string, key: string, status = 200): void => {
    expect(outcome.reply.statusCode).toBe(status);
    expect(outcome.photo).toBeNull();
    // The whole JSON field: a bare substring also matches PORTAL_CLIENT_PHOTO_URL_FAILED.
    expect(outcome.logged).toContain(`"code":"${code}"`);
    expect(outcome.logged).not.toContain(key);
  };

  it('the agency detail answers 200 with photoUrl null and logs CLIENT_PHOTO_URL_FAILED without the key', async () => {
    const outcome = await refused(() => call('GET', agencyClient, adminCookie), (body) => body.photoUrl, photoKey);
    expectDegraded(outcome, 'CLIENT_PHOTO_URL_FAILED', photoKey);
    expect(outcome.reply.json()).toMatchObject({ id: clientId, name: `Photo refused ${clientId}` });
  });

  it('the agency listing answers 200 with the client and photoUrl null', async () => {
    const listing = (): Promise<Reply> => call('GET', `/agencies/${agencyId}/clients`, adminCookie);
    const outcome = await refused(listing, (body) => body.data[0].photoUrl, photoKey);
    expectDegraded(outcome, 'CLIENT_PHOTO_URL_FAILED', photoKey);
    expect(outcome.reply.json().data).toHaveLength(1);
    expect(outcome.reply.json().data[0]).toMatchObject({ id: clientId });
  });

  it('the edit answers 200 with the saved field and photoUrl null', async () => {
    let segment = 0;
    const edit = (): Promise<Reply> => call('PATCH', agencyClient, adminCookie, { segment: `Segmento ${(segment += 1)}` });
    const outcome = await refused(edit, (body) => body.photoUrl, photoKey);
    expectDegraded(outcome, 'CLIENT_PHOTO_URL_FAILED', photoKey);
    expect(outcome.reply.json()).toMatchObject({ segment: 'Segmento 2' });
    await expect(owner.knex('clients').where({ id: clientId }).first('segment')).resolves.toEqual({ segment: 'Segmento 2' });
  });

  it('scheduling the closing date answers 200 with photoUrl null', async () => {
    const outcome = await refused(
      () => call('PUT', `${agencyClient}/closing`, adminCookie, { closingDate: '2099-12-31' }),
      (body) => body.photoUrl,
      photoKey
    );
    expectDegraded(outcome, 'CLIENT_PHOTO_URL_FAILED', photoKey);
    expect(outcome.reply.json()).toMatchObject({ closingDate: '2099-12-31' });
    await owner.knex('clients').where({ id: clientId }).update({ closing_date: null });
  });

  it('the portal read answers 200 with photoUrl null and logs PORTAL_CLIENT_PHOTO_URL_FAILED without the key', async () => {
    const outcome = await refused(() => call('GET', `/clients/${clientId}`, portalCookie), (body) => body.photoUrl, photoKey);
    expectDegraded(outcome, 'PORTAL_CLIENT_PHOTO_URL_FAILED', photoKey);
    expect(outcome.reply.json()).toMatchObject({ id: clientId });
  });

  it('a comment is served with its author and photoUrl null on the agency side, the portal side and a new comment', async () => {
    const agencyComments = `${agencyClient}/threads/${threadId}/comments`;
    const agencyList = await refused(() => call('GET', agencyComments, adminCookie), (body) => body.data[0].author.photoUrl, adminAvatarKey);
    expectDegraded(agencyList, 'CONVERSATION_AUTHOR_PHOTO_URL_FAILED', adminAvatarKey);
    expect(agencyList.reply.json().data[0]).toMatchObject({ body: 'Vamos revisar o branding?', author: { name: 'Adriana Admin', photoUrl: null } });

    const portalList = await refused(() => call('GET', `/clients/${clientId}/threads/${threadId}/comments`, portalCookie), (body) => body.data[0].author.photoUrl, adminAvatarKey);
    expectDegraded(portalList, 'CONVERSATION_AUTHOR_PHOTO_URL_FAILED', adminAvatarKey);
    expect(portalList.reply.json().data[0]).toMatchObject({ body: 'Vamos revisar o branding?', author: { name: 'Adriana Admin', photoUrl: null } });

    const added = await refused(() => call('POST', agencyComments, adminCookie, { body: 'Segue a revisão.' }), (body) => body.author.photoUrl, adminAvatarKey);
    expectDegraded(added, 'CONVERSATION_AUTHOR_PHOTO_URL_FAILED', adminAvatarKey, 201);
    expect(added.reply.json()).toMatchObject({ body: 'Segue a revisão.', author: { name: 'Adriana Admin', photoUrl: null } });
    await expect(owner.knex('client_thread_comments').where({ thread_id: threadId, body: 'Segue a revisão.' })).resolves.toHaveLength(2);
  });
});
