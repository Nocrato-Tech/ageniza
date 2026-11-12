import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MediaProcessingConfig, WorkerStorageConfig } from '@ageniza/config/server';
import { MEDIA_VIDEO_PROCESSING_JOB_NAME } from '@ageniza/contracts';
import { createLogger } from '@ageniza/core';
import {
  assertLocalDatabaseUrl,
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { markVideoProcessingReady } from './media-repository.js';
import { createMediaProcessingStorageClient } from './media-storage.js';
import { MEDIA_VIDEO_RETRY_LIMIT, mediaVideoProcessingJob } from './media-video-job.js';
import type { DurableJobContext } from './queue.js';

// Issue #24 acceptance tests. Runs against the real local PostgreSQL and LocalStack started by
// `pnpm db:migrate` / `pnpm storage:start` -- see
// apps/api/src/modules/media/README.md for how those are started, and real ffmpeg/ffprobe on
// PATH (see media-ffmpeg.integration.test.ts for why these are not mocked).
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

const testStorageCredentials = localStorageCredentials();

const storageConfig: WorkerStorageConfig = {
  endpoint: process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: 'auto',
  accessKeyId: testStorageCredentials.accessKeyId,
  secretAccessKey: testStorageCredentials.secretAccessKey,
  bucket: process.env.R2_BUCKET ?? 'ageniza-media-local',
  forcePathStyle: true
};

const mediaProcessingConfig: MediaProcessingConfig = {
  ffmpegTimeoutSeconds: 30,
  maxDurationSeconds: 30,
  timeoutPerMediaSecond: 0.5,
  maxTimeoutSeconds: 120,
  thumbnailWidthPixels: 160,
  previewMaxHeightPixels: 480,
  previewMaxOutputBytes: 20 * 1024 * 1024
};

let owner: DatabaseClient;
let application: DatabaseClient;
let s3: S3Client;
let sampleVideoBytes: Buffer;
let fixtureDir: string;
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdAssetIds: string[] = [];

const testContext = (): DurableJobContext => ({
  logger: createLogger({ enabled: false }),
  signal: new AbortController().signal
});

const insertOwnerAndAgency = async (label: string): Promise<{ userId: string; agencyId: string }> => {
  const userId = randomUUID();
  const agencyId = randomUUID();
  createdUserIds.push(userId);
  createdAgencyIds.push(agencyId);
  await raw(owner.knex, 'insert into auth."user" (id, name, email, "emailVerified") values (?, ?, ?, true)', [
    userId, `Media Job Test ${label}`, `media-job-test-${label}-${userId}@example.test`
  ]);
  await owner.knex('agencies').insert({ id: agencyId, name: `Media Job Test Agency ${label}`, owner_user_id: userId });
  return { userId, agencyId };
};

/** Inserts a confirmed video asset row directly (bypassing the API's own upload flow, which
 * issue #21 already tests) and, unless `skipUpload` is set, puts `body` at its object key in
 * the bucket first. Returns the fixed assetId so tests can build the exact object key up front. */
const insertConfirmedVideoAsset = async (input: {
  agencyId: string;
  userId: string;
  body?: Buffer;
}): Promise<{ assetId: string; objectKey: string }> => {
  const assetId = randomUUID();
  createdAssetIds.push(assetId);
  const objectKey = `${input.agencyId}/${assetId}/original.mp4`;
  if (input.body !== undefined) {
    await s3.send(new PutObjectCommand({ Bucket: storageConfig.bucket, Key: objectKey, Body: input.body, ContentType: 'video/mp4' }));
  }
  await raw(owner.knex, `
    insert into public.media_assets
      (id, agency_id, category, declared_content_type, extension, object_key, upload_object_key, status, declared_size_bytes, confirmed_size_bytes, confirmed_content_type, created_by_user_id, confirmed_at)
    values (?, ?, 'video', 'video/mp4', 'mp4', ?, ?, 'confirmed', 1024, 1024, 'video/mp4', ?, now())
  `, [assetId, input.agencyId, objectKey, objectKey, input.userId]);
  return { assetId, objectKey };
};

interface VideoProcessingRow {
  readonly video_processing_status: string;
  readonly thumbnail_object_key: string | null;
  readonly preview_object_key: string | null;
  readonly video_duration_seconds: string | null;
  readonly video_thumbnail_size_bytes: string | null;
  readonly video_preview_size_bytes: string | null;
  readonly video_processing_error: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

const videoProcessingRow = async (assetId: string): Promise<VideoProcessingRow> => {
  const result = await raw<{ rows: VideoProcessingRow[] }>(owner.knex, `
    select video_processing_status, thumbnail_object_key, preview_object_key, video_duration_seconds,
      video_thumbnail_size_bytes, video_preview_size_bytes, video_processing_error, width, height
    from public.media_assets where id = ?::uuid
  `, [assetId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Media asset row not found.');
  return row;
};

/** The attempt pg-boss would pass once no retry is left; only then is a failure terminal. */
const FINAL_ATTEMPT = MEDIA_VIDEO_RETRY_LIMIT + 1;

const runJob = (
  config: MediaProcessingConfig,
  payload: { assetId: string; agencyId: string; actorUserId: string },
  overrides: { tempRootDir?: string; attempt?: number } = {}
): Promise<void> => {
  const { attempt = FINAL_ATTEMPT, ...dependencyOverrides } = overrides;
  const job = mediaVideoProcessingJob({
    database: application,
    storage: createMediaProcessingStorageClient(storageConfig),
    config,
    ...dependencyOverrides
  });
  return job.handler(
    { id: randomUUID(), name: MEDIA_VIDEO_PROCESSING_JOB_NAME, payload, attempt },
    testContext()
  );
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

  // A synthetic 2-second clip generated entirely from ffmpeg's own test-pattern source (lavfi) --
  // no network, no external fixture committed to the repository.
  fixtureDir = await mkdtemp(join(tmpdir(), 'ageniza-media-job-fixture-'));
  const sampleVideoPath = join(fixtureDir, 'sample.mp4');
  const result = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
    sampleVideoPath
  ]);
  if (result.status !== 0) throw new Error(`Failed to generate the fixture video: ${result.stderr?.toString()}`);
  sampleVideoBytes = await readFile(sampleVideoPath);
}, 30_000);

afterAll(async () => {
  try {
    for (const assetId of createdAssetIds) {
      await raw(owner.knex, 'delete from public.media_assets where id = ?::uuid', [assetId]);
    }
    for (const agencyId of createdAgencyIds) {
      await owner.knex('agencies').where({ id: agencyId }).delete();
    }
    for (const userId of createdUserIds) {
      await raw(owner.knex, 'delete from auth."user" where id = ?::uuid', [userId]);
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await application?.close();
    await owner?.close();
  }
});

describe('media video processing job (real PostgreSQL + LocalStack, real ffmpeg)', () => {
  it('downloads the original, generates a thumbnail and 720p preview, uploads them, and records the outcome', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('ready');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: sampleVideoBytes });

    await runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId });

    const row = await videoProcessingRow(assetId);
    expect(row.video_processing_status).toBe('ready');
    expect(row.thumbnail_object_key).toBe(`${agencyId}/${assetId}/thumbnail.jpg`);
    expect(row.preview_object_key).toBe(`${agencyId}/${assetId}/preview.mp4`);
    expect(Number(row.video_duration_seconds)).toBeGreaterThan(1);
    expect(Number(row.video_thumbnail_size_bytes)).toBeGreaterThan(0);
    expect(Number(row.video_preview_size_bytes)).toBeGreaterThan(0);
    // The library shows the size of the video: the worker is who reads it, the row is where it lands.
    expect(row.width).toBe(320);
    expect(row.height).toBe(240);

    const thumbnailHead = await s3.send(new HeadObjectCommand({ Bucket: storageConfig.bucket, Key: row.thumbnail_object_key! }));
    expect(thumbnailHead.ContentLength).toBeGreaterThan(0);
    const previewHead = await s3.send(new HeadObjectCommand({ Bucket: storageConfig.bucket, Key: row.preview_object_key! }));
    expect(previewHead.ContentLength).toBeGreaterThan(0);
  }, 60_000);

  it('records no size for a video whose processing fails', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('no-size');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: Buffer.from('not a real video file') });

    await expect(runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId })).rejects.toThrow();

    await expect(videoProcessingRow(assetId)).resolves.toMatchObject({ video_processing_status: 'failed', width: null, height: null });
  }, 60_000);

  it('leaves no temporary file behind and records an explicit failure when the original is not a valid video', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('broken');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: Buffer.from('not a real video file') });

    const tempRootDir = await mkdtemp(join(tmpdir(), 'ageniza-media-job-temp-root-'));
    try {
      await expect(runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId }, { tempRootDir })).rejects.toThrow();

      const row = await videoProcessingRow(assetId);
      expect(row.video_processing_status).toBe('failed');
      expect(row.video_processing_error).toBeTruthy();
      // Acceptance criterion (issue #24): no temporary file survives a failed job.
      expect(await readdir(tempRootDir)).toEqual([]);
    } finally {
      await rm(tempRootDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('returns the asset to pending while a retry is still available, and only fails on the last attempt', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('retrying');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: Buffer.from('not a real video file') });

    // A non-final attempt must not leave a terminal 'failed' behind, or the row would contradict
    // the queue while pg-boss is still going to retry the job.
    await expect(runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId }, { attempt: 1 })).rejects.toThrow();
    await expect(videoProcessingRow(assetId)).resolves.toMatchObject({
      video_processing_status: 'pending',
      video_processing_error: null
    });

    await expect(runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId }, { attempt: FINAL_ATTEMPT })).rejects.toThrow();
    const row = await videoProcessingRow(assetId);
    expect(row.video_processing_status).toBe('failed');
    expect(row.video_processing_error).toBeTruthy();
  }, 60_000);

  it('is a no-op the second time it processes an already-ready asset (at-least-once delivery)', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('idempotent');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: sampleVideoBytes });

    await runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId });
    const first = await videoProcessingRow(assetId);
    await runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: userId });
    const second = await videoProcessingRow(assetId);
    expect(second).toEqual(first);
  }, 60_000);

  it('kills a stuck ffmpeg call and marks the asset failed instead of hanging (timeout)', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('timeout');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: sampleVideoBytes });

    // An impossibly small timeout forces the probe/encode step to be killed rather than hang.
    // (0 would disable Node's spawn timeout entirely, so this uses a tiny fractional second.)
    // A time-out is final at once (the queue is not asked to repeat it), even on the first attempt, with its reason on the row.
    await expect(runJob({ ...mediaProcessingConfig, ffmpegTimeoutSeconds: 0.001 }, { assetId, agencyId, actorUserId: userId }, { attempt: 1 })).resolves.toBeUndefined();

    const row = await videoProcessingRow(assetId);
    expect(row.video_processing_status).toBe('failed');
    expect(row.video_processing_error).toBe('processing_timed_out');
  }, 30_000);

  it('honours an already-aborted signal before storage I/O starts', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('aborted-storage');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: sampleVideoBytes });
    const job = mediaVideoProcessingJob({
      database: application,
      storage: createMediaProcessingStorageClient(storageConfig),
      config: mediaProcessingConfig
    });
    const controller = new AbortController();
    controller.abort();

    await expect(job.handler(
      { id: randomUUID(), name: MEDIA_VIDEO_PROCESSING_JOB_NAME, payload: { assetId, agencyId, actorUserId: userId }, attempt: FINAL_ATTEMPT },
      { logger: createLogger({ enabled: false }), signal: controller.signal }
    )).rejects.toThrow();
    await expect(videoProcessingRow(assetId)).resolves.toMatchObject({ video_processing_status: 'failed' });
  });

  it('rejects a video longer than the configured duration limit without invoking ffmpeg\'s encoder', async () => {
    const { userId, agencyId } = await insertOwnerAndAgency('too-long');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId, body: sampleVideoBytes });

    // The fixture is ~2s; a 1s limit must fail it explicitly.
    await expect(runJob({ ...mediaProcessingConfig, maxDurationSeconds: 1 }, { assetId, agencyId, actorUserId: userId })).rejects.toThrow();

    const row = await videoProcessingRow(assetId);
    expect(row.video_processing_status).toBe('failed');
    expect(row.video_processing_error).toBe('duration_exceeds_limit');
  }, 30_000);

  it('skips silently when the referenced asset is not visible to the actor (defense in depth)', async () => {
    const { agencyId } = await insertOwnerAndAgency('wrong-tenant');
    const { userId: otherUserId } = await insertOwnerAndAgency('other-owner');
    // otherUserId owns a different agency, so RLS hides this row from them entirely -- the job
    // must treat "not visible" the same as "does not exist", not throw.
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId: otherUserId });

    await runJob(mediaProcessingConfig, { assetId, agencyId, actorUserId: otherUserId });

    const row = await videoProcessingRow(assetId);
    expect(row.video_processing_status).toBe('not_applicable');
  });
});

