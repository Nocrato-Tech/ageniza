import { isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME = 'notifications.approval-deadline-passed';

/**
 * Five past every hour, so a deadline with an hour on it is told close to the instant (specs/notificacoes.md section 8), and again at
 * every start of the worker, so an hour missed while no worker ran is caught up at once; the function never tells the same round twice.
 */
export const APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE = { cron: '5 * * * *', timeZone: 'America/Sao_Paulo' } as const;

export interface ApprovalDeadlineNotificationsJobDependencies {
  readonly database: DatabaseClient;
}

/**
 * The job that tells the responsible of a content that the deadline of its round passed (decision 2026-11-11, event
 * `approval_deadline_passed`), and only a clock: every rule lives in `app_private.notify_approval_deadlines_passed()`, a single-purpose
 * `security definer` function that creates the notifications and audits each one, exactly as the events of the routes do. The worker
 * calls it as `ageniza_app` with NO actor bound to the transaction: with an actor the function refuses (42501), so no request can run it.
 * That is why the call goes through the client directly and never through `withAuthenticatedUserTransaction`.
 *
 * The function is one transaction, so a deadlock or a serialization failure against a concurrent archive or approval leaves nothing
 * behind: the run ends, logs only that it did, and the next hour tells what is still due. Any other failure throws and the queue
 * retries the run; none of them takes the worker down. Idempotent, as every durable job must be.
 */
export const approvalDeadlineNotificationsJob = (
  dependencies: ApprovalDeadlineNotificationsJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: APPROVAL_DEADLINE_NOTIFICATIONS_JOB_NAME,
  schedule: APPROVAL_DEADLINE_NOTIFICATIONS_SCHEDULE,
  runOnStart: true,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    let notified: unknown;
    try {
      const result = await raw<{ rows: ReadonlyArray<{ notified: unknown }> }>(
        dependencies.database.knex,
        'select app_private.notify_approval_deadlines_passed() as notified',
        []
      );
      notified = result.rows[0]?.notified;
    } catch (error) {
      if (!isRetryableConflict(error)) throw error;
      context.logger.warn({}, 'Approval deadlines left for the next run after losing a race');
      return;
    }
    if (typeof notified !== 'number' || !Number.isInteger(notified)) {
      throw new Error('notify_approval_deadlines_passed() did not return how many it notified.');
    }

    context.logger.info({ notified }, 'Notified the approvals whose deadline passed');
  }
});
