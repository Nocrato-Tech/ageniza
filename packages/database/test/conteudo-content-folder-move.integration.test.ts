import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';
import { createContentWorld, type ContentFormat, type ContentStatus } from './support/content-world.js';

// Decision 2026-11-04 (the folder is a drive): a content takes what its folder holds, and changes folder with its media.
// `move_content_folder`, `inherit_content_media` and the helper they share, `folder_media_for`. Every attack runs as
// `ageniza_app`; a custom role holding one permission stands in for each guard, and a race is two real transactions ordered
// by the lock the first holds (`waitForBackendsBlockedBy`), never by a sleep.
const w = createContentWorld('conteudo-folder-move');
const { ids } = w;

let operarAndVisualizar: string;
let onlyOperar: string;
let onlyVisualizar: string;
let noContent: string;

beforeAll(async () => {
  await w.setup();
  operarAndVisualizar = await w.personWith('conteudo.operar', 'conteudo.visualizar');
  onlyOperar = await w.personWith('conteudo.operar');
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  noContent = await w.personWith('cliente.visualizar');
});

afterAll(async () => {
  await w.teardown();
});

const newFolder = async (clientId: string, name = `Pasta ${randomUUID().slice(0, 8)}`): Promise<string> => {
  const id = randomUUID();
  await w.getOwner().knex('media_folders').insert({ id, client_id: clientId, name, is_default: false });
  return id;
};

const move = (user: string, contentId: string, folderId: string, list: readonly string[] | null = null) =>
  w.asUser(user, (transaction) => transaction.raw('select app_private.move_content_folder(?::uuid, ?::uuid, ?::uuid[])', [
    contentId, folderId, list === null ? null : `{${list.join(',')}}`
  ]));
const inherit = (user: string, contentId: string) =>
  w.asUser(user, (transaction) => transaction.raw('select app_private.inherit_content_media(?::uuid)', [contentId]));

const listOf = async (contentId: string): Promise<string[]> =>
  (await w.getOwner().knex('content_media').where({ content_id: contentId }).orderBy('position').select('asset_id')).map((row) => row.asset_id as string);

const FORMATS_OF_ONE_VIDEO: readonly ContentFormat[] = ['reels', 'long_video', 'vsl'];

interface Scene {
  readonly from: string;
  readonly to: string;
  readonly contentId: string;
  readonly oldAssets: readonly string[];
}

/** A content in `from` that holds `oldAssets`, and an empty folder `to` of the same client. */
const scene = async (extra: { status?: ContentStatus; format?: ContentFormat; cover?: boolean; assets?: number } = {}): Promise<Scene> => {
  const from = await newFolder(ids.clientA1);
  const to = await newFolder(ids.clientA1);
  const format = extra.format ?? 'carousel';
  const category = format === 'image' || format === 'carousel' ? 'image' : 'video';
  const oldAssets: string[] = [];
  for (let index = 0; index < (extra.assets ?? 2); index += 1) oldAssets.push(await w.seedAsset(ids.clientA1, from, { category }));
  const cover = extra.cover === true ? await w.seedAsset(ids.clientA1, from, { category: 'image' }) : undefined;
  const contentId = await w.seedContent(ids.clientA1, {
    format,
    folderId: from,
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(cover === undefined ? {} : { coverAssetId: cover })
  });
  await w.attach(contentId, oldAssets);
  return { from, to, contentId, oldAssets };
};

const unchanged = async (s: Scene, before: Record<string, unknown>): Promise<void> => {
  const row = await w.contentRow(s.contentId);
  expect([row.folder_id, row.cover_asset_id, row.status, row.revision]).toEqual([before.folder_id, before.cover_asset_id, before.status, before.revision]);
  expect(await listOf(s.contentId)).toEqual(s.oldAssets);
};

