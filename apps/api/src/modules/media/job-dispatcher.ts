import { MEDIA_VIDEO_PROCESSING_JOB_NAME, type MediaVideoProcessingJobPayload } from '@ageniza/contracts';
import type { CoreLogger } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';
import { PgBoss } from 'pg-boss';
import { fromKnex } from 'pg-boss/dist/adapters/knex.js';

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/**
 * Send-only pg-boss producer the API uses to hand a confirmed video upload to the worker (issue
 * #24). This never registers a handler or runs `work()` -- only the worker consumes
 * `media.process-video` (`apps/worker/src/media-video-job.ts`) -- so it needs none of the
 * concurrency/retry/supervision settings `apps/worker/src/queue.ts` configures for that side.
 *
 * `createQueue` here is idempotent and safe to race with the worker's own startup: whichever side
 * creates the `pgboss.queue` row first "wins" the default options, but the worker always calls
 * `updateQueue` with its retry/expiry settings on its own startup regardless of creation order, so
 * this producer intentionally does not duplicate those settings.
 */
export interface MediaJobDispatcher {
  start(): Promise<void>;
  enqueueVideoProcessing(transaction: Transaction, payload: MediaVideoProcessingJobPayload): Promise<void>;
  stop(): Promise<void>;
}

export const createMediaJobDispatcher = (options: { readonly connectionString: string; readonly logger: CoreLogger }): MediaJobDispatcher => {
  const logger = options.logger.child({ module: 'media-job-dispatcher' });
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: 'pgboss',
    application_name: 'ageniza-api-queue-producer',
    max: 2,
    migrate: false,
    createSchema: false,
    // This side only sends; it must never run supervision, REINDEX, or scheduling duties, which
    // the worker's own queue already owns.
    supervise: false,
    reindex: false,
    schedule: false,
    useListenNotify: false,
    persistWarnings: false,
    persistQueueStats: false
  });
  boss.on('error', (error: Error) => {
    logger.error({ error: { name: error.name, code: 'MEDIA_JOB_DISPATCH_ERROR' } }, 'Media job dispatcher error');
  });

  let started = false;

  return {
    async start() {
      if (started) return;
      await boss.start();
      await boss.createQueue(MEDIA_VIDEO_PROCESSING_JOB_NAME);
      started = true;
    },
    async enqueueVideoProcessing(transaction, payload) {
      if (!started) throw new Error('Media job dispatcher must be started before enqueuing a job.');
      // pg-boss's Knex adapter inserts through the caller's transaction. The asset cannot commit
      // as `pending` unless its durable job commits with it, and the worker cannot see the job
      // before the media row becomes visible.
      const id = await boss.send(MEDIA_VIDEO_PROCESSING_JOB_NAME, payload, {
        db: fromKnex(transaction),
        id: payload.assetId
      });
      if (id === null) throw new Error('Media job dispatcher refused to enqueue a video processing job.');
    },
    async stop() {
      if (!started) return;
      await boss.stop({ graceful: false, close: true, timeout: 5_000 });
      started = false;
    }
  };
};
