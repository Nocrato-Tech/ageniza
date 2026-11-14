import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import { buildTestApp, insertTestUser, ownerClient, TEST_APP_PUBLIC_URL, type TestApp, type TestUserFixture } from '../auth/test-support/harness.js';

// Decisions 2026-11-11 "a mídia ganha nome, dimensões, texto alternativo, renomear e mover" and "a mídia mostra onde é usada": the
// client's library across folders, one file with where it is used, its edit and its move, and the folders with what they hold. Every
// permission is held alone by a custom role, and every refusal is checked by the state it leaves in the database.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const agencyD = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientArchived = randomUUID();
const clientB = randomUUID();
const clientD = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const assetIds: string[] = [];
const contentIds: string[] = [];
const extraClientIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};
const agencyOfClient = new Map<string, string>([[clientA1, agencyA], [clientA2, agencyA], [clientArchived, agencyA], [clientB, agencyB], [clientD, agencyD]]);

const cookieOf = (response: { cookies: readonly { name: string; value: string }[] }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, as?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(as === undefined ? {} : { cookie: cookies[as]! }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const clientUrl = (agency: string, client: string): string => `/agencies/${agency}/clients/${client}`;
const libraryUrl = (client: string, agency = agencyA): string => `${clientUrl(agency, client)}/media`;
const assetUrl = (client: string, asset: string, agency = agencyA): string => `${libraryUrl(client, agency)}/${asset}`;
const summaryUrl = (client: string, agency = agencyA): string => `${clientUrl(agency, client)}/media-folders/summary`;
const folderUrl = (client: string, folder: string, agency = agencyA): string => `${clientUrl(agency, client)}/media-folders/${folder}`;

const freshClient = async (agencyId = agencyA): Promise<string> => {
  const id = randomUUID();
  extraClientIds.push(id);
  agencyOfClient.set(id, agencyId);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: `Cliente ${id}` });
  return id;
};

const folderOf = async (clientId: string, name: string): Promise<string> =>
  (await owner.knex('media_folders').where({ client_id: clientId, name, is_default: true }).first('id')).id as string;

const customFolder = async (clientId: string, name: string, parentId: string | null = null): Promise<string> => {
  const id = randomUUID();
  await owner.knex('media_folders').insert({ id, client_id: clientId, parent_id: parentId, name, is_default: false });
  return id;
};

const TYPES = {
  image: { contentType: 'image/png', extension: 'png' },
  video: { contentType: 'video/mp4', extension: 'mp4' },
  pdf: { contentType: 'application/pdf', extension: 'pdf' },
  audio: { contentType: 'audio/mpeg', extension: 'mp3' },
  logo: { contentType: 'image/png', extension: 'png' }
} as const;

interface Seed {
  readonly clientId: string;
  readonly folderId?: string;
  readonly folder?: string;
  readonly category?: keyof typeof TYPES;
  readonly name?: string | null;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
  readonly size?: number;
  readonly at?: Date;
  readonly by?: string;
  readonly status?: 'confirmed' | 'pending' | 'rejected';
  readonly removedAt?: Date;
}

const seedAsset = async (seed: Seed): Promise<string> => {
  const id = randomUUID();
  const agencyId = agencyOfClient.get(seed.clientId)!;
  const category = seed.category ?? 'image';
  const { contentType, extension } = TYPES[category];
  const status = seed.status ?? 'confirmed';
  const size = seed.size ?? 1_000;
  const at = seed.at ?? new Date();
  assetIds.push(id);
  await owner.knex('media_assets').insert({
    id,
    agency_id: agencyId,
    client_id: seed.clientId,
    folder_id: seed.folderId ?? await folderOf(seed.clientId, seed.folder ?? 'Imagens'),
    category,
    declared_content_type: contentType,
    extension,
    object_key: `${agencyId}/${id}/original.${extension}`,
    upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
    declared_size_bytes: size,
    created_by_user_id: users[seed.by ?? 'owner']!.id,
    created_at: at,
    updated_at: at,
    ...(seed.name === undefined ? { file_name: `${id.slice(0, 8)}.${extension}` } : { file_name: seed.name }),
    ...(seed.width === undefined ? {} : { width: seed.width, height: seed.height }),
    ...(seed.altText === undefined ? {} : { alt_text: seed.altText }),
    ...(status === 'confirmed' ? { status, confirmed_size_bytes: size, confirmed_content_type: contentType, confirmed_at: at } : {}),
    ...(status === 'rejected' ? { status, rejected_reason: 'content_type_mismatch' } : {}),
    ...(seed.removedAt === undefined ? {} : { removed_at: seed.removedAt })
  });
  return id;
};

const seedContent = async (
  clientId: string,
  status: 'in_production' | 'awaiting_approval' | 'approved' | 'published',
  folderId: string,
  use: { readonly assetId: string; readonly asMedia?: boolean; readonly asCover?: boolean },
  extra: { readonly title?: string; readonly publishOn?: string } = {}
): Promise<string> => {
  const id = randomUUID();
  contentIds.push(id);
  const approved = status === 'approved' || status === 'published';
  await owner.knex('contents').insert({
    id,
    client_id: clientId,
    title: extra.title ?? `Conteúdo ${id.slice(0, 8)}`,
    platform: 'instagram',
    format: 'image',
    publish_on: extra.publishOn ?? '2026-10-20',
    folder_id: folderId,
    owner_user_id: users.opVis!.id,
    status,
    ...(use.asCover === true ? { cover_asset_id: use.assetId } : {}),
    ...(approved ? { approved_by: users.owner!.id, approved_at: new Date() } : {}),
    ...(status === 'published' ? { published_on: '2026-10-06', published_at: new Date() } : {})
  });
  if (use.asMedia !== false) {
    await owner.knex('content_media').insert({ content_id: id, asset_id: use.assetId, client_id: clientId, folder_id: folderId, position: 1 });
  }
  return id;
};

/** The whole row, so that a refusal can be shown to have written nothing. */
const snapshot = async (assetId: string): Promise<string> =>
  JSON.stringify(await owner.knex('media_assets').where({ id: assetId }).first());

const folderSnapshot = async (folderId: string): Promise<string> =>
  JSON.stringify(await owner.knex('media_folders').where({ id: folderId }).first());

const auditCount = async (action: string, targetId: string): Promise<number> =>
  Number((await owner.knex('audit.events').where({ action, target_id: targetId }).count<{ count: string }[]>('id as count'))[0]?.count);

const membershipOf = async (userKey: string, agencyId = agencyA): Promise<string> =>
  (await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: users[userKey]!.id }).first('id')).id as string;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;

const expectError = (reply: Reply, statusCode: number, code: string, message?: string): void => {
  expect(reply.statusCode).toBe(statusCode);
  expect(reply.json().error.code).toBe(code);
  if (message !== undefined) expect(reply.json().error.message).toBe(message);
  expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
};