describe('what a folder gives a content, by format (decision 2026-11-04)', () => {
  it('gives an image the newest image of the folder, never a video', async () => {
    const s = await scene({ format: 'image', assets: 1 });
    await w.seedAsset(ids.clientA1, s.to, { category: 'image' });
    const newest = await w.seedAsset(ids.clientA1, s.to, { category: 'image' });
    await w.seedAsset(ids.clientA1, s.to, { category: 'video' });

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(await listOf(s.contentId)).toEqual([newest]);
  });

  it.each(FORMATS_OF_ONE_VIDEO)('gives a %s the newest video of the folder, never an image', async (format) => {
    const s = await scene({ format, assets: 1 });
    await w.seedAsset(ids.clientA1, s.to, { category: 'video' });
    const newest = await w.seedAsset(ids.clientA1, s.to, { category: 'video' });
    await w.seedAsset(ids.clientA1, s.to, { category: 'image' });

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(await listOf(s.contentId)).toEqual([newest]);
  });

  it('gives a carousel every image and video of the folder, the newest first', async () => {
    const s = await scene({ format: 'carousel' });
    const first = await w.seedAsset(ids.clientA1, s.to, { category: 'image' });
    const second = await w.seedAsset(ids.clientA1, s.to, { category: 'video' });
    const third = await w.seedAsset(ids.clientA1, s.to, { category: 'image' });

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(await listOf(s.contentId)).toEqual([third, second, first]);
  });

  it('stops a carousel at twenty', async () => {
    const s = await scene({ format: 'carousel' });
    const created: string[] = [];
    for (let index = 0; index < 22; index += 1) created.push(await w.seedAsset(ids.clientA1, s.to));

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(await listOf(s.contentId)).toEqual(created.slice(2).reverse());
  });

  it('does not take a media that is pending, rejected or removed, and takes the next one', async () => {
    const s = await scene({ format: 'image', assets: 1 });
    const usable = await w.seedAsset(ids.clientA1, s.to);
    await w.seedAsset(ids.clientA1, s.to, { status: 'pending' });
    await w.seedAsset(ids.clientA1, s.to, { status: 'rejected' });
    await w.seedAsset(ids.clientA1, s.to, { removed: true });

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(await listOf(s.contentId)).toEqual([usable]);
  });

  it('leaves the content without media when the folder holds nothing that fits', async () => {
    const s = await scene({ format: 'image', assets: 1 });
    await w.seedAsset(ids.clientA1, s.to, { category: 'video' });

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(await listOf(s.contentId)).toEqual([]);
    expect((await w.contentRow(s.contentId)).folder_id).toBe(s.to);
  });

  it('takes the list the caller names instead, even an empty one or a partial one', async () => {
    const s = await scene({ format: 'carousel' });
    const a = await w.seedAsset(ids.clientA1, s.to);
    const b = await w.seedAsset(ids.clientA1, s.to);
    await w.seedAsset(ids.clientA1, s.to);

    await move(operarAndVisualizar, s.contentId, s.to, [b, a]);
    expect(await listOf(s.contentId)).toEqual([b, a]);

    const other = await scene({ format: 'carousel' });
    await w.seedAsset(ids.clientA1, other.to);
    await move(operarAndVisualizar, other.contentId, other.to, []);
    expect(await listOf(other.contentId)).toEqual([]);
  });

  it('refuses a named media that is not of the new folder, and changes nothing', async () => {
    const s = await scene({ format: 'carousel', cover: true });
    const before = await w.contentRow(s.contentId);
    const foreign = await w.seedAsset(ids.clientA1, await newFolder(ids.clientA1));

    for (const list of [[s.oldAssets[0]!], [foreign], [randomUUID()]]) {
      await expect(move(operarAndVisualizar, s.contentId, s.to, list)).rejects.toMatchObject({ code: 'A0069' });
    }
    await unchanged(s, before);
  });
});

