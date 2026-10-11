import { isRetryableConflict, raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const ARCHIVE_DUE_CLIENTS_JOB_NAME = 'clients.archive-due';

/**
 * Ten past every hour, in the time zone the contract date is read in, which includes 00:10 (specs/clientes.md
 * section 8). Hourly, and again at every start of the worker, because a turn of the day missed while no
 * worker ran would leave the portal of an ended contract open for a day; the function is idempotent.
 */
export const ARCHIVE_DUE_CLIENTS_SCHEDULE = { cron: '10 * * * *', timeZone: 'America/Sao_Paulo' } as const;

export interface ArchiveDueClientsJobDependencies {
  readonly database: DatabaseClient;
}

/**
 * The job that archives the clients whose contract ended (issues #133 and #397): the first scheduled job
 * of the product, and only a clock. Every rule lives in `app_private.archive_due_client(client)`, which
 * archives exactly what the archive route archives, and `app_private.due_client_ids()` says who is due.
 * The worker calls them as `ageniza_app`, the role of the API, with no user and no wider access: that is
 * safe because they can do nothing else, whoever calls them (the single-purpose `security definer`
 * exception in docs/business/structural-changes.md).
 *
 * One client per call, and each call is a short transaction of its own, so a client that loses a race
 * with a concurrent write (40P01 or 40001) does not take the others of the hour down with it: it stays
 * due, is left for the next run, and is logged by its id, which is no personal data, to be followed up.
 * Any other failure throws and the queue retries the run.
 *
 * Idempotent, as every durable job must be: a run that finds nothing due archives none, so it can run
 * hourly and at every start. The log carries the number archived and, for a client left for the next
 * run, only its id.
 */
export const archiveDueClientsJob = (
  dependencies: ArchiveDueClientsJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: ARCHIVE_DUE_CLIENTS_JOB_NAME,
  schedule: ARCHIVE_DUE_CLIENTS_SCHEDULE,
  runOnStart: true,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    const due = await raw<{ rows: ReadonlyArray<{ id: unknown }> }>(dependencies.database.knex, 'select app_private.due_client_ids() as id', []);
    const clientIds = due.rows.map((row) => {
      if (typeof row.id !== 'string') throw new Error('due_client_ids() did not return client ids.');
      return row.id;
    });

    let archived = 0;
    const leftForNextRun: string[] = [];
    for (const clientId of clientIds) {
      try {
        const result = await raw<{ rows: ReadonlyArray<{ archived: unknown }> }>(
          dependencies.database.knex,
          'select app_private.archive_due_client(?::uuid) as archived',
          [clientId]
        );
        const answer = result.rows[0]?.archived;
        if (typeof answer !== 'boolean') throw new Error('archive_due_client() did not return whether it archived.');
        if (answer) archived += 1;
      } catch (error) {
        if (!isRetryableConflict(error)) throw error;
        leftForNextRun.push(clientId);
      }
    }

    context.logger.info({ archived }, 'Archived the clients whose contract ended');
    if (leftForNextRun.length > 0) {
      context.logger.warn({ leftForNextRun: leftForNextRun.length, clientIds: leftForNextRun }, 'Clients left for the next run after losing a race');
    }
  }
});
