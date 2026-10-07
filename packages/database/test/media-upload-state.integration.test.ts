import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #295. A role holding only `midia.enviar` passes the `media_assets` policies, and until
// migration 20261007000700 the table grant let it write every column: it could confirm a rejected
// upload and rewrite `confirmed_size_bytes` of a 100 MB asset to 1, dropping the agency's used quota.
// Every attack below runs as `ageniza_app` with a custom role that holds that one permission.
// The trigger refuses with 42501 like the RLS does, so each case checks the trigger's own message;
// a refusal at the privilege layer reads "permission denied for table".
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

const HUNDRED_MB = 104_857_600;

const MOVE_FORWARD_ONLY = 'A media upload can only move from pending to confirmed or rejected.';
const CONFIRMED_SHAPE = 'A confirmed media upload carries its confirmed size, content type and time.';
const REJECTED_SHAPE = 'A rejected media upload carries its reason and no confirmation.';
const OUTCOME_ONCE = 'The outcome of a media upload is written once, together with its status.';

const trigger = (message: string) => ({ code: '42501', message: expect.stringContaining(message) });
const deniedByGrant = { code: '42501', message: expect.stringContaining('permission denied for table media_assets') };

// Literal on purpose: the catalog is compared with this list in both directions, so a column added
// to the grant later, or one dropped from it, turns the test red.
const INSERTABLE = [
  'agency_id', 'category', 'created_by_user_id', 'declared_content_type', 'declared_size_bytes', 'extension',
  'id', 'object_key', 'upload_object_key'
];
const UPDATABLE = [
  'confirmed_at', 'confirmed_content_type', 'confirmed_size_bytes', 'multipart_upload_id', 'preview_object_key',
  'rejected_reason', 'status', 'thumbnail_object_key', 'updated_at', 'video_duration_seconds',
  'video_preview_size_bytes', 'video_processed_at', 'video_processing_error', 'video_processing_status',
  'video_thumbnail_size_bytes'
];

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyId = randomUUID();
const ownerUserId = randomUUID();
const uploaderId = randomUUID();
const strangerId = randomUUID();
const assetIds: string[] = [];
const roleIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUploader = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: uploaderId }), work);

type State = 'pending' | 'confirmed' | 'rejected';

const seed = async (state: State, category: 'image' | 'video' = 'image'): Promise<string> => {
  const id = randomUUID();
  const extension = category === 'image' ? 'png' : 'mp4';
  assetIds.push(id);
  await getOwner().knex('media_assets').insert({
    id,
    agency_id: agencyId,
    category,
    declared_content_type: category === 'image' ? 'image/png' : 'video/mp4',
    extension,
    object_key: `${agencyId}/${id}/original.${extension}`,
    upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
    declared_size_bytes: HUNDRED_MB,
    created_by_user_id: uploaderId,
    status: state,
    ...(state === 'confirmed' ? { confirmed_size_bytes: HUNDRED_MB, confirmed_content_type: 'image/png', confirmed_at: new Date() } : {}),
    ...(state === 'rejected' ? { rejected_reason: 'content_type_mismatch' } : {})
  });
  return id;
};

interface Stored {
  readonly status: string;
  readonly confirmed_size_bytes: string | null;
  readonly confirmed_content_type: string | null;
  readonly confirmed_at: Date | null;
  readonly rejected_reason: string | null;
}

const stored = async (id: string): Promise<Stored> =>
  await getOwner().knex('media_assets').where({ id }).first(
    'status', 'confirmed_size_bytes', 'confirmed_content_type', 'confirmed_at', 'rejected_reason'
  ) as Stored;

const usedBytes = async (): Promise<number> => {
  const { rows } = await getOwner().knex.raw<{ rows: Array<{ used: string }> }>(
    "select coalesce(sum(confirmed_size_bytes), 0)::text as used from public.media_assets where agency_id = ?::uuid and status = 'confirmed'",
    [agencyId]
  );
  return Number(rows[0]?.used);
};

