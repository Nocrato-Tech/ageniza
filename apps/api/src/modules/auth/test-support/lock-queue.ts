import { raw } from '@ageniza/database';

type Observer = Parameters<typeof raw>[0];

/**
 * A row lock held by one transaction makes only the first waiter wait for it: every next one waits for the one ahead of it,
 * and `pg_blocking_pids` answers that backend. So the queue is read through the chain, starting from the holder.
 */
const QUEUED_BEHIND = `
  with recursive queued(pid) as (
    select activity.pid from pg_catalog.pg_stat_activity activity
    where activity.datname = pg_catalog.current_database() and ?::int = any (pg_catalog.pg_blocking_pids(activity.pid))
    union
    select activity.pid from pg_catalog.pg_stat_activity activity
    join queued on queued.pid = any (pg_catalog.pg_blocking_pids(activity.pid))
    where activity.datname = pg_catalog.current_database()
  )
  select count(*)::int as queued from queued
`;

/**
 * Resolves as soon as `count` backends of this database are queued behind the transaction of `holderPid`, directly or
 * through the backends ahead of them, and rejects when they never are. A test that needs its second request to enter the
 * queue after its first waits for this, never for "someone waits on a lock": that poll is satisfied by any other wait of
 * the database, and the second request then starts before the first has taken its place (docs/implementation-checklist.md, 76).
 *
 * `observer` must be a connection outside the transactions under test, autocommit.
 */
export const waitForQueueBehind = async (observer: Observer, holderPid: number, count: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await raw<{ rows: Array<{ queued: number }> }>(observer, QUEUED_BEHIND, [holderPid]);
    if (Number(result.rows[0]?.queued) >= count) return;
    if (Date.now() > deadline) throw new Error(`Fewer than ${count} backend(s) ever queued behind backend ${holderPid}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
