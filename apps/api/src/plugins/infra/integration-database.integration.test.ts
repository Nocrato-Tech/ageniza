import { randomUUID } from 'node:crypto';

import { createLocalTestDatabaseClient, withDatabaseName } from '@ageniza/database';
import { afterAll, describe, expect, it } from 'vitest';

import { APPLICATION_DATABASE_URL, OWNER_DATABASE_URL, ownerClient, queryAsOwner } from '../../modules/auth/test-support/harness.js';

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
const owner = ownerClient();

afterAll(async () => {
  await owner.knex('agencies').where({ id: agencyId }).delete();
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
