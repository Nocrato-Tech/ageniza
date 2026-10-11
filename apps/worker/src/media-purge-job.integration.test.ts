import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { WorkerStorageConfig } from '@ageniza/config/server';
import { createLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, raw, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMediaProcessingStorageClient } from './media-storage.js';
import { MEDIA_PURGE_JOB_NAME, mediaPurgeJob } from './media-purge-job.js';
import type { DurableJobContext } from './queue.js';

// Issue #607: the retention of a removed media, against the real local PostgreSQL and the real local object storage started by
// `pnpm db:migrate` / `pnpm storage:start`. The files are put in the bucket, the media is removed at a date the test chooses, and
// what the job leaves in the bucket and in the row is what is read back.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const localStorageCredentials = (): { accessKeyId: string; secretAccessKey: string } => {
  if (process.env.R2_ACCESS_KEY_ID !== undefined && process.env.R2_SECRET_ACCESS_KEY !== undefined) {
    return { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY };
  }
  const values = Object.fromEntries(readFileSync(resolve(process.cwd(), '../../.local/storage.env'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  if (values.R2_ACCESS_KEY_ID === undefined || values.R2_SECRET_ACCESS_KEY === undefined) {
    throw new Error('Run pnpm storage:start before worker integration tests.');
  }
  return { accessKeyId: values.R2_ACCESS_KEY_ID, secretAccessKey: values.R2_SECRET_ACCESS_KEY };
};

const credentials = localStorageCredentials();
const storageConfig: WorkerStorageConfig = {
  endpoint: process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: 'auto',
  accessKeyId: credentials.accessKeyId,
  secretAccessKey: credentials.secretAccessKey,
  bucket: process.env.R2_BUCKET ?? 'ageniza-media-local',
  forcePathStyle: true
};

type ContentStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';

let owner: DatabaseClient;
let application: DatabaseClient;
let s3: S3Client;
let userId: string;
let agencyId: string;
let clientId: string;
let folderId: string;
const assetIds: string[] = [];
const contentIds: string[] = [];

const testContext = (): DurableJobContext => ({ logger: createLogger({ enabled: false }), signal: new AbortController().signal });

const runJob = (storage = createMediaProcessingStorageClient(storageConfig)): Promise<void> =>
  mediaPurgeJob({ database: application, storage }).handler(
    { id: randomUUID(), name: MEDIA_PURGE_JOB_NAME, payload: {}, attempt: 1 },
    testContext()
  );

const exists = async (key: string): Promise<boolean> => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: storageConfig.bucket, Key: key }));
    return true;
  } catch (error) {
    if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) return false;
    throw error;
  }
};

interface Seeded {
  readonly assetId: string;
  /** Every key the media has in the bucket. */
  readonly keys: readonly string[];
  readonly original: string;
  readonly preview: string | null;
}

/** A confirmed media with its files in the bucket, removed `removedAgo` ago (never removed when `null`). A video has its thumbnail and its preview too. */
const seedMedia = async (removedAgo: string | null, category: 'image' | 'video' = 'image'): Promise<Seeded> => {
  const assetId = randomUUID();
  assetIds.push(assetId);
  const extension = category === 'image' ? 'png' : 'mp4';
  const original = `${agencyId}/${assetId}/original.${extension}`;
  const staging = `staging/${agencyId}/${assetId}/upload.${extension}`;
  const thumbnail = category === 'video' ? `${agencyId}/${assetId}/thumbnail.jpg` : null;
  const preview = category === 'video' ? `${agencyId}/${assetId}/preview.mp4` : null;
  const keys = [original, staging, ...(thumbnail === null ? [] : [thumbnail]), ...(preview === null ? [] : [preview])];
  for (const key of keys) {
    await s3.send(new PutObjectCommand({ Bucket: storageConfig.bucket, Key: key, Body: Buffer.from(`file ${key}`), ContentType: 'application/octet-stream' }));
  }
  await raw(owner.knex, `
    insert into public.media_assets
      (id, agency_id, client_id, folder_id, category, declared_content_type, extension, object_key, upload_object_key, status,
       declared_size_bytes, confirmed_size_bytes, confirmed_content_type, created_by_user_id, confirmed_at, thumbnail_object_key, preview_object_key)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1000, 1000, ?, ?, now(), ?, ?)
  `, [
    assetId, agencyId, clientId, folderId, category, category === 'image' ? 'image/png' : 'video/mp4', extension, original, staging,
    category === 'image' ? 'image/png' : 'video/mp4', userId, thumbnail, preview
  ]);
  if (removedAgo !== null) {
    await raw(owner.knex, 'update public.media_assets set removed_at = now() - ?::interval where id = ?::uuid', [removedAgo, assetId]);
  }
  return { assetId, keys, original, preview };
};

