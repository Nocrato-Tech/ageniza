import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEDIA_VIDEO_PROCESSING_JOB_NAME, MediaVideoProcessingJobPayloadSchema, type MediaVideoProcessingJobPayload } from '@ageniza/contracts';
import type { MediaProcessingConfig } from '@ageniza/config/server';
import { createVerifiedUserClaims, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';

import type { DurableJobDefinition, DurableJobContext, DurableJob } from './queue.js';
import { generatePreview, generateThumbnail, MediaBinaryError, probeVideo } from './media-ffmpeg.js';
import { lockConfirmedVideoAsset, markVideoProcessingFailed, markVideoProcessingReady, markVideoProcessingRetrying, markVideoProcessingStarted } from './media-repository.js';
import type { MediaProcessingStorageClient } from './media-storage.js';

export interface MediaVideoJobDependencies {
  readonly database: DatabaseClient;
  readonly storage: MediaProcessingStorageClient;
  readonly config: MediaProcessingConfig;
  /** Overridable only in tests; production always uses a fresh OS temp directory. */
  readonly tempRootDir?: string;
}

class VideoTooLongError extends Error {
  constructor(durationSeconds: number, maxDurationSeconds: number) {
    super(`Video duration ${durationSeconds.toFixed(1)}s exceeds the ${maxDurationSeconds}s limit.`);
    this.name = 'VideoTooLongError';
  }
}

/** A short, non-sensitive classification recorded on the row -- never raw ffmpeg stderr, which
 * could otherwise leak input file paths, and never a signed URL. */
const explicitFailureReason = (error: unknown, wholeJobTimedOut: boolean): string => {
  if (wholeJobTimedOut) return 'processing_timed_out';
  if (error instanceof MediaBinaryError) {
    switch (error.code) {
      case 'TIMEOUT': return 'processing_timed_out';
      case 'ABORTED': return 'processing_aborted';
      default: return 'processing_failed';
    }
  }
  if (error instanceof VideoTooLongError) return 'duration_exceeds_limit';
  return 'processing_failed';
};

const objectKeyFor = (agencyId: string, assetId: string, name: 'thumbnail.jpg' | 'preview.mp4'): string =>
  `${agencyId}/${assetId}/${name}`;

export const mediaVideoHandlerTimeoutSeconds = (ffmpegTimeoutSeconds: number): number =>
  ffmpegTimeoutSeconds * 3 + 120;

export const mediaVideoExpireInSeconds = (ffmpegTimeoutSeconds: number): number =>
  mediaVideoHandlerTimeoutSeconds(ffmpegTimeoutSeconds) + 60;

export const MEDIA_VIDEO_RETRY_LIMIT = 2;

/**
 * Video processing job (issue #24): downloads a confirmed video original, generates a thumbnail
 * and a 720p preview with ffmpeg, uploads both back under the object's own key prefix, and
 * records the outcome. The original is never transcoded or modified.
 *
 * Concurrency and per-job timeout are the queue's own settings (`apps/worker/src/queue.ts`):
 * `concurrency` below bounds how many of these run at once — issue #24 asks for 1 to 2, because
 * ffmpeg saturates CPU the VPS shares with PostgreSQL and the API — and `expireInSeconds` bounds
 * how long one may run before pg-boss marks it crashed and retries it.
 */
export const mediaVideoProcessingJob = (
  dependencies: MediaVideoJobDependencies
): DurableJobDefinition<MediaVideoProcessingJobPayload> => ({
  name: MEDIA_VIDEO_PROCESSING_JOB_NAME,
  // Issue #24: one ffmpeg run at a time, whatever headroom the worker has for lighter jobs.
  concurrency: 1,
  // ffprobe plus two ffmpeg calls may each consume their own timeout. The handler aborts all
  // storage/process I/O first; pg-boss expiry remains a later crash-recovery backstop.
  expireInSeconds: mediaVideoExpireInSeconds(dependencies.config.ffmpegTimeoutSeconds),
  // Bounded: repeatedly retrying an expensive ffmpeg run against a genuinely broken upload is not
  // worth the CPU a shared VPS would spend on it.
  retryLimit: MEDIA_VIDEO_RETRY_LIMIT,
  retryDelaySeconds: 30,
  async handler(job: DurableJob<MediaVideoProcessingJobPayload>, context: DurableJobContext): Promise<void> {
    const payload = MediaVideoProcessingJobPayloadSchema.parse(job.payload);
    const { database, storage, config } = dependencies;
    const claims = createVerifiedUserClaims({ userId: payload.actorUserId });
    const wholeJobTimeout = AbortSignal.timeout(mediaVideoHandlerTimeoutSeconds(config.ffmpegTimeoutSeconds) * 1_000);
    const jobSignal = AbortSignal.any([context.signal, wholeJobTimeout]);

    const asset = await withAuthenticatedUserTransaction(database, claims, async (transaction) => {
      const row = await lockConfirmedVideoAsset(transaction, { assetId: payload.assetId, agencyId: payload.agencyId });
      if (row === undefined) return undefined;
      // At-least-once delivery: a job already marked 'ready' is a no-op, and one already
      // 'processing' from a crashed attempt is safe to redo from scratch.
      if (row.video_processing_status === 'ready') return undefined;
      await markVideoProcessingStarted(transaction, row.id);
      return row;
    });

    if (asset === undefined) {
      context.logger.info({ status: 'skipped' }, 'Video asset is not a pending confirmed video visible to its uploader; skipping.');
      return;
    }

    const tempDir = await mkdtemp(join(dependencies.tempRootDir ?? tmpdir(), `ageniza-media-${randomUUID()}-`));
    const originalPath = join(tempDir, 'original');
    const thumbnailPath = join(tempDir, 'thumbnail.jpg');
    const previewPath = join(tempDir, 'preview.mp4');
    const thumbnailKey = objectKeyFor(asset.agency_id, asset.id, 'thumbnail.jpg');
    const previewKey = objectKeyFor(asset.agency_id, asset.id, 'preview.mp4');

    try {
      let result: { durationSeconds: number; thumbnailSizeBytes: number; previewSizeBytes: number };
      try {
        await storage.downloadToFile({ key: asset.object_key, destinationPath: originalPath, signal: jobSignal });

        const binaryOptions = { timeoutMs: config.ffmpegTimeoutSeconds * 1_000, signal: jobSignal };
        const probe = await probeVideo(originalPath, binaryOptions);
        if (probe.durationSeconds > config.maxDurationSeconds) {
          throw new VideoTooLongError(probe.durationSeconds, config.maxDurationSeconds);
        }

        await generateThumbnail(originalPath, thumbnailPath, {
          ...binaryOptions,
          widthPixels: config.thumbnailWidthPixels,
          // A frame partway through reads better than the very first (often black/blank) frame.
          atSeconds: Math.min(probe.durationSeconds / 2, Math.max(probe.durationSeconds - 0.1, 0))
        });
        await generatePreview(originalPath, previewPath, {
          ...binaryOptions,
          maxHeightPixels: config.previewMaxHeightPixels,
          maxOutputBytes: config.previewMaxOutputBytes
        });

        const [thumbnailStat, previewStat] = await Promise.all([stat(thumbnailPath), stat(previewPath)]);
        result = {
          durationSeconds: probe.durationSeconds,
          thumbnailSizeBytes: thumbnailStat.size,
          previewSizeBytes: previewStat.size
        };

        await storage.uploadFile({ key: thumbnailKey, sourcePath: thumbnailPath, contentType: 'image/jpeg', signal: jobSignal });
        await storage.uploadFile({ key: previewKey, sourcePath: previewPath, contentType: 'video/mp4', signal: jobSignal });

        await withAuthenticatedUserTransaction(database, claims, (transaction) => markVideoProcessingReady(transaction, asset.id, {
          thumbnailObjectKey: thumbnailKey,
          previewObjectKey: previewKey,
          durationSeconds: result.durationSeconds,
          thumbnailSizeBytes: result.thumbnailSizeBytes,
          previewSizeBytes: result.previewSizeBytes
        }));
      } catch (error) {
        const reason = explicitFailureReason(error, wholeJobTimeout.aborted && !context.signal.aborted);
        // Cleanup gets its own short budget because the job signal may already be aborted. A
        // thumbnail uploaded before a preview failure must never survive without a DB reference.
        const cleanupSignal = AbortSignal.timeout(30_000);
        await Promise.allSettled([
          storage.deleteObject({ key: thumbnailKey, signal: cleanupSignal }),
          storage.deleteObject({ key: previewKey, signal: cleanupSignal })
        ]);
        await withAuthenticatedUserTransaction(database, claims, (transaction) =>
          job.attempt > MEDIA_VIDEO_RETRY_LIMIT
            ? markVideoProcessingFailed(transaction, asset.id, reason)
            : markVideoProcessingRetrying(transaction, asset.id)
        );
        throw error;
      }
    } finally {
      // Issue #24 acceptance criterion: no temporary file survives, including on failure.
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});
