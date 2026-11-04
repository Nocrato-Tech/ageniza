import { randomUUID } from 'node:crypto';

import type { ContentStatus } from '@ageniza/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPortalFixtures } from './test-support/portal-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Decision 2026-11-04 (the folder is a drive). Choosing the folder gives the content what the folder holds, and the folder may
// change with the media and the cover in it. The folder, the format and the state are judged by the database, in one transaction;
// the route only decides what it hands the function. Every refusal names its code, and the row, the list and the cover are read back
// from the database after it, because a status alone does not prove that nothing was written.
const w = createContentsWorld('folder-media');
const p = createPortalFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|23503|pg_|relation|constraint|process/i;

let clientA: string;
let clientA2: string;
let clientB: string;
let folderB: string;

const base = (clientId = clientA): string => `/agencies/${w.agencyA}/clients/${clientId}/contents`;
const create = { title: 'Lançamento da coleção', publishOn: '2026-10-20' };

const patch = (contentId: string, payload: Record<string, unknown>, cookie = people.production.cookie, clientId = clientA): Promise<Reply> =>
  w.call('PATCH', cookie, `${base(clientId)}/${contentId}`, payload);
const listOf = async (contentId: string): Promise<string[]> =>
  (await w.getOwner().knex('content_media').where({ content_id: contentId }).orderBy('position').select('asset_id')).map((row) => row.asset_id as string);
const idsOf = (reply: Reply): string[] => (reply.json().media as Array<{ id: string; position: number }>).map((item) => item.id);

