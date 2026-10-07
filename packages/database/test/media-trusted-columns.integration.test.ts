import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #371 (findings of the #369 reviews). After #295 a role holding only `midia.enviar` could still
// choose the author of a media in an INSERT, stamp `confirmed_at` of its own confirmation, take a
// pending video straight to `ready`, rewrite the results of a finished or rejected video and rewrite
// `multipart_upload_id` in a terminal state. Every attack runs as `ageniza_app` with a custom role that
// holds that one permission; the trigger refuses with 42501 like the RLS does, so each case checks the
// trigger's own message.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

const HUNDRED_MB = 104_857_600;

const VIDEO_FORWARD = 'Video processing only moves forward';
const READY_SHAPE = 'A ready video carries its thumbnail, preview, duration, sizes and time, and no error.';
const FAILED_SHAPE = 'A failed video carries its reason and time and changes no result.';
const UNFINISHED_SHAPE = 'A video that is not finished carries no result, error or time.';
const VIDEO_ONCE = 'The result of video processing is written once, together with its status.';
const MULTIPART_ONCE = 'The multipart upload id is written once, while the upload is pending.';

const trigger = (message: string) => ({ code: '42501', message: expect.stringContaining(message) });
const deniedByGrant = { code: '42501', message: expect.stringContaining('permission denied for table media_assets') };

type UploadState = 'pending' | 'confirmed' | 'rejected';
type VideoState = 'not_applicable' | 'pending' | 'processing' | 'ready' | 'failed';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyId = randomUUID();
const otherAgencyId = randomUUID();
const ownerUserId = randomUUID();
const otherOwnerUserId = randomUUID();
const uploaderId = randomUUID();
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

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const asUploader = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  asUser(uploaderId, work);

const resultColumns = (id: string) => ({
  thumbnail_object_key: `${agencyId}/${id}/thumbnail.jpg`,
  preview_object_key: `${agencyId}/${id}/preview.mp4`,
  video_duration_seconds: 12.5,
  video_thumbnail_size_bytes: 1_000,
  video_preview_size_bytes: 2_000
});

const seedVideo = async (video: VideoState, upload: UploadState = 'confirmed'): Promise<string> => {
  const id = randomUUID();
  assetIds.push(id);
  await getOwner().knex('media_assets').insert({
    id,
    agency_id: agencyId,
    category: 'video',
    declared_content_type: 'video/mp4',
    extension: 'mp4',
    object_key: `${agencyId}/${id}/original.mp4`,
    upload_object_key: `staging/${agencyId}/${id}/upload.mp4`,
    declared_size_bytes: HUNDRED_MB,
    created_by_user_id: uploaderId,
    status: upload,
    ...(upload === 'confirmed' ? { confirmed_size_bytes: HUNDRED_MB, confirmed_content_type: 'video/mp4', confirmed_at: new Date() } : {}),
    ...(upload === 'rejected' ? { rejected_reason: 'content_type_mismatch' } : {}),
    video_processing_status: video,
    ...(video === 'ready' ? { ...resultColumns(id), video_processed_at: new Date() } : {}),
    ...(video === 'failed' ? { video_processing_error: 'ffmpeg_failed', video_processed_at: new Date() } : {})
  });
  return id;
};

const VIDEO_COLUMNS = [
  'status', 'multipart_upload_id', 'confirmed_at', 'video_processing_status', 'video_processing_error', 'video_processed_at',
  'thumbnail_object_key', 'preview_object_key', 'video_duration_seconds', 'video_thumbnail_size_bytes', 'video_preview_size_bytes'
];

const stored = async (id: string): Promise<Record<string, unknown>> =>
  await getOwner().knex('media_assets').where({ id }).first(...VIDEO_COLUMNS) as Record<string, unknown>;

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  for (const [id, label] of [[ownerUserId, 'dona'], [otherOwnerUserId, 'dona-b'], [uploaderId, 'enviadora']] as const) {
    await getOwner().knex('auth.user').insert({ id, name: label, email: `${label}.${id.slice(0, 8)}@db-integration.test`, emailVerified: false });
  }
  await getOwner().knex('agencies').insert([
    { id: agencyId, name: 'Colunas confiáveis A', owner_user_id: ownerUserId, status: 'active' },
    { id: otherAgencyId, name: 'Colunas confiáveis B', owner_user_id: otherOwnerUserId, status: 'active' }
  ]);

  const roleId = randomUUID();
  roleIds.push(roleId);
  await getOwner().knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Só mídia', is_system: false });
  await getOwner().knex('role_permissions').insert({ role_id: roleId, permission_key: 'midia.enviar' });
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: uploaderId, role_id: roleId, status: 'active' });
});