const expectNotFound = (reply: Reply, message: string): void => expectError(reply, 404, 'NOT_FOUND', message);

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();

  const makeUser = async (key: string): Promise<void> => {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `library-${key.toLowerCase()}`, name: key });
    userIds.push(user.id);
    users[key] = user;
  };
  for (const key of ['owner', 'ownerB', 'ownerD', 'opVis', 'onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales', 'both']) await makeUser(key);

  await owner.knex('agencies').insert([
    { id: agencyA, name: `Library A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Library B ${agencyB}`, owner_user_id: users.ownerB!.id },
    { id: agencyD, name: `Library D ${agencyD}`, owner_user_id: users.ownerD!.id }
  ]);
  await owner.knex('clients').insert([
    { id: clientA1, agency_id: agencyA, name: `Cliente A1 ${clientA1}` },
    { id: clientA2, agency_id: agencyA, name: `Cliente A2 ${clientA2}` },
    { id: clientArchived, agency_id: agencyA, name: `Cliente arquivado ${clientArchived}` },
    { id: clientB, agency_id: agencyB, name: `Cliente B ${clientB}` },
    { id: clientD, agency_id: agencyD, name: `Cliente D ${clientD}` }
  ]);

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
    { agency_id: agencyA, user_id: users.sales!.id, role_id: sales },
    // Holds the two permissions in two agencies: RLS shows it the client of the other agency, so only the route can refuse it.
    { agency_id: agencyA, user_id: users.both!.id, role_id: await customRole(agencyA, 'conteudo.operar', 'conteudo.visualizar') },
    { agency_id: agencyB, user_id: users.both!.id, role_id: await customRole(agencyB, 'conteudo.operar', 'conteudo.visualizar') }
  ]);
  await owner.knex('clients').where({ id: clientArchived }).update({ status: 'archived', archived_at: new Date() });
  await owner.knex('agencies').where({ id: agencyD }).update({
    plan: 'trial',
    trial_ends_at: owner.knex.raw("now() - interval '1 minute'"),
    trial_owner_email_key: owner.knex.raw('coalesce(trial_owner_email_key, id::text)')
  });

  for (const key of Object.keys(users)) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode).toBe(200);
    cookies[key] = cookieOf(response);
  }
}, 60_000);

afterAll(async () => {
  const agencies = [agencyA, agencyB, agencyD];
  const clients = [clientA1, clientA2, clientArchived, clientB, clientD, ...extraClientIds];
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

describe('the library of a client, across its folders', () => {
  it('lists the confirmed files of the client newest first, with what the screen shows of each', async () => {
    const client = await freshClient();
    const day = (n: number): Date => new Date(`2026-11-0${n}T12:00:00Z`);
    const capa = await seedAsset({ clientId: client, name: 'Capa.png', width: 1200, height: 800, altText: 'Capa da campanha', size: 2_048, at: day(1), by: 'opVis' });
    const manual = await seedAsset({ clientId: client, folder: 'Carrosséis', category: 'pdf', name: 'Manual.pdf', size: 5_000, at: day(2) });
    const musica = await seedAsset({ clientId: client, folder: 'Vídeos', category: 'audio', name: 'Trilha.mp3', size: 9_000, at: day(3), by: 'opVis' });
    // None of these is a file of this library.
    await seedAsset({ clientId: client, status: 'pending', name: 'pendente.png' });
    await seedAsset({ clientId: client, status: 'rejected', name: 'recusado.png' });
    await seedAsset({ clientId: client, name: 'removido.png', removedAt: new Date() });
    await seedAsset({ clientId: clientA2, name: 'de-outro-cliente.png' });
    await seedAsset({ clientId: clientB, name: 'de-outra-agencia.png' });

    const response = await call('GET', libraryUrl(client), 'opVis');

    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toEqual({ page: 1, pageSize: 48, totalItems: 3, totalPages: 1 });
    expect(response.json().data.map((item: { id: string }) => item.id)).toEqual([musica, manual, capa]);
    expect(response.json().data[2]).toEqual({
      id: capa,
      folderId: await folderOf(client, 'Imagens'),
      folderName: 'Imagens',
      category: 'image',
      contentType: 'image/png',
      sizeBytes: 2_048,
      name: 'Capa.png',
      width: 1200,
      height: 800,
      altText: 'Capa da campanha',
      videoProcessingStatus: 'not_applicable',
      uploadedBy: { membershipId: await membershipOf('opVis'), name: 'opVis' },
      uploadedBySide: 'agency',
      createdAt: day(1).toISOString(),
      usageCount: 0
    });
    expect(response.json().data[1]).toMatchObject({ category: 'pdf', folderName: 'Carrosséis', width: null, height: null, altText: null, uploadedBy: null });
    expect(response.json().data[0]).toMatchObject({ category: 'audio', folderName: 'Vídeos', contentType: 'audio/mpeg' });
    expect(JSON.stringify(response.json())).not.toMatch(/object_?key|upload_?key|original\./i);
  });

  it('pages the list and counts the total on a page past the end', async () => {
    const client = await freshClient();
    for (let n = 1; n <= 5; n += 1) await seedAsset({ clientId: client, name: `arquivo-${n}.png`, at: new Date(`2026-11-0${n}T12:00:00Z`) });

    const second = await call('GET', `${libraryUrl(client)}?page=2&pageSize=2`, 'opVis');
    expect(second.json().data.map((item: { name: string }) => item.name)).toEqual(['arquivo-3.png', 'arquivo-2.png']);
    expect(second.json().meta).toEqual({ page: 2, pageSize: 2, totalItems: 5, totalPages: 3 });

    const past = await call('GET', `${libraryUrl(client)}?page=9&pageSize=2`, 'opVis');
    expect(past.json().data).toEqual([]);
    expect(past.json().meta).toEqual({ page: 9, pageSize: 2, totalItems: 5, totalPages: 3 });
  });

  it('searches by the name ignoring case and accents, taking % and _ as the plain characters they are', async () => {
    const client = await freshClient();
    const named = async (name: string | null, n: number): Promise<string> =>
      seedAsset({ clientId: client, name, at: new Date(`2026-11-0${n}T12:00:00Z`) });
    await named('Relatório Março.pdf', 1);
    await named('relatorio_final.pdf', 2);
    await named('100% real.png', 3);
    await named('a_b.png', 4);
    await named('axb.png', 5);
    await named(null, 6);
    const search = async (q: string): Promise<string[]> => {
      const response = await call('GET', `${libraryUrl(client)}?q=${encodeURIComponent(q)}`, 'opVis');
      expect(response.statusCode).toBe(200);
      return response.json().data.map((item: { name: string }) => item.name).sort();
    };

    expect(await search('relatorio')).toEqual(['Relatório Março.pdf', 'relatorio_final.pdf']);
    expect(await search('RELATÓRIO')).toEqual(['Relatório Março.pdf', 'relatorio_final.pdf']);
    expect(await search('março')).toEqual(['Relatório Março.pdf']);
    expect(await search('%')).toEqual(['100% real.png']);
    expect(await search('_')).toEqual(['a_b.png', 'relatorio_final.pdf']);
    expect(await search('a_b')).toEqual(['a_b.png']);
    expect(await search('\\')).toEqual([]);
    expect(await search('\\a')).toEqual([]);
    expect(await search("' or 1=1 --")).toEqual([]);
    expect(await search('zzz')).toEqual([]);
    // A blank search is no search, and a file with no name is only in the list that is not searched.
    expect((await call('GET', `${libraryUrl(client)}?q=%20%20`, 'opVis')).json().meta.totalItems).toBe(6);
    expect((await call('GET', libraryUrl(client), 'opVis')).json().meta.totalItems).toBe(6);
  });

  it('refuses a search that is too long or holds a control character, and a parameter nobody defined', async () => {
    for (const query of [`q=${'x'.repeat(101)}`, `q=${encodeURIComponent('a\u0000b')}`, `q=${encodeURIComponent('a\nb')}`, 'sort=name', 'category=document', 'folderId=not-a-uuid', 'page=1e20']) {
      expect({ query, status: (await call('GET', `${libraryUrl(clientA1)}?${query}`, 'opVis')).statusCode }).toEqual({ query, status: 400 });
    }
  });

  it('filters by the category and by the folder', async () => {
    const client = await freshClient();
    const imagens = await folderOf(client, 'Imagens');
    const image = await seedAsset({ clientId: client, name: 'foto.png' });
    const pdf = await seedAsset({ clientId: client, category: 'pdf', name: 'a.pdf', folder: 'Carrosséis' });
    const logo = await seedAsset({ clientId: client, category: 'logo', name: 'logo.png', width: 10, height: 10 });
    const ids = async (query: string): Promise<string[]> =>
      (await call('GET', `${libraryUrl(client)}?${query}`, 'opVis')).json().data.map((item: { id: string }) => item.id).sort();

    expect(await ids('category=pdf')).toEqual([pdf]);
    expect(await ids('category=logo')).toEqual([logo]);
    expect(await ids('category=audio')).toEqual([]);
    expect(await ids(`folderId=${imagens}`)).toEqual([image, logo].sort());
    expect(await ids(`folderId=${imagens}&category=image`)).toEqual([image]);
  });

  it('answers the same 404 for the folder of another client, of another agency and an absent one', async () => {
    const otherClient = await folderOf(clientA2, 'Imagens');
    const otherAgency = await folderOf(clientB, 'Imagens');
    for (const folder of [otherClient, otherAgency, randomUUID()]) {
      expectNotFound(await call('GET', `${libraryUrl(clientA1)}?folderId=${folder}`, 'opVis'), 'Folder not found.');
    }
  });

  it('still reads the library of an archived client', async () => {
    await seedAsset({ clientId: clientArchived, name: 'arquivado.png' });
    const response = await call('GET', libraryUrl(clientArchived), 'opVis');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.length).toBeGreaterThan(0);
  });

  it('does not list a PDF, an audio or a logo among the files of a folder the content screens pick from', async () => {
    const client = await freshClient();
    const image = await seedAsset({ clientId: client, name: 'foto.png' });
    await seedAsset({ clientId: client, category: 'pdf', name: 'a.pdf' });
    await seedAsset({ clientId: client, category: 'audio', name: 'a.mp3' });
    await seedAsset({ clientId: client, category: 'logo', name: 'logo.png', width: 10, height: 10 });

    const response = await call('GET', `${clientUrl(agencyA, client)}/media-folders/${await folderOf(client, 'Imagens')}/assets`, 'opVis');

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((item: { id: string }) => item.id)).toEqual([image]);
  });
});

