import { randomUUID } from 'node:crypto';

import { PORTAL_MATERIAL_UPLOAD_MAX_BYTES, PORTAL_MATERIAL_UPLOAD_MAX_FILES } from '@ageniza/contracts';
import type { DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { PORTAL_PAUSED_MESSAGE } from './portal-upload-errors.js';
import { portalUploadKeys } from './portal-upload-service.js';
import { createMemoryStorage, type MemoryStorage } from './test-support/memory-storage.js';
import { jpegBytes, mp3Bytes, pngBytes, SAFE_SVG, textBytes, webmBytes } from './test-support/files.js';

// Scope redesign-igual, subtask W12-S1 (decision 2026-11-11, "o cliente envia material pelo portal"): the API of the portal's upload. The
// database refuses who may send, what and how much (migration 20261113000100, proved by its own suite); what is proved here is what the API
// adds: the bytes it reads, the copy it makes, the answers it gives and the ones it never gives. The bucket is a double in memory, so no
// storage needs to be up, and every person is a real login against the real database as `ageniza_app`.
const origin = { origin: TEST_APP_PUBLIC_URL };

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

interface World {
  readonly agency: string;
  readonly client: string;
  readonly thread: string;
  readonly user: TestUserFixture;
  readonly cookie: string;
}

const NEVER_SPOKEN_OF = /plano|cota|armazenamento|cobran|renov|trial|quota|storage|billing|\bplan\b/i;

let owner: DatabaseClient;
let app: TestApp;
let storage: MemoryStorage;

const agencies: string[] = [];
const clients: string[] = [];
const threads: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];
const cookies: Record<string, string> = {};
const users: Record<string, TestUserFixture> = {};

let agencyA: string;
let agencyB: string;
let clientA1: string;
let clientA2: string;
let clientB1: string;
let threadA1: string;
let threadA1Second: string;
let threadA2: string;
let threadB1: string;

// The routes that sign a URL are limited per address: each call comes from an address of its own, except where the limit is the subject.
let addressCounter = 0;
const nextAddress = (): string => {
  addressCounter += 1;
  return `10.${Math.floor(addressCounter / 65_536) % 256}.${Math.floor(addressCounter / 256) % 256}.${addressCounter % 256}`;
};

const call = async (method: 'GET' | 'POST', url: string, cookie: string | undefined, payload?: unknown, address = nextAddress()): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    remoteAddress: address,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const uploadsOf = (client: string, thread: string): string => `/clients/${client}/material-requests/${thread}/uploads`;

const startUpload = (cookie: string | undefined, client: string, thread: string, body: Record<string, unknown> = {}): Promise<Reply> =>
  call('POST', uploadsOf(client, thread), cookie, { fileName: 'foto.png', contentType: 'image/png', declaredSizeBytes: 100, ...body });

const completeUpload = (cookie: string | undefined, client: string, thread: string, assetId: string): Promise<Reply> =>
  call('POST', `${uploadsOf(client, thread)}/${assetId}/complete`, cookie, {});

const listUploads = (cookie: string | undefined, client: string, thread: string, query = ''): Promise<Reply> =>
  call('GET', `${uploadsOf(client, thread)}${query}`, cookie);

const announce = (cookie: string | undefined, client: string, thread: string, assetIds: readonly string[]): Promise<Reply> =>
  call('POST', `${uploadsOf(client, thread)}/announce`, cookie, { assetIds });

const errorOf = (reply: Reply): { code?: string; message?: string; details?: { reason?: string } } => reply.json().error ?? reply.json();

const rowOf = async (assetId: string): Promise<Record<string, unknown>> => (await owner.knex('media_assets').where({ id: assetId }).first()) as Record<string, unknown>;

const eventsOf = async (assetId: string): Promise<Array<{ action: string; actor_user_id: string; agency_id: string }>> =>
  owner.knex('audit.events').where({ target_id: assetId }).orderBy('id').select('action', 'actor_user_id', 'agency_id');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const newUser = async (key: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `portal-upload-${key.toLowerCase()}`, name: `Portal ${key}` });
  userIds.push(user.id);
  users[key] = user;
  cookies[key] = await login(user);
  return user;
};

const newThread = async (client: string): Promise<string> => {
  const id = randomUUID();
  threads.push(id);
  await owner.knex('client_threads').insert({ id, client_id: client, is_material_request: true, title: 'Fotos da equipe', opened_by: users.admin!.id, opened_side: 'agency' });
  await owner.knex('client_thread_comments').insert({ thread_id: id, client_id: client, author_user_id: users.admin!.id, author_side: 'agency', body: 'Envie as fotos' });
  return id;
};

/** An agency, a client, a person of its portal and an open request of its own: the state a test spoils without touching the others. */
const newWorld = async (key: string): Promise<World> => {
  const agency = randomUUID();
  const client = randomUUID();
  agencies.push(agency);
  clients.push(client);
  await owner.knex('agencies').insert({ id: agency, name: `Portal upload ${key} ${agency}`, owner_user_id: null });
  await owner.knex('clients').insert({ id: client, agency_id: agency, name: `Cliente ${key} ${client}` });
  const user = await newUser(key);
  await owner.knex('client_memberships').insert({ client_id: client, user_id: user.id });
  return { agency, client, thread: await newThread(client), user, cookie: cookies[key]! };
};

interface Sent {
  readonly assetId: string;
  readonly stagingKey: string;
  readonly start: Reply;
}

const send = async (cookie: string, client: string, thread: string, bytes: Uint8Array, contentType: string, body: Record<string, unknown> = {}): Promise<Sent> => {
  const start = await startUpload(cookie, client, thread, { fileName: 'arquivo', contentType, declaredSizeBytes: bytes.length, ...body });
  expect(start.statusCode, JSON.stringify(start.json())).toBe(201);
  const stagingKey = storage.keyOfUrl(start.json().upload.url);
  storage.put(stagingKey, bytes, contentType);
  return { assetId: start.json().assetId, stagingKey, start };
};

