import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Issue #384 and the database half of #253 (specs/conteudo.md §5 rules 3 and 12). Every attack runs as
// `ageniza_app`; RLS filters silently, so a read is checked by the rows it returns and a write by the state left
// in the database. A custom role holding one permission stands in for each guard.
const w = createContentWorld('conteudo-media-removal');
const { ids } = w;

const NOT_FOUND = { code: 'A0080' };
const IN_USE = { code: 'A0082' };

const extraAgencies: Array<{ agencyId: string; clientId: string; userId: string }> = [];

let folderVideos: string;
let folderImages: string;
let onlyOperar: string;
let onlyVisualizar: string;
let operarAndVisualizar: string;
let onlyMidia: string;
let onlyOperarAndMidia: string;

beforeAll(async () => {
  await w.setup();
  folderVideos = await w.folderOf(ids.clientA1);
  folderImages = await w.folderOf(ids.clientA1, 'Imagens');
  onlyOperar = await w.personWith('conteudo.operar');
  onlyVisualizar = await w.personWith('conteudo.visualizar');
  operarAndVisualizar = await w.personWith('conteudo.operar', 'conteudo.visualizar');
  onlyMidia = await w.personWith('midia.enviar');
  onlyOperarAndMidia = await w.personWith('conteudo.operar', 'midia.enviar');
});

afterAll(async () => {
  for (const extra of extraAgencies) {
    await w.getOwner().knex('media_assets').where({ agency_id: extra.agencyId }).delete();
    await w.getOwner().knex('clients').where({ id: extra.clientId }).delete();
    await w.getOwner().knex('agencies').where({ id: extra.agencyId }).update({ owner_user_id: null });
    await w.getOwner().knex('agencies').where({ id: extra.agencyId }).delete();
    await w.getOwner().knex('auth.user').where({ id: extra.userId }).delete();
  }
  await w.getOwner().knex('media_assets').where({ agency_id: ids.agencyA }).whereNull('client_id').delete();
  await w.teardown();
});

const fn = (user: string, signature: string, ...args: unknown[]): Promise<unknown> =>
  w.asUser(user, (transaction) => transaction.raw(`select app_private.${signature}`, args as never[]));
const removeAs = (user: string, assetId: string, folderId: string) => fn(user, 'remove_media_asset(?::uuid, ?::uuid)', assetId, folderId);
const submitAs = (user: string, contentId: string) => fn(user, 'submit_content(?::uuid)', contentId);

const removedAt = async (assetId: string): Promise<Date | null> =>
  (await w.getOwner().knex('media_assets').where({ id: assetId }).first('removed_at'))?.removed_at as Date | null;

const usageAs = async (user: string, windowSeconds: number | null, exclude: string | null = null, agency = ids.agencyA): Promise<{ bytes: number; count: number }> => {
  const result = await w.asUser(user, (transaction) => transaction.raw<{ rows: Array<{ used_bytes: string; used_object_count: string }> }>(
    'select used_bytes, used_object_count from app_private.agency_media_usage(?::uuid, ?::integer, ?::uuid)',
    [agency, windowSeconds, exclude] as never[]
  ));
  const row = result.rows[0];
  return { bytes: Number(row?.used_bytes), count: Number(row?.used_object_count) };
};

