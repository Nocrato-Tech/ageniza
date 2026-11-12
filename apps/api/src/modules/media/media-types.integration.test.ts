import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  TEST_STORAGE_CONFIG,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { MEDIA_AUDIO_MAX_BYTES, MEDIA_PDF_MAX_BYTES } from './policy.js';
import { createMediaStorageClient } from './storage-client.js';
import { SVG_MAX_BYTES } from './svg-guard.js';
import {
  gifBytes,
  jpegBytes,
  m4aBytes,
  mp3Bytes,
  oggBytes,
  pdfBytes,
  pngBytes,
  SAFE_SVG,
  textBytes,
  wavBytes,
  webmBytes,
  webpBytes
} from './test-support/files.js';

// Decision 2026-11-11 "a mídia aceita PDF, áudio e SVG como logo": what the library accepts is checked by the bytes at the confirmation
// of the upload, and what must never open as a page is served as a download of the type the server confirmed. Everything runs through
// the real routes and the real bucket (LocalStack); a refusal is shown by the row it leaves and by the object that is no longer there.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
const storage = createMediaStorageClient(TEST_STORAGE_CONFIG);

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};
const plantedKeys: string[] = [];

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST', url: string, as?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(as === undefined ? {} : { cookie: cookies[as]! }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const folderOf = async (clientId: string, name = 'Imagens'): Promise<string> =>
  (await owner.knex('media_folders').where({ client_id: clientId, name, is_default: true }).first('id')).id as string;

interface UploadInput {
  readonly as?: string;
  readonly agencyId?: string;
  readonly clientId?: string | null;
  readonly folderId?: string;
  readonly fileName?: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly asLogo?: boolean;
  readonly declaredSizeBytes?: number;
}

interface UploadResult {
  readonly created: Reply;
  readonly assetId: string | undefined;
  readonly objectKey: string | undefined;
  readonly completed: Reply | undefined;
}

/** The three steps of the browser: ask for the URL, put the bytes, confirm. Stops where the server stops it. */
const upload = async (input: UploadInput): Promise<UploadResult> => {
  const agencyId = input.agencyId ?? agencyA;
  const clientId = input.clientId === undefined ? clientA : input.clientId;
  const created = await call('POST', `/agencies/${agencyId}/media/uploads`, input.as ?? 'opVis', {
    fileName: input.fileName ?? 'arquivo.bin',
    contentType: input.contentType,
    declaredSizeBytes: input.declaredSizeBytes ?? input.bytes.length,
    ...(input.asLogo === undefined ? {} : { asLogo: input.asLogo }),
    ...(clientId === null ? {} : { clientId, folderId: input.folderId ?? await folderOf(clientId) })
  });
  if (created.statusCode !== 201) return { created, assetId: undefined, objectKey: undefined, completed: undefined };

  const put = await fetch(created.json().upload.url as string, { method: 'PUT', body: input.bytes, headers: { 'content-type': input.contentType } });
  expect(put.ok).toBe(true);
  const completed = await call('POST', `/agencies/${agencyId}/media/uploads/${created.json().assetId as string}/complete`, input.as ?? 'opVis', {});
  return { created, assetId: created.json().assetId as string, objectKey: created.json().objectKey as string, completed };
};

// The URLs of an upload are limited per address (60 in 15 minutes): each group of tests starts with an application whose count is zero.
const withFreshLimiter = (): void => {
  beforeAll(async () => {
    const previous = app;
    app = await buildTestApp();
    await previous.close();
  });
};

const row = async (assetId: string): Promise<Record<string, unknown>> =>
  (await owner.knex('media_assets').where({ id: assetId }).first()) as Record<string, unknown>;

const rowCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('media_assets').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count);

const exists = async (key: string): Promise<boolean> => (await storage.headObject({ key })) !== undefined;

