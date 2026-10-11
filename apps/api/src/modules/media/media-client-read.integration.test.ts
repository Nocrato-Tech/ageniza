import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #550: the read URL of a client's media for who holds `conteudo.visualizar`. Every permission is held alone by a
// custom role where it matters, because the Owner passes every guard; the system roles (Gestor, Produção, Vendas,
// Financeiro) are checked as they ship. A refusal is checked by the audit trail it must not leave, because RLS answers an
// empty result and the route answers a status.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA = randomUUID();
const clientA2 = randomUUID();
const clientB = randomUUID();
const portalClient = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const assetIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const cookieOf = (response: { cookies: readonly { name: string; value: string }[] }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const read = async (agency: string, assetId: string, as?: string, query = ''): Promise<Reply> =>
  (await app.app.inject({
    method: 'GET',
    url: `/agencies/${agency}/media/${assetId}/download-url${query}`,
    headers: { ...origin, ...(as === undefined ? {} : { cookie: cookies[as]! }) }
  })) as unknown as Reply;

interface SeedOptions {
  readonly clientId?: string | null;
  readonly category?: 'image' | 'video';
  readonly status?: 'confirmed' | 'pending' | 'rejected';
  readonly removed?: boolean;
  readonly video?: 'pending' | 'ready' | 'failed';
}

const seedAsset = async (agencyId: string, options: SeedOptions = {}): Promise<string> => {
  const id = randomUUID();
  const category = options.category ?? 'image';
  const status = options.status ?? 'confirmed';
  const clientId = options.clientId === undefined ? clientA : options.clientId;
  const extension = category === 'image' ? 'png' : 'mp4';
  const contentType = category === 'image' ? 'image/png' : 'video/mp4';
  assetIds.push(id);
  const folderId = clientId === null
    ? null
    : (await owner.knex('media_folders').where({ client_id: clientId, name: category === 'image' ? 'Imagens' : 'Vídeos', is_default: true }).first('id')).id as string;
  await owner.knex('media_assets').insert({
    id,
    agency_id: agencyId,
    client_id: clientId,
    folder_id: folderId,
    category,
    declared_content_type: contentType,
    extension,
    object_key: `${agencyId}/${id}/original.${extension}`,
    upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
    declared_size_bytes: 1_000,
    created_by_user_id: users.owner!.id,
    ...(status === 'confirmed' ? { status, confirmed_size_bytes: 1_000, confirmed_content_type: contentType, confirmed_at: new Date() } : {}),
    ...(status === 'rejected' ? { status, rejected_reason: 'Formato inválido' } : {}),
    ...(options.removed === true ? { removed_at: new Date() } : {}),
    ...(category === 'video' && status === 'confirmed' ? { video_processing_status: options.video ?? 'pending' } : {}),
    ...(options.video === 'ready'
      ? {
          thumbnail_object_key: `${agencyId}/${id}/thumbnail.jpg`,
          preview_object_key: `${agencyId}/${id}/preview.mp4`,
          video_duration_seconds: 12
        }
      : {}),
    ...(options.video === 'failed' ? { video_processing_error: 'processing_failed' } : {})
  });
  return id;
};

const issuedCount = async (assetId: string): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action: 'media.download_url_issued', target_id: assetId }).count<{ count: string }[]>('id as count'))[0]?.count);