/** A content in a folder of its own that holds `assets`, and a second folder of the client that holds nothing yet. */
const scene = async (extra: { format?: 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl'; status?: ContentStatus; assets?: number; cover?: boolean; client?: string } = {}) => {
  const client = extra.client ?? clientA;
  const from = await w.newFolder(client, `Origem ${randomUUID().slice(0, 6)}`);
  const to = await w.newFolder(client, `Destino ${randomUUID().slice(0, 6)}`);
  const format = extra.format ?? 'carousel';
  const category = format === 'image' || format === 'carousel' ? 'image' : 'video';
  const oldAssets: string[] = [];
  for (let index = 0; index < (extra.assets ?? 2); index += 1) oldAssets.push(await w.seedAsset(client, from, { category }));
  const cover = extra.cover === true ? await w.seedAsset(client, from, { category: 'image' }) : undefined;
  const contentId = await w.seedContent(client, {
    format,
    folderId: from,
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(cover === undefined ? {} : { coverAssetId: cover })
  });
  await w.attach(contentId, oldAssets);
  return { client, from, to, contentId, oldAssets, cover };
};

const expectUntouched = async (s: Awaited<ReturnType<typeof scene>>, before: Record<string, unknown>): Promise<void> => {
  const row = await w.contentRow(s.contentId);
  expect([row.folder_id, row.cover_asset_id, row.status, row.revision]).toEqual([before.folder_id, before.cover_asset_id, before.status, before.revision]);
  expect(await listOf(s.contentId)).toEqual(s.oldAssets);
};

const expectRefused = (reply: Reply, status: number, code: string): void => {
  expect(reply.statusCode).toBe(status);
  expect(reply.json().error.code).toBe(code);
  expect(JSON.stringify({ ...reply.json(), meta: undefined })).not.toMatch(NO_DATABASE_DETAIL);
};

beforeAll(async () => {
  await w.setup();
  await p.setup();
  clientA = await w.newClient('a');
  clientA2 = await w.newClient('a2');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
  folderB = await w.folderOf(clientB);
}, 90_000);

afterAll(async () => {
  await p.cleanup();
  await w.teardown();
}, 60_000);

describe('a new content takes the media of its folder', () => {
  it('takes the newest video for a reels and nothing else', async () => {
    const folder = await w.newFolder(clientA, 'Vídeos novos');
    await w.seedAsset(clientA, folder, { category: 'video' });
    const newest = await w.seedAsset(clientA, folder, { category: 'video' });
    await w.seedAsset(clientA, folder, { category: 'image' });

    const reply = await w.call('POST', people.production.cookie, base(), { ...create, format: 'reels', folderId: folder });

    expect(reply.statusCode).toBe(201);
    expect(idsOf(reply)).toEqual([newest]);
    expect(await listOf(reply.json().id)).toEqual([newest]);
  });

  it('takes every image and video of the folder for a carousel, the newest first', async () => {
    const folder = await w.newFolder(clientA, 'Fotos novas');
    const first = await w.seedAsset(clientA, folder, { category: 'image' });
    const second = await w.seedAsset(clientA, folder, { category: 'video' });

    const reply = await w.call('POST', people.production.cookie, base(), { ...create, format: 'carousel', folderId: folder });

    expect(reply.statusCode).toBe(201);
    expect(reply.json().media).toEqual([{ id: second, position: 1 }, { id: first, position: 2 }]);
  });

  it('is born without media in a folder that holds none, and not in the folder of the media that does not fit', async () => {
    const empty = await w.call('POST', people.production.cookie, base(), { ...create, format: 'image', folderId: await w.newFolder(clientA, 'Vazia') });
    const wrong = await w.newFolder(clientA, 'Só vídeo');
    await w.seedAsset(clientA, wrong, { category: 'video' });
    const unfit = await w.call('POST', people.production.cookie, base(), { ...create, format: 'image', folderId: wrong });

    expect(empty.statusCode).toBe(201);
    expect(empty.json().media).toEqual([]);
    expect(unfit.json().media).toEqual([]);
  });

  it('takes the list the caller names instead of the folder, and an empty list means none', async () => {
    const folder = await w.newFolder(clientA, 'Duas imagens');
    const a = await w.seedAsset(clientA, folder);
    const b = await w.seedAsset(clientA, folder);

    const named = await w.call('POST', people.production.cookie, base(), { ...create, format: 'carousel', folderId: folder, mediaAssetIds: [a, b] });
    const none = await w.call('POST', people.production.cookie, base(), { ...create, format: 'carousel', folderId: folder, mediaAssetIds: [] });

    expect(idsOf(named)).toEqual([a, b]);
    expect(none.statusCode).toBe(201);
    expect(none.json().media).toEqual([]);
  });

  it.each([
    ['a media of another folder of the client', async () => [await w.seedAsset(clientA, await w.newFolder(clientA, 'Outra'))]],
    ['a media of another client', async () => [await w.seedAsset(clientA2, await w.newFolder(clientA2, 'De outro cliente'))]],
    ['a media that was removed', async (folder: string) => [await w.seedAsset(clientA, folder, { removed: true })]],
    ['the same media twice', async (folder: string) => { const a = await w.seedAsset(clientA, folder); return [a, a]; }]
  ])('answers 400 CONTENT_MEDIA_INVALID to %s, and creates nothing', async (_label, list) => {
    const folder = await w.newFolder(clientA, 'Pasta do pedido');
    const mediaAssetIds = await list(folder);
    const before = await w.countContents(clientA);

    const reply = await w.call('POST', people.production.cookie, base(), { ...create, format: 'carousel', folderId: folder, mediaAssetIds });

    expectRefused(reply, 400, 'CONTENT_MEDIA_INVALID');
    expect(await w.countContents(clientA)).toBe(before);
  });

  it('does not change a content that exists when media comes to its folder later, and does not take back an approval', async () => {
    const s = await scene({ status: 'approved' });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(clientA, s.from);

    const reply = await w.call('GET', people.production.cookie, `${base()}/${s.contentId}`);

    expect(reply.statusCode).toBe(200);
    expect(idsOf(reply)).toEqual(s.oldAssets);
    expect([reply.json().status, reply.json().revision]).toEqual(['approved', before.revision]);
  });
});

describe('the folder of a content changes, with its media', () => {
  it('takes the media of the new folder by the format, and puts the cover back to none', async () => {
    const s = await scene({ format: 'reels', assets: 1, cover: true });
    await w.seedAsset(clientA, s.to, { category: 'video' });
    const newest = await w.seedAsset(clientA, s.to, { category: 'video' });
    await w.seedAsset(clientA, s.to, { category: 'image' });

    const reply = await patch(s.contentId, { folderId: s.to });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().folderId).toBe(s.to);
    expect(reply.json().coverAssetId).toBeNull();
    expect(idsOf(reply)).toEqual([newest]);
    expect(await listOf(s.contentId)).toEqual([newest]);
    expect((await w.contentRow(s.contentId)).cover_asset_id).toBeNull();
  });

  it('leaves the content without media when the new folder holds none, and says nothing of "in use"', async () => {
    const s = await scene({ format: 'image', assets: 1, cover: true });

    const reply = await patch(s.contentId, { folderId: s.to });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().media).toEqual([]);
    expect(reply.json().coverAssetId).toBeNull();
  });

  it('judges the new folder by the format of the same request', async () => {
    const s = await scene({ format: 'carousel', assets: 2 });
    await w.seedAsset(clientA, s.to, { category: 'image' });
    const video = await w.seedAsset(clientA, s.to, { category: 'video' });

    const reply = await patch(s.contentId, { folderId: s.to, format: 'reels' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json().format).toBe('reels');
    expect(idsOf(reply)).toEqual([video]);
  });

  it('takes the list that the same request names, and the cover that the same request names', async () => {
    const s = await scene({ format: 'reels', assets: 1, cover: true });
    const video = await w.seedAsset(clientA, s.to, { category: 'video' });
    await w.seedAsset(clientA, s.to, { category: 'video' });
    const image = await w.seedAsset(clientA, s.to, { category: 'image' });

    const reply = await patch(s.contentId, { folderId: s.to, mediaAssetIds: [video], coverAssetId: image });

    expect(reply.statusCode).toBe(200);
    expect(idsOf(reply)).toEqual([video]);
    expect(reply.json().coverAssetId).toBe(image);
  });

  it.each([
    ['a media of the old folder', (s: Awaited<ReturnType<typeof scene>>) => ({ mediaAssetIds: [s.oldAssets[0]!] }), 'CONTENT_MEDIA_INVALID'],
    ['a cover of the old folder', (s: Awaited<ReturnType<typeof scene>>) => ({ coverAssetId: s.cover! }), 'CONTENT_MEDIA_INVALID']
  ])('answers 400 to %s named with the new folder, and the folder, the list and the cover stay', async (_label, extra, code) => {
    const s = await scene({ format: 'carousel', cover: true });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(clientA, s.to);

    const reply = await patch(s.contentId, { folderId: s.to, ...extra(s) });

    expectRefused(reply, 400, code);
    await expectUntouched(s, before);
  });

  it('does not blame the folder when the folder asked is the one the content already has', async () => {
    const s = await scene({ format: 'carousel', status: 'awaiting_approval' });
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: s.from, mediaAssetIds: [s.oldAssets[0]!] });

    expectRefused(reply, 409, 'CONTENT_MEDIA_INCOMPLETE');
    expect(reply.json().error.message).toMatch(/não cobre este formato/);
    await expectUntouched(s, before);
  });

  it('writes nothing of the other fields when the move is refused', async () => {
    const s = await scene({ format: 'carousel', status: 'awaiting_approval' });
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: s.to, title: 'Trocado', caption: 'Nova legenda' });

    expectRefused(reply, 409, 'CONTENT_MEDIA_INCOMPLETE');
    const row = await w.contentRow(s.contentId);
    expect([row.title, row.caption]).toEqual([before.title, before.caption]);
    await expectUntouched(s, before);
  });

  it('asking for the folder it already has is no move: the list stays as the person adjusted it', async () => {
    const s = await scene({ format: 'carousel', assets: 2 });
    await w.seedAsset(clientA, s.from);
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: s.from });

    expect(reply.statusCode).toBe(200);
    expect(idsOf(reply)).toEqual(s.oldAssets);
    expect(reply.json().revision).toBe(before.revision);
  });

  it.each([
    ['of another client', () => w.newFolder(clientA2, 'Do outro')],
    ['of another agency', () => Promise.resolve(folderB)],
    ['that does not exist', () => Promise.resolve(randomUUID())]
  ])('answers 400 CONTENT_FOLDER_INVALID to a folder %s, and the content is as it was', async (_label, folder) => {
    const s = await scene({ format: 'carousel', cover: true });
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: await folder() });

    expectRefused(reply, 400, 'CONTENT_FOLDER_INVALID');
    await expectUntouched(s, before);
  });

  it('answers 400 CONTENT_FOLDER_INVALID, not a media error, when the request moves to the folder of another client with a media of it', async () => {
    const s = await scene({ format: 'carousel' });
    const other = await w.newFolder(clientA2, 'Do outro');
    const foreign = await w.seedAsset(clientA2, other);
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: other, mediaAssetIds: [foreign] });

    expectRefused(reply, 400, 'CONTENT_FOLDER_INVALID');
    await expectUntouched(s, before);
  });
});