const row = async (assetId: string): Promise<{ purged_at: Date | null; removed_at: Date | null; object_key: string }> =>
  (await raw<{ rows: Array<{ purged_at: Date | null; removed_at: Date | null; object_key: string }> }>(owner.knex,
    'select purged_at, removed_at, object_key from public.media_assets where id = ?::uuid', [assetId])).rows[0]!;

const filesLeft = async (media: Seeded): Promise<string[]> => {
  const left: string[] = [];
  for (const key of media.keys) if (await exists(key)) left.push(key);
  return left;
};

/** A media used by a content in the given state, then removed (a removed file cannot be attached, so the use comes first). */
const usedThenRemoved = async (status: ContentStatus, by: 'file' | 'cover'): Promise<Seeded> => {
  const media = await seedMedia(null);
  const contentId = randomUUID();
  contentIds.push(contentId);
  await owner.knex('contents').insert({
    id: contentId,
    client_id: clientId,
    title: `Retention ${contentId.slice(0, 8)}`,
    platform: 'instagram',
    format: 'image',
    publish_on: '2026-10-20',
    folder_id: folderId,
    owner_user_id: userId,
    status,
    ...(by === 'cover' ? { cover_asset_id: media.assetId } : {}),
    ...(status === 'approved' || status === 'published' ? { approved_by: userId, approved_at: new Date('2026-10-05T12:00:00.000Z') } : {}),
    ...(status === 'published' ? { published_on: '2026-10-06', published_at: new Date() } : {}),
    ...(status === 'cancelled' ? { cancelled_at: new Date('2026-10-05T12:00:00.000Z') } : {})
  });
  if (by === 'file') {
    await owner.knex('content_media').insert({ content_id: contentId, asset_id: media.assetId, client_id: clientId, folder_id: folderId, position: 1 });
  }
  await raw(owner.knex, `update public.media_assets set removed_at = now() - interval '45 days' where id = ?::uuid`, [media.assetId]);
  return media;
};

