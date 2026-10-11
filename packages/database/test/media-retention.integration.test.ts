import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Issue #607 (database half): the retention of a removed media (specs/conteudo.md §3 and §8, decision of 2026-10-11). A removed media
// leaves storage 30 days after `removed_at`, the row stays stamped with `purged_at`, the quota stops counting what was purged and keeps
// counting what was only removed, and a media a content waiting for approval, approved or published uses is never offered nor stamped.
// The worker is `ageniza_app` with no actor bound to the transaction; a request is the same role with one.
const w = createContentWorld('media-retention');
const { ids } = w;
const { applicationUrl } = resolveIntegrationDatabaseUrls();

let worker: DatabaseClient;
let folder: string;

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
  folder = await w.folderOf(ids.clientA1);
});

afterAll(async () => {
  await w.getOwner().knex('audit.events').where({ action: 'media.purged', agency_id: ids.agencyA }).delete();
  await worker.close();
  await w.teardown();
});

const asWorker = <T>(work: (transaction: Knex.Transaction) => Promise<T>, isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'): Promise<T> =>
  worker.knex.transaction(work, isolationLevel === undefined ? {} : { isolationLevel });

interface Due {
  asset_id: string;
  agency_id: string;
  object_key: string;
  upload_object_key: string;
  thumbnail_object_key: string | null;
  preview_object_key: string | null;
}

/** What the worker is offered, narrowed to the media this file made: the database is shared with every other suite. */
const due = async (limit = 500): Promise<Due[]> => {
  const { rows } = await asWorker((transaction) => transaction.raw<{ rows: Due[] }>('select * from app_private.media_due_for_purge(?::integer)', [limit]));
  return rows.filter((row) => row.agency_id === ids.agencyA);
};
const dueIds = async (): Promise<string[]> => (await due()).map((row) => row.asset_id);
const stamp = (assetId: string): Promise<boolean> =>
  asWorker(async (transaction) => (await transaction.raw<{ rows: Array<{ purged: boolean }> }>('select app_private.mark_media_purged(?::uuid) as purged', [assetId])).rows[0]!.purged);

/** A removed media, removed this long ago. */
const removedAgo = async (interval: string, extra: { category?: 'image' | 'video' } = {}): Promise<string> => {
  const assetId = await w.seedAsset(ids.clientA1, folder, extra);
  await w.getOwner().knex.raw(`update public.media_assets set removed_at = now() - ?::interval where id = ?`, [interval, assetId]);
  return assetId;
};

const row = async (assetId: string): Promise<Record<string, unknown>> =>
  (await w.getOwner().knex('media_assets').where({ id: assetId }).first()) as Record<string, unknown>;

const usage = async (): Promise<{ bytes: number; count: number }> => {
  const result = await w.asUser(ids.adminA, (transaction) => transaction.raw<{ rows: Array<{ used_bytes: string; used_object_count: string }> }>(
    'select used_bytes, used_object_count from app_private.agency_media_usage(?::uuid, ?::integer, ?::uuid)', [ids.agencyA, 900, null] as never[]
  ));
  return { bytes: Number(result.rows[0]?.used_bytes), count: Number(result.rows[0]?.used_object_count) };
};

/** A media used by a content in the given state, then removed `interval` ago (the way the state is only reached in a race). */
const usedThenRemoved = async (status: ContentStatus, by: 'file' | 'cover', interval = '31 days'): Promise<string> => {
  const assetId = await w.seedAsset(ids.clientA1, folder);
  const contentId = await w.seedContent(ids.clientA1, { status, ...(by === 'cover' ? { coverAssetId: assetId } : {}) });
  if (by === 'file') await w.attach(contentId, [assetId]);
  await w.getOwner().knex.raw(`update public.media_assets set removed_at = now() - ?::interval where id = ?`, [interval, assetId]);
  return assetId;
};

describe('which removed media is due', () => {
  it('offers a media removed more than 30 days ago and not one removed less, whichever side of the boundary a minute puts it', async () => {
    const old = await removedAgo('31 days');
    const justOver = await removedAgo('30 days 1 minute');
    const justUnder = await removedAgo('29 days 23 hours 59 minutes');
    const recent = await removedAgo('1 day');
    const fresh = await removedAgo('0 seconds');
    const never = await w.seedAsset(ids.clientA1, folder);

    const offered = await dueIds();
    expect(offered).toEqual(expect.arrayContaining([old, justOver]));
    for (const notDue of [justUnder, recent, fresh, never]) expect(offered).not.toContain(notDue);
  });

  it('keeps the period in one function, 30 days, that both the list and the stamp read', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ period: string }> }>('select app_private.media_retention_period()::text as period');
    expect(rows[0]?.period).toBe('30 days');
    const justUnder = await removedAgo('29 days 23 hours 59 minutes');
    await expect(stamp(justUnder)).resolves.toBe(false);
    expect((await row(justUnder)).purged_at).toBeNull();
  });

  it('says what to delete: the original, the staging key, and the thumbnail and the preview of a video, oldest first', async () => {
    const video = await removedAgo('90 days', { category: 'video' });
    await w.getOwner().knex('media_assets').where({ id: video }).update({
      thumbnail_object_key: `${ids.agencyA}/${video}/thumbnail.jpg`,
      preview_object_key: `${ids.agencyA}/${video}/preview.mp4`
    });
    const image = await removedAgo('45 days');

    const offered = await due();
    const mine = offered.filter((item) => item.asset_id === video || item.asset_id === image);
    expect(mine.map((item) => item.asset_id)).toEqual([video, image]);
    expect(mine[0]).toEqual({
      asset_id: video,
      agency_id: ids.agencyA,
      object_key: `${ids.agencyA}/${video}/original.mp4`,
      upload_object_key: `staging/${ids.agencyA}/${video}/upload.mp4`,
      thumbnail_object_key: `${ids.agencyA}/${video}/thumbnail.jpg`,
      preview_object_key: `${ids.agencyA}/${video}/preview.mp4`
    });
    expect(mine[1]).toMatchObject({ thumbnail_object_key: null, preview_object_key: null });
  });

  it('answers a batch of the size asked, from the oldest', async () => {
    await removedAgo('400 days');
    await removedAgo('401 days');
    const everything = await due();
    expect(everything.length).toBeGreaterThanOrEqual(2);
    const one = await asWorker((transaction) => transaction.raw<{ rows: Due[] }>('select * from app_private.media_due_for_purge(?::integer)', [1]));
    expect(one.rows).toHaveLength(1);
  });

  it('does not offer what was purged', async () => {
    const assetId = await removedAgo('40 days');
    await expect(stamp(assetId)).resolves.toBe(true);
    expect(await dueIds()).not.toContain(assetId);
  });
});

