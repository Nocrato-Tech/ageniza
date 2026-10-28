import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, requestLockOnceBlocked, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

// Issue #762: a deadlock test closes the cycle from the holder's transaction, inside the database, the moment the
// transaction under test is blocked. Advisory locks stand in for the rows of a route, so the file needs no fixture.
const { ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient;
const open: Knex.Transaction[] = [];

const ADVISORY = 'select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%L, 0))';
const advisory = (trx: Pick<Knex, 'raw'>, key: string) => trx.raw('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [key]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const holding = async (key: string): Promise<Knex.Transaction> => {
  const holder = await owner.knex.transaction();
  open.push(holder);
  await advisory(holder, key);
  return holder;
};

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
});

afterAll(async () => {
  for (const transaction of open) if (!transaction.isCompleted()) await transaction.rollback();
  await owner.close();
});

describe('requestLockOnceBlocked', () => {
  it('makes the holder close the cycle in the database, so the backend that waited first loses even when the test process stalls for 1.5 s', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const holder = await holding(first);

    const asks = requestLockOnceBlocked(holder, ADVISORY, [second]);
    const waiter = owner.knex.transaction(async (transaction) => {
      await advisory(transaction, second);
      await advisory(transaction, first);
    });
    waiter.catch(() => undefined);
    await sleep(1500);

    const [waiterOutcome, holderOutcome] = await Promise.allSettled([waiter, asks]);
    expect(waiterOutcome).toMatchObject({ status: 'rejected', reason: { code: '40P01' } });
    expect(holderOutcome.status).toBe('fulfilled');
    await holder.rollback();
  }, 30_000);

  it('does not run the statement and raises when no backend is ever blocked by the holder', async () => {
    const holder = await holding(randomUUID());

    await expect(requestLockOnceBlocked(holder, 'select 1 / 0', [], { timeoutSeconds: 1 })).rejects.toThrow(/No backend ever waited on a lock held by this transaction/);
    await holder.rollback();
  }, 30_000);

  const blockedBehind = (key: string): Promise<void> => {
    const blocked = owner.knex.transaction(async (transaction) => {
      await transaction.raw("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0)), 'marker-of-the-blocked-one'", [key]);
    });
    blocked.catch(() => undefined);
    return blocked;
  };

  it('ignores a blocked backend whose statement does not match the pattern', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const blocked = blockedBehind(key);

    await expect(requestLockOnceBlocked(holder, 'select 1', [], { blockedStatement: '%marker-of-another-statement%', timeoutSeconds: 1 }))
      .rejects.toThrow(/No backend ever waited/);
    await holder.rollback();
    await blocked;
  }, 30_000);

  it('runs the statement for a blocked backend that matches the pattern, and takes the bindings as quoted literals', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const blocked = blockedBehind(key);
    const value = `it's "quoted"; select 1 / 0 --`;

    await requestLockOnceBlocked(holder, "select pg_catalog.set_config('ageniza_test.bound', %L, true)", [value], { blockedStatement: '%marker-of-the-blocked-one%' });
    const read = await holder.raw<{ rows: Array<{ value: string }> }>("select pg_catalog.current_setting('ageniza_test.bound') as value");
    expect(read.rows[0]?.value).toBe(value);

    await holder.rollback();
    await blocked;
  }, 30_000);
});