beforeAll(async () => {
  assertLocalDatabaseUrl(applicationUrl);
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  s3 = new S3Client({
    region: storageConfig.region,
    forcePathStyle: storageConfig.forcePathStyle,
    endpoint: storageConfig.endpoint,
    credentials: { accessKeyId: storageConfig.accessKeyId, secretAccessKey: storageConfig.secretAccessKey }
  });
  userId = randomUUID();
  agencyId = randomUUID();
  clientId = randomUUID();
  await raw(owner.knex, 'insert into auth."user" (id, name, email, "emailVerified") values (?, ?, ?, true)', [userId, 'Media Purge Test', `media-purge-${userId}@example.test`]);
  await owner.knex('agencies').insert({ id: agencyId, name: `Media Purge Agency ${agencyId}`, owner_user_id: userId });
  await owner.knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Media Purge Client ${clientId}` });
  folderId = (await owner.knex('media_folders').where({ client_id: clientId, name: 'Imagens' }).first('id'))!.id as string;
}, 30_000);

afterAll(async () => {
  try {
    await owner.knex('audit.events').where({ agency_id: agencyId, action: 'media.purged' }).delete();
    await owner.knex('content_media').where({ client_id: clientId }).delete();
    await owner.knex('contents').whereIn('id', contentIds).delete();
    await owner.knex('media_assets').whereIn('id', assetIds).delete();
    await owner.knex('media_folders').where({ client_id: clientId }).delete();
    await owner.knex('clients').where({ id: clientId }).delete();
    await owner.knex('agencies').where({ id: agencyId }).delete();
    await raw(owner.knex, 'delete from auth."user" where id = ?::uuid', [userId]);
  } finally {
    await application?.close();
    await owner?.close();
  }
});

describe('media purge job (real PostgreSQL + real local object storage)', () => {
  it('deletes the files of a media removed more than 30 days ago, and keeps the row stamped with the same keys', async () => {
    const image = await seedMedia('31 days');
    const video = await seedMedia('45 days', 'video');
    expect(await filesLeft(image)).toHaveLength(2);
    expect(await filesLeft(video)).toHaveLength(4);

    await runJob();

    expect(await filesLeft(image)).toEqual([]);
    expect(await filesLeft(video)).toEqual([]);
    for (const media of [image, video]) {
      const after = await row(media.assetId);
      expect(after.purged_at).toBeInstanceOf(Date);
      expect(after.removed_at).toBeInstanceOf(Date);
      expect(after.object_key).toBe(media.original);
    }
    expect(await owner.knex('audit.events').where({ action: 'media.purged', target_id: image.assetId })).toHaveLength(1);
  });

  it('keeps the files and the row of a media removed less than 30 days ago, and of one never removed', async () => {
    const recent = await seedMedia('29 days 23 hours');
    const untouched = await seedMedia(null);

    await runJob();

    for (const media of [recent, untouched]) {
      expect(await filesLeft(media)).toEqual(media.keys);
      expect((await row(media.assetId)).purged_at).toBeNull();
    }
  });

  it.each([
    ['awaiting_approval', 'file'], ['awaiting_approval', 'cover'],
    ['approved', 'file'], ['approved', 'cover'],
    ['published', 'file'], ['published', 'cover']
  ] as const)('never touches the media of a content that is %s, used as its %s', async (status, by) => {
    const media = await usedThenRemoved(status, by);

    await runJob();

    expect(await filesLeft(media)).toEqual(media.keys);
    expect((await row(media.assetId)).purged_at).toBeNull();
  });

  it('purges the media of a content that is still in production, which cannot go on with a removed file', async () => {
    const media = await usedThenRemoved('in_production', 'file');
    await runJob();
    expect(await filesLeft(media)).toEqual([]);
    expect((await row(media.assetId)).purged_at).toBeInstanceOf(Date);
  });

  it('runs twice with nothing more to do: the second run changes nothing and stamps nothing again', async () => {
    const media = await seedMedia('60 days');
    await runJob();
    const stamped = (await row(media.assetId)).purged_at;
    await runJob();
    expect((await row(media.assetId)).purged_at).toEqual(stamped);
    expect(await owner.knex('audit.events').where({ action: 'media.purged', target_id: media.assetId })).toHaveLength(1);
  });

  it('finishes what a run that died between the delete and the stamp left: the files are already gone, the next run stamps', async () => {
    const media = await seedMedia('50 days');
    const storage = createMediaProcessingStorageClient(storageConfig);
    const controller = new AbortController();
    for (const key of media.keys) await storage.deleteObject({ key, signal: controller.signal });
    expect(await filesLeft(media)).toEqual([]);
    expect((await row(media.assetId)).purged_at).toBeNull();

    await runJob();

    expect((await row(media.assetId)).purged_at).toBeInstanceOf(Date);
  });

  it('leaves a media whose delete failed unstamped with its files, purges the others, and purges it on the next run', async () => {
    const stuck = await seedMedia('40 days', 'video');
    const fine = await seedMedia('40 days');
    const real = createMediaProcessingStorageClient(storageConfig);
    const failing = {
      deleteObject: async (input: { key: string; signal: AbortSignal }): Promise<void> => {
        if (input.key === stuck.preview) throw Object.assign(new Error('The storage refused.'), { name: 'AccessDenied' });
        await real.deleteObject(input);
      }
    };

    await runJob(failing as ReturnType<typeof createMediaProcessingStorageClient>);

    expect((await row(stuck.assetId)).purged_at).toBeNull();
    expect(await exists(stuck.preview!)).toBe(true);
    expect(await filesLeft(fine)).toEqual([]);
    expect((await row(fine.assetId)).purged_at).toBeInstanceOf(Date);

    await runJob();

    expect(await filesLeft(stuck)).toEqual([]);
    expect((await row(stuck.assetId)).purged_at).toBeInstanceOf(Date);
  });
});
