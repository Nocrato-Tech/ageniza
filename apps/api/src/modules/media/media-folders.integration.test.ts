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
const extraClientIds: string[] = [];
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

const waitUntilSomeoneWaitsOnALock = async (waiters = 1): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await owner.knex.raw<{ rows: Array<{ count: string }> }>(
      "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'"
    );
    if (Number(waiting.rows[0]?.count) >= waiters) return;
    if (Date.now() > deadline) throw new Error(`Fewer than ${waiters} requests ever queued behind the lock.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * The two windows of the race with the archive of a client. `in-progress`: the archive has changed the client and
 * not committed, the request passes the policy on a snapshot where the client is still active and waits on the AFTER
 * INSERT lock of the client's children (#284), which raises A0020. `committed-before-insert`: the request has read
 * the client as active, and the archive commits before the statement that writes starts, so the policy of the INSERT
 * refuses (42501); the table is locked by the archive's own transaction, which holds the request in front of that
 * statement and releases it together with the commit.
 */
type ArchiveWindow = 'in-progress' | { readonly committedBeforeInsert: 'media_folders' | 'media_assets' };

const duringArchiveOfAFreshClient = async <TPrepared = void>(
  window: ArchiveWindow,
  prepare: (clientId: string) => Promise<TPrepared>,
  request: (clientId: string, prepared: TPrepared) => Promise<Reply>
): Promise<{ clientId: string; reply: Reply }> => {
  const clientId = randomUUID();
  extraClientIds.push(clientId);
  await owner.knex('clients').insert({ id: clientId, agency_id: agencyA, name: `Cliente em arquivamento ${clientId}` });
  const prepared = await prepare(clientId);
  const archiving = await owner.knex.transaction();
  let pending: Promise<Reply> | undefined;
  try {
    if (window !== 'in-progress') await archiving.raw(`lock table public.${window.committedBeforeInsert} in access exclusive mode`);
    await archiving('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
    pending = request(clientId, prepared);
    await waitUntilSomeoneWaitsOnALock();
  } finally {
    await archiving.commit();
  }
  return { clientId, reply: await pending! };
};

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process/i;

const expectClientArchived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

const firstLevelFolder = async (clientId: string, name: string): Promise<string> => {
  const created = await call('POST', foldersUrl(agencyA, clientId), 'opVis', { name });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
};

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
  const clients = [clientA1, clientA2, clientArchived, clientB, clientC, ...extraClientIds];
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

  it('refuses a name the database would accept: invisible, joiner, control, blank and long', async () => {
    const before = await folderCount(clientA1);
    const names = [
      'Zero​width', 'Liga‍ção', 'Nao‌join', 'Bell\u0007', 'Linha dois', '   ', ' \t', '😀😀', 'a'.repeat(81), `a${'😀'.repeat(40)}`, ''
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

  it('loses the race with the archive of the client: 409 CLIENT_ARCHIVED, and the folder is not left behind', async () => {
    const { clientId, reply } = await duringArchiveOfAFreshClient('in-progress', async () => undefined, (id) => call('POST', foldersUrl(agencyA, id), 'opVis', { name: 'Chegou tarde' }));

    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('CLIENT_ARCHIVED');
    expect(await owner.knex('media_folders').where({ client_id: clientId, is_default: false })).toHaveLength(0);
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

  it('loses the race with the archive of the client: 409 CLIENT_ARCHIVED, and no media or reservation is left behind', async () => {
    const { clientId, reply } = await duringArchiveOfAFreshClient('in-progress', defaultFolder, (id, folderId) =>
      call('POST', uploadUrl(agencyA), 'opVis', body(id, folderId)));

    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('CLIENT_ARCHIVED');
    expect(await owner.knex('media_assets').where({ client_id: clientId })).toHaveLength(0);
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

describe('the race with the archive of the client, in both of its windows (issue #253)', () => {
  // Every route that writes into the children of a client answers the 409 in both windows, with nothing written.
  const windows: ReadonlyArray<readonly [string, (table: 'media_folders' | 'media_assets') => ArchiveWindow]> = [
    ['the archive is still running (A0020 of the trigger)', () => 'in-progress'],
    ['the archive committed before the INSERT (42501 of the policy)', (table) => ({ committedBeforeInsert: table })]
  ];

  for (const [label, windowOf] of windows) {
    describe(`when ${label}`, () => {
      it('creating a first-level folder is a 409 and leaves no folder', async () => {
        const { clientId, reply } = await duringArchiveOfAFreshClient(windowOf('media_folders'), async () => undefined, (id) =>
          call('POST', foldersUrl(agencyA, id), 'opVis', { name: 'Chegou tarde' }));

        expectClientArchived(reply);
        expect(await owner.knex('media_folders').where({ client_id: clientId, is_default: false })).toHaveLength(0);
      });

      it('creating a folder inside a folder is a 409 and leaves only the parent', async () => {
        const { clientId, reply } = await duringArchiveOfAFreshClient(windowOf('media_folders'), (id) => firstLevelFolder(id, 'Pai'), (id, parentId) =>
          call('POST', foldersUrl(agencyA, id), 'opVis', { name: 'Filha tardia', parentId }));

        expectClientArchived(reply);
        expect((await owner.knex('media_folders').where({ client_id: clientId, is_default: false })).map((folder) => folder.name)).toEqual(['Pai']);
      });

      it('uploading into a folder is a 409 and leaves no media', async () => {
        const { clientId, reply } = await duringArchiveOfAFreshClient(windowOf('media_assets'), defaultFolder, (id, folderId) =>
          call('POST', `/agencies/${agencyA}/media/uploads`, 'opVis', {
            fileName: 'foto.png', contentType: 'image/png', declaredSizeBytes: 10, clientId: id, folderId
          }));

        expectClientArchived(reply);
        expect(await owner.knex('media_assets').where({ client_id: clientId })).toHaveLength(0);
      });

      it('removing a media is a 409, the media stays and no event is written', async () => {
        let seeded = { folder: '', asset: '' };
        const { reply } = await duringArchiveOfAFreshClient(
          windowOf('media_assets'),
          async (id) => {
            const folder = await defaultFolder(id);
            seeded = { folder, asset: await seedAsset(agencyA, id, folder) };
            return seeded;
          },
          (id, prepared) => call('POST', removeUrl(agencyA, id, prepared.folder, prepared.asset), 'opVis')
        );

        expectClientArchived(reply);
        expect(await removedAt(seeded.asset)).toBeNull();
        expect(await auditCount(seeded.asset)).toBe(0);
      });
    });
  }
});

describe('two removals of the same media at the same instant (issue #253, rule 12)', () => {
  it('both answer 200 and the audit has ONE media.removed: who audits is decided after the lock of the media', async () => {
    const folder = await defaultFolder(clientA1);
    const asset = await seedAsset(agencyA, clientA1, folder);

    const holder = await owner.knex.transaction();
    let released = false;
    try {
      const locked = await holder('media_assets').where({ id: asset }).forUpdate().select('id');
      expect(locked).toHaveLength(1);
      const both = Promise.all([
        call('POST', removeUrl(agencyA, clientA1, folder, asset), 'opVis'),
        call('POST', removeUrl(agencyA, clientA1, folder, asset), 'owner')
      ]);
      await waitUntilSomeoneWaitsOnALock(2);
      await holder.commit();
      released = true;

      for (const reply of await both) {
        expect(reply.statusCode).toBe(200);
        expect(reply.json()).toEqual({ assetId: asset, removed: true });
      }
    } finally {
      if (!released) await holder.rollback();
    }

    expect(await removedAt(asset)).toBeInstanceOf(Date);
    expect(await auditCount(asset)).toBe(1);
  });
});

describe('a page past the end answers the real total, not an empty library (issue #253)', () => {
  it('folders: page 9 is empty and still carries the count of the folders of the client', async () => {
    const total = await folderCount(clientA1);
    expect(total).toBeGreaterThanOrEqual(4);

    const past = await call('GET', `${foldersUrl(agencyA, clientA1)}?page=9`, 'opVis');
    expect(past.statusCode).toBe(200);
    expect(past.json().data).toEqual([]);
    expect(past.json().meta).toEqual({ page: 9, pageSize: 100, totalItems: total, totalPages: 1 });

    const smaller = await call('GET', `${foldersUrl(agencyA, clientA1)}?page=${total}&pageSize=3`, 'opVis');
    expect(smaller.json().data).toEqual([]);
    expect(smaller.json().meta).toEqual({ page: total, pageSize: 3, totalItems: total, totalPages: Math.ceil(total / 3) });
  });

  it('media: page 9 is empty, counts only the confirmed and not removed media and tells the folder is not empty', async () => {
    const folder = await defaultFolder(clientA2, 'Vídeos');
    await seedAsset(agencyA, clientA2, folder);
    await seedAsset(agencyA, clientA2, folder);
    await seedAsset(agencyA, clientA2, folder, { removed: true });
    await seedAsset(agencyA, clientA2, folder, { status: 'pending' });
    await seedAsset(agencyA, clientA2, folder, { status: 'rejected' });

    const past = await call('GET', `${assetsUrl(agencyA, clientA2, folder)}?page=9&pageSize=1`, 'opVis');

    expect(past.statusCode).toBe(200);
    expect(past.json().data).toEqual([]);
    expect(past.json().meta).toEqual({ page: 9, pageSize: 1, totalItems: 2, totalPages: 2 });
  });
});

describe('the order of the folders (issue #253)', () => {
  it('sorts the folders of the agency by name without telling accent or case apart, after the default ones', async () => {
    for (const name of ['Zebra', 'abril', 'Água', 'Ábaco']) expect((await call('POST', foldersUrl(agencyA, clientA2), 'opVis', { name })).statusCode).toBe(201);

    const listed = await call('GET', foldersUrl(agencyA, clientA2), 'opVis');

    expect(listed.json().data.map((folder: { name: string }) => folder.name))
      .toEqual(['Carrosséis', 'Ensaio fotográfico', 'Imagens', 'Vídeos', 'Ábaco', 'abril', 'Água', 'Zebra']);
  });
});

describe('a role with one permission alone, where the lock answers before the policy would (issue #253)', () => {
  it('creating a folder with a parent, or in an archived client, is a 403 and writes nothing, even for who only operates', async () => {
    const parent = await firstLevelFolder(clientA1, 'Pai da permissão');
    const archivedFolder = await defaultFolder(clientArchived);
    const before = [await folderCount(clientA1), await folderCount(clientArchived)];

    for (const as of ['onlyOperar', 'onlyVisualizar']) {
      for (const [clientId, payload] of [
        [clientA1, { name: 'Com pai', parentId: parent }],
        [clientArchived, { name: 'Em arquivado' }],
        [clientArchived, { name: 'Em arquivado com pai', parentId: archivedFolder }]
      ] as const) {
        const reply = await call('POST', foldersUrl(agencyA, clientId), as, payload);
        expect({ as, clientId, status: reply.statusCode, code: reply.json().error.code }).toEqual({ as, clientId, status: 403, code: 'FORBIDDEN' });
      }
    }
    expect([await folderCount(clientA1), await folderCount(clientArchived)]).toEqual(before);
  });

  it('removing a media of an archived client, or uploading into it, is a 403 for who only operates', async () => {
    const folder = await defaultFolder(clientArchived);
    const asset = await seedAsset(agencyA, clientArchived, folder);
    const before = await mediaCount(agencyA);

    for (const as of ['onlyOperar', 'onlyVisualizar']) {
      expect({ as, status: (await call('POST', removeUrl(agencyA, clientArchived, folder, asset), as)).statusCode }).toEqual({ as, status: 403 });
      expect({ as, status: (await call('POST', `/agencies/${agencyA}/media/uploads`, as, {
        fileName: 'foto.png', contentType: 'image/png', declaredSizeBytes: 10, clientId: clientArchived, folderId: folder
      })).statusCode }).toEqual({ as, status: 403 });
    }
    expect(await removedAt(asset)).toBeNull();
    expect(await mediaCount(agencyA)).toBe(before);
  });
});

describe('the folder that is not there answers the same body in every case (issue #253)', () => {
  it('names the folder when the parent is of another client, of another agency or absent', async () => {
    const parentOfA1 = await firstLevelFolder(clientA1, 'Pai alheio');
    const folderB = await defaultFolder(clientB);
    const before = [await folderCount(clientA1), await folderCount(clientA2), await folderCount(clientB)];

    for (const [clientId, parentId] of [[clientA2, parentOfA1], [clientA1, folderB], [clientA1, randomUUID()]] as const) {
      const reply = await call('POST', foldersUrl(agencyA, clientId), 'opVis', { name: 'Sem pai', parentId });
      expect({ clientId, parentId, status: reply.statusCode, error: reply.json().error }).toEqual({
        clientId, parentId, status: 404, error: { code: 'NOT_FOUND', message: 'Folder not found.' }
      });
    }
    expect([await folderCount(clientA1), await folderCount(clientA2), await folderCount(clientB)]).toEqual(before);
  });
});

describe('what the database raises inside the writes is never a 500 the route knows (issue #253)', () => {
  // A trigger of the test plays the lost race: a deadlock or a serialization failure raised by the statement.
  const withFailing = async (table: 'media_folders' | 'media_assets', event: 'insert' | 'update', condition: string, errcode: string, run: () => Promise<void>): Promise<void> => {
    const name = `zz_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await owner.knex.raw(`
      create function public.${name}() returns trigger language plpgsql as $$
      begin
        if ${condition} then raise exception 'injected failure' using errcode = '${errcode}'; end if;
        return new;
      end $$;
      create trigger ${name} before ${event} on public.${table} for each row execute function public.${name}();
    `);
    try {
      await run();
    } finally {
      await owner.knex.raw(`drop trigger if exists ${name} on public.${table}; drop function if exists public.${name}();`);
    }
  };

  const uploadBody = { fileName: 'foto.png', contentType: 'image/png', declaredSizeBytes: 10 };

  it.each([['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'creating a folder that fails with %s answers %i %s, leaves nothing and works when repeated',
    async (errcode, status, code) => {
      const before = await folderCount(clientA1);

      await withFailing('media_folders', 'insert', `new.name = 'Falha injetada ${errcode}'`, errcode, async () => {
        const failed = await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: `Falha injetada ${errcode}` });
        expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
        expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
      });

      expect(await folderCount(clientA1)).toBe(before);
      expect((await call('POST', foldersUrl(agencyA, clientA1), 'opVis', { name: `Falha injetada ${errcode}` })).statusCode).toBe(201);
    }
  );

  it.each([['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'uploading into a folder that fails with %s answers %i %s and leaves no media',
    async (errcode, status, code) => {
      const folder = await defaultFolder(clientA1);
      const before = await mediaCount(agencyA);

      await withFailing('media_assets', 'insert', `new.client_id = '${clientA1}'::uuid`, errcode, async () => {
        const failed = await call('POST', `/agencies/${agencyA}/media/uploads`, 'opVis', { ...uploadBody, clientId: clientA1, folderId: folder });
        expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
        expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
      });

      expect(await mediaCount(agencyA)).toBe(before);
    }
  );

  it.each([['40P01', 409, 'TRY_AGAIN'], ['40001', 409, 'TRY_AGAIN'], ['XX000', 500, 'INTERNAL_ERROR']] as const)(
    'removing a media that fails with %s answers %i %s, the media stays, nothing is audited and repeating works',
    async (errcode, status, code) => {
      const folder = await defaultFolder(clientA1);
      const asset = await seedAsset(agencyA, clientA1, folder);

      await withFailing('media_assets', 'update', `new.id = '${asset}'::uuid`, errcode, async () => {
        const failed = await call('POST', removeUrl(agencyA, clientA1, folder, asset), 'opVis');
        expect({ status: failed.statusCode, code: failed.json().error.code }).toEqual({ status, code });
        expect(JSON.stringify(failed.json())).not.toMatch(NO_DATABASE_DETAIL);
      });

      expect(await removedAt(asset)).toBeNull();
      expect(await auditCount(asset)).toBe(0);
      expect((await call('POST', removeUrl(agencyA, clientA1, folder, asset), 'opVis')).statusCode).toBe(200);
      expect(await auditCount(asset)).toBe(1);
    }
  );
});