afterAll(async () => {
  await getOwner().knex('media_assets').whereIn('agency_id', [agencyId, otherAgencyId]).delete();
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').whereIn('id', [agencyId, otherAgencyId]).update({ owner_user_id: null });
  await getOwner().knex('agencies').whereIn('id', [agencyId, otherAgencyId]).delete();
  await getOwner().knex('auth.user').whereIn('id', [ownerUserId, otherOwnerUserId, uploaderId]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('the author of a media is the actor, stamped by the database (issue #371)', () => {
  const insertAsActor = (userId: string, id: string, extra: Record<string, unknown> = {}) =>
    asUser(userId, (transaction) => transaction('media_assets').insert({
      id,
      agency_id: agencyId,
      category: 'image',
      declared_content_type: 'image/png',
      extension: 'png',
      object_key: `${agencyId}/${id}/original.png`,
      upload_object_key: `staging/${agencyId}/${id}/upload.png`,
      declared_size_bytes: 1_000,
      ...extra
    }));

  const authorOf = async (id: string): Promise<string | undefined> =>
    (await getOwner().knex('media_assets').where({ id }).first('created_by_user_id'))?.created_by_user_id as string | undefined;

  it.each([
    ['the uploader', () => uploaderId],
    ['the owner of the agency', () => ownerUserId]
  ] as const)('stamps %s as the author without the caller naming one', async (_label, actor) => {
    const id = randomUUID();
    assetIds.push(id);

    await insertAsActor(actor(), id);

    expect(await authorOf(id)).toBe(actor());
  });

  it('refuses the owner of another agency as the author of a media of this agency, leaving no row', async () => {
    const id = randomUUID();
    assetIds.push(id);

    await expect(insertAsActor(uploaderId, id, { created_by_user_id: otherOwnerUserId })).rejects.toMatchObject(deniedByGrant);

    expect(await authorOf(id)).toBeUndefined();
  });

  it('refuses the caller naming itself as the author too: the column is not writable at all', async () => {
    const id = randomUUID();
    assetIds.push(id);

    await expect(insertAsActor(uploaderId, id, { created_by_user_id: uploaderId })).rejects.toMatchObject(deniedByGrant);

    expect(await authorOf(id)).toBeUndefined();
  });

  it('refuses an UPDATE of the author, which keeps the stamped person', async () => {
    const id = randomUUID();
    assetIds.push(id);
    await insertAsActor(uploaderId, id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ created_by_user_id: otherOwnerUserId })))
      .rejects.toMatchObject(deniedByGrant);

    expect(await authorOf(id)).toBe(uploaderId);
  });
});

