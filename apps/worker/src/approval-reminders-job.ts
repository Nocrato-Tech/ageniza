import { databaseErrorCode, isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const APPROVAL_REMINDERS_JOB_NAME = 'approvals.enqueue-reminders';

/**
 * Once a day at 09:00 in São Paulo (decision 2026-11-10, "de manhã"), and at every start of the worker, but a start before 09:00 waits for
 * the cron: the stamp of the function makes a second run of the same day enqueue nothing, so a restart can never repeat a reminder.
 */
export const APPROVAL_REMINDERS_SCHEDULE = { cron: '0 9 * * *', timeZone: 'America/Sao_Paulo' } as const;

// No argument: the function reads the instant itself (now()). The function that takes an instant is the owner's, since an instant chosen by
// the application role could re-run a day this job never ran.
const ENQUEUE_SQL = 'select app_private.enqueue_approval_reminders() as enqueued';

/** The first hour of the morning (São Paulo) the reminders may leave at. */
export const APPROVAL_REMINDERS_FIRST_HOUR = 9;

const saoPauloHour = (instant: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: APPROVAL_REMINDERS_SCHEDULE.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(instant));

export interface ApprovalRemindersJobDependencies {
  readonly database: DatabaseClient;
  /** Test seam: the instant the morning is judged at. The database reads its own clock for the day of the rounds. */
  readonly now?: () => Date;
}

/**
 * The reminders of approval, "vence amanhã" and "venceu" (decision 2026-11-10): only a clock. Every rule lives in
 * `app_private.enqueue_approval_reminders()`, which puts each reminder in the notification queue once per round, for the active people of the
 * client, and only for what still waits; the e-mails leave through `notifications.send-client-content-emails`. The worker calls it as
 * `ageniza_app` with no user bound to the transaction, which is all it answers to (42501 otherwise), at the default isolation (READ COMMITTED,
 * which it asks for: 40001 otherwise).
 *
 * A reminder is owed for ONE day and a day missed is not made up, so a failure is not left for tomorrow: it ends the run with an error and the
 * queue retries it over the morning. A lost race (40001, 40P01) is the one the database may recover from by itself and is logged as such; 42501
 * means the call carried an actor, a defect no retry fixes, and is logged as an error before the retries end in the failure the queue reports.
 * The error that leaves the job carries the code and never the text of the database. The log carries a count and a code: no id, no address.
 *
 * `runOnStart` sends the job at every start, and a start at 02:00 would send the reminders at 02:00 and stamp them, leaving nothing for
 * the 09:00 run. The queue gives the handler no way to tell the start from the cron, so the handler answers by the hour: before 09:00 in São
 * Paulo it does nothing and the cron of the morning does the work; from 09:00 on (a worker that was down at 09:00 and came back) it runs.
 */
export const approvalRemindersJob = (
  dependencies: ApprovalRemindersJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: APPROVAL_REMINDERS_JOB_NAME,
  schedule: APPROVAL_REMINDERS_SCHEDULE,
  runOnStart: true,
  retryLimit: 6,
  retryDelaySeconds: 60,
  retryDelayMaxSeconds: 900,
  expireInSeconds: 300,
  concurrency: 1,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    if (saoPauloHour((dependencies.now ?? (() => new Date()))()) < APPROVAL_REMINDERS_FIRST_HOUR) {
      context.logger.info({ skipped: 'before_morning' }, 'Approval reminders wait for 09:00 in São Paulo');
      return;
    }
    let enqueued: unknown;
    try {
      const result = await raw<{ rows: ReadonlyArray<{ enqueued: unknown }> }>(dependencies.database.knex, ENQUEUE_SQL, []);
      enqueued = result.rows[0]?.enqueued;
    } catch (error) {
      const errorCode = databaseErrorCode(error);
      if (errorCode === '42501') context.logger.error({ errorCode }, 'The approval reminders were refused: the call carried an actor');
      else if (isRetryableConflict(error)) context.logger.warn({ errorCode }, 'The approval reminders lost a race and will be retried');
      else throw error;
      throw new Error(`enqueue_approval_reminders() failed with ${errorCode}.`);
    }
    if (typeof enqueued !== 'number' || !Number.isInteger(enqueued) || enqueued < 0) throw new Error('enqueue_approval_reminders() did not return how many it enqueued.');
    context.logger.info({ enqueued }, 'Approval reminders enqueued');
  }
});