describe('a media in use is never offered nor stamped (rule 12)', () => {
  it.each([
    ['awaiting_approval', 'file'], ['awaiting_approval', 'cover'],
    ['approved', 'file'], ['approved', 'cover'],
    ['published', 'file'], ['published', 'cover']
  ] as const)('keeps the media of a content that is %s, used as its %s', async (status, by) => {
    const assetId = await usedThenRemoved(status, by);
    expect(await dueIds()).not.toContain(assetId);
    await expect(stamp(assetId)).resolves.toBe(false);
    expect((await row(assetId)).purged_at).toBeNull();
  });

  it.each([
    ['in_production', 'file'], ['adjusting', 'file'], ['cancelled', 'file'], ['adjusting', 'cover']
  ] as const)('does not hold the media of a content that is %s, used as its %s: it cannot go on with a removed file', async (status, by) => {
    const assetId = await usedThenRemoved(status, by);
    expect(await dueIds()).toContain(assetId);
    await expect(stamp(assetId)).resolves.toBe(true);
  });

  it('lets the media go once the content that held it is gone from the protected states, and not before', async () => {
    const assetId = await usedThenRemoved('awaiting_approval', 'file');
    await expect(stamp(assetId)).resolves.toBe(false);
    const contentId = (await w.getOwner().knex('content_media').where({ asset_id: assetId }).first('content_id'))!.content_id as string;
    await w.getOwner().knex('contents').where({ id: contentId }).update({ status: 'cancelled', cancelled_at: new Date() });
    await expect(stamp(assetId)).resolves.toBe(true);
  });

  it('asks again at the stamp, under the lock of the content: a content sent for approval after the list is not stamped over', async () => {
    const assetId = await usedThenRemoved('in_production', 'file');
    expect(await dueIds()).toContain(assetId);
    const contentId = (await w.getOwner().knex('content_media').where({ asset_id: assetId }).first('content_id'))!.content_id as string;
    await w.getOwner().knex('contents').where({ id: contentId }).update({ status: 'awaiting_approval' });
    await expect(stamp(assetId)).resolves.toBe(false);
    expect((await row(assetId)).purged_at).toBeNull();
  });
});

describe('the stamp', () => {
  it('stamps a due media once, keeps the row and its keys, and writes media.purged to the audit', async () => {
    const assetId = await removedAgo('31 days');
    const before = await row(assetId);

    await expect(stamp(assetId)).resolves.toBe(true);

    const after = await row(assetId);
    expect(after.purged_at).toBeInstanceOf(Date);
    expect(after).toMatchObject({ id: assetId, object_key: before.object_key, upload_object_key: before.upload_object_key, removed_at: before.removed_at, status: 'confirmed' });
    const events = await w.getOwner().knex('audit.events').where({ action: 'media.purged', target_id: assetId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agency_id: ids.agencyA, actor_user_id: null, target_type: 'media_asset', request_id: 'job:media.purge-removed' });

    // The second call finds it done: nothing is stamped again, and the audit does not grow.
    await expect(stamp(assetId)).resolves.toBe(false);
    expect((await row(assetId)).purged_at).toEqual(after.purged_at);
    expect(await w.getOwner().knex('audit.events').where({ action: 'media.purged', target_id: assetId })).toHaveLength(1);
  });

  it.each([
    ['one never removed', async () => w.seedAsset(ids.clientA1, folder)],
    ['one removed a day ago', async () => removedAgo('1 day')],
    ['an id that does not exist', async () => randomUUID()]
  ])('stamps nothing for %s', async (_label, make) => {
    const assetId = await make();
    await expect(stamp(assetId)).resolves.toBe(false);
    expect(await w.getOwner().knex('media_assets').where({ id: assetId }).whereNotNull('purged_at')).toHaveLength(0);
  });

  it('refuses a purge mark on a media that was never removed, whoever writes it', async () => {
    const assetId = await w.seedAsset(ids.clientA1, folder);
    await expect(w.getOwner().knex('media_assets').where({ id: assetId }).update({ purged_at: new Date() })).rejects.toMatchObject({ code: '23514' });
  });
});

