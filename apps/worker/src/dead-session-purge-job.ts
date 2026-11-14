import { isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const DEAD_SESSION_PURGE_JOB_NAME = 'sessions.purge-dead';

/** Once a day, at 04:20 in the time zone of the product, after the purge of the unconfirmed accounts (04:10). */
export const DEAD_SESSION_PURGE_SCHEDULE = { cron: '20 4 * * *', timeZone: 'America/Sao_Paulo' } as const;

/** How many sessions one call deletes at most, and how many calls one run makes at most (50 000 sessions). */
export const DEAD_SESSION_PURGE_BATCH_SIZE = 500;
const MAX_BATCHES = 100;

const PURGE_SQL = 'select app_private.purge_dead_sessions(pg_catalog.now(), ?::integer) as purged';

export interface DeadSessionPurgeJobDependencies {
  readonly database: DatabaseClient;
}

/**
 * The retention of a session that died (decision of 2026-11-12): thirty days after it expired, or after the credential of its account
 * was replaced, the row, with its IP, user agent and city, is deleted. Every rule lives in `app_private.purge_dead_sessions(at, limit)`,
 * which this job calls with the clock of the database and which never touches a session that is still active. It only answers a
 * caller with no user bound to the transaction, as the worker is.
 *
 * One call per batch, each a transaction of its own, until a call deletes fewer than the batch, so a day with more sessions than a
 * batch is finished in the same run. A lost race (40P01 or 40001) ends the run and leaves the rest for tomorrow; any other failure
 * throws and the queue retries. Idempotent, as every durable job must be. The log carries only how many were deleted.
 */
export const deadSessionPurgeJob = (
  dependencies: DeadSessionPurgeJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: DEAD_SESSION_PURGE_JOB_NAME,
  schedule: DEAD_SESSION_PURGE_SCHEDULE,
  runOnStart: true,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    let purged = 0;
    let lostRace = false;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      context.signal.throwIfAborted();
      let deleted: number;
      try {
        const result = await raw<{ rows: ReadonlyArray<{ purged: unknown }> }>(dependencies.database.knex, PURGE_SQL, [DEAD_SESSION_PURGE_BATCH_SIZE]);
        const answer = result.rows[0]?.purged;
        if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0) throw new Error('purge_dead_sessions() did not return how many it deleted.');
        deleted = answer;
      } catch (error) {
        if (!isRetryableConflict(error)) throw error;
        lostRace = true;
        break;
      }
      purged += deleted;
      if (deleted < DEAD_SESSION_PURGE_BATCH_SIZE) break;
    }

    context.logger.info({ purged }, 'Purged the sessions dead for more than their retention');
    if (lostRace) context.logger.warn({ purged }, 'Purge of dead sessions ended early after losing a race; the rest waits for the next run');
  }
});