const seedAgencyMedia = async (extra: { size: number; status: 'confirmed' | 'pending'; updatedAt?: Date }): Promise<string> => {
  const id = randomUUID();
  await w.getOwner().knex('media_assets').insert({
    id,
    agency_id: ids.agencyA,
    category: 'image',
    declared_content_type: 'image/png',
    extension: 'png',
    object_key: `${ids.agencyA}/${id}/original.png`,
    upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`,
    declared_size_bytes: extra.size,
    created_by_user_id: ids.adminA,
    ...(extra.status === 'confirmed' ? { status: 'confirmed', confirmed_size_bytes: extra.size, confirmed_content_type: 'image/png', confirmed_at: new Date() } : {}),
    ...(extra.updatedAt === undefined ? {} : { updated_at: extra.updatedAt })
  });
  return id;
};

describe('the storage quota is summed over the whole agency (issue #253)', () => {
  it('counts the media of a client that the caller cannot read, and the pending ones inside the window', async () => {
    const before = await usageAs(ids.adminA, 900);
    const stale = new Date(Date.now() - 3_600_000);

    await w.seedAsset(ids.clientA1, folderImages);
    await w.seedAsset(ids.clientA1, folderVideos, { category: 'video' });
    await w.seedAsset(ids.clientA1, folderImages, { status: 'pending' });
    await w.seedAsset(ids.clientA1, folderImages, { status: 'rejected' });
    await w.seedAsset(ids.clientA1, folderImages, { removed: true });
    await seedAgencyMedia({ size: 500, status: 'confirmed' });
    const staleReservation = await seedAgencyMedia({ size: 7_000, status: 'pending', updatedAt: stale });

    // Confirmed 1000 + 1000, pending inside the window 1000, removed 1000 (still in storage) and 500 without client.
    await expect(usageAs(onlyMidia, 900)).resolves.toEqual({ bytes: before.bytes + 4_500, count: before.count + 5 });
    // The caller reads none of the client's media: the sum it used to compute was short by 4 000.
    const hidden = await w.asUser(onlyMidia, (transaction) => transaction('media_assets').where({ agency_id: ids.agencyA }).whereNotNull('client_id').count({ total: '*' }));
    expect(Number(hidden[0]?.total)).toBe(0);

    // A pending reservation counts only while it is fresh; a longer window brings the stale one back.
    await expect(usageAs(ids.adminA, 7_200)).resolves.toEqual({ bytes: before.bytes + 4_500 + 7_000, count: before.count + 6 });
    await expect(usageAs(ids.adminA, 0)).resolves.toEqual({ bytes: before.bytes + 3_500, count: before.count + 4 });
    await expect(usageAs(ids.adminA, 900, staleReservation)).resolves.toEqual({ bytes: before.bytes + 4_500, count: before.count + 5 });
  });

  it('leaves out the asset the caller asks to exclude', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);
    const all = await usageAs(ids.adminA, 900);

    await expect(usageAs(ids.adminA, 900, asset)).resolves.toEqual({ bytes: all.bytes - 1_000, count: all.count - 1 });
  });

  it('answers who uploads, whichever of the two permissions it is, and nobody else', async () => {
    await expect(usageAs(onlyMidia, 900)).resolves.toMatchObject({ count: expect.any(Number) });
    await expect(usageAs(onlyOperarAndMidia, 900)).resolves.toMatchObject({ count: expect.any(Number) });
    await expect(usageAs(onlyOperar, 900)).resolves.toMatchObject({ count: expect.any(Number) });

    for (const outsider of [onlyVisualizar, ids.salesA, ids.financeA, ids.adminB, ids.crossDual, ids.portalA1, ids.dualBare]) {
      await expect(usageAs(outsider, 900)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses a window that would silently drop the pending reservations', async () => {
    await expect(usageAs(ids.adminA, null)).rejects.toMatchObject({ code: '22023' });
    await expect(usageAs(ids.adminA, -1)).rejects.toMatchObject({ code: '22023' });
  });
});

describe('removing a media from its folder (issue #384, rule 12)', () => {
  it('marks it removed once, and a second call changes nothing', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);

    await removeAs(operarAndVisualizar, asset, folderImages);
    const first = await removedAt(asset);
    expect(first).toBeInstanceOf(Date);

    await removeAs(operarAndVisualizar, asset, folderImages);
    expect(await removedAt(asset)).toEqual(first);
  });

  it('is the only way: not even an Admin writes removed_at', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);

    await expect(w.asUser(ids.adminA, (transaction) => transaction('media_assets').where({ id: asset }).update({ removed_at: new Date() })))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table media_assets') });
    expect(await w.columnsWithPrivilege('media_assets', 'update')).not.toContain('removed_at');
    expect(await removedAt(asset)).toBeNull();
  });

  it('needs conteudo.operar AND conteudo.visualizar: one of them alone is not found', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);

    for (const person of [onlyOperar, onlyVisualizar, onlyMidia, await w.personWith()]) {
      await expect(removeAs(person, asset, folderImages)).rejects.toMatchObject(NOT_FOUND);
    }
    expect(await removedAt(asset)).toBeNull();

    await removeAs(operarAndVisualizar, asset, folderImages);
    expect(await removedAt(asset)).not.toBeNull();
  });

  it('is not found for the roles without the permissions, the portal, the dual people and another agency', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);

    for (const outsider of [ids.salesA, ids.financeA, ids.portalA1, ids.dualBare, ids.crossDual, ids.adminB, ids.portalB]) {
      await expect(removeAs(outsider, asset, folderImages)).rejects.toMatchObject(NOT_FOUND);
    }
    expect(await removedAt(asset)).toBeNull();

    // A person who holds a role of the agency and a link to the client is a collaborator like any other.
    await removeAs(ids.dualFull, asset, folderImages);
    expect(await removedAt(asset)).not.toBeNull();
  });

  it('answers the same for a media that does not exist, one of another client, another folder, or without a client', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);
    const otherClient = await w.seedAsset(ids.clientA2, await w.folderOf(ids.clientA2, 'Imagens'));
    const otherAgency = await w.seedAsset(ids.clientB, await w.folderOf(ids.clientB, 'Imagens'));
    const agencyMedia = await seedAgencyMedia({ size: 10, status: 'confirmed' });
    const forbidden = await removeAs(ids.salesA, asset, folderImages).catch((error: unknown) => error as Error);

    const attempts: ReadonlyArray<() => Promise<unknown>> = [
      () => removeAs(ids.adminA, randomUUID(), folderImages),
      () => removeAs(ids.adminA, asset, folderVideos),
      () => removeAs(ids.adminA, asset, randomUUID()),
      () => removeAs(ids.adminA, otherClient, folderImages),
      () => removeAs(ids.adminA, otherAgency, folderImages),
      () => removeAs(ids.adminA, agencyMedia, folderImages)
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ ...NOT_FOUND, message: (forbidden as Error).message });
    }
    expect(await Promise.all([asset, otherClient, otherAgency, agencyMedia].map(removedAt))).toEqual([null, null, null, null]);
  });

  it('removes only a confirmed media: a pending or rejected upload is not a media of the folder', async () => {
    const pending = await w.seedAsset(ids.clientA1, folderImages, { status: 'pending' });
    const rejected = await w.seedAsset(ids.clientA1, folderImages, { status: 'rejected' });

    await expect(removeAs(ids.adminA, pending, folderImages)).rejects.toMatchObject(NOT_FOUND);
    await expect(removeAs(ids.adminA, rejected, folderImages)).rejects.toMatchObject(NOT_FOUND);
    expect(await Promise.all([removedAt(pending), removedAt(rejected)])).toEqual([null, null]);
  });

  it('refuses a client that was archived, and leaves the media as it was', async () => {
    const asset = await w.seedAsset(ids.clientArchived, await w.folderOf(ids.clientArchived, 'Imagens'));
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(removeAs(ids.adminA, asset, await w.folderOf(ids.clientArchived, 'Imagens'))).rejects.toMatchObject({ code: 'A0081' });
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect(await removedAt(asset)).toBeNull();
  });

  // The content states and whether the media may leave. A table of literals, not a loop over the rule.
  const byState: ReadonlyArray<readonly [ContentStatus, boolean]> = [
    ['in_production', true], ['adjusting', true], ['cancelled', true],
    ['awaiting_approval', false], ['approved', false], ['published', false]
  ];

  it.each(byState)('a media of a content %s is removable: %s', async (status, removable) => {
    const content = await w.seedContent(ids.clientA1, { status, format: 'image', folderId: folderImages });
    const asset = await w.seedAsset(ids.clientA1, folderImages);
    await w.attach(content, [asset]);

    if (removable) {
      await removeAs(operarAndVisualizar, asset, folderImages);
      expect(await removedAt(asset)).not.toBeNull();
    } else {
      await expect(removeAs(operarAndVisualizar, asset, folderImages)).rejects.toMatchObject(IN_USE);
      expect(await removedAt(asset)).toBeNull();
    }
  });

  it.each(byState)('a cover of a content %s is removable: %s', async (status, removable) => {
    const cover = await w.seedAsset(ids.clientA1, folderImages);
    await w.seedContent(ids.clientA1, { status, folderId: folderImages, coverAssetId: cover });

    if (removable) {
      await removeAs(operarAndVisualizar, cover, folderImages);
      expect(await removedAt(cover)).not.toBeNull();
    } else {
      await expect(removeAs(operarAndVisualizar, cover, folderImages)).rejects.toMatchObject(IN_USE);
      expect(await removedAt(cover)).toBeNull();
    }
  });

  it('does not let a media in use by another content go, even when the first one lets it', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);
    await w.attach(await w.seedContent(ids.clientA1, { status: 'cancelled', format: 'image', folderId: folderImages }), [asset]);
    await w.attach(await w.seedContent(ids.clientA1, { status: 'published', format: 'image', folderId: folderImages }), [asset]);

    await expect(removeAs(operarAndVisualizar, asset, folderImages)).rejects.toMatchObject(IN_USE);
  });

  it('is gone for a new content and for the portal once removed', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);
    const adjusting = await w.seedContent(ids.clientA1, { status: 'adjusting', format: 'image', folderId: folderImages });
    await w.attach(adjusting, [asset]);
    const inProduction = await w.seedContent(ids.clientA1, { format: 'image', folderId: folderImages });
    const portalSees = async () => (await w.asUser(ids.portalA1, (transaction) => transaction.raw<{ rows: Array<{ asset_id: string }> }>(
      'select asset_id from app_private.portal_content_media(?::uuid)', [adjusting] as never[]
    ))).rows.map((row) => row.asset_id);
    expect(await portalSees()).toEqual([asset]);

    await removeAs(operarAndVisualizar, asset, folderImages);

    expect(await portalSees()).toEqual([]);
    await expect(fn(ids.productionA, 'set_content_media(?::uuid, ?::uuid[])', inProduction, [asset])).rejects.toMatchObject({ code: 'A0069' });
    await expect(w.asUser(ids.adminA, (transaction) => transaction('contents').insert({
      client_id: ids.clientA1, title: 'Capa removida', platform: 'instagram', format: 'image', publish_on: '2026-10-25', folder_id: folderImages, cover_asset_id: asset, owner_user_id: ids.productionA
    }))).rejects.toMatchObject({ code: 'A0069' });
  });
});

describe('removal against the transition that races it (issue #384)', () => {
  it('waits for a content being sent, then refuses the media of the content that is now waiting', async () => {
    const content = await w.seedContent(ids.clientA1, { folderId: folderVideos });
    const asset = await w.seedAsset(ids.clientA1, folderVideos, { category: 'video' });
    await w.attach(content, [asset]);
    const sender = await w.openTransactionAs(ids.productionA);
    let removing: Promise<unknown> | undefined;

    try {
      await sender.raw('select app_private.submit_content(?::uuid)', [content]);
      removing = removeAs(operarAndVisualizar, asset, folderVideos).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await sender.commit();
    }

    expect(await removing).toMatchObject(IN_USE);
    expect(await removedAt(asset)).toBeNull();
    expect((await w.contentRow(content)).status).toBe('awaiting_approval');
  });

  it('is waited for by a content being sent, which then finds its media gone', async () => {
    const content = await w.seedContent(ids.clientA1, { folderId: folderVideos });
    const asset = await w.seedAsset(ids.clientA1, folderVideos, { category: 'video' });
    await w.attach(content, [asset]);
    const remover = await w.openTransactionAs(operarAndVisualizar);
    let sending: Promise<unknown> | undefined;

    try {
      await remover.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [asset, folderVideos]);
      sending = submitAs(ids.productionA, content).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await remover.commit();
    }

    expect(await sending).toMatchObject({ code: 'A0065' });
    expect(await removedAt(asset)).not.toBeNull();
    expect((await w.contentRow(content)).status).toBe('in_production');
  });

  it('waits for the client being archived, then refuses it as archived', async () => {
    const folder = await w.folderOf(ids.clientA2, 'Imagens');
    const asset = await w.seedAsset(ids.clientA2, folder);
    const archiver = await w.openTransactionAs(ids.adminA);
    let removing: Promise<unknown> | undefined;

    try {
      await archiver.raw('select app_private.archive_client(?::uuid)', [ids.clientA2]);
      removing = removeAs(operarAndVisualizar, asset, folder).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiver.commit();
    }

    try {
      expect(await removing).toMatchObject({ code: 'A0081' });
    } finally {
      await w.reactivateClient(ids.clientA2);
    }
    expect(await removedAt(asset)).toBeNull();
  });
});

describe('locking the parent folder (issue #253)', () => {
  const lockAs = (user: string, folderId: string) => w.asUser(user, (transaction) => transaction.raw<{ rows: Array<{ id: string; client_id: string; is_default: boolean }> }>(
    'select id, client_id, is_default from app_private.lock_media_folder(?::uuid)', [folderId] as never[]
  ));

  it('locks what a plain select for update as the application role cannot: a default folder', async () => {
    const locked = await w.asUser(operarAndVisualizar, (transaction) => transaction('media_folders').where({ id: folderVideos }).forUpdate().select('id'));
    expect(locked).toEqual([]);

    expect((await lockAs(operarAndVisualizar, folderVideos)).rows).toEqual([{ id: folderVideos, client_id: ids.clientA1, is_default: true }]);
  });

  it('needs conteudo.operar AND conteudo.visualizar, and is not found for anyone else', async () => {
    for (const person of [onlyOperar, onlyVisualizar, onlyMidia, ids.salesA, ids.portalA1, ids.dualBare, ids.crossDual, ids.adminB]) {
      await expect(lockAs(person, folderVideos)).rejects.toMatchObject(NOT_FOUND);
    }
    await expect(lockAs(operarAndVisualizar, randomUUID())).rejects.toMatchObject(NOT_FOUND);
    await expect(lockAs(ids.adminA, await w.folderOf(ids.clientB))).rejects.toMatchObject(NOT_FOUND);
  });

  it('makes a second lock and a child insert wait behind the first', async () => {
    const holder = await w.openTransactionAs(operarAndVisualizar);

    try {
      await holder.raw('select id from app_private.lock_media_folder(?::uuid)', [folderVideos]);

      await expect(w.asUser(ids.adminA, async (transaction) => {
        await transaction.raw("set local lock_timeout = '300ms'");
        await transaction.raw('select id from app_private.lock_media_folder(?::uuid)', [folderVideos]);
      })).rejects.toMatchObject({ code: '55P03' });

      await expect(w.asUser(ids.adminA, async (transaction) => {
        await transaction.raw("set local lock_timeout = '300ms'");
        await transaction('media_folders').insert({ client_id: ids.clientA1, parent_id: folderVideos, name: 'Lançamento' });
      })).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.rollback();
    }

    expect(await w.getOwner().knex('media_folders').where({ client_id: ids.clientA1, name: 'Lançamento' })).toHaveLength(0);
    await expect(lockAs(ids.adminA, folderVideos)).resolves.toMatchObject({ rows: [{ id: folderVideos }] });
  });
});

describe('the sum belongs to the agency that asks (issue #253, review of #394)', () => {
  it('measures the value of a fresh agency, which another agency\'s media does not move', async () => {
    const userE = randomUUID();
    const agencyE = randomUUID();
    const clientE = randomUUID();
    extraAgencies.push({ agencyId: agencyE, clientId: clientE, userId: userE });
    await w.getOwner().knex('auth.user').insert({ id: userE, name: 'Owner E', email: `${userE}@conteudo-media-removal.test`, emailVerified: true });
    await w.getOwner().knex('agencies').insert({ id: agencyE, name: `Agência E ${agencyE}`, owner_user_id: userE });
    await w.getOwner().knex('clients').insert({ id: clientE, agency_id: agencyE, name: `Cliente E ${clientE}` });
    const folderE = (await w.getOwner().knex('media_folders').where({ client_id: clientE, name: 'Imagens' }).first('id')).id as string;
    const insertFor = async (size: number): Promise<void> => {
      const id = randomUUID();
      await w.getOwner().knex('media_assets').insert({
        id, agency_id: agencyE, client_id: clientE, folder_id: folderE, category: 'image', declared_content_type: 'image/png', extension: 'png',
        object_key: `${agencyE}/${id}/original.png`, upload_object_key: `staging/${agencyE}/${id}/upload.png`, declared_size_bytes: size,
        created_by_user_id: userE, status: 'confirmed', confirmed_size_bytes: size, confirmed_content_type: 'image/png', confirmed_at: new Date()
      });
    };
    const ofA = await usageAs(ids.adminA, 900);

    await insertFor(300);
    await insertFor(200);

    // A's sum cannot depend on E's media, and E's is exactly its own two files, whatever A holds.
    await expect(usageAs(ids.adminA, 900)).resolves.toEqual(ofA);
    await expect(usageAs(userE, 900, null, agencyE)).resolves.toEqual({ bytes: 500, count: 2 });
  });
});

describe('removal against a media swap that races it (issue #384, review of #394)', () => {
  const awaitingWith = async (first: string): Promise<string> => {
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval', format: 'image', folderId: folderImages });
    await w.attach(content, [first]);
    return content;
  };
  const setMedia = (tx: Awaited<ReturnType<typeof w.openTransactionAs>>, content: string, assets: string[]) =>
    tx.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [content, assets]);

  it('makes a swap to the media wait for the removal that holds it, then refuses the content that now has a removed file', async () => {
    const first = await w.seedAsset(ids.clientA1, folderImages);
    const swapped = await w.seedAsset(ids.clientA1, folderImages);
    const content = await awaitingWith(first);
    const remover = await w.openTransactionAs(operarAndVisualizar);
    let swapping: Promise<unknown> | undefined;

    try {
      const locker = await remover.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [swapped, folderImages]);
      expect(locker.rows).toHaveLength(1);
      swapping = w.asUser(ids.productionA, (tx) => setMedia(tx, content, [swapped])).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await remover.commit();
    }

    expect(await swapping).toMatchObject({ code: 'A0065' });
    expect(await removedAt(swapped)).not.toBeNull();
    expect(await w.getOwner().knex('content_media').where({ content_id: content }).pluck('asset_id')).toEqual([first]);
  });

  it('makes the removal wait for a swap that holds the media, then refuses a media that a waiting content now uses', async () => {
    const first = await w.seedAsset(ids.clientA1, folderImages);
    const swapped = await w.seedAsset(ids.clientA1, folderImages);
    const content = await awaitingWith(first);
    const swapper = await w.openTransactionAs(ids.productionA);
    let removing: Promise<unknown> | undefined;

    try {
      const locker = await setMedia(swapper, content, [swapped]);
      expect(locker.rows).toHaveLength(1);
      removing = removeAs(operarAndVisualizar, swapped, folderImages).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await swapper.commit();
    }

    expect(await removing).toMatchObject(IN_USE);
    expect(await removedAt(swapped)).toBeNull();
    expect(await w.getOwner().knex('content_media').where({ content_id: content }).pluck('asset_id')).toEqual([swapped]);
  });
});

describe('removal against a cover swap that races it (issue #396)', () => {
  const coverOf = async (content: string): Promise<string | null> => (await w.contentRow(content)).cover_asset_id as string | null;

  it('makes a cover swap wait for the removal that holds the media, then refuses the removed cover', async () => {
    const cover = await w.seedAsset(ids.clientA1, folderImages);
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval', folderId: folderImages });
    const remover = await w.openTransactionAs(operarAndVisualizar);
    let swapping: Promise<unknown> | undefined;

    try {
      const locker = await remover.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [cover, folderImages]);
      expect(locker.rows).toHaveLength(1);
      swapping = w.asUser(ids.productionA, (tx) => tx('contents').where({ id: content }).update({ cover_asset_id: cover })).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await remover.commit();
    }

    expect(await swapping).toMatchObject({ code: 'A0069' });
    expect(await removedAt(cover)).not.toBeNull();
    expect(await coverOf(content)).toBeNull();
  });

  it('makes the removal wait for a cover swap that holds the media, then refuses the cover of a waiting content', async () => {
    const cover = await w.seedAsset(ids.clientA1, folderImages);
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval', folderId: folderImages });
    const swapper = await w.openTransactionAs(ids.productionA);
    let removing: Promise<unknown> | undefined;

    try {
      expect(await swapper('contents').where({ id: content }).update({ cover_asset_id: cover })).toBe(1);
      removing = removeAs(operarAndVisualizar, cover, folderImages).catch((error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await swapper.commit();
    }

    expect(await removing).toMatchObject(IN_USE);
    expect(await removedAt(cover)).toBeNull();
    expect(await coverOf(content)).toBe(cover);
  });

  it('does not publish a content whose cover was removed', async () => {
    const cover = await w.seedAsset(ids.clientA1, folderImages);
    const file = await w.seedAsset(ids.clientA1, folderImages);
    const content = await w.seedContent(ids.clientA1, { status: 'approved', format: 'image', folderId: folderImages, coverAssetId: cover });
    await w.attach(content, [file]);
    await w.getOwner().knex('media_assets').where({ id: cover }).update({ removed_at: new Date() });

    await expect(fn(ids.productionA, 'publish_content(?::uuid, ?::date)', content, '2026-10-06')).rejects.toMatchObject({ code: 'A0065' });
    expect((await w.contentRow(content)).status).toBe('approved');
  });
});

describe('a snapshot older than the lock is refused, not trusted (review of #394)', () => {
  const levels = ['repeatable read', 'serializable'] as const;
  const staleFailure = { code: '40001', message: expect.stringContaining('READ COMMITTED') };

  it.each(levels)('%s: the removal of a media that a waiting content got after the snapshot is refused, and the media stays', async (level) => {
    const first = await w.seedAsset(ids.clientA1, folderImages);
    const swapped = await w.seedAsset(ids.clientA1, folderImages);
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval', format: 'image', folderId: folderImages });
    await w.attach(content, [first]);
    const stale = await w.openTransactionAs(operarAndVisualizar, level);

    try {
      await fn(ids.productionA, 'set_content_media(?::uuid, ?::uuid[])', content, [swapped]);
      await expect(stale.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [swapped, folderImages])).rejects.toMatchObject(staleFailure);
    } finally {
      await stale.rollback();
    }
    expect(await removedAt(swapped)).toBeNull();
  });

  it.each(levels)('%s: the removal of a media that a waiting content got as cover after the snapshot is refused', async (level) => {
    const cover = await w.seedAsset(ids.clientA1, folderImages);
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval', folderId: folderImages });
    const stale = await w.openTransactionAs(operarAndVisualizar, level);

    try {
      await w.asUser(ids.productionA, (tx) => tx('contents').where({ id: content }).update({ cover_asset_id: cover }));
      await expect(stale.raw('select app_private.remove_media_asset(?::uuid, ?::uuid)', [cover, folderImages])).rejects.toMatchObject(staleFailure);
    } finally {
      await stale.rollback();
    }
    expect(await removedAt(cover)).toBeNull();
  });

  it.each(levels)('%s: a cover set after the snapshot of a removal is refused by the lock on the media', async (level) => {
    const cover = await w.seedAsset(ids.clientA1, folderImages);
    const content = await w.seedContent(ids.clientA1, { status: 'awaiting_approval', folderId: folderImages });
    const setter = await w.openTransactionAs(ids.productionA, level);

    try {
      await removeAs(operarAndVisualizar, cover, folderImages);
      await expect(setter('contents').where({ id: content }).update({ cover_asset_id: cover })).rejects.toMatchObject({ code: expect.stringMatching(/^(40001|A0069)$/) });
    } finally {
      await setter.rollback();
    }
    expect(await w.contentRow(content)).toMatchObject({ cover_asset_id: null });
  });

  it.each(levels)('%s: a content is not sent or published, nor its folder locked, from a snapshot taken before', async (level) => {
    const file = await w.seedAsset(ids.clientA1, folderVideos, { category: 'video' });
    const inProduction = await w.seedContent(ids.clientA1, { folderId: folderVideos });
    await w.attach(inProduction, [file]);
    const approvedFile = await w.seedAsset(ids.clientA1, folderImages);
    const approved = await w.seedContent(ids.clientA1, { status: 'approved', format: 'image', folderId: folderImages });
    await w.attach(approved, [approvedFile]);
    const cases: ReadonlyArray<readonly [string, unknown[], (() => Promise<unknown>) | undefined]> = [
      // The media leaves the content in production after the snapshot of the sender, which could not see it.
      ['select app_private.submit_content(?::uuid)', [inProduction], () => w.getOwner().knex('media_assets').where({ id: file }).update({ removed_at: new Date() })],
      ['select app_private.publish_content(?::uuid, ?::date)', [approved, '2026-10-06'], undefined],
      ['select * from app_private.lock_media_folder(?::uuid)', [folderVideos], undefined]
    ];

    for (const [sql, bindings, outside] of cases) {
      const stale = await w.openTransactionAs(ids.adminA, level);
      try {
        await outside?.();
        await expect(stale.raw(sql, bindings as never[])).rejects.toMatchObject({ code: '40001' });
      } finally {
        await stale.rollback();
      }
    }
    expect((await w.contentRow(inProduction)).status).toBe('in_production');
    expect((await w.contentRow(approved)).status).toBe('approved');
  });
});

describe('who is not authorized does not wait on the lock of someone else (review of #394)', () => {
  const lockTimeout = async (user: string, sql: string, bindings: unknown[]): Promise<unknown> =>
    w.asUser(user, async (transaction) => {
      await transaction.raw("set local lock_timeout = '250ms'");
      return transaction.raw(sql, bindings as never[]);
    });

  it('answers A0080 to the removal and to the folder lock while the client, the media and the folder are locked by another', async () => {
    const asset = await w.seedAsset(ids.clientA1, folderImages);
    const holder = await w.getOwner().knex.transaction();

    try {
      await holder.raw('select 1 from public.clients where id = ? for update', [ids.clientA1]);
      await holder.raw('select 1 from public.media_assets where id = ? for update', [asset]);
      await holder.raw('select 1 from public.media_folders where id in (?, ?) for update', [folderImages, folderVideos]);

      for (const outsider of [ids.adminB, ids.crossDual, ids.portalA1, ids.dualBare, ids.salesA, onlyOperar, onlyVisualizar, onlyMidia]) {
        await expect(lockTimeout(outsider, 'select app_private.remove_media_asset(?::uuid, ?::uuid)', [asset, folderImages]))
          .rejects.toMatchObject({ ...NOT_FOUND });
        await expect(lockTimeout(outsider, 'select * from app_private.lock_media_folder(?::uuid)', [folderImages])).rejects.toMatchObject({ ...NOT_FOUND });
      }
      // The control: who is authorized does wait, so the answers above are not a lock that was never there.
      await expect(lockTimeout(operarAndVisualizar, 'select app_private.remove_media_asset(?::uuid, ?::uuid)', [asset, folderImages])).rejects.toMatchObject({ code: '55P03' });
      await expect(lockTimeout(operarAndVisualizar, 'select * from app_private.lock_media_folder(?::uuid)', [folderImages])).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.rollback();
    }
    expect(await removedAt(asset)).toBeNull();
  });
});

describe('the functions are the only door (issue #384)', () => {
  it('opens the three to ageniza_app, and none to PUBLIC', async () => {
    const names = ['agency_media_usage', 'remove_media_asset', 'lock_media_folder'];
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ name: string; app: boolean; public_execute: boolean; definer: boolean }> }>(`
      select p.proname as name,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app,
             has_function_privilege('public', p.oid, 'execute') as public_execute,
             p.prosecdef as definer
      from pg_catalog.pg_proc p
      where p.pronamespace = 'app_private'::regnamespace and p.proname = any (?::text[])
      order by 1
    `, [names]);

    expect(rows.map((row) => ({ ...row }))).toEqual([
      { name: 'agency_media_usage', app: true, public_execute: false, definer: true },
      { name: 'lock_media_folder', app: true, public_execute: false, definer: true },
      { name: 'remove_media_asset', app: true, public_execute: false, definer: true }
    ]);
  });
});