describe('a move in each state of the content', () => {
  it('lets a content in production and in adjustment move', async () => {
    for (const status of ['in_production', 'adjusting'] as const) {
      const s = await scene({ status });
      const taken = await w.seedAsset(clientA, s.to);
      await w.seedAsset(clientA, s.to);

      const reply = await patch(s.contentId, { folderId: s.to });

      expect(reply.statusCode).toBe(200);
      expect(reply.json().status).toBe(status);
      expect(idsOf(reply)).toContain(taken);
    }
  });

  it('keeps a content that waits for approval waiting, with the list of the new folder and a new revision', async () => {
    const s = await scene({ status: 'awaiting_approval' });
    const a = await w.seedAsset(clientA, s.to);
    const b = await w.seedAsset(clientA, s.to);

    const reply = await patch(s.contentId, { folderId: s.to });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'awaiting_approval', revision: 2 });
    expect(idsOf(reply)).toEqual([b, a]);
  });

  it('sends an approved content back to "aguardando aprovação", without who approved', async () => {
    const s = await scene({ status: 'approved', format: 'reels', assets: 1, cover: true });
    const video = await w.seedAsset(clientA, s.to, { category: 'video' });

    const reply = await patch(s.contentId, { folderId: s.to });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'awaiting_approval', approvedBy: null, approvedAt: null, coverAssetId: null });
    expect(reply.json().revision).toBeGreaterThan(1);
    expect(idsOf(reply)).toEqual([video]);
  });

  it.each(['awaiting_approval', 'approved'] as const)('answers 409 CONTENT_MEDIA_INCOMPLETE to a %s content moved to a folder that cannot fill it, in the words of the folder', async (status) => {
    const s = await scene({ status, format: 'reels', assets: 1, cover: true });
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: s.to });

    expectRefused(reply, 409, 'CONTENT_MEDIA_INCOMPLETE');
    expect(reply.json().error.message).toMatch(/pasta/);
    await expectUntouched(s, before);
    expect(before.cover_asset_id).not.toBeNull();
  });

  it('keeps the old words for a list that does not cover the format when the folder does not move', async () => {
    const s = await scene({ status: 'approved', format: 'reels', assets: 1 });

    const reply = await patch(s.contentId, { mediaAssetIds: [] });

    expectRefused(reply, 409, 'CONTENT_MEDIA_INCOMPLETE');
    expect(reply.json().error.message).toMatch(/carrossel/);
  });

  it.each(['published', 'cancelled'] as const)('answers 409 CONTENT_NOT_EDITABLE to a %s content, and nothing moves', async (status) => {
    const s = await scene({ status });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(clientA, s.to);

    const reply = await patch(s.contentId, { folderId: s.to });

    expectRefused(reply, 409, 'CONTENT_NOT_EDITABLE');
    await expectUntouched(s, before);
  });
});

