import { randomUUID } from 'node:crypto';

import { createLocalTestDatabaseClient, waitForBackendsBlockedBy, withDatabaseName } from '@ageniza/database';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { APPLICATION_DATABASE_URL, OWNER_DATABASE_URL, ownerClient, queryAsOwner } from '../../modules/auth/test-support/harness.js';
import { waitForQueueBehind } from '../../modules/auth/test-support/lock-queue.js';

// Issue #792: every integration file runs against a clone of a migrated model, named
// `<operator database>_c<run>_<file>`. A file that reached the operator's database instead would share rows,
// locks and pg_stat_activity with every other file running at the same time.
const CLONE_NAME = /^(?<base>.+)_c(?<run>[0-9a-f]{6})_[0-9a-f]{8}$/;

const databaseOf = (connectionString: string): string => decodeURIComponent(new URL(connectionString).pathname.slice(1));

const currentDatabase = async (): Promise<string> => {
  const [row] = await queryAsOwner<{ name: string }>('select current_database() as name');
  return row?.name ?? '';
};

const agencyId = randomUUID();
const queueAgencyId = randomUUID();
const owner = ownerClient();

afterAll(async () => {
  await owner.knex('agencies').whereIn('id', [agencyId, queueAgencyId]).delete();
  await owner.close();
});

describe('the database of an API integration file (issue #792)', () => {
  it('is a clone of its own, for the application role and for the owner alike', async () => {
    const name = await currentDatabase();

    expect(name).toMatch(CLONE_NAME);
    expect(databaseOf(APPLICATION_DATABASE_URL)).toBe(name);
    expect(databaseOf(OWNER_DATABASE_URL)).toBe(name);
  });

  it('waits 3s before it calls a lock cycle a deadlock, so the waiter of a lock-barrier race is the victim and not the holder', async () => {
    const [shown] = await queryAsOwner<{ deadlock_timeout: string }>('show deadlock_timeout');

    expect(shown?.deadlock_timeout).toBe('3s');
  });

  it('keeps what the file writes out of the model and out of the operator\'s database', async () => {
    const { base, run } = CLONE_NAME.exec(await currentDatabase())?.groups ?? {};
    await owner.knex('agencies').insert({ id: agencyId, name: `Isolation ${agencyId}`, owner_user_id: null });

    expect(await owner.knex('agencies').where({ id: agencyId })).toHaveLength(1);
    for (const other of [`${base}_m${run}`, base ?? '']) {
      const elsewhere = createLocalTestDatabaseClient(withDatabaseName(OWNER_DATABASE_URL, other));
      try {
        expect(await elsewhere.knex('agencies').where({ id: agencyId }), other).toHaveLength(0);
      } finally {
        await elsewhere.close();
      }
    }
  });
});

// The race tests order two requests by waiting until the first is queued behind their holder. The wait has to see the whole
// queue and only the queue (docs/implementation-checklist.md, 76). The transactions here are plain connections of their own:
// the pool of the file holds three.
describe('the wait for requests queued behind a held lock', () => {
  const LOCK_THE_ROW = 'select id from public.agencies where id = $1::uuid for update';
  const SLOT = "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lock-queue-stray', 0))";
  const CHAIN_SLOT = "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lock-queue-chain', 0))";

  const begin = async (): Promise<Client> => {
    const client = new Client({ connectionString: OWNER_DATABASE_URL });
    await client.connect();
    await client.query('begin');
    return client;
  };

  const pidOf = async (client: Client): Promise<number> => Number((await client.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid);

  /** Holds the row of one agency; `queue()` puts one more transaction behind it, and everything is released in order at the end. */
  const withHeldRow = async (work: (held: { readonly pid: number; queue(): Promise<void> }) => Promise<void>): Promise<void> => {
    await owner.knex('agencies').insert({ id: queueAgencyId, name: `Queue ${queueAgencyId}`, owner_user_id: null });
    const holder = await begin();
    const queued: Array<{ readonly client: Client; readonly locking: Promise<unknown> }> = [];
    try {
      await holder.query(LOCK_THE_ROW, [queueAgencyId]);
      await work({
        pid: await pidOf(holder),
        queue: async () => {
          const client = await begin();
          queued.push({ client, locking: client.query(LOCK_THE_ROW, [queueAgencyId]) });
        }
      });
    } finally {
      await holder.query('rollback');
      await holder.end();
      for (const { client, locking } of queued) {
        await Promise.allSettled([locking]);
        await client.query('rollback');
        await client.end();
      }
      await owner.knex('agencies').where({ id: queueAgencyId }).delete();
    }
  };

  it('counts the whole chain behind the holder, though only the first waiter waits on the holder itself', async () => {
    await withHeldRow(async (held) => {
      for (const place of [1, 2, 3]) {
        await held.queue();
        await waitForQueueBehind(owner.knex, held.pid, place);
      }

      expect(await waitForBackendsBlockedBy(owner.knex, held.pid)).toHaveLength(1);
    });
  });

  // An advisory lock makes every request wait for the holder and for each request ahead of it, so the same backend is reachable
  // along more than one path of the chain and has to be counted once.
  it('counts each queued request once, though several backends ahead of it hold it up', async () => {
    const holder = await begin();
    const queued: Array<{ readonly client: Client; readonly locking: Promise<unknown> }> = [];
    const queue = async (): Promise<void> => {
      const client = await begin();
      queued.push({ client, locking: client.query(CHAIN_SLOT) });
    };
    try {
      await holder.query(CHAIN_SLOT);
      const holderPid = await pidOf(holder);
      await queue();
      await queue();
      await waitForQueueBehind(owner.knex, holderPid, 2);

      await expect(waitForQueueBehind(owner.knex, holderPid, 3, 300)).rejects.toThrow(/ever queued/);

      await queue();
      await waitForQueueBehind(owner.knex, holderPid, 3);
    } finally {
      await holder.query('rollback');
      await holder.end();
      for (const { client, locking } of queued) {
        await Promise.allSettled([locking]);
        await client.query('rollback');
        await client.end();
      }
    }
  });

  it('does not count a backend that waits for something else, and counts the request once it queues', async () => {
    const strayHolder = await begin();
    const strayWaiter = await begin();
    let stray: Promise<unknown> | undefined;
    try {
      await strayHolder.query(SLOT);
      stray = strayWaiter.query(SLOT);
      await waitForBackendsBlockedBy(owner.knex, await pidOf(strayHolder));

      await withHeldRow(async (held) => {
        await expect(waitForQueueBehind(owner.knex, held.pid, 1, 300)).rejects.toThrow(/ever queued/);

        await held.queue();
        await waitForQueueBehind(owner.knex, held.pid, 1);
      });
    } finally {
      await strayHolder.query('rollback');
      await strayHolder.end();
      await Promise.allSettled([stray]);
      await strayWaiter.query('rollback');
      await strayWaiter.end();
    }
  });
});