describe('the cover and the revision of a move', () => {
  it('clears the cover, which was a media of the old folder', async () => {
    const s = await scene({ format: 'reels', cover: true, assets: 1 });
    await w.seedAsset(ids.clientA1, s.to, { category: 'video' });

    await move(operarAndVisualizar, s.contentId, s.to);

    expect((await w.contentRow(s.contentId)).cover_asset_id).toBeNull();
  });

  it('counts one revision for a move that changes the list', async () => {
    const s = await scene({ format: 'carousel', assets: 2 });
    await w.seedAsset(ids.clientA1, s.to);
    const before = Number((await w.contentRow(s.contentId)).revision);

    await move(operarAndVisualizar, s.contentId, s.to);

    expect(Number((await w.contentRow(s.contentId)).revision)).toBe(before + 1);
  });

  it('counts a revision when the move empties a list, and none when there was nothing to take off', async () => {
    const full = await scene({ format: 'carousel', assets: 2 });
    const empty = await scene({ format: 'carousel', assets: 0 });

    await move(operarAndVisualizar, full.contentId, full.to);
    await move(operarAndVisualizar, empty.contentId, empty.to);

    expect(Number((await w.contentRow(full.contentId)).revision)).toBe(2);
    expect(Number((await w.contentRow(empty.contentId)).revision)).toBe(1);
  });

  it('counts exactly one revision when a content in production with a cover and media moves to an empty folder', async () => {
    const s = await scene({ format: 'reels', cover: true, assets: 1 });
    const before = Number((await w.contentRow(s.contentId)).revision);

    await move(operarAndVisualizar, s.contentId, s.to);

    const row = await w.contentRow(s.contentId);
    expect(await listOf(s.contentId)).toEqual([]);
    expect(row.cover_asset_id).toBeNull();
    expect(Number(row.revision)).toBe(before + 1);
  });

  it.each(['approved', 'awaiting_approval'] as const)('refuses a direct UPDATE of the folder of a %s content with no media and no cover, which no route reaches', async (status) => {
    const s = await scene({ status, assets: 0 });
    const before = await w.contentRow(s.contentId);

    await expect(w.asUser(operarAndVisualizar, (transaction) => transaction('contents').where({ id: s.contentId }).update({ folder_id: s.to })))
      .rejects.toMatchObject({ code: '42501' });

    expect(await w.contentRow(s.contentId)).toEqual(before);
    expect(await w.columnsWithPrivilege('contents', 'update')).not.toContain('folder_id');
  });

  it('asking for the folder the content already has changes nothing, and writes only a list the caller names', async () => {
    const s = await scene({ format: 'carousel' });
    const extra = await w.seedAsset(ids.clientA1, s.from);

    await move(operarAndVisualizar, s.contentId, s.from);
    expect(await listOf(s.contentId)).toEqual(s.oldAssets);
    expect(Number((await w.contentRow(s.contentId)).revision)).toBe(1);

    await move(operarAndVisualizar, s.contentId, s.from, [extra]);
    expect(await listOf(s.contentId)).toEqual([extra]);
  });

  it('does not touch a content when a media is added to its folder afterwards', async () => {
    const s = await scene({ format: 'carousel', status: 'approved' });
    await w.seedAsset(ids.clientA1, s.from);

    const row = await w.contentRow(s.contentId);
    expect(await listOf(s.contentId)).toEqual(s.oldAssets);
    expect([row.status, row.revision]).toEqual(['approved', 1]);
  });
});