describe('who reads the library', () => {
  const client = clientA1;
  let asset: string;
  beforeAll(async () => { asset = await seedAsset({ clientId: client, name: 'quem-le.png' }); });

  const reads = (clientId: string, assetId: string, agency = agencyA): string[] => [
    libraryUrl(clientId, agency),
    summaryUrl(clientId, agency),
    assetUrl(clientId, assetId, agency),
    `${assetUrl(clientId, assetId, agency)}/usage`
  ];

  it('is for who reads Conteúdo, whichever the role, and for nobody without a session', async () => {
    for (const url of reads(client, asset)) {
      for (const as of ['onlyOperar', 'onlyMidia', 'sales']) expect({ url, as, status: (await call('GET', url, as)).statusCode }).toEqual({ url, as, status: 403 });
      for (const as of ['onlyVisualizar', 'opVis', 'owner']) expect({ url, as, status: (await call('GET', url, as)).statusCode }).toEqual({ url, as, status: 200 });
      expect({ url, status: (await call('GET', url)).statusCode }).toEqual({ url, status: 401 });
    }
  });

  it('answers the same 404 for a client of another agency, an absent one and a malformed id, on every read', async () => {
    const otherAssetOfB = await seedAsset({ clientId: clientB, name: 'b.png' });
    for (const [clientId, assetId] of [[clientB, otherAssetOfB], [randomUUID(), asset], ['not-a-uuid', asset]] as const) {
      for (const url of reads(clientId, assetId)) expectNotFound(await call('GET', url, 'opVis'), 'Client not found.');
    }
    // Who belongs to both agencies is refused by the route, though the database would show it the other agency's client.
    for (const url of reads(clientB, otherAssetOfB)) expectNotFound(await call('GET', url, 'both'), 'Client not found.');
    // And the other agency's owner has no way in through this agency.
    for (const url of reads(client, asset)) expect([404, 403]).toContain((await call('GET', url, 'ownerB')).statusCode);
  });

  it('answers the same 404 for a file of another client, of another agency, an absent one and a malformed id', async () => {
    const ofOtherClient = await seedAsset({ clientId: clientA2, name: 'a2.png' });
    const ofOtherAgency = await seedAsset({ clientId: clientB, name: 'b2.png' });
    for (const assetId of [ofOtherClient, ofOtherAgency, randomUUID(), 'not-a-uuid']) {
      for (const url of [assetUrl(client, assetId), `${assetUrl(client, assetId)}/usage`]) expectNotFound(await call('GET', url, 'opVis'), 'Media asset not found.');
    }
  });

  it('answers the same 404 for a file that is pending, rejected or removed', async () => {
    for (const seed of [{ status: 'pending' as const }, { status: 'rejected' as const }, { removedAt: new Date() }]) {
      const hidden = await seedAsset({ clientId: client, name: 'oculto.png', ...seed });
      expectNotFound(await call('GET', assetUrl(client, hidden), 'opVis'), 'Media asset not found.');
    }
  });
});

describe('one file of the library and where it is used', () => {
  it('shows the file as the list does, with the number of contents that hold it as a media or as the cover', async () => {
    const client = await freshClient();
    const imagens = await folderOf(client, 'Imagens');
    const asset = await seedAsset({ clientId: client, name: 'em-uso.png', width: 640, height: 480, by: 'opVis' });
    await seedContent(client, 'in_production', imagens, { assetId: asset });
    // As the media and as the cover of the same content it is one content.
    await seedContent(client, 'approved', imagens, { assetId: asset, asCover: true });
    await seedContent(client, 'awaiting_approval', imagens, { assetId: asset, asCover: true, asMedia: false });

    const detail = await call('GET', assetUrl(client, asset), 'opVis');

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: asset, name: 'em-uso.png', width: 640, height: 480, usageCount: 3, folderName: 'Imagens' });
    const listed = await call('GET', libraryUrl(client), 'opVis');
    expect(listed.json().data[0]).toEqual(detail.json());
  });

  it('lists the contents that hold it, with their state and in which role, newest day first', async () => {
    const client = await freshClient();
    const imagens = await folderOf(client, 'Imagens');
    const asset = await seedAsset({ clientId: client, name: 'usada.png' });
    const asMedia = await seedContent(client, 'in_production', imagens, { assetId: asset }, { title: 'Só mídia', publishOn: '2026-10-10' });
    const asCoverOnly = await seedContent(client, 'awaiting_approval', imagens, { assetId: asset, asCover: true, asMedia: false }, { title: 'Só capa', publishOn: '2026-10-20' });
    const both = await seedContent(client, 'published', imagens, { assetId: asset, asCover: true }, { title: 'Mídia e capa', publishOn: '2026-10-15' });
    const notUsing = await seedAsset({ clientId: client, name: 'outra.png' });
    await seedContent(client, 'in_production', imagens, { assetId: notUsing });

    const usage = await call('GET', `${assetUrl(client, asset)}/usage`, 'opVis');

    expect(usage.statusCode).toBe(200);
    expect(usage.json().meta).toEqual({ page: 1, pageSize: 100, totalItems: 3, totalPages: 1 });
    expect(usage.json().data).toEqual([
      { contentId: asCoverOnly, title: 'Só capa', status: 'awaiting_approval', asMedia: false, asCover: true },
      { contentId: both, title: 'Mídia e capa', status: 'published', asMedia: true, asCover: true },
      { contentId: asMedia, title: 'Só mídia', status: 'in_production', asMedia: true, asCover: false }
    ]);
    expect((await call('GET', `${assetUrl(client, asset)}/usage?page=2&pageSize=2`, 'opVis')).json().data.map((item: { contentId: string }) => item.contentId)).toEqual([asMedia]);
  });

  it('says nothing for a file that no content holds', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'solta.png' });

    const usage = await call('GET', `${assetUrl(client, asset)}/usage`, 'opVis');

    expect(usage.json().data).toEqual([]);
    expect(usage.json().meta.totalItems).toBe(0);
  });
});

