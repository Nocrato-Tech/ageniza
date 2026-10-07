import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { createLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, raw, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ARCHIVE_DUE_CLIENTS_JOB_NAME, ARCHIVE_DUE_CLIENTS_SCHEDULE, archiveDueClientsJob } from './archive-due-clients-job.js';
import { createDurableQueue, deadLetterQueueName, type DurableJobDefinition, type DurableQueue } from './queue.js';

// Issue #133, against the migrated local database and as the application role, the one the worker
// uses in production: the job needs data access alone and no identity of its own. The definition under
// test is the real one with only its queue name changed, so the real `clients.archive-due` queue of a
// developer's local database is never deleted by the cleanup below.
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const prefix = `test.${randomUUID().slice(0, 8)}`;
const jobName = `${prefix}.${ARCHIVE_DUE_CLIENTS_JOB_NAME}`;

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
const running = new Set<DurableQueue>();
const agencyId = randomUUID();

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const captureLogs = () => {
  const destination = new PassThrough();
  const output: string[] = [];
  destination.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return {
    logger: createLogger({}, destination),
    records: (): Array<Record<string, unknown>> => output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    text: (): string => output.join('')
  };
};

type Captured = ReturnType<typeof captureLogs>;

const definition = (overrides: Partial<DurableJobDefinition<Record<string, never>>> = {}): DurableJobDefinition<Record<string, never>> => ({
  ...archiveDueClientsJob({ database: getApplication() }),
  name: jobName,
  retryDelaySeconds: 1,
  ...overrides
});

const openQueue = async (
  jobs: ReadonlyArray<DurableJobDefinition<Record<string, never>>>,
  captured: Captured,
  options: { readonly cronMonitorIntervalSeconds?: number } = {}
): Promise<DurableQueue> => {
  const queue = createDurableQueue({
    connectionString: applicationUrl,
    logger: captured.logger,
    concurrency: 1,
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 1,
    ...options
  });
  for (const job of jobs) queue.register(job as DurableJobDefinition<object>);
  running.add(queue);
  await queue.start();
  return queue;
};

const closeQueue = async (queue: DurableQueue): Promise<void> => {
  await queue.stop();
  running.delete(queue);
};

const scheduleRows = async (): Promise<Array<{ name: string; cron: string; timezone: string | null; data: unknown }>> =>
  (await raw<{ rows: Array<{ name: string; cron: string; timezone: string | null; data: unknown }> }>(
    getOwner().knex, 'select name, cron, timezone, data from pgboss.schedule where name = ?', [jobName]
  )).rows;

const jobStates = async (): Promise<string[]> =>
  (await raw<{ rows: Array<{ state: string }> }>(getOwner().knex, 'select state::text as state from pgboss.job where name = ? order by created_on', [jobName])).rows.map((row) => row.state);

const waitForState = (id: string, state: string, timeout = 20_000): Promise<void> =>
  vi.waitFor(async () => {
    const result = await raw<{ rows: Array<{ state: string }> }>(getOwner().knex, 'select state::text as state from pgboss.job where id = ?', [id]);
    expect(result.rows[0]?.state).toBe(state);
  }, { timeout, interval: 250 });

const brasiliaDay = async (offsetDays: number): Promise<string> =>
  (await raw<{ rows: Array<{ day: string }> }>(
    getOwner().knex, "select (((now() at time zone 'America/Sao_Paulo')::date) + ?::int)::text as day", [offsetDays]
  )).rows[0]!.day;

const insertClient = async (name: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  await getOwner().knex('clients').insert({ id, agency_id: agencyId, name: `${name} ${id}`, ...extra });
  return id;
};

