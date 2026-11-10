import { databaseErrorCode, isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const APPROVAL_REMINDERS_JOB_NAME = 'approvals.enqueue-reminders';

/**
 * Once a day at 09:00 in São Paulo (decision 2026-11-10, "de manhã"), and at every start of the worker: the stamp of the function makes a
 * second run of the same day enqueue nothing, so a restart can never repeat a reminder.
 */
export const APPROVAL_REMINDERS_SCHEDULE = { cron: '0 9 * * *', timeZone: 'America/Sao_Paulo' } as const;

// No argument: the function reads the instant itself (now()). The function that takes an instant is the owner's, since an instant chosen by
// the application role could re-run a day this job never ran.
const ENQUEUE_SQL = 'select app_private.enqueue_approval_reminders() as enqueued';

export interface ApprovalRemindersJobDependencies {
  readonly database: DatabaseClient;
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