const sendAndComplete = async (cookie: string, client: string, thread: string, bytes: Uint8Array = pngBytes(), contentType = 'image/png'): Promise<{ sent: Sent; done: Reply }> => {
  const sent = await send(cookie, client, thread, bytes, contentType);
  return { sent, done: await completeUpload(cookie, client, thread, sent.assetId) };
};

/** The key of every signed URL of a response, and the response with the URLs taken out (a signed URL carries its key by nature). */
const withoutUrls = (value: unknown): { keys: string[]; rest: string } => {
  const keys: string[] = [];
  const rest = JSON.stringify(value, (name, inner) => {
    if (name === 'url' && typeof inner === 'string') {
      keys.push(storage.keyOfUrl(inner));
      return undefined;
    }
    return inner;
  });
  return { keys, rest };
};

describe('the portal sends material to a request (decision 2026-11-11)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    storage = createMemoryStorage();
    app = await buildTestApp({ wrapMediaStorage: () => storage });

    const systemRoles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    agencyA = randomUUID();
    agencyB = randomUUID();
    clientA1 = randomUUID();
    clientA2 = randomUUID();
    clientB1 = randomUUID();
    agencies.push(agencyA, agencyB);
    clients.push(clientA1, clientA2, clientB1);

    await newUser('admin');
    await owner.knex('agencies').insert([
      { id: agencyA, name: `Portal upload A ${agencyA}`, owner_user_id: null },
      { id: agencyB, name: `Portal upload B ${agencyB}`, owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert({ agency_id: agencyA, user_id: users.admin!.id, role_id: systemRoles.find((role) => role.key === 'admin')!.id });
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Upload A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Upload A2 ${clientA2}` },
      { id: clientB1, agency_id: agencyB, name: `Upload B1 ${clientB1}` }
    ]);
    for (const key of ['portalOne', 'portalTwo', 'portalOther', 'portalB', 'portalRemoved']) await newUser(key);
    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.portalOne!.id },
      { client_id: clientA1, user_id: users.portalTwo!.id },
      { client_id: clientA1, user_id: users.portalRemoved!.id },
      { client_id: clientA2, user_id: users.portalOther!.id },
      { client_id: clientB1, user_id: users.portalB!.id }
    ]);
    [threadA1, threadA1Second, threadA2, threadB1] = [await newThread(clientA1), await newThread(clientA1), await newThread(clientA2), await newThread(clientB1)];
  });

  afterAll(async () => {
    await owner.knex('audit.events').whereIn('agency_id', agencies).delete();
    await owner.knex('media_assets').whereIn('agency_id', agencies).delete();
    await owner.knex('media_folders').whereIn('client_id', clients).delete();
    await owner.knex('client_thread_comments').whereIn('client_id', clients).delete();
    await owner.knex('client_threads').whereIn('client_id', clients).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', userIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clients).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencies).delete();
    await owner.knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
    await owner.knex('roles').whereIn('id', roleIds).delete();
    await owner.knex('clients').whereIn('id', clients).delete();
    await owner.knex('agencies').whereIn('id', agencies).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    await app.close();
    await owner.close();
  });

  describe('the cycle of one photo', () => {
    it('starts, takes the bytes, copies them to the final key and confirms, with the audit of each step', async () => {
      const started = await startUpload(cookies.portalOne, clientA1, threadA1, { fileName: 'equipe.png', declaredSizeBytes: pngBytes().length });
      expect(started.statusCode).toBe(201);
      const body = started.json();
      expect(body).toMatchObject({ category: 'image', contentType: 'image/png', upload: { type: 'single' } });
      expect(Object.keys(body).sort()).toEqual(['assetId', 'category', 'contentType', 'upload']);
      expect(Object.keys(body.upload).sort()).toEqual(['expiresAt', 'type', 'url']);

      const stagingKey = storage.keyOfUrl(body.upload.url);
      const row = await rowOf(body.assetId);
      expect(row).toMatchObject({
        status: 'pending', uploaded_by_side: 'client', created_by_user_id: users.portalOne!.id, client_id: clientA1, material_request_thread_id: threadA1,
        file_name: 'equipe.png', agency_id: agencyA
      });
      // The two keys the API derives for a file whose list does not carry them are the ones the database wrote.
      expect(row.upload_object_key).toBe(stagingKey);
      const keys = portalUploadKeys(agencyA, body.assetId, 'image/png');
      expect(keys).toEqual({ canonicalKey: row.object_key, stagingKey: row.upload_object_key });
      expect(stagingKey.startsWith('staging/')).toBe(true);

      storage.put(stagingKey, pngBytes(640, 480), 'image/png');
      const done = await completeUpload(cookies.portalOne, clientA1, threadA1, body.assetId);
      expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
      expect(done.json()).toEqual({ assetId: body.assetId, status: 'confirmed', sizeBytes: pngBytes(640, 480).length, contentType: 'image/png' });

      expect(await rowOf(body.assetId)).toMatchObject({ status: 'confirmed', confirmed_content_type: 'image/png', width: 640, height: 480, confirmed_size_bytes: String(pngBytes(640, 480).length) });
      expect(storage.objects.has(keys.canonicalKey)).toBe(true);
      expect(storage.objects.has(keys.stagingKey)).toBe(false);
      expect((await eventsOf(body.assetId)).map(({ action, actor_user_id: actor, agency_id: agency }) => [action, actor, agency])).toEqual([
        ['media.upload_initiated', users.portalOne!.id, agencyA],
        ['media.upload_confirmed', users.portalOne!.id, agencyA]
      ]);
    });

    it('takes an audio recorded in the browser, with its parameter, and the type kept is the one of the bytes', async () => {
      const { sent, done } = await sendAndComplete(cookies.portalOne, clientA1, threadA1, webmBytes(), 'audio/webm;codecs=opus');
      expect(sent.start.json()).toMatchObject({ category: 'audio', contentType: 'audio/webm' });
      expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
      expect(await rowOf(sent.assetId)).toMatchObject({ status: 'confirmed', confirmed_content_type: 'audio/webm', category: 'audio', width: null });
    });

    it('answers the refusals of the database with one answer each, and never in the words of a plan', async () => {
      const refused = async (body: Record<string, unknown>) => startUpload(cookies.portalOne, clientA1, threadA1, body);
      expect(errorOf(await refused({ contentType: 'image/svg+xml' }))).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
      expect((await refused({ contentType: 'image/svg+xml' })).statusCode).toBe(415);
      for (const contentType of ['application/pdf', 'video/mp4', 'text/html']) expect((await refused({ contentType })).statusCode, contentType).toBe(415);
      const tooBig = await refused({ declaredSizeBytes: PORTAL_MATERIAL_UPLOAD_MAX_BYTES + 1 });
      expect(tooBig.statusCode).toBe(413);
      expect(errorOf(tooBig).code).toBe('PAYLOAD_TOO_LARGE');
      expect((await refused({ declaredSizeBytes: 0 })).statusCode).toBe(400);
      expect((await refused({ extra: true })).statusCode).toBe(400);
      expect(JSON.stringify(tooBig.json())).not.toMatch(NEVER_SPOKEN_OF);
    });
  });

  describe('the limit of the URLs a person may ask for', () => {
    it('stops the start and the finish at sixty from one address in a window, and counts them apart', async () => {
      const address = '192.0.2.77';
      const starts: number[] = [];
      for (let attempt = 0; attempt < 61; attempt += 1) starts.push((await call('POST', uploadsOf(clientA1, threadA1), cookies.portalOne, { fileName: 'x', contentType: 'text/html', declaredSizeBytes: 1 }, address)).statusCode);
      expect(starts.slice(0, 60).every((status) => status === 415)).toBe(true);
      expect(starts[60]).toBe(429);
      const finishes: number[] = [];
      for (let attempt = 0; attempt < 61; attempt += 1) finishes.push((await call('POST', `${uploadsOf(clientA1, threadA1)}/${randomUUID()}/complete`, cookies.portalOne, {}, address)).statusCode);
      expect(finishes.slice(0, 60).every((status) => status === 404)).toBe(true);
      expect(finishes[60]).toBe(429);
    });
  });

  describe('the cycle of the agency, which shares the reading of the bytes', () => {
    it('confirms what is what it declared, and turns down and cleans what is not or never came', async () => {
      const agencyStart = (body: Record<string, unknown>) => call('POST', `/agencies/${agencyA}/media/uploads`, cookies.admin, { fileName: 'a.png', contentType: 'image/png', declaredSizeBytes: 100, ...body });
      const agencyFinish = (assetId: string) => call('POST', `/agencies/${agencyA}/media/uploads/${assetId}/complete`, cookies.admin, {});

      const good = await agencyStart({});
      expect(good.statusCode, JSON.stringify(good.json())).toBe(201);
      const goodRow = await rowOf(good.json().assetId);
      storage.put(goodRow.upload_object_key as string, pngBytes(8, 6), 'image/png');
      const confirmed = await agencyFinish(good.json().assetId);
      expect(confirmed.statusCode, JSON.stringify(confirmed.json())).toBe(200);
      expect(await rowOf(good.json().assetId)).toMatchObject({ status: 'confirmed', width: 8, height: 6, uploaded_by_side: 'agency' });
      expect(storage.objects.has(goodRow.object_key as string)).toBe(true);
      expect(storage.objects.has(goodRow.upload_object_key as string)).toBe(false);

      const wrong = await agencyStart({});
      const wrongRow = await rowOf(wrong.json().assetId);
      storage.put(wrongRow.upload_object_key as string, jpegBytes(), 'image/png');
      const mismatch = await agencyFinish(wrong.json().assetId);
      expect([mismatch.statusCode, errorOf(mismatch).details?.reason]).toEqual([422, 'content_type_mismatch']);
      expect(storage.objects.has(wrongRow.object_key as string)).toBe(false);
      expect(storage.objects.has(wrongRow.upload_object_key as string)).toBe(false);

      const missing = await agencyStart({});
      const absent = await agencyFinish(missing.json().assetId);
      expect([absent.statusCode, errorOf(absent).details?.reason]).toEqual([422, 'object_not_found']);
      expect(await rowOf(missing.json().assetId)).toMatchObject({ status: 'rejected', rejected_reason: 'object_not_found' });
    });
  });

  describe('what the bytes say', () => {
    const rejectedWith = async (reply: Reply, assetId: string, reason: string): Promise<void> => {
      expect(reply.statusCode, JSON.stringify(reply.json())).toBe(422);
      expect(errorOf(reply)).toMatchObject({ code: 'UPLOAD_REJECTED', details: { reason } });
      expect(JSON.stringify(reply.json())).not.toMatch(NEVER_SPOKEN_OF);
      expect(await rowOf(assetId)).toMatchObject({ status: 'rejected', rejected_reason: reason });
      const row = await rowOf(assetId);
      expect(storage.objects.has(row.object_key as string)).toBe(false);
      expect(storage.objects.has(row.upload_object_key as string)).toBe(false);
      expect((await eventsOf(assetId)).map((event) => event.action)).toEqual(['media.upload_initiated', 'media.upload_rejected']);
    };

    it('turns down a file whose bytes are not the type it declared, and keeps nothing of it', async () => {
      const sent = await send(cookies.portalOne, clientA1, threadA1, jpegBytes(), 'image/png');
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId), sent.assetId, 'content_type_mismatch');
    });

    it('turns down a file whose stored type is not the declared one, even when the bytes open as the declared type', async () => {
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      storage.put(sent.stagingKey, pngBytes(), 'image/jpeg');
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId), sent.assetId, 'content_type_mismatch');
    });

    it('never takes an SVG: not as a declared type, and not as the bytes of a photo', async () => {
      expect((await startUpload(cookies.portalOne, clientA1, threadA1, { contentType: 'image/svg+xml' })).statusCode).toBe(415);
      const disguised = await send(cookies.portalOne, clientA1, threadA1, textBytes(SAFE_SVG), 'image/png');
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, disguised.assetId), disguised.assetId, 'content_type_mismatch');
      const typed = await send(cookies.portalOne, clientA1, threadA1, textBytes(SAFE_SVG), 'image/png');
      storage.put(typed.stagingKey, textBytes(SAFE_SVG), 'image/svg+xml');
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, typed.assetId), typed.assetId, 'content_type_mismatch');
    });

    it('turns down an object above 25 MiB before it is copied, whatever size was declared', async () => {
      const big = new Uint8Array(PORTAL_MATERIAL_UPLOAD_MAX_BYTES + 1);
      big.set(pngBytes());
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      storage.put(sent.stagingKey, big, 'image/png');
      storage.calls.length = 0;
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId), sent.assetId, 'too_large');
      expect(storage.calls.some((call) => call.startsWith('copy '))).toBe(false);
    });

    it('turns down an object that never came, and an object of no bytes, as an empty one', async () => {
      const missing = await startUpload(cookies.portalOne, clientA1, threadA1, {});
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, missing.json().assetId), missing.json().assetId, 'empty_object');
      const empty = await send(cookies.portalOne, clientA1, threadA1, new Uint8Array(0), 'image/png', { declaredSizeBytes: 1 });
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, empty.assetId), empty.assetId, 'empty_object');
    });

    it('turns down the dimensions of a photo that cannot be one', async () => {
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(0, 0), 'image/png');
      await rejectedWith(await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId), sent.assetId, 'invalid_dimensions');
    });

    it('finishes a file once: a second completion answers that it is not pending, and touches no object', async () => {
      const { sent, done } = await sendAndComplete(cookies.portalOne, clientA1, threadA1);
      expect(done.statusCode).toBe(200);
      storage.calls.length = 0;
      const again = await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId);
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).code).toBe('UPLOAD_NOT_PENDING');
      expect(storage.calls).toEqual([]);
      expect(storage.objects.has(portalUploadKeys(agencyA, sent.assetId, 'image/png').canonicalKey)).toBe(true);
    });

    it('serializes two completions of one file: one confirms, the other answers not pending, and the kept object is never copied twice', async () => {
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      storage.latencyMs = 25;
      storage.calls.length = 0;
      const replies = await Promise.all([
        completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId),
        completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId)
      ]);
      storage.latencyMs = 0;
      expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
      expect(storage.calls.filter((call) => call.startsWith('copy '))).toHaveLength(1);
      expect(storage.objects.has(portalUploadKeys(agencyA, sent.assetId, 'image/png').canonicalKey)).toBe(true);
      expect(await rowOf(sent.assetId)).toMatchObject({ status: 'confirmed' });
    });

    // The delay of the double above lets the second request arrive after the commit of the first; this holds the lock from outside until both
    // wait on it (proved in pg_locks), and the staging stays in the bucket, as it does when its deletion after the commit fails.
    it('rereads the file after the lock: the completion that waited finds it confirmed and never copies over, or deletes, the kept object', async () => {
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      const { canonicalKey } = portalUploadKeys(agencyA, sent.assetId, 'image/png');
      storage.refuseDeleteOf.add(sent.stagingKey);
      storage.calls.length = 0;

      const holder = await owner.knex.transaction();
      let replies: Reply[];
      try {
        await holder.raw("select pg_advisory_xact_lock(hashtextextended('portal-upload-completion:' || ?::text, 0))", [sent.assetId]);
        const pending = Promise.all([
          completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId),
          completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId)
        ]);
        let waiting = 0;
        for (let attempt = 0; attempt < 200 && waiting < 2; attempt += 1) {
          const found = await owner.knex.raw(
            "select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())"
          );
          waiting = (found.rows[0] as { waiting: number }).waiting;
          if (waiting < 2) await new Promise((resolve) => { setTimeout(resolve, 25); });
        }
        expect(waiting).toBe(2);
        await holder.commit();
        replies = await pending;
      } finally {
        if (!holder.isCompleted()) await holder.rollback();
        storage.refuseDeleteOf.clear();
      }

      expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
      expect(storage.objects.has(sent.stagingKey)).toBe(true);
      expect(storage.calls.filter((call) => call.startsWith('copy '))).toHaveLength(1);
      expect(storage.calls).not.toContain(`delete ${canonicalKey}`);
      expect(storage.objects.has(canonicalKey)).toBe(true);
      expect(await rowOf(sent.assetId)).toMatchObject({ status: 'confirmed' });
    });

    it('records the size of the bytes it read, not the one the person declared', async () => {
      const bytes = new Uint8Array(5_000);
      bytes.set(pngBytes());
      const sent = await send(cookies.portalOne, clientA1, threadA1, bytes, 'image/png', { declaredSizeBytes: 1 });
      const done = await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId);
      expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
      expect(done.json().sizeBytes).toBe(5_000);
      expect(await rowOf(sent.assetId)).toMatchObject({ status: 'confirmed', confirmed_size_bytes: '5000' });
      const listed = (await listUploads(cookies.portalOne, clientA1, threadA1)).json().data.find((file: { id: string }) => file.id === sent.assetId);
      expect(listed.sizeBytes).toBe(5_000);
    });

    it('takes an object of exactly 25 MiB and turns down one byte more', async () => {
      const exact = new Uint8Array(PORTAL_MATERIAL_UPLOAD_MAX_BYTES);
      exact.set(pngBytes());
      const taken = await send(cookies.portalOne, clientA1, threadA1, exact, 'image/png');
      const done = await completeUpload(cookies.portalOne, clientA1, threadA1, taken.assetId);
      expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
      expect(done.json().sizeBytes).toBe(PORTAL_MATERIAL_UPLOAD_MAX_BYTES);

      const over = new Uint8Array(PORTAL_MATERIAL_UPLOAD_MAX_BYTES + 1);
      over.set(pngBytes());
      const refused = await send(cookies.portalOne, clientA1, threadA1, over, 'image/png', { declaredSizeBytes: PORTAL_MATERIAL_UPLOAD_MAX_BYTES });
      const answer = await completeUpload(cookies.portalOne, clientA1, threadA1, refused.assetId);
      expect(answer.statusCode).toBe(422);
      expect(errorOf(answer).details?.reason).toBe('too_large');
    });
  });

  describe('hostile input on the new routes', () => {
    const raw = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: string) =>
      app.app.inject({ method, url, remoteAddress: nextAddress(), headers, ...(payload === undefined ? {} : { payload }) });

    it('answers every route with 401 without a session, and with no write accepted from a foreign origin', async () => {
      const id = randomUUID();
      for (const reply of [
        await startUpload(undefined, clientA1, threadA1),
        await completeUpload(undefined, clientA1, threadA1, id),
        await listUploads(undefined, clientA1, threadA1),
        await announce(undefined, clientA1, threadA1, [id])
      ]) expect(reply.statusCode).toBe(401);
      const before = await owner.knex('media_assets').where({ client_id: clientA1 }).count<Array<{ count: string }>>('id');
      const foreign = await raw('POST', uploadsOf(clientA1, threadA1), { origin: 'https://evil.example', cookie: cookies.portalOne!, 'content-type': 'application/json' },
        JSON.stringify({ fileName: 'a.png', contentType: 'image/png', declaredSizeBytes: 100 }));
      expect(foreign.statusCode).toBe(403);
      expect(await owner.knex('media_assets').where({ client_id: clientA1 }).count('id')).toEqual(before);
    });

    it('turns down an extra field, a tenant the person names, a malformed or typed-wrong body and a key, each as a 4xx that echoes nothing', async () => {
      const good = { fileName: 'a.png', contentType: 'image/png', declaredSizeBytes: 100 };
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      const cases: Array<[string, Reply]> = [
        ['extra field', await call('POST', uploadsOf(clientA1, threadA1), cookies.portalOne, { ...good, status: 'confirmed' })],
        ['agency named', await call('POST', uploadsOf(clientA1, threadA1), cookies.portalOne, { ...good, agencyId: agencyB })],
        ['size as text', await call('POST', uploadsOf(clientA1, threadA1), cookies.portalOne, { ...good, declaredSizeBytes: '100' })],
        ['negative size', await call('POST', uploadsOf(clientA1, threadA1), cookies.portalOne, { ...good, declaredSizeBytes: -1 })],
        ['key on complete', await call('POST', `${uploadsOf(clientA1, threadA1)}/${sent.assetId}/complete`, cookies.portalOne, { key: 'staging/x' })],
        ['text on announce', await call('POST', `${uploadsOf(clientA1, threadA1)}/announce`, cookies.portalOne, { assetIds: [sent.assetId], body: 'oi' })],
        ['not a uuid', await call('POST', `${uploadsOf(clientA1, threadA1)}/not-a-uuid/complete`, cookies.portalOne, {})],
        ['malformed json', await raw('POST', uploadsOf(clientA1, threadA1), { ...origin, cookie: cookies.portalOne!, 'content-type': 'application/json' }, '{"fileName": ') as unknown as Reply],
        ['text body', await raw('POST', uploadsOf(clientA1, threadA1), { ...origin, cookie: cookies.portalOne!, 'content-type': 'text/plain' }, 'hello') as unknown as Reply]
      ];
      for (const [name, reply] of cases) {
        expect(reply.statusCode, name).toBeGreaterThanOrEqual(400);
        expect(reply.statusCode, name).toBeLessThan(500);
        expect(JSON.stringify(reply.json()), name).not.toMatch(/hello|evil|staging\/|fileName": $/);
      }
      expect(await rowOf(sent.assetId)).toMatchObject({ status: 'pending' });
      expect(await owner.knex('media_assets').where({ agency_id: agencyB }).count('id')).toEqual([{ count: '0' }]);
    });

    it('answers a hostile page, page size or query as a 400, never as a 5xx', async () => {
      for (const query of ['?page=1e20', '?page=-1', '?page=0', '?pageSize=0', '?pageSize=abc', '?pageSize=100000', '?key=staging/x', '?page=1&page=2']) {
        const reply = await listUploads(cookies.portalOne, clientA1, threadA1, query);
        expect(reply.statusCode, query).toBeLessThan(500);
        expect(JSON.stringify(reply.json()), query).not.toMatch(/staging\/|object_key/);
      }
      expect((await listUploads(cookies.portalOne, clientA1, threadA1, '?pageSize=0')).statusCode).toBe(400);
      expect((await listUploads(cookies.portalOne, clientA1, threadA1, '?page=1e20')).statusCode).toBe(400);
    });
  });

  describe('who reads and who finishes what', () => {
    it('signs the read URL of a listed audio as a download of the type the server confirmed', async () => {
      const thread = await newThread(clientA1);
      const { sent, done } = await sendAndComplete(cookies.portalOne, clientA1, thread, mp3Bytes(), 'audio/mpeg');
      expect(done.statusCode).toBe(200);
      const listed = (await listUploads(cookies.portalOne, clientA1, thread)).json().data.find((file: { id: string }) => file.id === sent.assetId);
      expect(new URL(listed.url).searchParams.get('disposition')).toMatch(/^attachment; filename="/);
    });

    it('lists only the files the person sent to this request, with a read URL that reaches only those, and never a key', async () => {
      const mine = await sendAndComplete(cookies.portalTwo, clientA1, threadA1Second);
      const pending = await send(cookies.portalTwo, clientA1, threadA1Second, mp3Bytes(), 'audio/mpeg');
      const others = await sendAndComplete(cookies.portalOne, clientA1, threadA1Second);
      expect(mine.done.statusCode).toBe(200);
      expect(others.done.statusCode).toBe(200);

      const listed = await listUploads(cookies.portalTwo, clientA1, threadA1Second);
      expect(listed.statusCode, JSON.stringify(listed.json())).toBe(200);
      const body = listed.json();
      expect(body.meta).toMatchObject({ totalItems: 2 });
      expect(body.data.map((file: { id: string }) => file.id)).toEqual([mine.sent.assetId, pending.assetId]);
      expect(body.data[0]).toMatchObject({ status: 'confirmed', category: 'image', contentType: 'image/png', name: 'arquivo' });
      expect(body.data[1]).toMatchObject({ status: 'pending', category: 'audio', url: null });
      for (const file of body.data) expect(Object.keys(file).sort()).toEqual(['category', 'contentType', 'createdAt', 'height', 'id', 'name', 'sizeBytes', 'status', 'url', 'width']);

      const { keys, rest } = withoutUrls(body);
      const mineRow = await rowOf(mine.sent.assetId);
      expect(keys).toEqual([mineRow.object_key]);
      const reachable = await owner.knex('media_assets').whereIn('object_key', keys).select('created_by_user_id', 'client_id');
      expect(reachable).toEqual([{ created_by_user_id: users.portalTwo!.id, client_id: clientA1 }]);
      for (const secret of [mineRow.object_key, mineRow.upload_object_key, agencyA, 'staging/', 'multipart', 'object_key', 'objectKey']) expect(rest, String(secret)).not.toContain(String(secret));
      expect(await listUploads(cookies.portalTwo, clientA1, threadA1)).toMatchObject({ statusCode: 200 });
      expect((await listUploads(cookies.portalTwo, clientA1, threadA1)).json().data.map((file: { id: string }) => file.id)).not.toContain(mine.sent.assetId);
    });

    it('answers a page past the end, and a request with no file, with the total alone', async () => {
      const empty = await newThread(clientA1);
      const none = await listUploads(cookies.portalOne, clientA1, empty);
      expect(none.json()).toMatchObject({ data: [], meta: { totalItems: 0 } });
      const past = await listUploads(cookies.portalOne, clientA1, threadA1Second, '?page=50&pageSize=10');
      expect(past.statusCode).toBe(200);
      expect(past.json()).toMatchObject({ data: [], meta: { page: 50, totalItems: 1 } });
      expect((await listUploads(cookies.portalOne, clientA1, threadA1Second, '?page=9007199254740991&pageSize=100')).statusCode).toBe(200);
    });

    it('lets another person of the same client neither finish the file nor see it', async () => {
      const sent = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      storage.calls.length = 0;
      const stolen = await completeUpload(cookies.portalTwo, clientA1, threadA1, sent.assetId);
      expect(stolen.statusCode).toBe(404);
      expect(errorOf(stolen).code).toBe('NOT_FOUND');
      expect(storage.calls).toEqual([]);
      expect(await rowOf(sent.assetId)).toMatchObject({ status: 'pending' });
      expect(storage.objects.has(sent.stagingKey)).toBe(true);
      expect((await listUploads(cookies.portalTwo, clientA1, threadA1)).json().data.map((file: { id: string }) => file.id)).not.toContain(sent.assetId);
      expect((await completeUpload(cookies.portalOne, clientA1, threadA1, sent.assetId)).statusCode).toBe(200);
    });

    it('treats a person of another client, of the same agency or of another one, as one who is not there, and writes nothing', async () => {
      const before = Number((await owner.knex('media_assets').count<{ count: string }[]>('id as count'))[0]!.count);
      const mine = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      for (const [who, client, thread] of [
        ['portalOther', clientA1, threadA1], ['portalB', clientA1, threadA1], ['portalOther', clientA2, threadA1], ['portalB', clientB1, threadA1], ['portalOne', clientA1, threadA2]
      ] as const) {
        const label = `${who} on ${client} / ${thread}`;
        for (const reply of [
          await startUpload(cookies[who], client, thread),
          await completeUpload(cookies[who], client, thread, mine.assetId),
          await listUploads(cookies[who], client, thread),
          await announce(cookies[who], client, thread, [mine.assetId])
        ]) {
          expect(reply.statusCode, label).toBe(404);
          expect(errorOf(reply).code, label).toBe('NOT_FOUND');
        }
      }
      expect(Number((await owner.knex('media_assets').count<{ count: string }[]>('id as count'))[0]!.count)).toBe(before + 1);
      expect(await rowOf(mine.assetId)).toMatchObject({ status: 'pending' });
      expect((await completeUpload(cookies.portalOne, clientA1, threadA1, mine.assetId)).statusCode).toBe(200);
    });

    it('answers the same for a request that is not one of material, an id that is nothing, and a request of another client', async () => {
      const conversation = randomUUID();
      threads.push(conversation);
      await owner.knex('client_threads').insert({ id: conversation, client_id: clientA1, section_key: 'branding', opened_by: users.admin!.id, opened_side: 'agency' });
      const replies = [
        await startUpload(cookies.portalOne, clientA1, conversation),
        await startUpload(cookies.portalOne, clientA1, randomUUID()),
        await startUpload(cookies.portalOne, clientA1, threadB1),
        await completeUpload(cookies.portalOne, clientA1, threadA1, randomUUID())
      ];
      for (const reply of replies) expect([reply.statusCode, errorOf(reply).code, errorOf(reply).message]).toEqual([404, 'NOT_FOUND', 'Pedido não encontrado.']);
      expect((await startUpload(undefined, clientA1, threadA1)).statusCode).toBe(401);
    });

    it('lets the agency read what the client sent in its library, marked as the client\'s, and finish none of it', async () => {
      const { sent, done } = await sendAndComplete(cookies.portalOne, clientA1, threadA1);
      expect(done.statusCode).toBe(200);
      const library = await call('GET', `/agencies/${agencyA}/clients/${clientA1}/media`, cookies.admin);
      expect(library.statusCode, JSON.stringify(library.json())).toBe(200);
      const files = library.json().data as Array<{ id: string; uploadedBySide: string; folderName: string }>;
      expect(files.find((file) => file.id === sent.assetId)).toMatchObject({ uploadedBySide: 'client', folderName: 'Enviados pelo cliente' });
    });

    it('refuses the agency the finish and the parts of a reservation of the client, with the answer of a file that is not there', async () => {
      const pending = await send(cookies.portalOne, clientA1, threadA1, pngBytes(), 'image/png');
      storage.calls.length = 0;
      const finish = await call('POST', `/agencies/${agencyA}/media/uploads/${pending.assetId}/complete`, cookies.admin, {});
      const parts = await call('POST', `/agencies/${agencyA}/media/uploads/${pending.assetId}/parts`, cookies.admin, { partNumbers: [1] });
      const unknown = await call('POST', `/agencies/${agencyA}/media/uploads/${randomUUID()}/complete`, cookies.admin, {});
      expect([finish.statusCode, parts.statusCode, unknown.statusCode]).toEqual([404, 404, 404]);
      expect(errorOf(finish)).toEqual(errorOf(unknown));
      expect(storage.calls).toEqual([]);
      expect(await rowOf(pending.assetId)).toMatchObject({ status: 'pending' });
      expect(storage.objects.has(pending.stagingKey)).toBe(true);
      expect((await completeUpload(cookies.portalOne, clientA1, threadA1, pending.assetId)).statusCode).toBe(200);
    });
  });

  describe('when the person, the request or the agency cannot take it', () => {
    it('refuses a resolved request at the start and at the finish, and keeps the reservation', async () => {
      const world = await newWorld('resolved');
      const before = await send(world.cookie, world.client, world.thread, pngBytes(), 'image/png');
      await owner.knex('client_threads').where({ id: world.thread }).update({ resolved_at: new Date(), resolved_by: users.admin!.id });

      const start = await startUpload(world.cookie, world.client, world.thread);
      expect([start.statusCode, errorOf(start).code]).toEqual([409, 'REQUEST_RESOLVED']);
      const finish = await completeUpload(world.cookie, world.client, world.thread, before.assetId);
      expect([finish.statusCode, errorOf(finish).code]).toEqual([409, 'REQUEST_RESOLVED']);
      expect(await rowOf(before.assetId)).toMatchObject({ status: 'pending' });
      expect(storage.objects.has(portalUploadKeys(world.agency, before.assetId, 'image/png').canonicalKey)).toBe(false);
    });

    it('refuses a person whose link was removed, an archived client and a suspended agency as a request that is not there', async () => {
      const gone = await newWorld('removed');
      const pending = await send(gone.cookie, gone.client, gone.thread, pngBytes(), 'image/png');
      await owner.knex.transaction(async (transaction) => {
        await transaction('client_portal_accesses').where({ client_id: gone.client, user_id: gone.user.id }).update({ status: 'removed', generation: transaction.raw('generation + 1') });
        await transaction('client_memberships').where({ client_id: gone.client, user_id: gone.user.id }).update({ status: 'removed' });
      });
      for (const reply of [await startUpload(gone.cookie, gone.client, gone.thread), await completeUpload(gone.cookie, gone.client, gone.thread, pending.assetId), await listUploads(gone.cookie, gone.client, gone.thread)]) {
        expect([reply.statusCode, errorOf(reply).code]).toEqual([404, 'NOT_FOUND']);
      }

      const archived = await newWorld('archived');
      const archivedPending = await send(archived.cookie, archived.client, archived.thread, pngBytes(), 'image/png');
      await owner.knex('clients').where({ id: archived.client }).update({ status: 'archived', archived_at: new Date() });
      for (const reply of [await startUpload(archived.cookie, archived.client, archived.thread), await completeUpload(archived.cookie, archived.client, archived.thread, archivedPending.assetId)]) {
        expect(reply.statusCode).toBe(404);
      }

      const suspended = await newWorld('suspended');
      const suspendedPending = await send(suspended.cookie, suspended.client, suspended.thread, pngBytes(), 'image/png');
      await owner.knex('agencies').where({ id: suspended.agency }).update({ status: 'suspended' });
      for (const reply of [await startUpload(suspended.cookie, suspended.client, suspended.thread), await completeUpload(suspended.cookie, suspended.client, suspended.thread, suspendedPending.assetId)]) {
        expect(reply.statusCode).toBe(404);
      }
      for (const asset of [pending, archivedPending, suspendedPending]) expect(await rowOf(asset.assetId)).toMatchObject({ status: 'pending' });
    });

    it('answers a read-only agency in the words of the portal, never in the trial\'s, at the start, at the finish and at the announcement', async () => {
      const world = await newWorld('readonly');
      const confirmed = await sendAndComplete(world.cookie, world.client, world.thread);
      expect(confirmed.done.statusCode).toBe(200);
      const pending = await send(world.cookie, world.client, world.thread, pngBytes(), 'image/png');
      await owner.knex('agencies').where({ id: world.agency }).update({
        plan: 'trial', trial_ends_at: owner.knex.raw("now() - interval '1 minute'"), trial_owner_email_key: owner.knex.raw('coalesce(trial_owner_email_key, id::text)')
      });
      const comments = Number((await owner.knex('client_thread_comments').where({ thread_id: world.thread }).count<{ count: string }[]>('id as count'))[0]!.count);
      for (const reply of [
        await startUpload(world.cookie, world.client, world.thread),
        await completeUpload(world.cookie, world.client, world.thread, pending.assetId),
        await announce(world.cookie, world.client, world.thread, [confirmed.sent.assetId])
      ]) {
        expect([reply.statusCode, errorOf(reply).code, errorOf(reply).message]).toEqual([409, 'AGENCY_READ_ONLY', PORTAL_PAUSED_MESSAGE]);
        expect(JSON.stringify(reply.json())).not.toMatch(NEVER_SPOKEN_OF);
      }
      expect(Number((await owner.knex('client_thread_comments').where({ thread_id: world.thread }).count<{ count: string }[]>('id as count'))[0]!.count)).toBe(comments);
      expect(await rowOf(pending.assetId)).toMatchObject({ status: 'pending' });
      expect((await listUploads(world.cookie, world.client, world.thread)).statusCode).toBe(200);
    });

    it('answers an agency with no room as neutral, at the start and at the finish, and never says why', async () => {
      const world = await newWorld('noroom');
      const pending = await send(world.cookie, world.client, world.thread, pngBytes(), 'image/png');
      await owner.knex.raw('insert into public.agency_storage_quotas (agency_id, quota_bytes, quota_object_count) values (?::uuid, ?::bigint, ?::bigint)', [world.agency, 1_000_000, 100]);

      const start = await startUpload(world.cookie, world.client, world.thread);
      expect([start.statusCode, errorOf(start).code, errorOf(start).message]).toEqual([409, 'UPLOAD_UNAVAILABLE', PORTAL_PAUSED_MESSAGE]);
      const finish = await completeUpload(world.cookie, world.client, world.thread, pending.assetId);
      expect(finish.statusCode).toBe(422);
      expect(errorOf(finish)).toMatchObject({ code: 'UPLOAD_REJECTED', details: { reason: 'agency_unavailable' } });
      for (const reply of [start, finish]) expect(JSON.stringify(reply.json())).not.toMatch(NEVER_SPOKEN_OF);
      expect(await rowOf(pending.assetId)).toMatchObject({ status: 'rejected', rejected_reason: 'agency_unavailable' });
      expect(storage.objects.has(portalUploadKeys(world.agency, pending.assetId, 'image/png').canonicalKey)).toBe(false);
      expect(storage.objects.has(pending.stagingKey)).toBe(false);
    });

    it('takes twenty files a request and answers the twenty-first as full', async () => {
      const world = await newWorld('full');
      for (let count = 0; count < PORTAL_MATERIAL_UPLOAD_MAX_FILES; count += 1) {
        expect((await sendAndComplete(world.cookie, world.client, world.thread)).done.statusCode, `file ${count}`).toBe(200);
      }
      const extra = await startUpload(world.cookie, world.client, world.thread);
      expect([extra.statusCode, errorOf(extra).code]).toEqual([409, 'REQUEST_FULL']);
    });
  });

  describe('the announcement of a batch', () => {
    it('writes one comment of the client, worded by the server from what she confirmed', async () => {
      const world = await newWorld('announce');
      const photos = [await sendAndComplete(world.cookie, world.client, world.thread), await sendAndComplete(world.cookie, world.client, world.thread, jpegBytes(), 'image/jpeg')];
      const audio = await sendAndComplete(world.cookie, world.client, world.thread, webmBytes(), 'audio/webm');
      const ids = [...photos, audio].map(({ sent }) => sent.assetId);
      const before = Number((await owner.knex('client_thread_comments').where({ thread_id: world.thread }).count<{ count: string }[]>('id as count'))[0]!.count);

      const done = await announce(world.cookie, world.client, world.thread, ids);
      expect(done.statusCode, JSON.stringify(done.json())).toBe(201);
      expect(done.json()).toMatchObject({ body: 'enviou 2 fotos e 1 áudio', side: 'client', author: { name: world.user.name } });
      const written = await owner.knex('client_thread_comments').where({ thread_id: world.thread }).orderBy('created_at', 'desc').first();
      expect(written).toMatchObject({ body: 'enviou 2 fotos e 1 áudio', author_side: 'client', author_user_id: world.user.id });
      expect(Number((await owner.knex('client_thread_comments').where({ thread_id: world.thread }).count<{ count: string }[]>('id as count'))[0]!.count)).toBe(before + 1);

      const single = await announce(world.cookie, world.client, world.thread, [ids[2]!]);
      expect(single.json()).toMatchObject({ body: 'enviou 1 áudio' });
    });

    it('answers the same 404 for an id that is another person\'s, pending, of another request or nothing, and writes no comment', async () => {
      const world = await newWorld('announce-attack');
      const second = await newThread(world.client);
      const other = await newUser('announceOther');
      await owner.knex('client_memberships').insert({ client_id: world.client, user_id: other.id });
      const mine = await sendAndComplete(world.cookie, world.client, world.thread);
      const pending = await send(world.cookie, world.client, world.thread, pngBytes(), 'image/png');
      const theirs = await sendAndComplete(cookies.announceOther!, world.client, world.thread);
      const elsewhere = await sendAndComplete(world.cookie, world.client, second);
      const rejected = await send(world.cookie, world.client, world.thread, jpegBytes(), 'image/png');
      await completeUpload(world.cookie, world.client, world.thread, rejected.assetId);
      const before = Number((await owner.knex('client_thread_comments').where({ client_id: world.client }).count<{ count: string }[]>('id as count'))[0]!.count);

      const replies: Reply[] = [];
      for (const bad of [theirs.sent.assetId, pending.assetId, elsewhere.sent.assetId, randomUUID(), rejected.assetId]) {
        replies.push(await announce(world.cookie, world.client, world.thread, [mine.sent.assetId, bad]));
        replies.push(await announce(world.cookie, world.client, world.thread, [bad]));
      }
      for (const reply of replies) expect([reply.statusCode, errorOf(reply).code, errorOf(reply).message]).toEqual([404, 'NOT_FOUND', 'Pedido não encontrado.']);
      expect(Number((await owner.knex('client_thread_comments').where({ client_id: world.client }).count<{ count: string }[]>('id as count'))[0]!.count)).toBe(before);
    });

    it('refuses an empty list, a repeated id, more than twenty and a text of the client\'s own, before anything is read', async () => {
      const world = await newWorld('announce-shape');
      const done = await sendAndComplete(world.cookie, world.client, world.thread);
      const id = done.sent.assetId;
      const many = Array.from({ length: 21 }, () => randomUUID());
      for (const body of [{ assetIds: [] }, { assetIds: [id, id] }, { assetIds: many }, { assetIds: [id], body: 'enviou 99 fotos' }, { assetIds: ['x'] }, {}]) {
        expect((await call('POST', `${uploadsOf(world.client, world.thread)}/announce`, world.cookie, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
    });

    it('refuses a request that was resolved after the files were sent', async () => {
      const world = await newWorld('announce-resolved');
      const done = await sendAndComplete(world.cookie, world.client, world.thread);
      await owner.knex('client_threads').where({ id: world.thread }).update({ resolved_at: new Date(), resolved_by: users.admin!.id });
      const reply = await announce(world.cookie, world.client, world.thread, [done.sent.assetId]);
      expect([reply.statusCode, errorOf(reply).code]).toEqual([409, 'REQUEST_RESOLVED']);
    });
  });
});