describe('the size of a video written with the end of its processing', () => {
  const finishWith = async (dimensions: { width?: number | undefined; height?: number | undefined }): Promise<VideoProcessingRow> => {
    const { userId, agencyId } = await insertOwnerAndAgency('size');
    const { assetId } = await insertConfirmedVideoAsset({ agencyId, userId });
    await raw(owner.knex, "update public.media_assets set video_processing_status = 'processing' where id = ?::uuid", [assetId]);
    await withAuthenticatedUserTransaction(application, createVerifiedUserClaims({ userId }), (transaction) => markVideoProcessingReady(transaction, assetId, {
      thumbnailObjectKey: `${agencyId}/${assetId}/thumbnail.jpg`,
      previewObjectKey: `${agencyId}/${assetId}/preview.mp4`,
      durationSeconds: 2,
      thumbnailSizeBytes: 1,
      previewSizeBytes: 1,
      ...dimensions
    }));
    return videoProcessingRow(assetId);
  };

  it('keeps the width and the height the probe read', async () => {
    await expect(finishWith({ width: 1080, height: 1920 })).resolves.toMatchObject({ video_processing_status: 'ready', width: 1080, height: 1920 });
  });

  // The column holds 1 to 100000 and both or none: a size that does not fit is no size, never a failure of the processing.
  it.each([
    ['no size', {}],
    ['a width alone', { width: 640 }],
    ['a height alone', { height: 480 }],
    ['a zero', { width: 0, height: 480 }],
    ['a negative', { width: -1, height: 480 }],
    ['a size above the column', { width: 100_001, height: 480 }],
    ['a size that is not whole', { width: 10.5, height: 480 }],
    ['not a number', { width: Number.NaN, height: 480 }]
  ])('leaves the row ready with no size for %s', async (_label, dimensions) => {
    await expect(finishWith(dimensions)).resolves.toMatchObject({ video_processing_status: 'ready', width: null, height: null });
  });

  it('accepts the largest size the column holds', async () => {
    await expect(finishWith({ width: 100_000, height: 1 })).resolves.toMatchObject({ width: 100_000, height: 1 });
  });
});