describe('confirmed_at is stamped by the database on the confirmation (issue #371)', () => {
  const pendingImage = async (): Promise<string> => {
    const id = randomUUID();
    assetIds.push(id);
    await getOwner().knex('media_assets').insert({
      id,
      agency_id: agencyId,
      category: 'image',
      declared_content_type: 'image/png',
      extension: 'png',
      object_key: `${agencyId}/${id}/original.png`,
      upload_object_key: `staging/${agencyId}/${id}/upload.png`,
      declared_size_bytes: 1_000,
      created_by_user_id: uploaderId
    });
    return id;
  };

  it('refuses to write confirmed_at, with a past date or the current one, on a pending and on a confirmed media', async () => {
    for (const state of ['pending', 'confirmed'] as const) {
      const id = state === 'pending' ? await pendingImage() : await seedVideo('not_applicable');
      for (const confirmed_at of [new Date(0), new Date()]) {
        await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ confirmed_at })), state)
          .rejects.toMatchObject(deniedByGrant);
      }
    }
  });

  it('refuses to confirm with a confirmed_at the caller chose, and leaves the media pending', async () => {
    const id = await pendingImage();

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', confirmed_at: new Date('1999-01-01')
    }))).rejects.toMatchObject(deniedByGrant);

    expect(await stored(id)).toMatchObject({ status: 'pending', confirmed_at: null });
  });

  it('stamps the confirmation with the transaction time, not with a date from the caller', async () => {
    const id = await pendingImage();
    const before = Date.now();

    await asUploader((transaction) => transaction('media_assets').where({ id }).update({
      status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png', updated_at: new Date()
    }));

    const confirmedAt = (await stored(id)).confirmed_at as Date;
    expect(confirmedAt).toBeInstanceOf(Date);
    expect(confirmedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(confirmedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('does not stamp a rejection', async () => {
    const id = await pendingImage();

    await asUploader((transaction) => transaction('media_assets').where({ id }).update({ status: 'rejected', rejected_reason: 'too_large' }));

    expect(await stored(id)).toMatchObject({ status: 'rejected', confirmed_at: null });
  });
});

describe('the direction of video processing (issue #371)', () => {
  const legitimateEdges = [
    ['pending', 'processing', {}],
    ['not_applicable', 'processing', {}],
    ['processing', 'processing', {}],
    ['processing', 'pending', {}],
    ['processing', 'ready', 'result'],
    ['processing', 'failed', 'failure']
  ] as const;

  const change = (id: string, to: VideoState, kind: string | object): Record<string, unknown> => ({
    video_processing_status: to,
    updated_at: new Date(),
    ...(kind === 'result' ? { ...resultColumns(id), video_processed_at: new Date() } : {}),
    ...(kind === 'failure' ? { video_processing_error: 'ffmpeg_failed', video_processed_at: new Date() } : {})
  });

  it.each(legitimateEdges)('lets the worker move %s -> %s on a confirmed video', async (from, to, kind) => {
    const id = await seedVideo(from);

    expect(await asUploader((transaction) => transaction('media_assets').where({ id }).update(change(id, to, kind)))).toBe(1);

    expect(await stored(id)).toMatchObject({ video_processing_status: to });
  });

  it.each([
    ['pending', 'ready'],
    ['not_applicable', 'ready'],
    ['not_applicable', 'failed'],
    ['pending', 'failed'],
    ['pending', 'not_applicable'],
    ['processing', 'not_applicable'],
    ['not_applicable', 'pending']
  ] as const)('refuses %s -> %s, even with every column the worker would write', async (from, to) => {
    const id = await seedVideo(from);
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update(
      change(id, to, to === 'ready' ? 'result' : to === 'failed' ? 'failure' : {})
    )), `${from} -> ${to}`).rejects.toMatchObject(trigger(VIDEO_FORWARD));

    expect(await stored(id)).toEqual(before);
  });

  it.each([
    ['ready', 'processing'],
    ['ready', 'pending'],
    ['ready', 'failed'],
    ['failed', 'processing'],
    ['failed', 'pending'],
    ['failed', 'ready']
  ] as const)('keeps %s final: refuses %s -> %s', async (from, to) => {
    const id = await seedVideo(from);
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update(
      change(id, to, to === 'ready' ? 'result' : to === 'failed' ? 'failure' : {})
    )), `${from} -> ${to}`).rejects.toMatchObject(trigger(VIDEO_FORWARD));

    expect(await stored(id)).toEqual(before);
  });

  it.each(['pending', 'rejected'] as const)('refuses any video status change on an upload that is %s', async (upload) => {
    for (const [from, to] of [['not_applicable', 'pending'], ['not_applicable', 'processing'], ['pending', 'processing']] as const) {
      const id = await seedVideo(from, upload);
      const before = await stored(id);

      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ video_processing_status: to })), `${upload}: ${from} -> ${to}`)
        .rejects.toMatchObject(trigger(VIDEO_FORWARD));

      expect(await stored(id)).toEqual(before);
    }
  });

  it('lets the confirmation of a video queue its processing, and nothing further, in the same update', async () => {
    const queued = await seedVideo('not_applicable', 'pending');
    await asUploader((transaction) => transaction('media_assets').where({ id: queued }).update({
      status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'video/mp4', video_processing_status: 'pending'
    }));
    expect(await stored(queued)).toMatchObject({ status: 'confirmed', video_processing_status: 'pending' });

    for (const to of ['processing', 'ready', 'failed'] as const) {
      const id = await seedVideo('not_applicable', 'pending');
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
        status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'video/mp4', ...change(id, to, to === 'ready' ? 'result' : to === 'failed' ? 'failure' : {})
      })), to).rejects.toMatchObject(trigger(VIDEO_FORWARD));
      expect(await stored(id)).toMatchObject({ status: 'pending', video_processing_status: 'not_applicable' });
    }
  });

  it('refuses to queue the processing of a confirmed video outside its confirmation', async () => {
    const id = await seedVideo('not_applicable');

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ video_processing_status: 'pending' })))
      .rejects.toMatchObject(trigger(VIDEO_FORWARD));

    expect(await stored(id)).toMatchObject({ video_processing_status: 'not_applicable' });
  });

  it.each([
    ['thumbnail_object_key', (id: string) => `${agencyId}/${id}/other.jpg`],
    ['preview_object_key', (id: string) => `${agencyId}/${id}/other.mp4`],
    ['video_duration_seconds', () => 1],
    ['video_thumbnail_size_bytes', () => 1],
    ['video_preview_size_bytes', () => 1],
    ['video_processed_at', () => new Date(0)],
    ['video_processing_error', () => 'forged']
  ] as const)('refuses to rewrite %s of a ready video without a status change', async (column, value) => {
    const id = await seedVideo('ready');
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ [column]: value(id) })))
      .rejects.toMatchObject(trigger(VIDEO_ONCE));

    expect(await stored(id)).toEqual(before);
  });

  it('refuses to rewrite the reason of a failed video and to clear it', async () => {
    const id = await seedVideo('failed');
    const before = await stored(id);

    for (const video_processing_error of ['other_reason', null]) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ video_processing_error })), String(video_processing_error))
        .rejects.toMatchObject(trigger(VIDEO_ONCE));
    }

    expect(await stored(id)).toEqual(before);
  });

  it.each(['pending', 'rejected', 'confirmed'] as const)('refuses to write a result column of a video whose upload is %s', async (upload) => {
    const id = await seedVideo('not_applicable', upload);
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ thumbnail_object_key: `${agencyId}/${id}/thumbnail.jpg` })))
      .rejects.toMatchObject(trigger(VIDEO_ONCE));

    expect(await stored(id)).toEqual(before);
  });

  it.each([
    ['thumbnail_object_key'],
    ['preview_object_key'],
    ['video_duration_seconds'],
    ['video_thumbnail_size_bytes'],
    ['video_preview_size_bytes'],
    ['video_processed_at']
  ] as const)('refuses ready without %s', async (missing) => {
    const id = await seedVideo('processing');
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      ...change(id, 'ready', 'result'), [missing]: null
    }))).rejects.toMatchObject(trigger(READY_SHAPE));

    expect(await stored(id)).toEqual(before);
  });

  it('refuses ready that carries an error', async () => {
    const id = await seedVideo('processing');

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      ...change(id, 'ready', 'result'), video_processing_error: 'forged'
    }))).rejects.toMatchObject(trigger(READY_SHAPE));

    expect(await stored(id)).toMatchObject({ video_processing_status: 'processing' });
  });

  it.each([
    ['without a reason', { video_processing_error: null }],
    ['with a blank reason', { video_processing_error: '   ' }],
    ['without the time', { video_processed_at: null }],
    ['carrying a thumbnail', { thumbnail_object_key: 'forged' }],
    ['carrying a duration', { video_duration_seconds: 1 }]
  ] as const)('refuses failed %s', async (_label, override) => {
    const id = await seedVideo('processing');
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      ...change(id, 'failed', 'failure'), ...override
    }))).rejects.toMatchObject(trigger(FAILED_SHAPE));

    expect(await stored(id)).toEqual(before);
  });

  it.each([
    ['processing', 'an error', { video_processing_error: 'forged' }],
    ['processing', 'a time', { video_processed_at: new Date() }],
    ['processing', 'a thumbnail', { thumbnail_object_key: 'forged' }],
    ['pending', 'a preview size', { video_preview_size_bytes: 1 }]
  ] as const)('refuses an unfinished video (%s) that carries %s', async (to, _label, override) => {
    const id = await seedVideo(to === 'pending' ? 'processing' : 'pending');
    const before = await stored(id);

    await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({
      video_processing_status: to, ...override
    }))).rejects.toMatchObject(trigger(UNFINISHED_SHAPE));

    expect(await stored(id)).toEqual(before);
  });

  it('does not let a concurrent transaction slip a second transition past it', async () => {
    const id = await seedVideo('processing');

    // The owner finishes the video and holds the row lock; the actor's failure queues behind it and,
    // once the lock is released, is evaluated against the row as it now stands (ready), not as it was.
    const locker = await getOwner().knex.transaction();
    let queued: Promise<number> | undefined;
    try {
      const locked = await locker.raw<{ rows: unknown[] }>('select id from public.media_assets where id = ?::uuid for update', [id]);
      expect(locked.rows).toHaveLength(1);

      queued = asUploader((transaction) => transaction('media_assets').where({ id }).update(change(id, 'failed', 'failure')));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await getOwner().knex.raw<{ rows: Array<{ count: string }> }>(
          "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%update \"media_assets\"%'"
        );
        if (Number(waiting.rows[0]?.count) >= 1) break;
        if (Date.now() > deadline) throw new Error('The failure never queued behind the lock.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const finished = await locker.raw<{ rowCount: number }>(`
        update public.media_assets set video_processing_status = 'ready', thumbnail_object_key = ?, preview_object_key = ?,
          video_duration_seconds = 1, video_thumbnail_size_bytes = 1, video_preview_size_bytes = 1, video_processed_at = now()
        where id = ?::uuid
      `, [`${agencyId}/${id}/thumbnail.jpg`, `${agencyId}/${id}/preview.mp4`, id]);
      expect(finished.rowCount).toBe(1);
      await locker.commit();
    } catch (error) {
      await locker.rollback().catch(() => undefined);
      await Promise.allSettled([queued]);
      throw error;
    }

    await expect(queued).rejects.toMatchObject(trigger(VIDEO_FORWARD));
    expect(await stored(id)).toMatchObject({ video_processing_status: 'ready', video_processing_error: null });
  });

  it('governs only ageniza_app: the schema owner is not held back', async () => {
    const id = await seedVideo('failed');

    await getOwner().knex('media_assets').where({ id }).update({ video_processing_status: 'processing', video_processing_error: null, video_processed_at: null });

    expect(await stored(id)).toMatchObject({ video_processing_status: 'processing' });
  });
});

describe('the multipart upload id is written once while the upload is pending (issue #371)', () => {
  const seedMultipart = async (state: UploadState, multipartId: string | null): Promise<string> => {
    const id = await seedVideo('not_applicable', state);
    if (multipartId !== null) await getOwner().knex('media_assets').where({ id }).update({ multipart_upload_id: multipartId });
    return id;
  };

  it('lets the API write it once on a pending upload', async () => {
    const id = await seedMultipart('pending', null);

    expect(await asUploader((transaction) => transaction('media_assets').where({ id }).update({ multipart_upload_id: 'upload-1', updated_at: new Date() }))).toBe(1);

    expect(await stored(id)).toMatchObject({ multipart_upload_id: 'upload-1' });
  });

  it('refuses to replace or clear it on a pending upload', async () => {
    const id = await seedMultipart('pending', 'upload-1');

    for (const multipart_upload_id of ['upload-2', null]) {
      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ multipart_upload_id })), String(multipart_upload_id))
        .rejects.toMatchObject(trigger(MULTIPART_ONCE));
    }

    expect(await stored(id)).toMatchObject({ multipart_upload_id: 'upload-1' });
  });

  it.each(['confirmed', 'rejected'] as const)('refuses to set, replace or clear it on a %s upload', async (state) => {
    for (const [initial, next] of [[null, 'forged'], ['upload-1', 'forged'], ['upload-1', null]] as const) {
      const id = await seedMultipart(state, initial);

      await expect(asUploader((transaction) => transaction('media_assets').where({ id }).update({ multipart_upload_id: next })), `${state}: ${String(initial)} -> ${String(next)}`)
        .rejects.toMatchObject(trigger(MULTIPART_ONCE));

      expect(await stored(id)).toMatchObject({ multipart_upload_id: initial });
    }
  });

  it('refuses to set it in the same update that confirms or rejects the upload', async () => {
    const confirmed = await seedMultipart('pending', null);
    await expect(asUploader((transaction) => transaction('media_assets').where({ id: confirmed }).update({
      status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'video/mp4', multipart_upload_id: 'forged'
    }))).rejects.toMatchObject(trigger(MULTIPART_ONCE));

    const rejected = await seedMultipart('pending', null);
    await expect(asUploader((transaction) => transaction('media_assets').where({ id: rejected }).update({
      status: 'rejected', rejected_reason: 'too_large', multipart_upload_id: 'forged'
    }))).rejects.toMatchObject(trigger(MULTIPART_ONCE));

    expect(await stored(confirmed)).toMatchObject({ status: 'pending', multipart_upload_id: null });
    expect(await stored(rejected)).toMatchObject({ status: 'pending', multipart_upload_id: null });
  });

  it('still lets an upload that has an id move on: the id stays as it was', async () => {
    const id = await seedMultipart('pending', 'upload-1');

    await asUploader((transaction) => transaction('media_assets').where({ id }).update({
      status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'video/mp4', video_processing_status: 'pending'
    }));

    expect(await stored(id)).toMatchObject({ status: 'confirmed', multipart_upload_id: 'upload-1' });
  });
});
