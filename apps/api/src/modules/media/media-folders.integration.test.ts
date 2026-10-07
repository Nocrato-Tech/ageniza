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

// Issue #253: the client's media library. Every permission is held alone by a custom role, because the Owner
// passes every guard and hides one written with the wrong key; every refusal is checked by the state left in the
// database, because RLS answers an empty result and the route answers a status.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const agencyC = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientArchived = randomUUID();
const clientB = randomUUID();
const clientC = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const assetIds: string[] = [];
const contentIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const cookieOf = (response: { cookies: readonly { name: string; value: string }[] }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

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

const foldersUrl = (agency: string, client: string): string => `/agencies/${agency}/clients/${client}/media-folders`;
const assetsUrl = (agency: string, client: string, folder: string): string => `${foldersUrl(agency, client)}/${folder}/assets`;
const removeUrl = (agency: string, client: string, folder: string, asset: string): string => `${assetsUrl(agency, client, folder)}/${asset}/remove`;

const defaultFolder = async (clientId: string, name = 'Imagens'): Promise<string> =>
  (await owner.knex('media_folders').where({ client_id: clientId, name, is_default: true }).first('id')).id as string;

const seedAsset = async (
  agencyId: string,
  clientId: string,
  folderId: string,
  extra: { status?: 'confirmed' | 'pending' | 'rejected'; removed?: boolean; size?: number; createdAt?: Date } = {}
): Promise<string> => {
  const id = randomUUID();
  const status = extra.status ?? 'confirmed';
  const size = extra.size ?? 1_000;
  assetIds.push(id);
  await owner.knex('media_assets').insert({
    id,
    agency_id: agencyId,
    client_id: clientId,
    folder_id: folderId,
    category: 'image',
    declared_content_type: 'image/png',
    extension: 'png',
    object_key: `${agencyId}/${id}/original.png`,
    upload_object_key: `staging/${agencyId}/${id}/upload.png`,
    declared_size_bytes: size,
    created_by_user_id: users.owner!.id,
    ...(status === 'confirmed' ? { status, confirmed_size_bytes: size, confirmed_content_type: 'image/png', confirmed_at: new Date() } : {}),
    ...(status === 'rejected' ? { status, rejected_reason: 'Formato inválido' } : {}),
    ...(extra.removed === true ? { removed_at: new Date() } : {}),
    ...(extra.createdAt === undefined ? {} : { created_at: extra.createdAt })
  });
  return id;
};

const seedContentUsing = async (
  status: 'in_production' | 'awaiting_approval' | 'approved' | 'published',
  folderId: string,
  assetId: string
): Promise<void> => {
  const id = randomUUID();
  contentIds.push(id);
  const approved = status === 'approved' || status === 'published';
  await owner.knex('contents').insert({
    id,
    client_id: clientA1,
    title: `Conteúdo ${id.slice(0, 8)}`,
    platform: 'instagram',
    format: 'image',
    publish_on: '2026-10-20',
    folder_id: folderId,
    owner_user_id: users.opVis!.id,
    status,
    ...(approved ? { approved_by: users.owner!.id, approved_at: new Date() } : {}),
    ...(status === 'published' ? { published_on: '2026-10-06', published_at: new Date() } : {})
  });
  await owner.knex('content_media').insert({ content_id: id, asset_id: assetId, client_id: clientA1, folder_id: folderId, position: 1 });
};

const removedAt = async (assetId: string): Promise<Date | null> =>
  (await owner.knex('media_assets').where({ id: assetId }).first('removed_at')).removed_at as Date | null;

const folderCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('media_folders').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count);

const mediaCount = async (agencyId: string): Promise<number> =>
  Number((await owner.knex('media_assets').where({ agency_id: agencyId }).count<{ count: string }[]>('id as count'))[0]?.count);