describe('the folders with what they hold', () => {
  it('counts the files by type, their size, the last change and who uploaded the newest, leaving out the removed ones', async () => {
    const client = await freshClient();
    const custom = await customFolder(client, 'Campanhas');
    // After the creation of the folders, which is the last change of an empty one.
    const at = (n: number): Date => new Date(`2027-01-0${n}T12:00:00Z`);
    await seedAsset({ clientId: client, folder: 'Imagens', name: 'a.png', size: 100, at: at(1), by: 'onlyOperar' });
    await seedAsset({ clientId: client, folder: 'Imagens', name: 'b.png', size: 200, at: at(2) });
    await seedAsset({ clientId: client, folder: 'Imagens', category: 'pdf', name: 'c.pdf', size: 50, at: at(3), by: 'opVis' });
    await seedAsset({ clientId: client, folder: 'Vídeos', category: 'video', name: 'v.mp4', size: 1_000, at: at(4) });
    await seedAsset({ clientId: client, folder: 'Vídeos', category: 'audio', name: 'gone.mp3', size: 7, at: at(1), removedAt: at(6) });
    await seedAsset({ clientId: client, folderId: custom, category: 'logo', name: 'logo.png', width: 5, height: 5, size: 30, at: at(5), by: 'opVis' });
    await seedAsset({ clientId: client, folder: 'Imagens', name: 'pendente.png', status: 'pending', size: 999_999 });

    const response = await call('GET', summaryUrl(client), 'opVis');

    expect(response.statusCode).toBe(200);
    const byName = Object.fromEntries(response.json().data.map((folder: { name: string }) => [folder.name, folder]));
    expect(response.json().data.map((folder: { name: string }) => folder.name)).toEqual(['Carrosséis', 'Ensaio fotográfico', 'Imagens', 'Vídeos', 'Campanhas']);
    expect(byName.Imagens).toMatchObject({
      isDefault: true,
      parentId: null,
      counts: { image: 2, video: 0, pdf: 1, audio: 0, logo: 0 },
      assetCount: 3,
      totalSizeBytes: 350,
      lastChangedAt: at(3).toISOString(),
      lastUploadedBy: { membershipId: await membershipOf('opVis'), name: 'opVis' }
    });
    // The file removed on the 6th is the last thing that happened in this folder, and it is no longer counted.
    expect(byName['Vídeos']).toMatchObject({ counts: { image: 0, video: 1, pdf: 0, audio: 0, logo: 0 }, assetCount: 1, totalSizeBytes: 1_000, lastChangedAt: at(6).toISOString(), lastUploadedBy: null });
    expect(byName.Campanhas).toMatchObject({ isDefault: false, counts: { logo: 1 }, assetCount: 1, totalSizeBytes: 30, lastUploadedBy: { name: 'opVis' } });
    expect(byName['Carrosséis']).toMatchObject({ counts: { image: 0, video: 0, pdf: 0, audio: 0, logo: 0 }, assetCount: 0, totalSizeBytes: 0, lastUploadedBy: null });
    expect(byName['Carrosséis'].lastChangedAt).toBe(byName['Carrosséis'].createdAt);
    expect(response.json().meta).toEqual({ page: 1, pageSize: 100, totalItems: 5, totalPages: 1 });
  });

  it('holds only the files of the client asked for', async () => {
    const client = await freshClient();
    await seedAsset({ clientId: clientA2, name: 'outro.png', size: 5_000 });
    await seedAsset({ clientId: clientB, name: 'outra-agencia.png', size: 5_000 });

    const response = await call('GET', summaryUrl(client), 'opVis');

    expect(response.json().data.every((folder: { assetCount: number }) => folder.assetCount === 0)).toBe(true);
  });

  it('pages the folders', async () => {
    const client = await freshClient();
    const second = await call('GET', `${summaryUrl(client)}?page=2&pageSize=3`, 'opVis');
    expect(second.json().data.map((folder: { name: string }) => folder.name)).toEqual(['Vídeos']);
    expect(second.json().meta).toEqual({ page: 2, pageSize: 3, totalItems: 4, totalPages: 2 });
  });
});

