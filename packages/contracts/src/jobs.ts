import { z } from 'zod';

/**
 * Durable queue job contract shared by the API (producer) and the worker (consumer) for video
 * processing (issue #24). Both sides import this instead of each defining their own copy of the
 * job name/payload shape, so they cannot silently drift apart.
 *
 * The payload is deliberately small and carries no secret: the worker re-derives everything else
 * (object key, category, status) from the database, scoped by `assetId` + `agencyId`, and never
 * trusts a signed URL or file path from a queue message (issue #24, "the queue is not an
 * authorization boundary").
 */
export const MEDIA_VIDEO_PROCESSING_JOB_NAME = 'media.process-video';

export const MediaVideoProcessingJobPayloadSchema = z.object({
  assetId: z.string().uuid(),
  agencyId: z.string().uuid(),
  /** The user whose upload confirmation triggered this job; the worker authenticates its
   * database transaction as this user, exactly like the API does for the same asset. */
  actorUserId: z.string().uuid()
}).strict();

export type MediaVideoProcessingJobPayload = z.infer<typeof MediaVideoProcessingJobPayloadSchema>;