const signedKey = (url: string): string => decodeURIComponent(new URL(url).pathname).replace(/^\/[^/]+\//, '');

const NO_LEAK = /A00\d\d|42501|pg_|relation|stack|ECONN/i;

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();

  const makeUser = async (key: string): Promise<void> => {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `client-read-${key.toLowerCase()}`, name: key });
    userIds.push(user.id);
    users[key] = user;
  };
  for (const key of ['owner', 'ownerB', 'manager', 'production', 'sales', 'finance', 'onlyVisualizar', 'onlyOperar', 'onlyMidia', 'both', 'portal']) await makeUser(key);

  await owner.knex('agencies').insert([
    { id: agencyA, name: `Client read A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Client read B ${agencyB}`, owner_user_id: users.ownerB!.id }
  ]);
  await owner.knex('clients').insert([
    { id: clientA, agency_id: agencyA, name: `Cliente A ${clientA}` },
    { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
    { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` },
    { id: portalClient, agency_id: agencyA, name: `Cliente do portal ${portalClient}` }
  ]);

  const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
    const id = randomUUID();
    roleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyId, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
    await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
    return id;
  };
  const systemRole = async (key: string): Promise<string> => (await owner.knex('roles').whereNull('agency_id').where({ key }).first('id')).id as string;
  await owner.knex('agency_memberships').insert([
    { agency_id: agencyA, user_id: users.manager!.id, role_id: await systemRole('account_manager') },
    { agency_id: agencyA, user_id: users.production!.id, role_id: await systemRole('production') },
    { agency_id: agencyA, user_id: users.sales!.id, role_id: await systemRole('sales') },
    { agency_id: agencyA, user_id: users.finance!.id, role_id: await systemRole('finance') },
    { agency_id: agencyA, user_id: users.onlyVisualizar!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.onlyOperar!.id, role_id: await customRole(agencyA, 'conteudo.operar') },
    { agency_id: agencyA, user_id: users.onlyMidia!.id, role_id: await customRole(agencyA, 'midia.enviar') },
    // Reads Conteúdo in two agencies: RLS shows it the media of the other agency, so only the agency filter refuses it.
    { agency_id: agencyA, user_id: users.both!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyB, user_id: users.both!.id, role_id: await customRole(agencyB, 'conteudo.visualizar') }
  ]);
  // The portal person has a client vínculo and no agency membership.
  await owner.knex('client_memberships').insert({ client_id: portalClient, user_id: users.portal!.id });

  for (const key of Object.keys(users)) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode).toBe(200);
    cookies[key] = cookieOf(response);
  }
}, 60_000);

afterAll(async () => {
  const agencies = [agencyA, agencyB];
  const clients = [clientA, clientA2, clientB, portalClient];
  await owner.knex('audit.events').whereIn('agency_id', agencies).delete();
  await owner.knex('media_assets').whereIn('agency_id', agencies).delete();
  await owner.knex('agency_storage_quotas').whereIn('agency_id', agencies).delete();
  await owner.knex('media_folders').whereIn('client_id', clients).delete();
  await owner.knex('client_memberships').whereIn('client_id', clients).delete();
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

describe('the read URL of a client\'s media (issue #550)', () => {
  it('signs the original for Gestor, Produção and a role holding only conteudo.visualizar, and audits who asked', async () => {
    const assetId = await seedAsset(agencyA);

    for (const as of ['manager', 'production', 'onlyVisualizar', 'owner']) {
      const before = await issuedCount(assetId);
      const response = await read(agencyA, assetId, as);
      expect({ as, status: response.statusCode }).toEqual({ as, status: 200 });
      expect(signedKey(response.json().url)).toBe(`${agencyA}/${assetId}/original.png`);
      expect(new Date(response.json().expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(await issuedCount(assetId)).toBe(before + 1);
    }
    const audited = await owner.knex('audit.events').where({ action: 'media.download_url_issued', target_id: assetId, actor_user_id: users.manager!.id }).first('agency_id');
    expect(audited?.agency_id).toBe(agencyA);
  });

  it('refuses Vendas, Financeiro, conteudo.operar alone and no session, and signs nothing', async () => {
    const assetId = await seedAsset(agencyA);

    for (const as of ['sales', 'finance', 'onlyOperar']) {
      const response = await read(agencyA, assetId, as);
      expect({ as, status: response.statusCode }).toEqual({ as, status: 403 });
      expect(JSON.stringify(response.json())).not.toMatch(/url|X-Amz/i);
    }
    expect((await read(agencyA, assetId)).statusCode).toBe(401);
    expect(await issuedCount(assetId)).toBe(0);
  });

  it('keeps a role with only midia.enviar out of a client\'s media: 404, no URL, no audit', async () => {
    const assetId = await seedAsset(agencyA);

    const response = await read(agencyA, assetId, 'onlyMidia');

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toEqual({ code: 'NOT_FOUND', message: 'Media asset not found.' });
    expect(await issuedCount(assetId)).toBe(0);
  });

  it('keeps the media with no client on midia.enviar: the one who holds it signs, the readers of Conteúdo get a 404', async () => {
    const assetId = await seedAsset(agencyA, { clientId: null });

    const sent = await read(agencyA, assetId, 'onlyMidia');
    expect(sent.statusCode).toBe(200);
    expect(signedKey(sent.json().url)).toBe(`${agencyA}/${assetId}/original.png`);

    for (const as of ['manager', 'production', 'onlyVisualizar']) {
      const response = await read(agencyA, assetId, as);
      expect({ as, status: response.statusCode }).toEqual({ as, status: 404 });
    }
    expect(await issuedCount(assetId)).toBe(1);
  });

  it('answers 404 for a media of another agency, in either path, even to a person who reads Conteúdo in both', async () => {
    const ofB = await seedAsset(agencyB, { clientId: clientB });
    const ofA = await seedAsset(agencyA);

    // Positive controls: the same person signs each media under its own agency.
    expect((await read(agencyB, ofB, 'both')).statusCode).toBe(200);
    expect((await read(agencyA, ofA, 'both')).statusCode).toBe(200);
    const before = await issuedCount(ofB);

    const wrongPath = await read(agencyA, ofB, 'both');
    expect(wrongPath.statusCode).toBe(404);
    expect(wrongPath.json().error).toEqual({ code: 'NOT_FOUND', message: 'Media asset not found.' });
    expect((await read(agencyB, ofA, 'both')).statusCode).toBe(404);
    expect(await issuedCount(ofB)).toBe(before);

    // Someone with no vínculo to the agency of the path never gets past the guard.
    for (const response of [await read(agencyB, ofB, 'manager'), await read(agencyB, ofB, 'production')]) {
      expect([403, 404]).toContain(response.statusCode);
      expect(JSON.stringify(response.json())).not.toMatch(/X-Amz/i);
    }
  });

  it('answers 404 for a removed media, a pending one, a rejected one and an unknown id, and leaves no audit', async () => {
    const live = await seedAsset(agencyA);
    const removed = await seedAsset(agencyA, { removed: true });
    const pending = await seedAsset(agencyA, { status: 'pending' });
    const rejected = await seedAsset(agencyA, { status: 'rejected' });

    expect((await read(agencyA, live, 'production')).statusCode).toBe(200);
    for (const [name, assetId] of [['removed', removed], ['pending', pending], ['rejected', rejected], ['unknown', randomUUID()]] as const) {
      const response = await read(agencyA, assetId, 'production');
      expect({ name, status: response.statusCode }).toEqual({ name, status: 404 });
      expect(await issuedCount(assetId)).toBe(0);
    }
    // The removed media is refused for every variant, not just the original.
    for (const variant of ['thumbnail', 'preview']) expect((await read(agencyA, removed, 'production', `?variant=${variant}`)).statusCode).toBe(404);
  });

  it('serves an image\'s original as its thumbnail and has no preview for it', async () => {
    const assetId = await seedAsset(agencyA);

    const thumbnail = await read(agencyA, assetId, 'manager', '?variant=thumbnail');
    expect(thumbnail.statusCode).toBe(200);
    expect(signedKey(thumbnail.json().url)).toBe(`${agencyA}/${assetId}/original.png`);

    const preview = await read(agencyA, assetId, 'manager', '?variant=preview');
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error.code).toBe('VARIANT_NOT_READY');
    expect(await issuedCount(assetId)).toBe(0);
  });

  it('audits the explicit download of the original and not the thumbnail or the preview the screens render', async () => {
    const image = await seedAsset(agencyA);
    const video = await seedAsset(agencyA, { category: 'video', video: 'ready' });

    expect((await read(agencyA, image, 'manager', '?variant=thumbnail')).statusCode).toBe(200);
    expect((await read(agencyA, video, 'manager', '?variant=thumbnail')).statusCode).toBe(200);
    expect((await read(agencyA, video, 'manager', '?variant=preview')).statusCode).toBe(200);
    expect(await issuedCount(image)).toBe(0);
    expect(await issuedCount(video)).toBe(0);

    expect((await read(agencyA, image, 'manager', '?variant=original')).statusCode).toBe(200);
    expect((await read(agencyA, video, 'production')).statusCode).toBe(200);
    expect(await issuedCount(image)).toBe(1);
    expect(await issuedCount(video)).toBe(1);
    const row = await owner.knex('audit.events').where({ action: 'media.download_url_issued', target_id: video }).first('actor_user_id');
    expect(row?.actor_user_id).toBe(users.production!.id);
  });

  it('serves a video\'s thumbnail once processed and answers a code the screen can handle before that', async () => {
    const processed = await seedAsset(agencyA, { category: 'video', video: 'ready' });
    const waiting = await seedAsset(agencyA, { category: 'video', video: 'pending' });
    const failed = await seedAsset(agencyA, { category: 'video', video: 'failed' });

    const thumbnail = await read(agencyA, processed, 'production', '?variant=thumbnail');
    expect(thumbnail.statusCode).toBe(200);
    expect(signedKey(thumbnail.json().url)).toBe(`${agencyA}/${processed}/thumbnail.jpg`);
    const original = await read(agencyA, processed, 'production');
    expect(signedKey(original.json().url)).toBe(`${agencyA}/${processed}/original.mp4`);

    const notReady = await read(agencyA, waiting, 'production', '?variant=thumbnail');
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error.code).toBe('VARIANT_NOT_READY');
    const processingFailed = await read(agencyA, failed, 'production', '?variant=thumbnail');
    expect(processingFailed.statusCode).toBe(409);
    expect(processingFailed.json().error).toMatchObject({ code: 'VARIANT_PROCESSING_FAILED', details: { reason: 'processing_failed' } });
    for (const assetId of [waiting, failed]) expect(await issuedCount(assetId)).toBe(0);
  });

  it('is not a portal route: a person with only a client vínculo never signs anything', async () => {
    const assetId = await seedAsset(agencyA, { clientId: portalClient });

    const response = await read(agencyA, assetId, 'portal');

    expect([403, 404]).toContain(response.statusCode);
    expect(JSON.stringify(response.json())).not.toMatch(/X-Amz/i);
    expect(await issuedCount(assetId)).toBe(0);
  });

  it('never answers 500: a malformed id, an unknown variant and a stray parameter are 4xx without database detail', async () => {
    const assetId = await seedAsset(agencyA);

    for (const response of [
      await read(agencyA, 'not-a-uuid', 'manager'),
      await read(agencyA, assetId, 'manager', '?variant=huge'),
      await read(agencyA, assetId, 'manager', '?sort=name'),
      await read('not-a-uuid', assetId, 'manager')
    ]) {
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(JSON.stringify(response.json())).not.toMatch(NO_LEAK);
    }
    expect(await issuedCount(assetId)).toBe(0);
  });
});