describe('the folder in use now: the one of the client, not a default one, with the file written most recently, in the last 30 days', () => {
  const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);
  const inUse = async (client: string, as = 'opVis'): Promise<string[]> => {
    const response = await call('GET', summaryUrl(client), as);
    expect(response.statusCode).toBe(200);
    return response.json().data.filter((folder: { inUseNow: boolean }) => folder.inUseNow).map((folder: { name: string }) => folder.name);
  };

  it('is the folder the agency made whose files changed last, and only that one', async () => {
    const client = await freshClient();
    const older = await customFolder(client, 'Campanha antiga');
    const newer = await customFolder(client, 'Campanha de agora');
    await seedAsset({ clientId: client, folderId: older, at: daysAgo(10) });
    await seedAsset({ clientId: client, folderId: newer, at: daysAgo(2) });
    await seedAsset({ clientId: client, folderId: newer, at: daysAgo(20) });

    expect(await inUse(client)).toEqual(['Campanha de agora']);
  });

  it('is never a default folder, however recent its files are', async () => {
    const client = await freshClient();
    await seedAsset({ clientId: client, folder: 'Imagens', at: new Date() });
    await seedAsset({ clientId: client, folder: 'Vídeos', category: 'video', at: daysAgo(1) });
    const custom = await customFolder(client, 'Campanha');
    await seedAsset({ clientId: client, folderId: custom, at: daysAgo(25) });

    expect(await inUse(client)).toEqual(['Campanha']);
  });

  it('is none when nothing was written in the last 30 days, and the whole day counts either side of the limit', async () => {
    const client = await freshClient();
    const inside = await customFolder(client, 'Dentro');
    const outside = await customFolder(client, 'Fora');
    await seedAsset({ clientId: client, folderId: outside, at: new Date(Date.now() - 30 * 86_400_000 - 3_600_000) });
    expect(await inUse(client)).toEqual([]);

    await seedAsset({ clientId: client, folderId: inside, at: new Date(Date.now() - 30 * 86_400_000 + 3_600_000) });
    expect(await inUse(client)).toEqual(['Dentro']);
  });

  it('is none for a client with no folder of its own, and for one that only has files in the default ones', async () => {
    const bare = await freshClient();
    expect(await inUse(bare)).toEqual([]);
    const defaults = await freshClient();
    await seedAsset({ clientId: defaults, at: new Date() });
    expect(await inUse(defaults)).toEqual([]);
  });

  it('counts the files that are still in the folder: a removed file, an upload that is pending and one that was rejected do not', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Só histórico');
    await seedAsset({ clientId: client, folderId: folder, at: daysAgo(1), removedAt: daysAgo(1) });
    await seedAsset({ clientId: client, folderId: folder, at: daysAgo(1), status: 'pending' });
    await seedAsset({ clientId: client, folderId: folder, at: daysAgo(1), status: 'rejected' });
    expect(await inUse(client)).toEqual([]);

    await seedAsset({ clientId: client, folderId: folder, at: daysAgo(3) });
    expect(await inUse(client)).toEqual(['Só histórico']);
  });

  it('follows a rename of a file and the move of a file into the folder', async () => {
    const client = await freshClient();
    const renamed = await customFolder(client, 'Renomeada');
    const target = await customFolder(client, 'Destino');
    const old = await seedAsset({ clientId: client, folderId: renamed, at: daysAgo(40) });
    const stale = await seedAsset({ clientId: client, folderId: await folderOf(client, 'Imagens'), at: daysAgo(50) });
    await seedAsset({ clientId: client, folderId: target, at: daysAgo(45) });
    expect(await inUse(client)).toEqual([]);

    expect((await call('PATCH', assetUrl(client, old), 'opVis', { name: 'Novo nome.png' })).statusCode).toBe(200);
    expect(await inUse(client)).toEqual(['Renomeada']);

    expect((await call('POST', `${assetUrl(client, stale)}/move`, 'opVis', { folderId: target })).statusCode).toBe(200);
    expect(await inUse(client)).toEqual(['Destino']);
  });

  it('does not follow the alternative text, a name written as it was, or any other write of the row: only the upload, the rename and the move file a file', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Antiga');
    const asset = await seedAsset({ clientId: client, folderId: folder, name: 'fixo.png', at: daysAgo(40) });

    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { altText: 'Texto novo' })).statusCode).toBe(200);
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { altText: null })).statusCode).toBe(200);
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { name: 'fixo.png' })).statusCode).toBe(200);
    // What the processing of a video does to the row: it writes it, and files nothing.
    await owner.knex('media_assets').where({ id: asset }).update({ updated_at: new Date() });
    expect(await inUse(client)).toEqual([]);

    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { name: 'novo.png' })).statusCode).toBe(200);
    expect(await inUse(client)).toEqual(['Antiga']);
  });

  it('is the folder of a file that was confirmed a moment ago, since the upload is what files it', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Enviada agora');
    const asset = await seedAsset({ clientId: client, folderId: folder, status: 'pending', at: daysAgo(40) });
    expect(await inUse(client)).toEqual([]);

    await owner.knex('media_assets').where({ id: asset }).update({ status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', confirmed_at: new Date() });

    expect(await inUse(client)).toEqual(['Enviada agora']);
  });

  it('holds only the folders of the client asked for', async () => {
    const busy = await freshClient();
    const quiet = await freshClient();
    await seedAsset({ clientId: busy, folderId: await customFolder(busy, 'Movimentada'), at: new Date() });
    await customFolder(quiet, 'Parada');
    await seedAsset({ clientId: clientB, folderId: await customFolder(clientB, 'De outra agência'), at: new Date() });

    expect(await inUse(busy)).toEqual(['Movimentada']);
    expect(await inUse(quiet)).toEqual([]);
  });

  it('is the same for who reads Conteúdo, whichever the role', async () => {
    const client = await freshClient();
    await seedAsset({ clientId: client, folderId: await customFolder(client, 'Campanha'), at: new Date() });
    expect(await inUse(client, 'onlyVisualizar')).toEqual(['Campanha']);
    expect(await inUse(client, 'owner')).toEqual(['Campanha']);
  });
});