describe('who may move the folder of a content, and in which client', () => {
  it.each(['sales', 'finance', 'noContent', 'reader', 'operateOnly'] as const)('answers 403 to %s, and nothing moves', async (person) => {
    const s = await scene();
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(clientA, s.to);

    const reply = await patch(s.contentId, { folderId: s.to }, people[person].cookie);

    expect(reply.statusCode).toBe(403);
    await expectUntouched(s, before);
  });

  it('answers the same 404 to a content of another client of the agency, and nothing moves', async () => {
    const s = await scene({ client: clientA2 });
    const before = await w.contentRow(s.contentId);

    const reply = await patch(s.contentId, { folderId: s.to }, people.admin.cookie, clientA);

    expectRefused(reply, 404, 'NOT_FOUND');
    await expectUntouched(s, before);
  });

  it('answers 409 CLIENT_ARCHIVED for an archived client, and nothing moves', async () => {
    const archived = await w.newClient('archived-move');
    const s = await scene({ client: archived });
    const before = await w.contentRow(s.contentId);
    await w.getOwner().knex('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });

    const reply = await patch(s.contentId, { folderId: s.to }, people.production.cookie, archived);

    expectRefused(reply, 409, 'CLIENT_ARCHIVED');
    await expectUntouched(s, before);
  });
});

describe('the portal sees the media of a content only through the content', () => {
  const portalGet = (contentId: string) => w.call('GET', p.people.portalOne.cookie, `/clients/${p.clientA1}/contents/${contentId}`);
  const portalUrl = (contentId: string, assetId: string) => w.call('GET', p.people.portalOne.cookie, `/clients/${p.clientA1}/contents/${contentId}/media/${assetId}/url`);

  it('shows nothing of a content in production that took the media of a folder', async () => {
    const folder = await w.newFolder(p.clientA1, 'Origem do portal');
    const to = await w.newFolder(p.clientA1, 'Destino do portal');
    const contentId = await w.seedContent(p.clientA1, { format: 'carousel', folderId: folder });
    const incoming = await w.seedAsset(p.clientA1, to);

    const moved = await w.call('PATCH', people.production.cookie, `${base(p.clientA1)}/${contentId}`, { folderId: to });
    const detail = await portalGet(contentId);

    expect(moved.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().media).toBeUndefined();
    expect((await portalUrl(contentId, incoming)).statusCode).toBe(404);
  });

  it('shows the list of the new folder of a content that waits, and refuses the file that left it', async () => {
    const folder = await w.newFolder(p.clientA1, 'Origem aberta');
    const to = await w.newFolder(p.clientA1, 'Destino aberto');
    const leaving = await w.seedAsset(p.clientA1, folder);
    const contentId = await w.seedContent(p.clientA1, { format: 'carousel', folderId: folder, status: 'awaiting_approval' });
    await w.attach(contentId, [leaving]);
    const a = await w.seedAsset(p.clientA1, to);
    const b = await w.seedAsset(p.clientA1, to);

    const moved = await w.call('PATCH', people.production.cookie, `${base(p.clientA1)}/${contentId}`, { folderId: to });
    const detail = await portalGet(contentId);

    expect(moved.statusCode).toBe(200);
    expect((detail.json().media as Array<{ id: string }>).map((item) => item.id)).toEqual([b, a]);
    expect((await portalUrl(contentId, leaving)).statusCode).toBe(404);
    expect((await portalUrl(contentId, b)).statusCode).toBe(200);
  });
});