/** Puts an object in the bucket straight away, with the stored type of the caller's choice: what a hole in the guard would leave there. */
const plantObject = async (key: string, contentType: string, bytes: Uint8Array): Promise<void> => {
  plantedKeys.push(key);
  const url = await storage.presignPutObject({ key, contentType, expiresInSeconds: 300 });
  const put = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
  expect(put.ok).toBe(true);
};

const seedConfirmed = async (input: { category: 'pdf' | 'audio' | 'logo' | 'image'; contentType: string; extension: string; name: string | null; bytes: Uint8Array; storedType: string }): Promise<string> => {
  const id = randomUUID();
  const objectKey = `${agencyA}/${id}/original.${input.extension}`;
  await plantObject(objectKey, input.storedType, input.bytes);
  await owner.knex('media_assets').insert({
    id,
    agency_id: agencyA,
    client_id: clientA,
    folder_id: await folderOf(clientA),
    category: input.category,
    declared_content_type: input.contentType,
    extension: input.extension,
    file_name: input.name,
    object_key: objectKey,
    upload_object_key: `staging/${agencyA}/${id}/upload.${input.extension}`,
    declared_size_bytes: input.bytes.length,
    created_by_user_id: users.owner!.id,
    status: 'confirmed',
    confirmed_size_bytes: input.bytes.length,
    confirmed_content_type: input.contentType,
    confirmed_at: new Date()
  });
  return id;
};