const columnsWithPrivilege = async (privilege: 'insert' | 'update'): Promise<string[]> => {
  const { rows } = await getOwner().knex.raw<{ rows: Array<{ column_name: string }> }>(`
    select a.attname as column_name
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.media_assets'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and has_column_privilege('ageniza_app', 'public.media_assets'::regclass, a.attnum, ?)
    order by a.attname
  `, [privilege]);
  return rows.map((row) => row.column_name);
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  for (const [id, label] of [[ownerUserId, 'dona'], [uploaderId, 'enviadora'], [strangerId, 'estranha']] as const) {
    await getOwner().knex('auth.user').insert({ id, name: label, email: `${label}.${id.slice(0, 8)}@db-integration.test`, emailVerified: false });
  }
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Estado da mídia', owner_user_id: ownerUserId, status: 'active' });

  const roleId = randomUUID();
  roleIds.push(roleId);
  await getOwner().knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Só mídia', is_system: false });
  await getOwner().knex('role_permissions').insert({ role_id: roleId, permission_key: 'midia.enviar' });
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: uploaderId, role_id: roleId, status: 'active' });
});

afterAll(async () => {
  await getOwner().knex('media_assets').whereIn('id', assetIds).delete();
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').whereIn('id', [ownerUserId, uploaderId, strangerId]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('the grants on media_assets (issue #295)', () => {
  it('lets ageniza_app insert and update only the listed columns, and delete nothing', async () => {
    expect(await columnsWithPrivilege('insert')).toEqual(INSERTABLE);
    expect(await columnsWithPrivilege('update')).toEqual(UPDATABLE);

    const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
      select
        has_table_privilege('ageniza_app', 'public.media_assets', 'select') as can_select,
        has_table_privilege('ageniza_app', 'public.media_assets', 'insert') as table_insert,
        has_table_privilege('ageniza_app', 'public.media_assets', 'update') as table_update,
        has_table_privilege('ageniza_app', 'public.media_assets', 'delete') as can_delete,
        has_table_privilege('ageniza_app', 'public.media_assets', 'truncate') as can_truncate
    `);
    expect(rows[0]).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
  });

  it.each([
    ['id', () => randomUUID()],
    ['agency_id', () => randomUUID()],
    ['category', () => 'video'],
    ['declared_content_type', () => 'image/jpeg'],
    ['extension', () => 'jpg'],
    ['object_key', () => 'forged'],
    ['upload_object_key', () => 'forged'],
    ['declared_size_bytes', () => 1],
    ['created_by_user_id', () => ownerUserId],
    ['created_at', () => new Date(0)]
  ] as const)('refuses an UPDATE of %s at the privilege layer, leaving the row', async (column, value) => {
    const id = await seed('pending');

    await expect(asUploader(async (transaction) => {
      expect(await transaction('media_assets').where({ id }).select('id')).toHaveLength(1);
      return await transaction('media_assets').where({ id }).update({ [column]: value() });
    })).rejects.toMatchObject(deniedByGrant);

    const row = await getOwner().knex('media_assets').where({ id }).first('category', 'declared_size_bytes', 'created_by_user_id');
    expect({ ...row, declared_size_bytes: Number(row.declared_size_bytes) }).toEqual({
      category: 'image', declared_size_bytes: HUNDRED_MB, created_by_user_id: uploaderId
    });
  });

  it.each([
    ['status', 'confirmed'],
    ['confirmed_size_bytes', 1],
    ['confirmed_content_type', 'image/png'],
    ['confirmed_at', new Date()],
    ['rejected_reason', 'forged'],
    ['video_processing_status', 'pending'],
    ['multipart_upload_id', 'forged']
  ] as const)('refuses an INSERT that sets %s, so no row is born with a state', async (column, value) => {
    const id = randomUUID();
    assetIds.push(id);
    const extension = 'png';

    await expect(asUploader((transaction) => transaction('media_assets').insert({
      id,
      agency_id: agencyId,
      category: 'image',
      declared_content_type: 'image/png',
      extension,
      object_key: `${agencyId}/${id}/original.${extension}`,
      upload_object_key: `staging/${agencyId}/${id}/upload.${extension}`,
      declared_size_bytes: HUNDRED_MB,
      created_by_user_id: uploaderId,
      [column]: value
    }))).rejects.toMatchObject(deniedByGrant);

    expect(await getOwner().knex('media_assets').where({ id }).select('id')).toHaveLength(0);
  });

  it('refuses a DELETE of a row the actor can see, even when a permissive DELETE policy is created by mistake', async () => {
    const id = await seed('rejected');

    await expect(asUploader(async (transaction) => {
      expect(await transaction('media_assets').where({ id }).select('id')).toHaveLength(1);
      return await transaction('media_assets').where({ id }).delete();
    })).rejects.toMatchObject(deniedByGrant);

    const transaction = await getOwner().knex.transaction();
    try {
      await transaction.raw('create policy zz_delete_by_mistake on public.media_assets for delete to ageniza_app using (true)');
      await transaction.raw('set local role ageniza_app');
      await transaction.raw('select app_private.bind_actor(?::uuid)', [uploaderId]);
      await expect(transaction('media_assets').where({ id }).delete()).rejects.toMatchObject(deniedByGrant);
    } finally {
      await transaction.rollback();
    }

    expect(await getOwner().knex('media_assets').where({ id }).select('id')).toHaveLength(1);
  });
});

describe('the upload state only moves forward (issue #295)', () => {
  it('refuses to confirm a rejected upload, with or without the confirmation columns', async () => {
    const id = await seed('rejected');

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      status: 'confirmed', rejected_reason: null, confirmed_size_bytes: 1, confirmed_content_type: 'image/png', confirmed_at: new Date()
    }))).rejects.toMatchObject(trigger(MOVE_FORWARD_ONLY));
    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ status: 'confirmed' })))
      .rejects.toMatchObject(trigger(MOVE_FORWARD_ONLY));

    expect(await stored(id)).toMatchObject({ status: 'rejected', rejected_reason: 'content_type_mismatch', confirmed_size_bytes: null });
  });

  it.each([
    ['confirmed', 'pending'],
    ['confirmed', 'rejected'],
    ['rejected', 'pending']
  ] as const)('refuses %s -> %s', async (from, to) => {
    const id = await seed(from);
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      status: to, ...(to === 'rejected' ? { rejected_reason: 'forged' } : {})
    }))).rejects.toMatchObject(trigger(MOVE_FORWARD_ONLY));

    expect(await stored(id)).toEqual(before);
  });

  it('refuses to clear or change the rejected reason of a rejected upload', async () => {
    const id = await seed('rejected');

    for (const rejected_reason of [null, 'other_reason']) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ rejected_reason })), String(rejected_reason))
        .rejects.toMatchObject(trigger(OUTCOME_ONCE));
    }

    expect((await stored(id)).rejected_reason).toBe('content_type_mismatch');
  });

  it('refuses to shrink the confirmed size of a 100 MB asset, and the used quota stays', async () => {
    const id = await seed('confirmed');
    const usedBefore = await usedBytes();
    expect(usedBefore).toBeGreaterThanOrEqual(HUNDRED_MB);

    for (const confirmed_size_bytes of [1, HUNDRED_MB + 1]) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ confirmed_size_bytes })), String(confirmed_size_bytes))
        .rejects.toMatchObject(trigger(OUTCOME_ONCE));
    }

    expect(Number((await stored(id)).confirmed_size_bytes)).toBe(HUNDRED_MB);
    expect(await usedBytes()).toBe(usedBefore);
  });

  it.each([
    ['confirmed_content_type', 'image/jpeg'],
    ['confirmed_at', new Date(0)],
    ['confirmed_content_type', null],
    ['confirmed_size_bytes', null]
  ] as const)('refuses to change %s of a confirmed upload', async (column, value) => {
    const id = await seed('confirmed');
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ [column]: value })))
      .rejects.toMatchObject(trigger(OUTCOME_ONCE));

    expect(await stored(id)).toEqual(before);
  });

  it('refuses to write an outcome column on a pending upload without moving its status', async () => {
    const id = await seed('pending');

    for (const change of [
      { confirmed_size_bytes: 1 },
      { confirmed_content_type: 'image/png' },
      { confirmed_at: new Date() },
      { rejected_reason: 'forged' }
    ]) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update(change)), Object.keys(change)[0])
        .rejects.toMatchObject(trigger(OUTCOME_ONCE));
    }

    expect(await stored(id)).toMatchObject({ status: 'pending', confirmed_size_bytes: null, rejected_reason: null });
  });

  it('refuses a confirmation that lacks a confirmed column or carries a rejection', async () => {
    const id = await seed('pending');
    const complete = { confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', confirmed_at: new Date() };

    for (const change of [
      { status: 'confirmed' },
      { status: 'confirmed', ...complete, confirmed_size_bytes: null },
      { status: 'confirmed', ...complete, confirmed_content_type: null },
      { status: 'confirmed', ...complete, confirmed_at: null },
      { status: 'confirmed', ...complete, rejected_reason: 'forged' }
    ]) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update(change)), JSON.stringify(change))
        .rejects.toMatchObject(trigger(CONFIRMED_SHAPE));
    }

    expect(await stored(id)).toMatchObject({ status: 'pending' });
  });

  it('refuses a rejection that lacks a reason or carries a confirmation', async () => {
    const id = await seed('pending');

    for (const change of [
      { status: 'rejected' },
      { status: 'rejected', rejected_reason: '   ' },
      { status: 'rejected', rejected_reason: 'too_large', confirmed_size_bytes: 1 },
      { status: 'rejected', rejected_reason: 'too_large', confirmed_content_type: 'image/png' },
      { status: 'rejected', rejected_reason: 'too_large', confirmed_at: new Date() }
    ]) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update(change)), JSON.stringify(change))
        .rejects.toMatchObject(trigger(REJECTED_SHAPE));
    }

    expect(await stored(id)).toMatchObject({ status: 'pending', rejected_reason: null });
  });

  it('does not let a concurrent transaction slip a second transition past it', async () => {
    const id = await seed('pending');

    // The owner confirms the asset and holds the row lock; the actor's rejection queues behind it and,
    // once the lock is released, is evaluated against the row as it now stands (confirmed), not as it was.
    const locker = await getOwner().knex.transaction();
    let queued: Promise<number> | undefined;
    try {
      const locked = await locker.raw<{ rows: unknown[] }>('select id from public.media_assets where id = ?::uuid for update', [id]);
      expect(locked.rows).toHaveLength(1);

      queued = asUploader((transaction) => transaction('media_assets').where({ id }).update({ status: 'rejected', rejected_reason: 'too_large' }));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await getOwner().knex.raw<{ rows: Array<{ count: string }> }>(
          "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%update \"media_assets\"%'"
        );
        if (Number(waiting.rows[0]?.count) >= 1) break;
        if (Date.now() > deadline) throw new Error('The rejection never queued behind the lock.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const confirmed = await locker.raw<{ rowCount: number }>(
        "update public.media_assets set status = 'confirmed', confirmed_size_bytes = 1000, confirmed_content_type = 'image/png', confirmed_at = now() where id = ?::uuid",
        [id]
      );
      expect(confirmed.rowCount).toBe(1);
      await locker.commit();
    } catch (error) {
      await locker.rollback().catch(() => undefined);
      await Promise.allSettled([queued]);
      throw error;
    }

    await expect(queued).rejects.toMatchObject(trigger(MOVE_FORWARD_ONLY));
    expect(await stored(id)).toMatchObject({ status: 'confirmed', rejected_reason: null });
  });

  it('governs only ageniza_app: the schema owner, which runs the security definer functions and maintenance, is not held back', async () => {
    const id = await seed('rejected');

    await getOwner().knex('media_assets').where({ id }).update({ status: 'pending', rejected_reason: null });

    expect(await stored(id)).toMatchObject({ status: 'pending', rejected_reason: null });
  });
});

describe('the upload flow still works for a role holding only midia.enviar (issue #295)', () => {
  it('creates, resumes, confirms and processes a video through the columns the API and the worker write', async () => {
    const id = randomUUID();
    assetIds.push(id);
    const objectKey = `${agencyId}/${id}/original.mp4`;

    await asUploader(async (transaction) => {
      await transaction('media_assets').insert({
        id,
        agency_id: agencyId,
        category: 'video',
        declared_content_type: 'video/mp4',
        extension: 'mp4',
        object_key: objectKey,
        upload_object_key: `staging/${agencyId}/${id}/upload.mp4`,
        declared_size_bytes: HUNDRED_MB,
        created_by_user_id: uploaderId
      });
      expect(await transaction('media_assets').where({ id }).update({ multipart_upload_id: 'upload-1', updated_at: new Date() })).toBe(1);
      expect(await transaction('media_assets').where({ id }).update({ updated_at: new Date() })).toBe(1);
    });
    expect(await stored(id)).toMatchObject({ status: 'pending' });

    await asUploader(async (transaction) => {
      expect(await transaction('media_assets').where({ id }).update({
        status: 'confirmed', confirmed_size_bytes: 52_428_800, confirmed_content_type: 'video/mp4', confirmed_at: new Date(),
        updated_at: new Date(), video_processing_status: 'pending'
      })).toBe(1);
    });
    expect(await stored(id)).toMatchObject({ status: 'confirmed', confirmed_content_type: 'video/mp4' });
    expect(Number((await stored(id)).confirmed_size_bytes)).toBe(52_428_800);

    await asUploader(async (transaction) => {
      expect(await transaction('media_assets').where({ id }).update({ video_processing_status: 'processing', video_processing_error: null, updated_at: new Date() })).toBe(1);
      expect(await transaction('media_assets').where({ id }).update({ video_processing_status: 'pending', video_processed_at: null, updated_at: new Date() })).toBe(1);
      expect(await transaction('media_assets').where({ id }).update({
        video_processing_status: 'ready',
        thumbnail_object_key: `${agencyId}/${id}/thumbnail.jpg`,
        preview_object_key: `${agencyId}/${id}/preview.mp4`,
        video_duration_seconds: 12.5,
        video_thumbnail_size_bytes: 1_000,
        video_preview_size_bytes: 2_000,
        video_processing_error: null,
        video_processed_at: new Date(),
        updated_at: new Date()
      })).toBe(1);
    });
    expect(await getOwner().knex('media_assets').where({ id }).first('video_processing_status')).toEqual({ video_processing_status: 'ready' });
  });

  it('rejects a pending upload with its reason, and writing the same terminal values again is not a change', async () => {
    const id = await seed('pending');

    await asUploader(async (transaction) => {
      expect(await transaction('media_assets').where({ id }).update({ status: 'rejected', rejected_reason: 'too_large', updated_at: new Date() })).toBe(1);
      expect(await transaction('media_assets').where({ id }).update({ status: 'rejected', rejected_reason: 'too_large', updated_at: new Date() })).toBe(1);
    });

    expect(await stored(id)).toMatchObject({ status: 'rejected', rejected_reason: 'too_large' });
  });

  it('still hides the asset from a person with no link to the agency: the policies were not touched', async () => {
    const id = await seed('confirmed');

    const visible = await withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: strangerId }), (transaction) =>
      transaction('media_assets').where({ id }).select('id'));

    expect(visible).toHaveLength(0);
  });
});
