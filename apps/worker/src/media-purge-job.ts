import { isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { MediaProcessingStorageClient } from './media-storage.js';
import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const MEDIA_PURGE_JOB_NAME = 'media.purge-removed';

/** Once a day, at 03:40 in the time zone of the product (the quiet hour, after the day closes and before the agencies open). */
export const MEDIA_PURGE_SCHEDULE = { cron: '40 3 * * *', timeZone: 'America/Sao_Paulo' } as const;

/** How many media one question to the database brings, and how many questions one run asks at most (20 000 media). */
export const MEDIA_PURGE_BATCH_SIZE = 50;
const MAX_BATCHES = 400;

// `removed_at` travels as text: a JavaScript Date drops the microseconds, and a cursor that is a hair before its own row offers that row again.
const LIST_SQL = `
  select asset_id, object_key, upload_object_key, thumbnail_object_key, preview_object_key, removed_at::text as removed_at
  from app_private.media_due_for_purge(?::integer, ?::timestamptz, ?::uuid)
`;
const STAMP_SQL = 'select app_private.mark_media_purged(?::uuid) as purged';

export interface MediaPurgeJobDependencies {
  readonly database: DatabaseClient;
  readonly storage: Pick<MediaProcessingStorageClient, 'deleteObject'>;
}

interface DueMedia {
  readonly assetId: string;
  readonly removedAt: string;
  readonly keys: readonly string[];
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`media_due_for_purge() did not return ${name}.`);
  return value;
};

const optionalText = (value: unknown, name: string): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return text(value, name);
};

const dueMediaOf = (row: Record<string, unknown>): DueMedia => {
  const keys = [
    text(row.object_key, 'object_key'),
    text(row.upload_object_key, 'upload_object_key'),
    optionalText(row.thumbnail_object_key, 'thumbnail_object_key'),
    optionalText(row.preview_object_key, 'preview_object_key')
  ].filter((key): key is string => key !== undefined);
  return { assetId: text(row.asset_id, 'asset_id'), removedAt: text(row.removed_at, 'removed_at'), keys: [...new Set(keys)] };
};

/**
 * The retention of a removed media (issue #607, decision of 2026-10-11): thirty days after `removed_at` the files of a removed media leave
 * the bucket, and the row stays, stamped `purged_at`, for the audit. The rule lives in two functions of the database, which only answer a
 * caller with no user bound to the transaction, as the worker is: `app_private.media_due_for_purge` says what is due (removed past the period,
 * not purged, and not used by a content waiting for approval, approved or published) with the keys to delete, and
 * `app_private.mark_media_purged` asks the same again under the lock of the contents and stamps.
 *
 * The files are deleted BEFORE the stamp, never after: a crash between the two leaves a media that is offered again next run, whose delete
 * the storage answers as done, instead of files that stay for ever behind a row that says they left. A delete that fails (the storage is
 * down, a key is refused) leaves that media unstamped and the run goes on with the next one; it is offered again tomorrow, and only its
 * id and the name of the error are logged (a key carries the agency, and no one needs it to follow up). A stamp lost to a deadlock or a
 * serialization failure is left the same way; any other database error, and an aborted run (the worker stops), throw so the queue retries.
 *
 * Idempotent, as every durable job must be: a run that finds nothing due does nothing, so it can run daily and at every start. The list is
 * read by cursor: each question starts after the last media of the previous batch, stamped or not, and the run stops at the first batch that
 * is not full. So a media that cannot be purged is asked once per run, and never holds the head of the queue against the ones behind it.
 */
export const mediaPurgeJob = (dependencies: MediaPurgeJobDependencies): DurableJobDefinition<Record<string, never>> => ({
  name: MEDIA_PURGE_JOB_NAME,
  schedule: MEDIA_PURGE_SCHEDULE,
  runOnStart: true,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    let purged = 0;
    // The media left for the next run and why, by the name of the error: never a key, and never the text of the storage.
    const failed = new Map<string, string>();
    let after: DueMedia | undefined;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      context.signal.throwIfAborted();
      const listed = await raw<{ rows: ReadonlyArray<Record<string, unknown>> }>(
        dependencies.database.knex, LIST_SQL, [MEDIA_PURGE_BATCH_SIZE, after?.removedAt ?? null, after?.assetId ?? null]
      );
      const due = listed.rows.map(dueMediaOf);

      for (const media of due) {
        try {
          for (const key of media.keys) {
            context.signal.throwIfAborted();
            await dependencies.storage.deleteObject({ key, signal: context.signal });
          }
        } catch (error) {
          if (context.signal.aborted) throw error;
          failed.set(media.assetId, error instanceof Error ? error.name : 'Error');
          continue;
        }
        try {
          const stamped = await raw<{ rows: ReadonlyArray<{ purged: unknown }> }>(dependencies.database.knex, STAMP_SQL, [media.assetId]);
          const answer = stamped.rows[0]?.purged;
          if (typeof answer !== 'boolean') throw new Error('mark_media_purged() did not return whether it stamped.');
          if (answer) purged += 1;
        } catch (error) {
          if (!isRetryableConflict(error)) throw error;
          failed.set(media.assetId, 'RetryableConflict');
        }
      }

      if (due.length < MEDIA_PURGE_BATCH_SIZE) break;
      after = due[due.length - 1];
    }

    context.logger.info({ purged }, 'Purged the removed media past its retention');
    if (failed.size > 0) {
      context.logger.warn(
        { left: failed.size, media: [...failed].map(([assetId, reason]) => ({ assetId, reason })) },
        'Media left for the next run, its files not deleted or its stamp lost to a conflict'
      );
    }
  }
});
