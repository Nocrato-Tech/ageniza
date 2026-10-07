import { raw, type DatabaseClient } from '@ageniza/database';

import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const ARCHIVE_DUE_CLIENTS_JOB_NAME = 'clients.archive-due';

/** 00:10 every day, in the time zone the contract date is read in (specs/clientes.md section 8). */
export const ARCHIVE_DUE_CLIENTS_SCHEDULE = { cron: '10 0 * * *', timeZone: 'America/Sao_Paulo' } as const;

export interface ArchiveDueClientsJobDependencies {
  readonly database: DatabaseClient;
}

/**
 * The daily job that archives the clients whose contract ended (issue #133): the first scheduled job
 * of the product, and only a clock. Every rule lives in `app_private.archive_due_clients()`, which
 * archives exactly what the archive route archives, for each client whose `closing_date` is already
 * past. The worker calls it as `ageniza_app`, the role of the API, with no user and no wider access:
 * that is safe because the function can do nothing else, whoever calls it (the single-purpose
 * `security definer` exception in docs/business/structural-changes.md).
 *
 * Idempotent, as every durable job must be: a second run the same day finds nothing due and archives
 * none. A failure, such as a lost race with a concurrent change of the client's invitations, throws
 * and the queue retries it. The log carries the number archived and no client or person.
 */
export const archiveDueClientsJob = (
  dependencies: ArchiveDueClientsJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: ARCHIVE_DUE_CLIENTS_JOB_NAME,
  schedule: ARCHIVE_DUE_CLIENTS_SCHEDULE,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    const result = await raw<{ rows: ReadonlyArray<{ archived: number | string }> }>(
      dependencies.database.knex,
      'select app_private.archive_due_clients() as archived',
      []
    );
    // The driver may hand a bigint back as text; null, a fraction or a negative are not a count.
    const value = result.rows[0]?.archived;
    const archived = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isInteger(archived) || archived < 0) throw new Error('archive_due_clients() did not return a count.');
    context.logger.info({ archived }, 'Archived the clients whose contract ended');
  }
});