describe('deleting a folder: one that is not a default one and is empty', () => {
  const folderCount = async (folderId: string): Promise<number> =>
    Number((await owner.knex('media_folders').where({ id: folderId }).count<{ count: string }[]>('id as count'))[0]?.count);
  const FILES_MESSAGE = 'Esta pasta tem arquivos. Mova ou exclua os arquivos antes.';

  it('deletes an empty folder the agency made, answering 204 with nothing, and records who did it', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Campanhas');
    const neighbour = await customFolder(client, 'Outra');

    const response = await call('DELETE', folderUrl(client, folder), 'opVis');

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(await folderCount(folder)).toBe(0);
    expect(await folderCount(neighbour)).toBe(1);
    expect(await owner.knex('audit.events').where({ action: 'media.folder_deleted', target_id: folder }).select('actor_user_id', 'agency_id', 'target_type'))
      .toEqual([{ actor_user_id: users.opVis!.id, agency_id: agencyA, target_type: 'media_folder' }]);
    expect((await call('GET', `${clientUrl(agencyA, client)}/media-folders`, 'opVis')).json().data.map((item: { id: string }) => item.id)).not.toContain(folder);
  });

  it('lets the Admin of the agency delete it too, and a folder inside another', async () => {
    const client = await freshClient();
    const parent = await customFolder(client, 'Pai');
    const child = await customFolder(client, 'Filha', parent);

    expect((await call('DELETE', folderUrl(client, child), 'owner')).statusCode).toBe(204);
    expect((await call('DELETE', folderUrl(client, parent), 'owner')).statusCode).toBe(204);
    expect(await folderCount(parent)).toBe(0);
  });

  it('refuses a default folder with a 409, however empty it is, and writes nothing', async () => {
    const client = await freshClient();
    const imagens = await folderOf(client, 'Imagens');
    const before = await folderSnapshot(imagens);

    expectError(await call('DELETE', folderUrl(client, imagens), 'opVis'), 409, 'DEFAULT_FOLDER_IMMUTABLE', 'As pastas padrão não podem ser excluídas.');
    expectError(await call('DELETE', folderUrl(client, imagens), 'owner'), 409, 'DEFAULT_FOLDER_IMMUTABLE');
    expect(await folderSnapshot(imagens)).toBe(before);
    expect(await auditCount('media.folder_deleted', imagens)).toBe(0);
  });

  it.each(['image', 'video', 'pdf', 'audio', 'logo'] as const)('refuses a folder that holds a %s, saying to move or delete the files first, and writes nothing', async (category) => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Com arquivo');
    const asset = await seedAsset({ clientId: client, folderId: folder, category });
    const before = [await folderSnapshot(folder), await snapshot(asset)];

    expectError(await call('DELETE', folderUrl(client, folder), 'opVis'), 409, 'FOLDER_NOT_EMPTY', FILES_MESSAGE);
    expect([await folderSnapshot(folder), await snapshot(asset)]).toEqual(before);
    expect(await auditCount('media.folder_deleted', folder)).toBe(0);
  });

  it('refuses a folder with an upload on its way, and goes ahead when only history is left in it', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Em envio');
    await seedAsset({ clientId: client, folderId: folder, status: 'pending' });
    expectError(await call('DELETE', folderUrl(client, folder), 'opVis'), 409, 'FOLDER_NOT_EMPTY', FILES_MESSAGE);

    const history = await customFolder(client, 'Só histórico');
    const removed = await seedAsset({ clientId: client, folderId: history, removedAt: new Date() });
    const rejected = await seedAsset({ clientId: client, folderId: history, status: 'rejected' });
    expect((await call('DELETE', folderUrl(client, history), 'opVis')).statusCode).toBe(204);
    expect(await owner.knex('media_assets').whereIn('id', [removed, rejected]).select('folder_id', 'client_id')).toEqual([
      { folder_id: null, client_id: client }, { folder_id: null, client_id: client }
    ]);
  });

  it('refuses a folder with a subfolder and one that a content is tied to, each with its own message', async () => {
    const client = await freshClient();
    const parent = await customFolder(client, 'Pai');
    await customFolder(client, 'Filha', parent);
    expectError(await call('DELETE', folderUrl(client, parent), 'opVis'), 409, 'FOLDER_NOT_EMPTY', 'Esta pasta tem subpastas. Mova ou exclua as subpastas antes.');

    const tied = await customFolder(client, 'Com conteúdo');
    const content = randomUUID();
    contentIds.push(content);
    await owner.knex('contents').insert({
      id: content, client_id: client, title: 'Sem arquivo', platform: 'instagram', format: 'image', publish_on: '2026-10-20', folder_id: tied,
      owner_user_id: users.opVis!.id, status: 'in_production'
    });
    expectError(await call('DELETE', folderUrl(client, tied), 'opVis'), 409, 'FOLDER_NOT_EMPTY', 'Esta pasta tem conteúdos. Mova ou exclua os conteúdos antes.');
    expect(await folderCount(parent)).toBe(1);
    expect(await folderCount(tied)).toBe(1);
  });

  it('deletes the folder once its file was moved away, the file keeping living in the other one', async () => {
    const client = await freshClient();
    const from = await customFolder(client, 'Origem');
    const to = await customFolder(client, 'Destino');
    const asset = await seedAsset({ clientId: client, folderId: from });

    expectError(await call('DELETE', folderUrl(client, from), 'opVis'), 409, 'FOLDER_NOT_EMPTY');
    expect((await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId: to })).statusCode).toBe(200);
    expect((await call('DELETE', folderUrl(client, from), 'opVis')).statusCode).toBe(204);
    expect((await call('GET', assetUrl(client, asset), 'opVis')).json()).toMatchObject({ id: asset, folderId: to });
  });

  it('answers the same 404 for a folder of another client, of another agency, an absent one and a malformed id, and for a second delete', async () => {
    const ofOtherClient = await customFolder(clientA2, 'De outro cliente');
    const ofOtherAgency = await customFolder(clientB, 'De outra agência');
    const before = [await folderSnapshot(ofOtherClient), await folderSnapshot(ofOtherAgency)];

    for (const folder of [ofOtherClient, ofOtherAgency, randomUUID(), 'not-a-uuid']) {
      expectNotFound(await call('DELETE', folderUrl(clientA1, folder), 'opVis'), 'Folder not found.');
    }
    expectNotFound(await call('DELETE', folderUrl(clientB, ofOtherAgency), 'both'), 'Client not found.');
    expect([await folderSnapshot(ofOtherClient), await folderSnapshot(ofOtherAgency)]).toEqual(before);
    expect(await auditCount('media.folder_deleted', ofOtherClient)).toBe(0);

    const client = await freshClient();
    const folder = await customFolder(client, 'Uma vez só');
    expect((await call('DELETE', folderUrl(client, folder), 'opVis')).statusCode).toBe(204);
    expectNotFound(await call('DELETE', folderUrl(client, folder), 'opVis'), 'Folder not found.');
    expect(await auditCount('media.folder_deleted', folder)).toBe(1);
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, another role or no session deletes nothing', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Campanhas');
    const before = await folderSnapshot(folder);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales']) {
      expect({ as, status: (await call('DELETE', folderUrl(client, folder), as)).statusCode }).toEqual({ as, status: 403 });
    }
    expect((await call('DELETE', folderUrl(client, folder), undefined)).statusCode).toBe(401);
    expect(await folderSnapshot(folder)).toBe(before);
    expect(await auditCount('media.folder_deleted', folder)).toBe(0);
  });

  it('answers 409 for a client that was archived and 409 for an agency that is read-only, without deleting', async () => {
    const archived = await customFolder(clientArchived, 'Arquivada');
    const readOnly = await customFolder(clientD, 'Leitura');
    const before = [await folderSnapshot(archived), await folderSnapshot(readOnly)];

    expectError(await call('DELETE', folderUrl(clientArchived, archived), 'opVis'), 409, 'CLIENT_ARCHIVED');
    expectError(await call('DELETE', folderUrl(clientD, readOnly, agencyD), 'ownerD'), 409, 'AGENCY_READ_ONLY');
    expect([await folderSnapshot(archived), await folderSnapshot(readOnly)]).toEqual(before);
  });
});