const auditCount = async (assetId: string): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action: 'media.removed', target_id: assetId }).count<{ count: string }[]>('id as count'))[0]?.count);

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();

  const makeUser = async (key: string): Promise<void> => {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `folders-${key.toLowerCase()}`, name: key });
    userIds.push(user.id);
    users[key] = user;
  };
  for (const key of ['owner', 'ownerB', 'ownerC', 'opVis', 'onlyOperar', 'onlyVisualizar', 'onlyMidia', 'midiaC', 'sales']) await makeUser(key);

  await owner.knex('agencies').insert([
    { id: agencyA, name: `Folders A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Folders B ${agencyB}`, owner_user_id: users.ownerB!.id },
    { id: agencyC, name: `Folders C ${agencyC}`, owner_user_id: users.ownerC!.id }
  ]);
  await owner.knex('clients').insert([
    { id: clientA1, agency_id: agencyA, name: `Cliente A1 ${clientA1}` },
    { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
    { id: clientArchived, agency_id: agencyA, name: `Cliente arquivado ${clientArchived}` },
    { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` },
    { id: clientC, agency_id: agencyC, name: `Cliente C ${clientC}` }
  ]);
  await owner.knex('clients').where({ id: clientArchived }).update({ status: 'archived', archived_at: new Date() });

  const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
    const id = randomUUID();
    roleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyId, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
    await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
    return id;
  };
  const sales = (await owner.knex('roles').whereNull('agency_id').where({ key: 'sales' }).first('id')).id as string;
  await owner.knex('agency_memberships').insert([
    { agency_id: agencyA, user_id: users.opVis!.id, role_id: await customRole(agencyA, 'conteudo.operar', 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.onlyOperar!.id, role_id: await customRole(agencyA, 'conteudo.operar') },
    { agency_id: agencyA, user_id: users.onlyVisualizar!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.onlyMidia!.id, role_id: await customRole(agencyA, 'midia.enviar') },
    { agency_id: agencyC, user_id: users.midiaC!.id, role_id: await customRole(agencyC, 'midia.enviar') },
    { agency_id: agencyA, user_id: users.sales!.id, role_id: sales }
  ]);

  for (const key of Object.keys(users)) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode).toBe(200);
    cookies[key] = cookieOf(response);
  }
});

afterAll(async () => {
  const agencies = [agencyA, agencyB, agencyC];
  const clients = [clientA1, clientA2, clientArchived, clientB, clientC];
  await owner.knex('content_media').whereIn('client_id', clients).delete();
  await owner.knex('contents').whereIn('id', contentIds).delete();
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

describe('listing the folders of a client (issue #253)', () => {
  it('lists the four default folders in a fixed order, by page', async () => {
    const response = await call('GET', foldersUrl(agencyA, clientA1), 'opVis');

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((folder: { name: string; isDefault: boolean; parentId: null }) => [folder.name, folder.isDefault, folder.parentId]))
      .toEqual([['Carrosséis', true, null], ['Ensaio fotográfico', true, null], ['Imagens', true, null], ['Vídeos', true, null]]);
    expect(response.json().meta).toEqual({ page: 1, pageSize: 100, totalItems: 4, totalPages: 1 });

    const second = await call('GET', `${foldersUrl(agencyA, clientA1)}?page=2&pageSize=3`, 'opVis');
    expect(second.json().data.map((folder: { name: string }) => folder.name)).toEqual(['Vídeos']);
    expect(second.json().meta).toEqual({ page: 2, pageSize: 3, totalItems: 4, totalPages: 2 });
  });

  it('answers the same 404 for a client of another agency, an absent one and a malformed id', async () => {
    const other = await call('GET', foldersUrl(agencyA, clientB), 'opVis');
    const absent = await call('GET', foldersUrl(agencyA, randomUUID()), 'opVis');
    const malformed = await call('GET', foldersUrl(agencyA, 'not-a-uuid'), 'opVis');

    for (const response of [other, absent, malformed]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });
    }
    expect((await call('GET', foldersUrl(agencyB, clientB), 'opVis')).statusCode).toBe(404);
  });

  it('is for who reads Conteúdo, whichever the role, and for nobody without a session', async () => {
    for (const as of ['onlyOperar', 'onlyMidia', 'sales']) expect((await call('GET', foldersUrl(agencyA, clientA1), as)).statusCode).toBe(403);
    expect((await call('GET', foldersUrl(agencyA, clientA1), 'onlyVisualizar')).statusCode).toBe(200);
    expect((await call('GET', foldersUrl(agencyA, clientA1))).statusCode).toBe(401);
  });

  it('refuses a page that would overflow, a stray parameter and a ceiling above 100 without a 500', async () => {
    expect((await call('GET', `${foldersUrl(agencyA, clientA1)}?page=1e20`, 'opVis')).statusCode).toBe(400);
    expect((await call('GET', `${foldersUrl(agencyA, clientA1)}?sort=name`, 'opVis')).statusCode).toBe(400);
    expect((await call('GET', `${foldersUrl(agencyA, clientA1)}?pageSize=1000`, 'opVis')).json().meta.pageSize).toBe(100);
  });
});

describe('creating a folder (issue #253)', () => {
  it('creates a first-level folder and a working folder inside it, and lists them after the default ones', async () => {
    const first = await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: '  Campanhas  ' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ parentId: null, name: 'Campanhas', isDefault: false });

    const inside = await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Outubro', parentId: first.json().id });
    expect(inside.statusCode).toBe(201);
    expect(inside.json()).toMatchObject({ parentId: first.json().id, name: 'Outubro', isDefault: false });

    const listed = await call('GET', foldersUrl(agencyA, clientA1), 'opVis');
    expect(listed.json().data.map((folder: { name: string }) => folder.name)).toEqual(['Carrosséis', 'Ensaio fotográfico', 'Imagens', 'Vídeos', 'Campanhas', 'Outubro']);
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone gets a 403 and writes nothing', async () => {
    const before = await folderCount(clientA1);

    for (const as of ['onlyVisualizar', 'onlyOperar', 'onlyMidia', 'sales']) {
      expect((await call('POST', foldersUrl(agencyA, clientA1), as, { name: 'Sem permissão' })).statusCode).toBe(403);
    }
    expect(await folderCount(clientA1)).toBe(before);
  });

  it('refuses a name the database would accept: invisible, joiner, control, blank, long and too wide once encoded', async () => {
    const before = await folderCount(clientA1);
    const names = [
      'Zero​width', 'Liga‍ção', 'Nao‌join', 'Bell\u0007', 'Linha dois', '   ', ' \t', '😀😀', 'a'.repeat(81), `a${'😀'.repeat(64)}`, ''
    ];

    for (const name of names) {
      const response = await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name });
      expect({ name, status: response.statusCode }).toEqual({ name, status: 400 });
    }
    expect(await folderCount(clientA1)).toBe(before);
    expect((await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'a'.repeat(80) })).statusCode).toBe(201);
    expect((await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Pasta ✨ com emoji' })).statusCode).toBe(201);
  });

  it('refuses an extra field, a folder inside a working folder, a parent of another client and an archived client', async () => {
    const parent = (await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Pai' })).json().id as string;
    const child = (await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Filha', parentId: parent })).json().id as string;
    const before = [await folderCount(clientA1), await folderCount(clientA2), await folderCount(clientArchived)];

    expect((await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Extra', isDefault: true })).statusCode).toBe(400);
    const deep = await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Neta', parentId: child });
    expect(deep.statusCode).toBe(400);
    expect(deep.json().error.details.issues[0].path).toBe('parentId');
    expect((await call('POST', foldersUrl(agencyA, clientA2), 'opVis', { name: 'Filha alheia', parentId: parent })).statusCode).toBe(404);
    expect((await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: 'Pai inexistente', parentId: randomUUID() })).statusCode).toBe(404);
    expect((await call('POST', foldersUrl(agencyA, clientB), 'opVis', { name: 'Cliente alheio' })).statusCode).toBe(404);
    const archived = await call('POST', foldersUrl(agencyA, clientArchived), 'opVis', { name: 'Arquivado' });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('CLIENT_ARCHIVED');
    expect([await folderCount(clientA1), await folderCount(clientA2), await folderCount(clientArchived)]).toEqual(before);
  });
});

describe('listing the media of a folder (issue #253)', () => {
  it('lists only the confirmed, not removed media of that folder, newest first, without a storage key', async () => {
    const folder = await defaultFolder(clientA1, 'Carrosséis');
    const other = await defaultFolder(clientA1, 'Vídeos');
    const old = await seedAsset(agencyA, clientA1, folder, { createdAt: new Date('2026-10-01T12:00:00Z') });
    const recent = await seedAsset(agencyA, clientA1, folder, { createdAt: new Date('2026-10-05T12:00:00Z'), size: 2_048 });
    await seedAsset(agencyA, clientA1, folder, { status: 'pending' });
    await seedAsset(agencyA, clientA1, folder, { status: 'rejected' });
    await seedAsset(agencyA, clientA1, folder, { removed: true });
    await seedAsset(agencyA, clientA1, other);

    const response = await call('GET', assetsUrl(agencyA, clientA1, folder), 'opVis');

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { id: recent, category: 'image', contentType: 'image/png', sizeBytes: 2_048, videoProcessingStatus: 'not_applicable', createdAt: '2026-10-05T12:00:00.000Z' },
      { id: old, category: 'image', contentType: 'image/png', sizeBytes: 1_000, videoProcessingStatus: 'not_applicable', createdAt: '2026-10-01T12:00:00.000Z' }
    ]);
    expect(response.json().meta).toEqual({ page: 1, pageSize: 48, totalItems: 2, totalPages: 1 });
    expect((await call('GET', `${assetsUrl(agencyA, clientA1, folder)}?page=2&pageSize=1`, 'opVis')).json().data.map((item: { id: string }) => item.id)).toEqual([old]);
  });

  it('answers the same 404 for a folder of another client, of another agency, absent or malformed', async () => {
    const folderA2 = await defaultFolder(clientA2);
    const folderB = await defaultFolder(clientB);
    await seedAsset(agencyA, clientA2, folderA2);

    for (const url of [
      assetsUrl(agencyA, clientA1, folderA2), assetsUrl(agencyA, clientA1, folderB), assetsUrl(agencyA, clientB, folderB),
      assetsUrl(agencyA, clientA1, randomUUID()), assetsUrl(agencyA, clientA1, 'not-a-uuid')
    ]) {
      expect({ url, status: (await call('GET', url, 'opVis')).statusCode }).toEqual({ url, status: 404 });
    }
    expect((await call('GET', assetsUrl(agencyA, clientA2, folderA2), 'onlyOperar')).statusCode).toBe(403);
    expect((await call('GET', assetsUrl(agencyA, clientA2, folderA2), 'onlyVisualizar')).statusCode).toBe(200);
  });
});

describe('removing a media from its folder (issue #253, rule 12)', () => {
  it('removes it once: it leaves the listing, the audit has one event, and a second call is not an error', async () => {
    const folder = await defaultFolder(clientA1);
    const asset = await seedAsset(agencyA, clientA1, folder);

    const first = await call('POST', removeUrl(agencyA, clientA1, folder, asset), 'opVis');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ assetId: asset, removed: true });
    expect(await removedAt(asset)).toBeInstanceOf(Date);
    expect((await call('GET', assetsUrl(agencyA, clientA1, folder), 'opVis')).json().data.map((item: { id: string }) => item.id)).not.toContain(asset);

    const removed = await removedAt(asset);
    expect((await call('POST', removeUrl(agencyA, clientA1, folder, asset), 'opVis')).statusCode).toBe(200);
    expect(await removedAt(asset)).toEqual(removed);
    expect(await auditCount(asset)).toBe(1);
  });

  it('refuses with 409 a media used by a content awaiting approval, approved or published, and lets one in production go', async () => {
    const folder = await defaultFolder(clientA1);
    const cases: ReadonlyArray<readonly ['in_production' | 'awaiting_approval' | 'approved' | 'published', boolean]> = [
      ['in_production', true], ['awaiting_approval', false], ['approved', false], ['published', false]
    ];

    for (const [status, removable] of cases) {
      const asset = await seedAsset(agencyA, clientA1, folder);
      await seedContentUsing(status, folder, asset);

      const response = await call('POST', removeUrl(agencyA, clientA1, folder, asset), 'opVis');

      expect({ status, http: response.statusCode, code: response.statusCode === 200 ? undefined : response.json().error.code })
        .toEqual({ status, http: removable ? 200 : 409, code: removable ? undefined : 'MEDIA_IN_USE' });
      expect({ status, removed: await removedAt(asset) !== null }).toEqual({ status, removed: removable });
      expect(await auditCount(asset)).toBe(removable ? 1 : 0);
    }
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone gets a 403 and removes nothing', async () => {
    const folder = await defaultFolder(clientA1);
    const asset = await seedAsset(agencyA, clientA1, folder);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales']) {
      expect({ as, status: (await call('POST', removeUrl(agencyA, clientA1, folder, asset), as)).statusCode }).toEqual({ as, status: 403 });
    }
    expect(await removedAt(asset)).toBeNull();
  });

  it('answers the same 404 for a media of another folder, another client or agency, an absent one and a malformed id', async () => {
    const folder = await defaultFolder(clientA1);
    const otherFolder = await defaultFolder(clientA1, 'Vídeos');
    const folderA2 = await defaultFolder(clientA2);
    const folderB = await defaultFolder(clientB);
    const inOtherFolder = await seedAsset(agencyA, clientA1, otherFolder);
    const ofA2 = await seedAsset(agencyA, clientA2, folderA2);
    const ofB = await seedAsset(agencyB, clientB, folderB);
    const pending = await seedAsset(agencyA, clientA1, folder, { status: 'pending' });

    for (const url of [
      removeUrl(agencyA, clientA1, folder, inOtherFolder), removeUrl(agencyA, clientA1, folder, ofA2), removeUrl(agencyA, clientA1, folderA2, ofA2),
      removeUrl(agencyA, clientB, folderB, ofB), removeUrl(agencyA, clientA1, folder, ofB), removeUrl(agencyA, clientA1, folder, randomUUID()),
      removeUrl(agencyA, clientA1, folder, 'not-a-uuid'), removeUrl(agencyA, clientA1, folder, pending)
    ]) {
      expect({ url, status: (await call('POST', url, 'opVis')).statusCode }).toEqual({ url, status: 404 });
    }
    expect(await Promise.all([inOtherFolder, ofA2, ofB, pending].map(removedAt))).toEqual([null, null, null, null]);
  });

  it('refuses a client that was archived with 409 and leaves the media', async () => {
    const folder = await defaultFolder(clientArchived);
    const asset = await seedAsset(agencyA, clientArchived, folder);

    const response = await call('POST', removeUrl(agencyA, clientArchived, folder, asset), 'opVis');

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CLIENT_ARCHIVED');
    expect(await removedAt(asset)).toBeNull();
  });
});

describe('uploading a media into a folder of a client (issue #253)', () => {
  const smallPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const uploadUrl = (agency: string): string => `/agencies/${agency}/media/uploads`;
  const body = (clientId?: string, folderId?: string) => ({
    fileName: 'foto.png', contentType: 'image/png', declaredSizeBytes: smallPng.length, ...(clientId === undefined ? {} : { clientId }), ...(folderId === undefined ? {} : { folderId })
  });

  it('is born in the folder, completed by who operates Conteúdo, and listed there', async () => {
    const folder = await defaultFolder(clientA1, 'Ensaio fotográfico');

    const created = await call('POST', uploadUrl(agencyA), 'opVis', body(clientA1, folder));
    expect(created.statusCode).toBe(201);
    const assetId = created.json().assetId as string;
    assetIds.push(assetId);
    expect(await owner.knex('media_assets').where({ id: assetId }).first('client_id', 'folder_id', 'created_by_user_id', 'status'))
      .toEqual({ client_id: clientA1, folder_id: folder, created_by_user_id: users.opVis!.id, status: 'pending' });
    expect((await call('GET', assetsUrl(agencyA, clientA1, folder), 'opVis')).json().data).toEqual([]);

    const put = await fetch(created.json().upload.url as string, { method: 'PUT', body: smallPng, headers: { 'content-type': 'image/png' } });
    expect(put.ok).toBe(true);
    const completed = await call('POST', `${uploadUrl(agencyA)}/${assetId}/complete`, 'opVis', {});
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ assetId, status: 'confirmed', sizeBytes: smallPng.length });
    expect((await call('GET', assetsUrl(agencyA, clientA1, folder), 'opVis')).json().data.map((item: { id: string }) => item.id)).toEqual([assetId]);
  });

  it('needs conteudo.operar AND conteudo.visualizar for a media of a client, and midia.enviar for one without', async () => {
    const folder = await defaultFolder(clientA1);
    const before = await mediaCount(agencyA);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales']) {
      expect({ as, status: (await call('POST', uploadUrl(agencyA), as, body(clientA1, folder))).statusCode }).toEqual({ as, status: 403 });
    }
    expect((await call('POST', uploadUrl(agencyA), 'opVis', body())).statusCode).toBe(403);
    expect(await mediaCount(agencyA)).toBe(before);

    const agencyMedia = await call('POST', uploadUrl(agencyA), 'onlyMidia', body());
    expect(agencyMedia.statusCode).toBe(201);
    assetIds.push(agencyMedia.json().assetId as string);
    expect(await owner.knex('media_assets').where({ id: agencyMedia.json().assetId }).first('client_id', 'folder_id')).toEqual({ client_id: null, folder_id: null });
  });

  it('validates the pair on the server: the client of another agency, the folder of another client or an archived client', async () => {
    const folderA1 = await defaultFolder(clientA1);
    const folderA2 = await defaultFolder(clientA2);
    const folderB = await defaultFolder(clientB);
    const folderArchived = await defaultFolder(clientArchived);
    const before = await mediaCount(agencyA) + await mediaCount(agencyB);

    for (const [clientId, folderId] of [[clientA1, folderA2], [clientA1, folderB], [clientB, folderB], [clientB, folderA1], [clientA1, randomUUID()], [randomUUID(), folderA1]] as const) {
      expect({ clientId, folderId, status: (await call('POST', uploadUrl(agencyA), 'opVis', body(clientId, folderId))).statusCode }).toEqual({ clientId, folderId, status: 404 });
    }
    const archived = await call('POST', uploadUrl(agencyA), 'opVis', body(clientArchived, folderArchived));
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('CLIENT_ARCHIVED');
    expect((await call('POST', uploadUrl(agencyA), 'opVis', body(clientA1))).statusCode).toBe(400);
    expect((await call('POST', uploadUrl(agencyA), 'opVis', body(undefined, folderA1))).statusCode).toBe(400);
    expect(await mediaCount(agencyA) + await mediaCount(agencyB)).toBe(before);
  });

  it('counts the media of a client that the caller cannot read against the quota of the agency', async () => {
    const folder = await defaultFolder(clientC, 'Vídeos');
    await seedAsset(agencyC, clientC, folder, { size: 600 });
    await owner.knex('agency_storage_quotas').insert({ agency_id: agencyC, quota_bytes: 1_000, quota_object_count: 100 });

    // `midia.enviar` alone does not read the media of a client: the old sum, under its RLS, was 0.
    const over = await call('POST', uploadUrl(agencyC), 'midiaC', { ...body(), declaredSizeBytes: 500 });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('QUOTA_EXCEEDED');

    const fits = await call('POST', uploadUrl(agencyC), 'midiaC', { ...body(), declaredSizeBytes: 300 });
    expect(fits.statusCode).toBe(201);
    assetIds.push(fits.json().assetId as string);
  });
});