describe('who may ask', () => {
  it.each([
    ['the list', 'select * from app_private.media_due_for_purge(10)'],
    ['the stamp', 'select app_private.mark_media_purged(?::uuid)']
  ])('refuses %s to a request: an actor is bound to the transaction of every request', async (_label, statement) => {
    const everything = await w.personWith('conteudo.operar', 'conteudo.visualizar', 'midia.enviar');
    for (const user of [ids.adminA, ids.ownerA, everything]) {
      const bindings = statement.includes('?') ? [randomUUID()] : [];
      await expect(w.asUser(user, (transaction) => transaction.raw(statement, bindings as never[]))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('is closed to PUBLIC and open to the application role, which the worker is', async () => {
    const { rows } = await w.getOwner().knex.raw<{ rows: Array<{ name: string; app: boolean; public_has: boolean }> }>(`
      select proc.proname as name,
        has_function_privilege('ageniza_app', proc.oid, 'EXECUTE') as app,
        exists (select 1 from aclexplode(proc.proacl) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_has
      from pg_proc proc
      where proc.pronamespace = 'app_private'::regnamespace and proc.proname in ('media_due_for_purge', 'mark_media_purged')
      order by 1
    `);
    expect(rows).toEqual([
      { name: 'mark_media_purged', app: true, public_has: false },
      { name: 'media_due_for_purge', app: true, public_has: false }
    ]);
  });

  it('answers 40001 to a stamp that does not run in READ COMMITTED, and 22023 to a batch outside 1 to 500', async () => {
    const assetId = await removedAgo('31 days');
    for (const level of ['repeatable read', 'serializable'] as const) {
      await expect(asWorker((transaction) => transaction.raw('select app_private.mark_media_purged(?::uuid)', [assetId]), level)).rejects.toMatchObject({ code: '40001' });
    }
    expect((await row(assetId)).purged_at).toBeNull();
    for (const limit of [0, -1, 501, null]) {
      await expect(asWorker((transaction) => transaction.raw('select * from app_private.media_due_for_purge(?::integer)', [limit as never]))).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('gives the application role no way to write purged_at, nor to un-remove a media', async () => {
    const assetId = await removedAgo('31 days');
    const insertable = await w.columnsWithPrivilege('media_assets', 'insert');
    const updatable = await w.columnsWithPrivilege('media_assets', 'update');
    for (const column of ['purged_at', 'removed_at']) {
      expect(insertable).not.toContain(column);
      expect(updatable).not.toContain(column);
    }
    await expect(w.asUser(ids.adminA, (transaction) => transaction('media_assets').where({ id: assetId }).update({ purged_at: new Date() }))).rejects.toMatchObject({ code: '42501' });
    expect((await row(assetId)).purged_at).toBeNull();
  });
});

describe('the storage quota', () => {
  it('stops counting a purged media and keeps counting one that was only removed', async () => {
    const before = await usage();
    const onlyRemoved = await removedAgo('31 days');
    const toPurge = await removedAgo('31 days');
    expect(onlyRemoved).not.toBe(toPurge);
    // Both removed, none purged: each counts, 1000 bytes and one object.
    await expect(usage()).resolves.toEqual({ bytes: before.bytes + 2_000, count: before.count + 2 });

    await expect(stamp(toPurge)).resolves.toBe(true);

    await expect(usage()).resolves.toEqual({ bytes: before.bytes + 1_000, count: before.count + 1 });
    // The row stays: only the sum forgot it.
    expect((await row(toPurge)).confirmed_size_bytes).toBe('1000');
    expect(await w.getOwner().knex('media_assets').where({ id: toPurge })).toHaveLength(1);
  });

  it('leaves a media that was removed less than the period in the sum, even when it is offered nowhere', async () => {
    const before = await usage();
    const recent = await removedAgo('2 days');
    await expect(usage()).resolves.toEqual({ bytes: before.bytes + 1_000, count: before.count + 1 });
    await expect(stamp(recent)).resolves.toBe(false);
    await expect(usage()).resolves.toEqual({ bytes: before.bytes + 1_000, count: before.count + 1 });
  });
});