describe('editing a file: its name and its alternative text', () => {
  it('renames it and writes its alternative text, answering the file as it is now, with one event for each thing that changed', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'antes.png' });
    const before = JSON.parse(await snapshot(asset));

    const renamed = await call('PATCH', assetUrl(client, asset), 'opVis', { name: '  Depois da revisão.png  ', altText: 'Fachada da loja' });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: asset, name: 'Depois da revisão.png', altText: 'Fachada da loja' });
    const after = await owner.knex('media_assets').where({ id: asset }).first();
    expect(after).toMatchObject({ file_name: 'Depois da revisão.png', alt_text: 'Fachada da loja', object_key: before.object_key, upload_object_key: before.upload_object_key, folder_id: before.folder_id });
    expect(await auditCount('media.renamed', asset)).toBe(1);
    expect(await auditCount('media.alt_text_changed', asset)).toBe(1);

    // The same values again change nothing and say nothing.
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { name: 'Depois da revisão.png', altText: 'Fachada da loja' })).statusCode).toBe(200);
    expect(await auditCount('media.renamed', asset)).toBe(1);
    expect(await auditCount('media.alt_text_changed', asset)).toBe(1);

    // One field alone leaves the other as it was.
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { name: 'Outro.png' })).json()).toMatchObject({ name: 'Outro.png', altText: 'Fachada da loja' });
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { altText: 'Outro texto' })).json()).toMatchObject({ name: 'Outro.png', altText: 'Outro texto' });
  });

  it('clears the alternative text with null or a blank one', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'a.png', altText: 'Texto' });

    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { altText: null })).json().altText).toBeNull();
    await owner.knex('media_assets').where({ id: asset }).update({ alt_text: 'Texto de novo' });
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { altText: '   ' })).json().altText).toBeNull();
    expect((await owner.knex('media_assets').where({ id: asset }).first('alt_text')).alt_text).toBeNull();
  });

  it('gives a name to a file that had none, and a name that is a plain label with the characters of a page is kept as text', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: null });

    const response = await call('PATCH', assetUrl(client, asset), 'opVis', { name: '<img src=x onerror=alert(1)>.png' });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('<img src=x onerror=alert(1)>.png');
  });

  it('keeps a name of exactly 255 characters and refuses one of 256, with the row as it was', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'inicial.png' });

    const longest = await call('PATCH', assetUrl(client, asset), 'opVis', { name: 'é'.repeat(255) });
    expect(longest.statusCode).toBe(200);
    expect(longest.json().name).toBe('é'.repeat(255));

    const before = await snapshot(asset);
    for (const name of ['é'.repeat(256), 'x'.repeat(256), 'x'.repeat(10_000)]) {
      expect({ length: name.length, status: (await call('PATCH', assetUrl(client, asset), 'opVis', { name })).statusCode }).toEqual({ length: name.length, status: 400 });
    }
    expect(await snapshot(asset)).toBe(before);
  });

  it('refuses a name that is a path, a control or an invisible character, a blank or a dot, and a text that is not one line', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'inicial.png', altText: 'inicial' });
    const before = await snapshot(asset);

    const names: unknown[] = [
      '../../etc/passwd', 'a/b.png', 'a\\b.png', '/abs.png', '..', '.', '...', '', '   ', 'a\u0000b', 'a\nb', 'a\r\nX-Injected: 1', 'a\tb', 'a\u001bb',
      'a‮b', 'a​b', 'a﻿b', 'a⁦b', 'a\u061cb', 'a\u2028b', 'a\u2029b', 123, null, true, ['a'], { name: 'a' }
    ];
    for (const name of names) {
      const reply = await call('PATCH', assetUrl(client, asset), 'opVis', { name });
      expect({ name, status: reply.statusCode }).toEqual({ name, status: 400 });
      expect(reply.json().error.code).toBe('VALIDATION_ERROR');
    }
    for (const altText of ['linha\noutra', 'a\u0000b', 'a‮b', 'a\u061cb', 'linha\u2028outra', 'linha\u2029outra', 'x'.repeat(501), 5, ['a']]) {
      expect({ altText, status: (await call('PATCH', assetUrl(client, asset), 'opVis', { altText })).statusCode }).toEqual({ altText, status: 400 });
    }
    expect(await snapshot(asset)).toBe(before);
  });

  it('refuses an empty edit and every field that is not the name or the alternative text, so the file cannot be moved or removed through it', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'inicial.png' });
    const before = await snapshot(asset);

    for (const payload of [{}, { folderId: await folderOf(client, 'Vídeos') }, { objectKey: 'x/y/z.png' }, { status: 'rejected' }, { removedAt: null }, { clientId: clientA2 }, { name: 'ok.png', width: 1 }]) {
      expect({ payload, status: (await call('PATCH', assetUrl(client, asset), 'opVis', payload)).statusCode }).toEqual({ payload, status: 400 });
    }
    expect(await snapshot(asset)).toBe(before);
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, another role or no session writes nothing', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'inicial.png' });
    const before = await snapshot(asset);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales']) {
      expect({ as, status: (await call('PATCH', assetUrl(client, asset), as, { name: 'invadido.png' })).statusCode }).toEqual({ as, status: 403 });
    }
    expect((await call('PATCH', assetUrl(client, asset), undefined, { name: 'invadido.png' })).statusCode).toBe(401);
    expect(await snapshot(asset)).toBe(before);
    expect((await call('PATCH', assetUrl(client, asset), 'opVis', { name: 'novo.png' })).statusCode).toBe(200);
  });

  it('writes nothing for a file of another client, of another agency or an absent one: all the same 404', async () => {
    const ofOtherClient = await seedAsset({ clientId: clientA2, name: 'a2.png' });
    const ofOtherAgency = await seedAsset({ clientId: clientB, name: 'b.png' });
    const before = [await snapshot(ofOtherClient), await snapshot(ofOtherAgency)];

    for (const assetId of [ofOtherClient, ofOtherAgency, randomUUID(), 'not-a-uuid']) {
      expectNotFound(await call('PATCH', assetUrl(clientA1, assetId), 'opVis', { name: 'invadido.png' }), 'Media asset not found.');
    }
    expectNotFound(await call('PATCH', assetUrl(clientB, ofOtherAgency), 'opVis', { name: 'invadido.png' }), 'Client not found.');
    expectNotFound(await call('PATCH', assetUrl(clientB, ofOtherAgency), 'both', { name: 'invadido.png' }), 'Client not found.');
    expect([await snapshot(ofOtherClient), await snapshot(ofOtherAgency)]).toEqual(before);
  });

  it('does not edit a file that is pending, rejected or removed', async () => {
    const client = await freshClient();
    for (const seed of [{ status: 'pending' as const }, { status: 'rejected' as const }, { removedAt: new Date() }]) {
      const hidden = await seedAsset({ clientId: client, name: 'oculto.png', ...seed });
      const before = await snapshot(hidden);
      expectNotFound(await call('PATCH', assetUrl(client, hidden), 'opVis', { name: 'novo.png' }), 'Media asset not found.');
      expect(await snapshot(hidden)).toBe(before);
    }
  });

  it('answers 409 for a client that was archived and 409 for an agency that is read-only, without writing', async () => {
    const archived = await seedAsset({ clientId: clientArchived, name: 'arquivado.png' });
    const readOnly = await seedAsset({ clientId: clientD, name: 'leitura.png' });
    const before = [await snapshot(archived), await snapshot(readOnly)];

    expectError(await call('PATCH', assetUrl(clientArchived, archived), 'opVis', { name: 'novo.png' }), 409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.');
    expectError(await call('PATCH', assetUrl(clientD, readOnly, agencyD), 'ownerD', { name: 'novo.png' }), 409, 'AGENCY_READ_ONLY');
    expect([await snapshot(archived), await snapshot(readOnly)]).toEqual(before);
    expect((await call('GET', assetUrl(clientD, readOnly, agencyD), 'ownerD')).statusCode).toBe(200);
  });
});