const insertInvitation = async (clientId: string | null, purpose: 'client_invite' | 'collaborator_invite' = 'client_invite'): Promise<string> => {
  const id = randomUUID();
  const role = purpose === 'collaborator_invite' ? (await getOwner().knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id : null;
  await getOwner().knex('invitations').insert({
    id,
    agency_id: agencyId,
    purpose,
    email: `${id}@job.test`,
    client_id: clientId,
    role_id: role,
    token_hash: `hash-${id}`,
    expires_at: new Date(Date.now() + 86_400_000)
  });
  return id;
};

const statusOf = async (clientId: string): Promise<{ status: string; archived_at: Date | null; closing_date: string | null }> =>
  (await getOwner().knex('clients').where({ id: clientId }).select('status', 'archived_at', getOwner().knex.raw('closing_date::text as closing_date')).first()) as never;

const dueCount = async (): Promise<number> =>
  Number((await raw<{ rows: Array<{ count: string }> }>(
    getOwner().knex,
    "select count(*) as count from public.clients where status = 'active' and closing_date < (now() at time zone 'America/Sao_Paulo')::date", []
  )).rows[0]!.count);

const archivedCounts = (captured: Captured): number[] =>
  captured.records().filter((record) => record.msg === 'Archived the clients whose contract ended').map((record) => record.archived as number);

beforeAll(async () => {
  assertLocalDatabaseUrl(applicationUrl);
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  await getOwner().knex('agencies').insert({ id: agencyId, name: `Job Agency ${agencyId}`, owner_user_id: null });
});

afterAll(async () => {
  try {
    await Promise.allSettled([...running].map((queue) => queue.stop()));
    // The schedule row goes with its queue (ON DELETE CASCADE); the source queue references its dead letter queue, so it goes first.
    await owner?.knex.raw("select pgboss.delete_queue(name) from pgboss.queue where name like ? and name not like '%.dead'", [`${prefix}.%`]);
    await owner?.knex.raw('select pgboss.delete_queue(name) from pgboss.queue where name like ?', [`${prefix}.%`]);
    await owner?.knex('invitations').where({ agency_id: agencyId }).delete();
    await owner?.knex('audit.events').where({ agency_id: agencyId }).delete();
    await owner?.knex('clients').where({ agency_id: agencyId }).delete();
    await owner?.knex('agencies').where({ id: agencyId }).delete();
  } finally {
    await application?.close();
    await owner?.close();
  }
});

describe('clients.archive-due on the durable queue', { timeout: 60_000 }, () => {
  it('archives the client whose contract ended yesterday and not the one that ends today, tomorrow or never, then archives nothing the second time', async () => {
    const yesterday = await insertClient('Ontem', { closing_date: await brasiliaDay(-1) });
    const longAgo = await insertClient('Faz tempo', { closing_date: await brasiliaDay(-40) });
    const today = await insertClient('Hoje', { closing_date: await brasiliaDay(0) });
    const tomorrow = await insertClient('Amanhã', { closing_date: await brasiliaDay(1) });
    const never = await insertClient('Sem data');
    const alreadyArchived = await insertClient('Arquivado', { status: 'archived', archived_at: new Date(Date.now() - 86_400_000) });
    const yesterdayInvitation = await insertInvitation(yesterday);
    const todayInvitation = await insertInvitation(today);
    const collaboratorInvitation = await insertInvitation(null, 'collaborator_invite');
    const due = await dueCount();
    expect(due).toBeGreaterThanOrEqual(2);

    const captured = captureLogs();
    const queue = await openQueue([definition()], captured);
    const first = await queue.send(jobName, {});
    await waitForState(first, 'completed');

    expect((await statusOf(yesterday)).status).toBe('archived');
    expect((await statusOf(longAgo)).status).toBe('archived');
    for (const id of [today, tomorrow, never]) expect((await statusOf(id)).status, id).toBe('active');
    expect(await statusOf(today)).toMatchObject({ archived_at: null, closing_date: await brasiliaDay(0) });
    expect(await statusOf(yesterday)).toMatchObject({ archived_at: expect.any(Date), closing_date: null });
    expect((await statusOf(alreadyArchived)).archived_at).toEqual(expect.any(Date));

    const revoked = async (id: string) => (await getOwner().knex('invitations').where({ id }).first('revoked_at')).revoked_at;
    expect(await revoked(yesterdayInvitation)).toBeInstanceOf(Date);
    expect(await revoked(todayInvitation)).toBeNull();
    expect(await revoked(collaboratorInvitation)).toBeNull();

    // One event per archived client, with no user and the job as origin; the already archived one has none.
    const events = await getOwner().knex('audit.events').where({ agency_id: agencyId, action: 'client.archived' }).select('target_id', 'actor_user_id', 'request_id');
    expect(events.map((event) => event.target_id).sort()).toEqual([yesterday, longAgo].sort());
    for (const event of events) expect(event).toMatchObject({ actor_user_id: null, request_id: 'job:clients.archive-due' });

    expect(archivedCounts(captured)).toEqual([due]);

    const second = await queue.send(jobName, {});
    await waitForState(second, 'completed');
    expect(archivedCounts(captured)).toEqual([due, 0]);
    expect(await getOwner().knex('audit.events').where({ agency_id: agencyId, action: 'client.archived' }).count<{ count: string }[]>('id as count'))
      .toEqual([{ count: String(events.length) }]);
    expect(await dueCount()).toBe(0);
    await closeQueue(queue);
  });

  it('runs a job inserted by hand with the SQL docs/local-environment.md gives, as the application role', async () => {
    const overdue = await insertClient('Disparo manual', { closing_date: await brasiliaDay(-2) });
    const captured = captureLogs();
    const queue = await openQueue([definition()], captured);

    // The statement of the guide, with the queue name of this test in place of 'clients.archive-due'.
    const inserted = await raw<{ rows: Array<{ id: string }> }>(getApplication().knex, `
      insert into pgboss.job (name, data, retry_limit, retry_delay, retry_backoff, dead_letter)
      values (?, '{}'::jsonb, 3, 10, true, ?)
      returning id
    `, [jobName, deadLetterQueueName(jobName)]);
    await waitForState(inserted.rows[0]!.id, 'completed');

    expect((await statusOf(overdue)).status).toBe('archived');
    expect(archivedCounts(captured)).toEqual([expect.any(Number)]);
    await closeQueue(queue);
  });

  it('logs the run and the count and nothing about a client or a person', async () => {
    const named = await insertClient('Sigilo da Padaria', { closing_date: await brasiliaDay(-1) });
    const invitationId = await insertInvitation(named);
    const captured = captureLogs();
    const queue = await openQueue([definition()], captured);
    const id = await queue.send(jobName, {});
    await waitForState(id, 'completed');
    await closeQueue(queue);

    const records = captured.records();
    expect(records.filter((record) => record.msg === 'Archived the clients whose contract ended')).toEqual([
      expect.objectContaining({ queue: jobName, jobId: id, attempt: 1, archived: expect.any(Number) })
    ]);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ msg: 'Durable job completed', status: 'completed', queue: jobName })]));
    for (const secret of [named, 'Sigilo', 'Padaria', invitationId, '@job.test', agencyId]) expect(captured.text(), secret).not.toContain(secret);
  });

  it('retries a run that loses a deadlock with a concurrent change of the client\'s invitation, and then archives', async () => {
    const racing = await insertClient('Disputa', { closing_date: await brasiliaDay(-1) });
    const invitationId = await insertInvitation(racing);
    const captured = captureLogs();
    const queue = await openQueue([definition()], captured);

    const holder = await getOwner().knex.transaction();
    let released = false;
    try {
      // The holder plays a resend already holding the invitation. The job locks the client and then
      // waits for that invitation; when the holder asks for the client, the job, which waited first, loses.
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitationId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
      const holderPid = Number((await raw<{ rows: Array<{ pid: number }> }>(holder, 'select pg_catalog.pg_backend_pid() as pid', [])).rows[0]!.pid);

      const id = await queue.send(jobName, {});
      await vi.waitFor(async () => {
        const blocked = await raw<{ rows: Array<{ pid: number }> }>(getOwner().knex, `
          select activity.pid from pg_catalog.pg_stat_activity activity
          where activity.datname = pg_catalog.current_database() and pg_catalog.pg_blocking_pids(activity.pid) @> array[?::int]
        `, [holderPid]);
        expect(blocked.rows.length).toBeGreaterThan(0);
      }, { timeout: 15_000, interval: 25 });
      await holder.raw('select id from public.clients where id = ?::uuid for share', [racing]);
      await holder.rollback();
      released = true;

      await waitForState(id, 'completed');
      const records = captured.records();
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ msg: 'Durable job failed and will be retried', status: 'retrying', attempt: 1, queue: jobName })
      ]));
      expect(JSON.stringify(records)).not.toMatch(/deadlock|40P01/i);
      expect((await statusOf(racing)).status).toBe('archived');
      expect((await getOwner().knex('invitations').where({ id: invitationId }).first('revoked_at')).revoked_at).toBeInstanceOf(Date);
    } finally {
      if (!released) await holder.rollback();
      await closeQueue(queue);
    }
  });
});