describe('a move in each state of the content (decision 2026-11-04)', () => {
  it.each(['in_production', 'adjusting'] as const)('moves a content in %s', async (status) => {
    const s = await scene({ status });
    const fresh = await w.seedAsset(ids.clientA1, s.to);
    await w.seedAsset(ids.clientA1, s.to);

    await move(operarAndVisualizar, s.contentId, s.to);

    const row = await w.contentRow(s.contentId);
    expect([row.status, row.folder_id]).toEqual([status, s.to]);
    expect(await listOf(s.contentId)).toHaveLength(2);
    expect(await listOf(s.contentId)).toContain(fresh);
  });

  it('keeps a content that waits for approval waiting, with the list of the new folder', async () => {
    const s = await scene({ status: 'awaiting_approval' });
    await w.seedAsset(ids.clientA1, s.to);
    await w.seedAsset(ids.clientA1, s.to);

    await move(operarAndVisualizar, s.contentId, s.to);

    const row = await w.contentRow(s.contentId);
    expect([row.status, row.folder_id, Number(row.revision)]).toEqual(['awaiting_approval', s.to, 2]);
  });

  it('takes the approval back from an approved content, and the cover with it', async () => {
    const s = await scene({ status: 'approved', format: 'reels', cover: true, assets: 1 });
    const video = await w.seedAsset(ids.clientA1, s.to, { category: 'video' });

    await move(operarAndVisualizar, s.contentId, s.to);

    const row = await w.contentRow(s.contentId);
    expect([row.status, row.approved_by, row.approved_at, row.cover_asset_id]).toEqual(['awaiting_approval', null, null, null]);
    expect(Number(row.revision)).toBeGreaterThan(1);
    expect(await listOf(s.contentId)).toEqual([video]);
  });

  it.each(['awaiting_approval', 'approved'] as const)('refuses to leave a content that is %s without media, and changes nothing', async (status) => {
    const s = await scene({ status, format: 'reels', cover: true, assets: 1 });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(ids.clientA1, s.to, { category: 'image' });

    await expect(move(operarAndVisualizar, s.contentId, s.to)).rejects.toMatchObject({ code: 'A0065' });

    await unchanged(s, before);
    expect(before.cover_asset_id).not.toBeNull();
  });

  it.each(['awaiting_approval', 'approved'] as const)('refuses to leave a content that is %s without media even when it has no cover to lose', async (status) => {
    const s = await scene({ status, format: 'reels', assets: 1 });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(ids.clientA1, s.to, { category: 'image' });

    await expect(move(operarAndVisualizar, s.contentId, s.to)).rejects.toMatchObject({ code: 'A0065' });

    await unchanged(s, before);
    expect(before.cover_asset_id).toBeNull();
  });

  it.each(['awaiting_approval', 'approved'] as const)('refuses a folder with one image for a carousel that is %s: the list would not cover the format', async (status) => {
    const s = await scene({ status, format: 'carousel' });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(ids.clientA1, s.to);

    await expect(move(operarAndVisualizar, s.contentId, s.to)).rejects.toMatchObject({ code: 'A0065' });

    await unchanged(s, before);
  });

  it.each(['published', 'cancelled'] as const)('refuses a move of a content that is %s', async (status) => {
    const s = await scene({ status });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(ids.clientA1, s.to);

    await expect(move(operarAndVisualizar, s.contentId, s.to)).rejects.toMatchObject({ code: 'A0062' });

    await unchanged(s, before);
  });

  it.each(['published', 'cancelled'] as const)('refuses the folder the %s content already has too: the state is read before anything', async (status) => {
    const s = await scene({ status });
    const before = await w.contentRow(s.contentId);

    await expect(move(operarAndVisualizar, s.contentId, s.from)).rejects.toMatchObject({ code: 'A0062' });
    await expect(move(operarAndVisualizar, s.contentId, s.from, [s.oldAssets[0]!])).rejects.toMatchObject({ code: 'A0062' });

    await unchanged(s, before);
  });

  it('tells a person without the permission "not found" before it says the content is published', async () => {
    const s = await scene({ status: 'published' });
    await expect(move(onlyVisualizar, s.contentId, s.from)).rejects.toMatchObject({ code: 'A0060' });
    await expect(move(onlyVisualizar, s.contentId, s.to)).rejects.toMatchObject({ code: 'A0060' });
  });
});

