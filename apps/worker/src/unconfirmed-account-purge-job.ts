import { isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const UNCONFIRMED_ACCOUNT_PURGE_JOB_NAME = 'accounts.purge-unconfirmed';

/** Once a day, at 04:10 in the time zone of the product, after the purge of the removed media (03:40). */
export const UNCONFIRMED_ACCOUNT_PURGE_SCHEDULE = { cron: '10 4 * * *', timeZone: 'America/Sao_Paulo' } as const;

/** How many accounts one call deletes at most, and how many calls one run makes at most (10 000 accounts). */
export const UNCONFIRMED_ACCOUNT_PURGE_BATCH_SIZE = 100;
const MAX_BATCHES = 100;

const PURGE_SQL = 'select app_private.purge_unconfirmed_accounts(pg_catalog.now(), ?::integer) as purged';

export interface UnconfirmedAccountPurgeJobDependencies {
  readonly database: DatabaseClient;
}

/**
 * The retention of an account that was never confirmed (issue #724, decision of 2026-10-27): seven days after it was created it is
 * deleted, with its confirmations and acceptances, so that a name and an e-mail typed by a third party do not stay for ever. Every
 * rule lives in `app_private.purge_unconfirmed_accounts(at, limit)`, which this job calls with the clock of the database and which
 * never touches a confirmed account, one with any tie (an agency, a membership, an invitation) or one with a live session. It only
 * answers a caller with no user bound to the transaction, as the worker is, and it runs one at a time by itself.
 *
 * One call per batch, each a transaction of its own, until a call deletes fewer than the batch, so a day with more accounts than a
 * batch is finished in the same run. A lost race (40P01 or 40001) ends the run and leaves the rest for tomorrow; any other failure
 * throws and the queue retries. Idempotent, as every durable job must be. The log carries only how many were deleted: no id, no
 * e-mail, no name.
 */
export const unconfirmedAccountPurgeJob = (
  dependencies: UnconfirmedAccountPurgeJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: UNCONFIRMED_ACCOUNT_PURGE_JOB_NAME,
  schedule: UNCONFIRMED_ACCOUNT_PURGE_SCHEDULE,
  runOnStart: true,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    let purged = 0;
    let lostRace = false;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      context.signal.throwIfAborted();
      let deleted: number;
      try {
        const result = await raw<{ rows: ReadonlyArray<{ purged: unknown }> }>(dependencies.database.knex, PURGE_SQL, [UNCONFIRMED_ACCOUNT_PURGE_BATCH_SIZE]);
        const answer = result.rows[0]?.purged;
        if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0) throw new Error('purge_unconfirmed_accounts() did not return how many it deleted.');
        deleted = answer;
      } catch (error) {
        if (!isRetryableConflict(error)) throw error;
        lostRace = true;
        break;
      }
      purged += deleted;
      if (deleted < UNCONFIRMED_ACCOUNT_PURGE_BATCH_SIZE) break;
    }

    context.logger.info({ purged }, 'Purged the unconfirmed accounts past their retention');
    if (lostRace) context.logger.warn({ purged }, 'Purge of unconfirmed accounts ended early after losing a race; the rest waits for the next run');
  }
});