describe('moving a file to another folder of the same client', () => {
  it('moves it, answering the file in its new folder, with an event, and never touching its object', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'mover.png' });
    const before = JSON.parse(await snapshot(asset));
    const target = await folderOf(client, 'Carrosséis');

    const moved = await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId: target });

    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: asset, folderId: target, folderName: 'Carrosséis', name: 'mover.png' });
    const after = await owner.knex('media_assets').where({ id: asset }).first();
    expect(after).toMatchObject({ folder_id: target, object_key: before.object_key, upload_object_key: before.upload_object_key, file_name: 'mover.png' });
    expect(await auditCount('media.moved', asset)).toBe(1);

    // It is already there: nothing moves and nothing is said.
    expect((await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId: target })).statusCode).toBe(200);
    expect(await auditCount('media.moved', asset)).toBe(1);
  });

  it('moves it into a folder the agency made and into one inside it, and a PDF, an audio and a logo move as well', async () => {
    const client = await freshClient();
    const campaigns = await customFolder(client, 'Campanhas');
    const october = await customFolder(client, 'Outubro', campaigns);
    const pdf = await seedAsset({ clientId: client, category: 'pdf', name: 'a.pdf' });
    const logo = await seedAsset({ clientId: client, category: 'logo', name: 'logo.png', width: 4, height: 4 });

    expect((await call('POST', `${assetUrl(client, pdf)}/move`, 'opVis', { folderId: campaigns })).json()).toMatchObject({ folderId: campaigns, folderName: 'Campanhas' });
    expect((await call('POST', `${assetUrl(client, logo)}/move`, 'opVis', { folderId: october })).json()).toMatchObject({ folderId: october, folderName: 'Outubro' });
  });

  it('refuses a folder of another client, of another agency and an absent one with the same 404, leaving the file where it is', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'fica.png' });
    const before = await snapshot(asset);

    for (const folder of [await folderOf(clientA2, 'Imagens'), await folderOf(clientB, 'Imagens'), randomUUID()]) {
      expectNotFound(await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId: folder }), 'Folder not found.');
    }
    expect(await snapshot(asset)).toBe(before);
    for (const folderId of ['not-a-uuid', 5, null, undefined]) {
      expect((await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId })).statusCode).toBe(400);
    }
    expect((await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId: await folderOf(client, 'Vídeos'), clientId: clientA2 })).statusCode).toBe(400);
    expect(await snapshot(asset)).toBe(before);
  });

  it('moves nothing of another client, of another agency or an absent file, even into a folder that exists', async () => {
    const ofOtherClient = await seedAsset({ clientId: clientA2, name: 'a2.png' });
    const ofOtherAgency = await seedAsset({ clientId: clientB, name: 'b.png' });
    const target = await folderOf(clientA1, 'Carrosséis');
    const before = [await snapshot(ofOtherClient), await snapshot(ofOtherAgency)];

    for (const assetId of [ofOtherClient, ofOtherAgency, randomUUID(), 'not-a-uuid']) {
      expectNotFound(await call('POST', `${assetUrl(clientA1, assetId)}/move`, 'opVis', { folderId: target }), 'Media asset not found.');
    }
    expectNotFound(await call('POST', `${assetUrl(clientB, ofOtherAgency)}/move`, 'both', { folderId: await folderOf(clientB, 'Carrosséis') }), 'Client not found.');
    expect([await snapshot(ofOtherClient), await snapshot(ofOtherAgency)]).toEqual(before);
  });

  it('refuses a file that a content holds, in whatever state the content is, because the content is tied to its folder', async () => {
    const client = await freshClient();
    const imagens = await folderOf(client, 'Imagens');
    const target = await folderOf(client, 'Carrosséis');
    const states = ['in_production', 'awaiting_approval', 'approved', 'published'] as const;
    for (const status of states) {
      const asset = await seedAsset({ clientId: client, name: `${status}.png` });
      await seedContent(client, status, imagens, { assetId: asset });
      const before = await snapshot(asset);

      expectError(await call('POST', `${assetUrl(client, asset)}/move`, 'opVis', { folderId: target }), 409, 'MEDIA_IN_USE', 'Esta mídia está em um conteúdo e não pode ser movida para outra pasta.');
      expect(await snapshot(asset)).toBe(before);
    }
    const cover = await seedAsset({ clientId: client, name: 'capa.png' });
    await seedContent(client, 'in_production', imagens, { assetId: cover, asCover: true, asMedia: false });
    expectError(await call('POST', `${assetUrl(client, cover)}/move`, 'opVis', { folderId: target }), 409, 'MEDIA_IN_USE');
    expect(await auditCount('media.moved', cover)).toBe(0);
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, another role or no session moves nothing', async () => {
    const client = await freshClient();
    const asset = await seedAsset({ clientId: client, name: 'fica.png' });
    const target = await folderOf(client, 'Carrosséis');
    const before = await snapshot(asset);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales']) {
      expect({ as, status: (await call('POST', `${assetUrl(client, asset)}/move`, as, { folderId: target })).statusCode }).toEqual({ as, status: 403 });
    }
    expect((await call('POST', `${assetUrl(client, asset)}/move`, undefined, { folderId: target })).statusCode).toBe(401);
    expect(await snapshot(asset)).toBe(before);
    expect(await auditCount('media.moved', asset)).toBe(0);
  });

  it('answers 409 for a client that was archived and 409 for an agency that is read-only, without moving', async () => {
    const archived = await seedAsset({ clientId: clientArchived, name: 'arquivado.png' });
    const readOnly = await seedAsset({ clientId: clientD, name: 'leitura.png' });
    const before = [await snapshot(archived), await snapshot(readOnly)];

    expectError(await call('POST', `${assetUrl(clientArchived, archived)}/move`, 'opVis', { folderId: await folderOf(clientArchived, 'Carrosséis') }), 409, 'CLIENT_ARCHIVED');
    expectError(await call('POST', `${assetUrl(clientD, readOnly, agencyD)}/move`, 'ownerD', { folderId: await folderOf(clientD, 'Carrosséis') }), 409, 'AGENCY_READ_ONLY');
    expect([await snapshot(archived), await snapshot(readOnly)]).toEqual(before);
  });
});

describe('renaming a folder', () => {
  it('renames a folder the agency made and answers it', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Campanhas');

    const response = await call('PATCH', folderUrl(client, folder), 'opVis', { name: '  Campanhas de Natal  ' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: folder, parentId: null, name: 'Campanhas de Natal', isDefault: false });
    expect((await owner.knex('media_folders').where({ id: folder }).first('name')).name).toBe('Campanhas de Natal');
  });

  it('refuses a default folder, which keeps its name, with a 409', async () => {
    const client = await freshClient();
    const imagens = await folderOf(client, 'Imagens');
    const before = await folderSnapshot(imagens);

    expectError(await call('PATCH', folderUrl(client, imagens), 'opVis', { name: 'Outro nome' }), 409, 'DEFAULT_FOLDER_IMMUTABLE', 'As pastas padrão não podem ser renomeadas.');
    expect(await folderSnapshot(imagens)).toBe(before);
  });

  it('refuses a folder of another client, of another agency and an absent one with the same 404', async () => {
    const ofOtherClient = await customFolder(clientA2, 'De outro cliente');
    const ofOtherAgency = await customFolder(clientB, 'De outra agência');
    const before = [await folderSnapshot(ofOtherClient), await folderSnapshot(ofOtherAgency)];

    for (const folder of [ofOtherClient, ofOtherAgency, randomUUID(), 'not-a-uuid']) {
      expectNotFound(await call('PATCH', folderUrl(clientA1, folder), 'opVis', { name: 'Invadida' }), 'Folder not found.');
    }
    expectNotFound(await call('PATCH', folderUrl(clientB, ofOtherAgency), 'both', { name: 'Invadida' }), 'Client not found.');
    expect([await folderSnapshot(ofOtherClient), await folderSnapshot(ofOtherAgency)]).toEqual(before);
  });

  it('refuses a name that is empty, too long, has a control or an invisible character, and a field that is not the name', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Campanhas');
    const before = await folderSnapshot(folder);

    for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(200) }, { name: 'a\u0000b' }, { name: 'a\nb' }, { name: 'a‮b' }, { name: 'a​b' }, { name: 5 }, { name: 'ok', parentId: randomUUID() }, { name: 'ok', isDefault: true }]) {
      expect({ payload, status: (await call('PATCH', folderUrl(client, folder), 'opVis', payload)).statusCode }).toEqual({ payload, status: 400 });
    }
    expect(await folderSnapshot(folder)).toBe(before);
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone, another role or no session renames nothing', async () => {
    const client = await freshClient();
    const folder = await customFolder(client, 'Campanhas');
    const before = await folderSnapshot(folder);

    for (const as of ['onlyOperar', 'onlyVisualizar', 'onlyMidia', 'sales']) {
      expect({ as, status: (await call('PATCH', folderUrl(client, folder), as, { name: 'Invadida' })).statusCode }).toEqual({ as, status: 403 });
    }
    expect((await call('PATCH', folderUrl(client, folder), undefined, { name: 'Invadida' })).statusCode).toBe(401);
    expect(await folderSnapshot(folder)).toBe(before);
  });

  it('answers 409 for a client that was archived and 409 for an agency that is read-only, without renaming', async () => {
    const archived = await customFolder(clientArchived, 'Arquivada');
    const readOnly = await customFolder(clientD, 'Leitura');
    const before = [await folderSnapshot(archived), await folderSnapshot(readOnly)];

    expectError(await call('PATCH', folderUrl(clientArchived, archived), 'opVis', { name: 'Nova' }), 409, 'CLIENT_ARCHIVED');
    expectError(await call('PATCH', folderUrl(clientD, readOnly, agencyD), 'ownerD', { name: 'Nova' }), 409, 'AGENCY_READ_ONLY');
    expect([await folderSnapshot(archived), await folderSnapshot(readOnly)]).toEqual(before);
  });
});