describe('who may move, and where (decision 2026-10-01 rule 3)', () => {
  it.each([
    ['conteudo.operar alone', () => onlyOperar],
    ['conteudo.visualizar alone', () => onlyVisualizar],
    ['neither', () => noContent],
    ['an admin of another agency', () => ids.adminB],
    ['the portal of the client', () => ids.portalA1]
  ])('answers "content not found" to %s, and changes nothing', async (_label, who) => {
    const s = await scene();
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(ids.clientA1, s.to);

    await expect(move(who(), s.contentId, s.to)).rejects.toMatchObject({ code: 'A0060' });
    await expect(inherit(who(), s.contentId)).rejects.toMatchObject({ code: 'A0060' });

    await unchanged(s, before);
  });

  it.each([
    ['of another client of the agency', async () => newFolder(ids.clientA2)],
    ['of another agency', async () => newFolder(ids.clientB)],
    ['that does not exist', async () => randomUUID()]
  ])('refuses a folder %s through the foreign key, and changes nothing', async (_label, folder) => {
    const s = await scene({ format: 'carousel', cover: true });
    const before = await w.contentRow(s.contentId);

    await expect(move(operarAndVisualizar, s.contentId, await folder())).rejects.toMatchObject({ code: '23503', constraint: 'contents_folder_fk' });

    await unchanged(s, before);
  });

  it('refuses the media of another client even when the caller names it', async () => {
    const s = await scene({ format: 'carousel' });
    const foreignFolder = await newFolder(ids.clientA2);
    const foreign = await w.seedAsset(ids.clientA2, foreignFolder);
    const before = await w.contentRow(s.contentId);

    await expect(move(operarAndVisualizar, s.contentId, foreignFolder, [foreign])).rejects.toMatchObject({ code: '23503' });

    await unchanged(s, before);
  });

  it('refuses a client that was archived, and the person is told it is archived', async () => {
    const s = await scene();
    await w.seedAsset(ids.clientA1, s.to);
    await w.archiveClient(ids.clientA1);
    try {
      await expect(move(operarAndVisualizar, s.contentId, s.to)).rejects.toMatchObject({ code: 'A0061' });
      expect((await w.contentRow(s.contentId)).folder_id).toBe(s.from);
    } finally {
      await w.reactivateClient(ids.clientA1);
    }
  });

  it('is executable by the application role for the two entry points, and the shared helper by nobody', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ name: string; app: boolean; anyone: boolean }> }>(`
      select p.proname as name,
        has_function_privilege('ageniza_app', p.oid, 'EXECUTE') as app,
        has_function_privilege('public', p.oid, 'EXECUTE') as anyone
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname in ('move_content_folder', 'inherit_content_media', 'folder_media_for')
      order by p.proname
    `);
    expect(rows).toEqual([
      { name: 'folder_media_for', app: false, anyone: false },
      { name: 'inherit_content_media', app: true, anyone: false },
      { name: 'move_content_folder', app: true, anyone: false }
    ]);
    await expect(w.asUser(operarAndVisualizar, (transaction) => transaction.raw('select app_private.folder_media_for(?::uuid, ?::uuid, ?)', [ids.clientA1, randomUUID(), 'image'])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it.each(['repeatable read', 'serializable'] as const)('%s: a lock read again after a wait cannot be trusted, so the move and the inheritance are refused', async (level) => {
    const s = await scene();
    const stale = await w.openTransactionAs(operarAndVisualizar, level);
    try {
      await expect(stale.raw('select app_private.move_content_folder(?::uuid, ?::uuid, null)', [s.contentId, s.to])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await stale.rollback();
    }
    const second = await w.openTransactionAs(operarAndVisualizar, level);
    try {
      await expect(second.raw('select app_private.inherit_content_media(?::uuid)', [s.contentId])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await second.rollback();
    }
    expect((await w.contentRow(s.contentId)).folder_id).toBe(s.from);
  });

  it.each(['repeatable read', 'serializable'] as const)('%s: the refusal comes before the content is read, even for the folder it already has and for a published one', async (level) => {
    const s = await scene();
    const published = await scene({ status: 'published' });
    for (const [content, folder] of [[s.contentId, s.from], [published.contentId, published.to]] as const) {
      const stale = await w.openTransactionAs(operarAndVisualizar, level);
      try {
        await expect(stale.raw('select app_private.move_content_folder(?::uuid, ?::uuid, null)', [content, folder])).rejects.toMatchObject({ code: '40001' });
      } finally {
        await stale.rollback();
      }
    }
  });
});

describe('a content born takes what its folder holds', () => {
  it('takes the media of its format, in the order of the folder', async () => {
    const folder = await newFolder(ids.clientA1);
    const first = await w.seedAsset(ids.clientA1, folder);
    const second = await w.seedAsset(ids.clientA1, folder);
    const contentId = await w.seedContent(ids.clientA1, { format: 'carousel', folderId: folder });

    await inherit(operarAndVisualizar, contentId);

    expect(await listOf(contentId)).toEqual([second, first]);
  });

  it('takes only what fits the format of the content: a reels takes the newest video, an image the newest image', async () => {
    const folder = await newFolder(ids.clientA1);
    const image = await w.seedAsset(ids.clientA1, folder, { category: 'image' });
    const oldVideo = await w.seedAsset(ids.clientA1, folder, { category: 'video' });
    const newestVideo = await w.seedAsset(ids.clientA1, folder, { category: 'video' });
    const reels = await w.seedContent(ids.clientA1, { format: 'reels', folderId: folder });
    const picture = await w.seedContent(ids.clientA1, { format: 'image', folderId: folder });

    await inherit(operarAndVisualizar, reels);
    await inherit(operarAndVisualizar, picture);

    expect(await listOf(reels)).toEqual([newestVideo]);
    expect(await listOf(picture)).toEqual([image]);
    expect(oldVideo).not.toBe(newestVideo);
  });

  it('leaves a content of an empty folder without media', async () => {
    const contentId = await w.seedContent(ids.clientA1, { format: 'image', folderId: await newFolder(ids.clientA1) });
    await inherit(operarAndVisualizar, contentId);
    expect(await listOf(contentId)).toEqual([]);
  });
});

describe('two writers at the same time (decision 2026-11-04)', () => {
  it('serializes two moves of the same content: the second one is the one that stays, with its own list', async () => {
    const s = await scene({ format: 'carousel' });
    const other = await newFolder(ids.clientA1);
    const inFirst = await w.seedAsset(ids.clientA1, s.to);
    const inSecond = await w.seedAsset(ids.clientA1, other);
    const first = await w.openTransactionAs(operarAndVisualizar);
    let released = false;
    try {
      await first.raw('select app_private.move_content_folder(?::uuid, ?::uuid, null)', [s.contentId, s.to]);
      const holderPid = await backendPid(first);

      const second = move(operarAndVisualizar, s.contentId, other);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      expect(await listOf(s.contentId)).toEqual(s.oldAssets);

      await first.commit();
      released = true;
      await second;
    } finally {
      if (!released) await first.rollback();
    }

    const row = await w.contentRow(s.contentId);
    expect(row.folder_id).toBe(other);
    expect(await listOf(s.contentId)).toEqual([inSecond]);
    expect(inFirst).not.toBe(inSecond);
    const rows = await w.getOwner().knex('content_media').where({ content_id: s.contentId }).select('folder_id');
    expect(rows.every((item) => item.folder_id === other)).toBe(true);
  });

  it('does not take a media whose removal is in course: it waits, reads it again and leaves it out', async () => {
    const s = await scene({ format: 'carousel' });
    const kept = await w.seedAsset(ids.clientA1, s.to);
    const leaving = await w.seedAsset(ids.clientA1, s.to);
    const remover = await w.openTransactionAs(operarAndVisualizar);
    let released = false;
    try {
      await remover.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [leaving, s.to]);
      const holderPid = await backendPid(remover);

      const moving = move(operarAndVisualizar, s.contentId, s.to);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);

      await remover.commit();
      released = true;
      await moving;
    } finally {
      if (!released) await remover.rollback();
    }

    expect(await listOf(s.contentId)).toEqual([kept]);
  });

  it('lets a media of the old folder be removed once the move took the content out of it', async () => {
    const s = await scene({ format: 'carousel' });
    const leaving = s.oldAssets[0]!;
    await w.seedAsset(ids.clientA1, s.to);
    const mover = await w.openTransactionAs(operarAndVisualizar);
    let released = false;
    let removal: Promise<unknown> | undefined;
    try {
      await mover.raw('select app_private.move_content_folder(?::uuid, ?::uuid, null)', [s.contentId, s.to]);
      const holderPid = await backendPid(mover);
      removal = w.asUser(operarAndVisualizar, (transaction) => transaction.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [leaving, s.from]));
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      await mover.commit();
      released = true;
      await removal;
    } finally {
      if (!released) {
        await mover.rollback();
        await removal?.catch(() => undefined);
      }
    }

    expect((await w.getOwner().knex('media_assets').where({ id: leaving }).first('removed_at'))?.removed_at).toBeInstanceOf(Date);
    expect(await listOf(s.contentId)).not.toContain(leaving);
  });

  it('protects the media of an approved content: a move that waits for the approval finds it approved and takes it back', async () => {
    const s = await scene({ status: 'awaiting_approval', format: 'reels', assets: 1 });
    const video = await w.seedAsset(ids.clientA1, s.to, { category: 'video' });
    const revision = Number((await w.contentRow(s.contentId)).revision);
    const approver = await w.openTransactionAs(ids.portalA1);
    let released = false;
    try {
      await approver.raw('select app_private.approve_content(?::uuid, ?::integer)', [s.contentId, revision]);
      const holderPid = await backendPid(approver);

      const moving = move(operarAndVisualizar, s.contentId, s.to);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      await approver.commit();
      released = true;
      await moving;
    } finally {
      if (!released) await approver.rollback();
    }

    const row = await w.contentRow(s.contentId);
    expect([row.status, row.approved_by, row.folder_id]).toEqual(['awaiting_approval', null, s.to]);
    expect(await listOf(s.contentId)).toEqual([video]);
  });

  it('makes an approval of the revision read before the move fail after it: nothing is approved on a list the person never saw', async () => {
    const s = await scene({ status: 'awaiting_approval', format: 'reels', assets: 1 });
    await w.seedAsset(ids.clientA1, s.to, { category: 'video' });
    const revision = Number((await w.contentRow(s.contentId)).revision);

    await move(operarAndVisualizar, s.contentId, s.to);

    await expect(w.asUser(ids.portalA1, (transaction) => transaction.raw('select app_private.approve_content(?::uuid, ?::integer)', [s.contentId, revision])))
      .rejects.toMatchObject({ code: 'A0063' });
    expect((await w.contentRow(s.contentId)).status).toBe('awaiting_approval');
  });

  it('answers "archived" and moves nothing when the archive of the client is in course', async () => {
    const s = await scene();
    await w.seedAsset(ids.clientA1, s.to);
    const archive = await w.getOwner().knex.transaction();
    let released = false;
    try {
      await archive.raw("update public.clients set status = 'archived', archived_at = now() where id = ?::uuid", [ids.clientA1]);
      const holderPid = await backendPid(archive);

      const moving = move(operarAndVisualizar, s.contentId, s.to).then(() => 'moved', (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      await archive.commit();
      released = true;

      expect(await moving).toBe('A0061');
      expect((await w.contentRow(s.contentId)).folder_id).toBe(s.from);
      expect(await listOf(s.contentId)).toEqual(s.oldAssets);
    } finally {
      if (!released) await archive.rollback();
      await w.reactivateClient(ids.clientA1);
    }
  });

  it('sees a content sent for approval while it waited: it does not leave the content without media', async () => {
    const s = await scene({ format: 'reels', assets: 1 });
    const before = await w.contentRow(s.contentId);
    await w.seedAsset(ids.clientA1, s.to, { category: 'image' });
    const sender = await w.openTransactionAs(operarAndVisualizar);
    let released = false;
    try {
      await sender.raw('select app_private.submit_content(?::uuid)', [s.contentId]);
      const holderPid = await backendPid(sender);

      const moving = move(operarAndVisualizar, s.contentId, s.to).then(() => 'moved', (error: { code?: string }) => error.code);
      await waitForBackendsBlockedBy(w.getOwner().knex, holderPid);
      await sender.commit();
      released = true;

      expect(await moving).toBe('A0065');
    } finally {
      if (!released) await sender.rollback();
    }

    const row = await w.contentRow(s.contentId);
    expect([row.status, row.folder_id, row.cover_asset_id]).toEqual(['awaiting_approval', s.from, before.cover_asset_id]);
    expect(await listOf(s.contentId)).toEqual(s.oldAssets);
  });
});