describe('the schedule of clients.archive-due', { timeout: 60_000 }, () => {
  it('registers one daily schedule at ten past midnight in Brasília', async () => {
    const queue = await openQueue([definition()], captureLogs());
    const rows = await scheduleRows();
    expect(rows).toEqual([{ name: jobName, cron: '10 0 * * *', timezone: 'America/Sao_Paulo', data: {} }]);
    expect(rows[0]).toMatchObject({ cron: ARCHIVE_DUE_CLIENTS_SCHEDULE.cron, timezone: ARCHIVE_DUE_CLIENTS_SCHEDULE.timeZone });
    await closeQueue(queue);
  });

  it('does not add a second schedule when the worker restarts or when two workers run at once', async () => {
    const first = await openQueue([definition()], captureLogs());
    const second = await openQueue([definition()], captureLogs());
    expect(await scheduleRows()).toHaveLength(1);
    await closeQueue(first);
    await closeQueue(second);

    const restarted = await openQueue([definition()], captureLogs());
    const rows = await scheduleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cron: '10 0 * * *', timezone: 'America/Sao_Paulo' });
    await closeQueue(restarted);
  });

  it('is what sends the job: a schedule that is due is turned into a job and the job runs', async () => {
    const every = definition({ schedule: { cron: '* * * * *', timeZone: 'America/Sao_Paulo' } });
    // Jobs the earlier tests sent by hand are still in the table; only a new one was sent by the clock.
    const before = (await jobStates()).length;
    const captured = captureLogs();
    const queue = await openQueue([every], captured, { cronMonitorIntervalSeconds: 1 });
    await vi.waitFor(async () => {
      const states = await jobStates();
      expect(states.length).toBeGreaterThan(before);
      expect(states.slice(before)).toContain('completed');
    }, { timeout: 45_000, interval: 500 });
    expect(archivedCounts(captured).length).toBeGreaterThanOrEqual(1);
    await closeQueue(queue);
  }, 60_000);

  it('keeps the dead letter queue of the job beside it', async () => {
    const queue = await openQueue([definition()], captureLogs());
    const names = (await raw<{ rows: Array<{ name: string }> }>(getOwner().knex, 'select name from pgboss.queue where name like ? order by name', [`${jobName}%`])).rows.map((row) => row.name);
    expect(names).toEqual([jobName, deadLetterQueueName(jobName)]);
    await closeQueue(queue);
  });
});