const signedGet = async (assetId: string, variant = 'original'): Promise<Response> => {
  const reply = await call('GET', `/agencies/${agencyA}/media/${assetId}/download-url?variant=${variant}`, 'opVis');
  expect(reply.statusCode).toBe(200);
  return fetch(reply.json().url as string);
};

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();

  for (const key of ['owner', 'ownerB', 'opVis', 'onlyOperar', 'onlyMidia']) {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `types-${key.toLowerCase()}`, name: key });
    userIds.push(user.id);
    users[key] = user;
  }
  await owner.knex('agencies').insert([
    { id: agencyA, name: `Types A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Types B ${agencyB}`, owner_user_id: users.ownerB!.id }
  ]);
  await owner.knex('clients').insert([
    { id: clientA, agency_id: agencyA, name: `Cliente A ${clientA}` },
    { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
    { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` }
  ]);
  const customRole = async (...permissions: string[]): Promise<string> => {
    const id = randomUUID();
    roleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
    await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
    return id;
  };
  await owner.knex('agency_memberships').insert([
    { agency_id: agencyA, user_id: users.opVis!.id, role_id: await customRole('conteudo.operar', 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.onlyOperar!.id, role_id: await customRole('conteudo.operar') },
    { agency_id: agencyA, user_id: users.onlyMidia!.id, role_id: await customRole('midia.enviar') }
  ]);
  for (const key of Object.keys(users)) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode).toBe(200);
    cookies[key] = response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }
}, 60_000);

afterAll(async () => {
  const agencies = [agencyA, agencyB];
  const clients = [clientA, clientA2, clientB];
  const keys = await owner.knex('media_assets').whereIn('agency_id', agencies).select('object_key', 'upload_object_key');
  for (const key of [...plantedKeys, ...keys.flatMap((item: { object_key: string; upload_object_key: string }) => [item.object_key, item.upload_object_key])]) {
    await storage.deleteObject({ key }).catch(() => undefined);
  }
  await owner.knex('audit.events').whereIn('agency_id', agencies).delete();
  await owner.knex('media_assets').whereIn('agency_id', agencies).delete();
  await owner.knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
  await owner.knex('media_folders').whereIn('client_id', clients).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', agencies).delete();
  await owner.knex('clients').whereIn('id', clients).delete();
  await owner.knex('role_permissions').whereIn('role_id', roleIds).delete();
  await owner.knex('roles').whereIn('id', roleIds).delete();
  await owner.knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', agencies).delete();
  await owner.knex('auth.user').whereIn('id', userIds).delete();
  await app.close();
  await owner.close();
});

describe('a file the library accepts, confirmed by its bytes', () => {
  withFreshLimiter();

  it.each([
    ['a PNG', 'image/png', 'image', pngBytes(3024, 4032), false, { width: 3024, height: 4032 }],
    ['a JPEG', 'image/jpeg', 'image', jpegBytes(4000, 3000), false, { width: 4000, height: 3000 }],
    ['a WebP', 'image/webp', 'image', webpBytes('lossy', 800, 600), false, { width: 800, height: 600 }],
    ['a GIF', 'image/gif', 'image', gifBytes(32, 16), false, { width: 32, height: 16 }],
    ['a PNG the agency marks as a logo', 'image/png', 'logo', pngBytes(512, 256), true, { width: 512, height: 256 }],
    ['an SVG, as a logo', 'image/svg+xml', 'logo', textBytes(SAFE_SVG), true, { width: null, height: null }],
    ['a PDF', 'application/pdf', 'pdf', pdfBytes(), false, { width: null, height: null }],
    ['an MP3', 'audio/mpeg', 'audio', mp3Bytes(), false, { width: null, height: null }],
    ['an M4A', 'audio/mp4', 'audio', m4aBytes(), false, { width: null, height: null }],
    ['a WAV', 'audio/wav', 'audio', wavBytes(), false, { width: null, height: null }],
    ['an Ogg', 'audio/ogg', 'audio', oggBytes(), false, { width: null, height: null }],
    ['a recording of the browser', 'audio/webm;codecs=opus', 'audio', webmBytes(), false, { width: null, height: null }]
  ] as const)('confirms %s in its category, with the dimensions its header gives and the name it was sent with', async (_label, contentType, category, bytes, asLogo, dimensions) => {
    const { created, assetId, objectKey, completed } = await upload({ contentType, bytes, asLogo, fileName: `Relatório (v2) ${category}.bin` });

    expect(created.statusCode).toBe(201);
    expect(created.json().category).toBe(category);
    expect(completed?.statusCode).toBe(200);
    const stored = contentType.split(';')[0];
    expect(completed?.json()).toMatchObject({ assetId, status: 'confirmed', sizeBytes: bytes.length, contentType: stored });
    // The key never carries the name: it is the agency, the asset and the fixed extension of the type.
    expect(objectKey).toMatch(new RegExp(`^${agencyA}/${assetId}/original\\.[a-z0-9]{3,4}$`));
    expect(await row(assetId!)).toMatchObject({
      status: 'confirmed',
      category,
      confirmed_content_type: stored,
      file_name: `Relatório (v2) ${category}.bin`,
      ...dimensions
    });
    expect(await exists(objectKey!)).toBe(true);

    const detail = await call('GET', `/agencies/${agencyA}/clients/${clientA}/media/${assetId}`, 'opVis');
    expect(detail.json()).toMatchObject({ category, contentType: stored, name: `Relatório (v2) ${category}.bin`, width: dimensions.width, height: dimensions.height });
  });

  it('keeps a video as it was: no dimensions yet, for the worker to write', async () => {
    const { completed, assetId } = await upload({ contentType: 'video/mp4', bytes: textBytes('a video the worker will read') });

    expect(completed?.statusCode).toBe(200);
    expect(await row(assetId!)).toMatchObject({ category: 'video', width: null, height: null });
    await owner.knex.raw("delete from pgboss.job where name = 'media.process-video' and data->>'assetId' = ?", [assetId]);
  });

  it('makes the folder the file went into the one in use now, which a rejected upload does not', async () => {
    const folder = async (name: string): Promise<string> => {
      const id = randomUUID();
      await owner.knex('media_folders').insert({ id, client_id: clientA2, parent_id: null, name, is_default: false });
      return id;
    };
    const inUseNow = async (): Promise<string[]> => {
      const summary = await call('GET', `/agencies/${agencyA}/clients/${clientA2}/media-folders/summary`, 'opVis');
      expect(summary.statusCode).toBe(200);
      return summary.json().data.filter((item: { inUseNow: boolean }) => item.inUseNow).map((item: { name: string }) => item.name);
    };
    const rejected = await folder('Rejeitada');
    const accepted = await folder('Aceita');

    const refused = await upload({ clientId: clientA2, folderId: rejected, contentType: 'image/png', bytes: textBytes('<script>alert(1)</script>') });
    expect(refused.completed?.statusCode).toBe(422);
    expect(await inUseNow()).toEqual([]);

    const sent = await upload({ clientId: clientA2, folderId: accepted, contentType: 'image/png', bytes: pngBytes(40, 30) });
    expect(sent.completed?.statusCode).toBe(200);
    expect(await inUseNow()).toEqual(['Aceita']);
  });
});

describe('a type the library does not accept, or accepts only as something else', () => {
  withFreshLimiter();

  it('refuses with 415, creating no file and no URL, what is not on the list', async () => {
    const before = await rowCount(clientA);
    for (const contentType of ['text/html', 'application/octet-stream', 'application/x-msdownload', 'application/javascript', 'image/svg', 'image/heic', 'image/bmp', 'audio/flac', 'application/zip', 'constructor', '__proto__', 'text/html;image/png']) {
      const { created } = await upload({ contentType, bytes: textBytes('x') });
      expect({ contentType, status: created.statusCode, code: created.json().error?.code }).toEqual({ contentType, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    expect(await rowCount(clientA)).toBe(before);
  });

  it('accepts an SVG only as a logo, and a GIF, a video, a PDF and an audio never as one', async () => {
    const before = await rowCount(clientA);
    const refused: [string, boolean | undefined][] = [
      ['image/svg+xml', undefined], ['image/svg+xml', false], ['image/gif', true], ['video/mp4', true], ['application/pdf', true], ['audio/mpeg', true]
    ];
    for (const [contentType, asLogo] of refused) {
      const { created } = await upload({ contentType, asLogo, bytes: textBytes('x') });
      expect({ contentType, asLogo, status: created.statusCode }).toEqual({ contentType, asLogo, status: 415 });
    }
    expect(await rowCount(clientA)).toBe(before);
  });

  it('gives a PDF, an audio and a logo no home outside the library of a client', async () => {
    const before = Number((await owner.knex('media_assets').where({ agency_id: agencyA }).whereNull('client_id').count<{ count: string }[]>('id as count'))[0]?.count);
    for (const [contentType, asLogo] of [['application/pdf', false], ['audio/mpeg', false], ['image/svg+xml', true], ['image/png', true]] as const) {
      const { created } = await upload({ as: 'owner', clientId: null, contentType, asLogo, bytes: pngBytes() });
      expect({ contentType, asLogo, status: created.statusCode }).toEqual({ contentType, asLogo, status: 415 });
    }
    expect(Number((await owner.knex('media_assets').where({ agency_id: agencyA }).whereNull('client_id').count<{ count: string }[]>('id as count'))[0]?.count)).toBe(before);
  });

  it('refuses a declared size above the ceiling of the category with 413, and takes the ceiling itself', async () => {
    const cases: [string, boolean, number][] = [
      ['image/svg+xml', true, SVG_MAX_BYTES],
      ['application/pdf', false, MEDIA_PDF_MAX_BYTES],
      ['audio/mpeg', false, MEDIA_AUDIO_MAX_BYTES],
      ['image/png', false, TEST_STORAGE_CONFIG.maxImageBytes],
      ['image/png', true, TEST_STORAGE_CONFIG.maxImageBytes]
    ];
    for (const [contentType, asLogo, ceiling] of cases) {
      const over = await upload({ contentType, asLogo, bytes: new Uint8Array(1), declaredSizeBytes: ceiling + 1 });
      expect({ contentType, asLogo, status: over.created.statusCode }).toEqual({ contentType, asLogo, status: 413 });
      expect(over.created.json().error.code).toBe('PAYLOAD_TOO_LARGE');
      const at = await call('POST', `/agencies/${agencyA}/media/uploads`, 'opVis', {
        fileName: 'no-limite.bin', contentType, declaredSizeBytes: ceiling, ...(asLogo ? { asLogo } : {}), clientId: clientA, folderId: await folderOf(clientA)
      });
      expect({ contentType, asLogo, atTheCeiling: at.statusCode }).toEqual({ contentType, asLogo, atTheCeiling: 201 });
    }
  });
});

describe('a file that is not what it says it is', () => {
  withFreshLimiter();

  const expectRejected = async (result: UploadResult, reason: string): Promise<void> => {
    expect(result.created.statusCode).toBe(201);
    expect(result.completed?.statusCode).toBe(422);
    expect(result.completed?.json().error).toMatchObject({ code: 'UPLOAD_REJECTED', details: { reason } });
    // What was sent is not kept anywhere: the row says why, and neither the canonical object nor the staging one is left.
    expect(await row(result.assetId!)).toMatchObject({ status: 'rejected', rejected_reason: reason, confirmed_at: null });
    expect(await exists(result.objectKey!)).toBe(false);
    expect(await exists(`staging/${agencyA}/${result.assetId}/upload.${result.objectKey!.split('.').pop()}`)).toBe(false);
    // And the library never lists it nor opens it.
    expect((await call('GET', `/agencies/${agencyA}/clients/${clientA}/media/${result.assetId}`, 'opVis')).statusCode).toBe(404);
    expect((await call('GET', `/agencies/${agencyA}/media/${result.assetId}/download-url`, 'opVis')).statusCode).toBe(404);
  };

  it.each([
    ['text with a script declared as a PNG', 'image/png', false, textBytes('<html><script>alert(1)</script></html>')],
    ['a JPEG declared as a PNG', 'image/png', false, jpegBytes()],
    ['a PNG declared as a PDF', 'application/pdf', false, pngBytes()],
    ['an executable declared as a PDF', 'application/pdf', false, textBytes('MZ\u0090\u0000\u0003')],
    ['an HTML page declared as an MP3', 'audio/mpeg', false, textBytes('<html>x</html>')],
    ['a PDF declared as an audio', 'audio/ogg', false, pdfBytes()],
    ['a file of zeros declared as an image', 'image/webp', false, new Uint8Array(200)]
  ] as const)('rejects %s, with the reason, deleting the object', async (_label, contentType, asLogo, bytes) => {
    await expectRejected(await upload({ contentType, asLogo, bytes }), 'content_type_mismatch');
  });

  it('rejects an image whose header gives a size the library cannot hold', async () => {
    await expectRejected(await upload({ contentType: 'image/png', bytes: pngBytes(0, 10) }), 'invalid_dimensions');
    await expectRejected(await upload({ contentType: 'image/png', bytes: pngBytes(100_001, 10) }), 'invalid_dimensions');
  });

  it('rejects an empty object, which the size of a file cannot be', async () => {
    const created = await call('POST', `/agencies/${agencyA}/media/uploads`, 'opVis', {
      fileName: 'vazio.png', contentType: 'image/png', declaredSizeBytes: 10, clientId: clientA, folderId: await folderOf(clientA)
    });
    const put = await fetch(created.json().upload.url as string, { method: 'PUT', body: new Uint8Array(0), headers: { 'content-type': 'image/png' } });
    expect(put.ok).toBe(true);
    const completed = await call('POST', `/agencies/${agencyA}/media/uploads/${created.json().assetId as string}/complete`, 'opVis', {});

    expect(completed.statusCode).toBe(422);
    expect(completed.json().error.details.reason).toBe('empty_object');
    expect(await row(created.json().assetId)).toMatchObject({ status: 'rejected', rejected_reason: 'empty_object' });
  });

  it.each([
    ['a script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'],
    ['an onload', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>'],
    ['an onclick on a shape', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onclick="alert(1)"/></svg>'],
    ['a script written with an entity', '<svg xmlns="http://www.w3.org/2000/svg"><scr&#105;pt>alert(1)</scr&#105;pt></svg>'],
    ['a foreignObject carrying HTML', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)"/></foreignObject></svg>'],
    ['a link out', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>'],
    ['an external image', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png" width="1" height="1"/></svg>'],
    ['an external stylesheet', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css);</style></svg>'],
    ['an entity that expands', '<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>'],
    ['an animation that sets a link', '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:alert(1)"/><rect width="1" height="1"/></a></svg>'],
    ['HTML instead of a drawing', '<html><body><script>alert(1)</script></body></html>']
  ])('rejects an SVG with %s, and the object that held it is deleted', async (_label, svg) => {
    await expectRejected(await upload({ contentType: 'image/svg+xml', asLogo: true, bytes: textBytes(svg) }), 'svg_rejected');
  });

  it('rejects an SVG above its ceiling with the same refusal as any large file, without reading it', async () => {
    const created = await call('POST', `/agencies/${agencyA}/media/uploads`, 'opVis', {
      fileName: 'grande.svg', contentType: 'image/svg+xml', asLogo: true, declaredSizeBytes: 1_000, clientId: clientA, folderId: await folderOf(clientA)
    });
    const big = textBytes(`<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(10_000)}</svg>`);
    expect(big.length).toBeGreaterThan(SVG_MAX_BYTES);
    const put = await fetch(created.json().upload.url as string, { method: 'PUT', body: big, headers: { 'content-type': 'image/svg+xml' } });
    expect(put.ok).toBe(true);

    const completed = await call('POST', `/agencies/${agencyA}/media/uploads/${created.json().assetId as string}/complete`, 'opVis', {});

    expect(completed.statusCode).toBe(422);
    expect(completed.json().error.details.reason).toBe('too_large');
    expect(await exists(created.json().objectKey as string)).toBe(false);
  });
});

describe('who may send these files, and where', () => {
  withFreshLimiter();

  it('needs conteudo.operar AND conteudo.visualizar to send a file of a client, and creates nothing for another role', async () => {
    const before = await rowCount(clientA);
    for (const as of ['onlyOperar', 'onlyMidia']) {
      const { created } = await upload({ as, contentType: 'application/pdf', bytes: pdfBytes() });
      expect({ as, status: created.statusCode }).toEqual({ as, status: 403 });
    }
    const anonymous = await call('POST', `/agencies/${agencyA}/media/uploads`, undefined, { fileName: 'a.pdf', contentType: 'application/pdf', declaredSizeBytes: 10, clientId: clientA, folderId: await folderOf(clientA) });
    expect(anonymous.statusCode).toBe(401);
    expect(await rowCount(clientA)).toBe(before);
  });

  it('answers the same 404 for the agency, the client or the folder of someone else, creating nothing', async () => {
    const before = [await rowCount(clientA), await rowCount(clientA2), await rowCount(clientB)];
    const attempts: { readonly label: string; readonly input: UploadInput }[] = [
      { label: 'the owner of another agency in this agency', input: { as: 'ownerB', clientId: clientA, contentType: 'application/pdf', bytes: pdfBytes() } },
      { label: 'a client of another agency', input: { clientId: clientB, folderId: await folderOf(clientB), contentType: 'application/pdf', bytes: pdfBytes() } },
      { label: 'a folder of another client', input: { clientId: clientA, folderId: await folderOf(clientA2), contentType: 'application/pdf', bytes: pdfBytes() } },
      { label: 'a folder of another agency', input: { clientId: clientA, folderId: await folderOf(clientB), contentType: 'audio/mpeg', bytes: mp3Bytes() } },
      { label: 'an absent folder', input: { clientId: clientA, folderId: randomUUID(), contentType: 'image/svg+xml', asLogo: true, bytes: textBytes(SAFE_SVG) } }
    ];
    for (const { label, input } of attempts) {
      const { created } = await upload(input);
      expect({ label, status: created.statusCode, code: created.json().error?.code }).toEqual({ label, status: 404, code: 'NOT_FOUND' });
    }
    expect([await rowCount(clientA), await rowCount(clientA2), await rowCount(clientB)]).toEqual(before);
  });

  it('refuses a name that is a path, a control character or too long, and a name of 255 characters is kept', async () => {
    const before = await rowCount(clientA);
    for (const fileName of ['../../etc/passwd', 'a/b.pdf', 'a\\b.pdf', '..', '', 'a\u0000b.pdf', 'a\nb.pdf', 'a‮b.pdf', 'x'.repeat(256), 'é'.repeat(256)]) {
      const { created } = await upload({ fileName, contentType: 'application/pdf', bytes: pdfBytes() });
      expect({ fileName, status: created.statusCode }).toEqual({ fileName, status: 400 });
    }
    expect(await rowCount(clientA)).toBe(before);
    const longest = await upload({ fileName: 'é'.repeat(255), contentType: 'application/pdf', bytes: pdfBytes() });
    expect(longest.completed?.statusCode).toBe(200);
    expect(await row(longest.assetId!)).toMatchObject({ file_name: 'é'.repeat(255) });
    expect(longest.objectKey).toBe(`${agencyA}/${longest.assetId}/original.pdf`);
  });
});

describe('a file that must never open as a page is served as a download of the type the server confirmed', () => {
  // The worst the guard could let through: what was stored carries the type that makes a browser run it.
  it.each([
    ['an SVG with a script', 'logo', 'image/svg+xml', 'svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['a PDF', 'pdf', 'application/pdf', 'pdf', '<html><script>alert(1)</script></html>'],
    ['an audio', 'audio', 'audio/mpeg', 'mp3', '<html><script>alert(1)</script></html>']
  ] as const)('forces %s to be an attachment of its confirmed type, whatever type the bucket stored it with', async (_label, category, contentType, extension, body) => {
    const asset = await seedConfirmed({ category, contentType, extension, name: 'Relatório "final"; v2', bytes: textBytes(body), storedType: 'text/html' });

    const response = await signedGet(asset);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).not.toMatch(/inline/i);
    expect(disposition).toContain(`filename*=UTF-8''Relat%C3%B3rio%20%22final%22%3B%20v2.${extension}`);
    // The name cannot close its own quotes: what is between the first pair is one value.
    expect(disposition.match(/filename="([^"]*)"/)?.[0]).toBe(`filename="Relat_rio _final__ v2.${extension}"`);
  });

  it('forces the same on the thumbnail of a logo, which is the original itself', async () => {
    const asset = await seedConfirmed({ category: 'logo', contentType: 'image/svg+xml', extension: 'svg', name: 'logo', bytes: textBytes(SAFE_SVG), storedType: 'text/html' });

    const response = await signedGet(asset, 'thumbnail');

    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('leaves a PNG, which the screens draw, with its own headers', async () => {
    const asset = await seedConfirmed({ category: 'image', contentType: 'image/png', extension: 'png', name: 'foto.png', bytes: pngBytes(), storedType: 'image/png' });

    const response = await signedGet(asset);

    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('serves a file that has no name with a name of its own', async () => {
    const asset = await seedConfirmed({ category: 'pdf', contentType: 'application/pdf', extension: 'pdf', name: null, bytes: pdfBytes(), storedType: 'application/pdf' });

    const response = await signedGet(asset);

    expect(response.headers.get('content-disposition')).toContain('filename="download.pdf"');
  });
});
