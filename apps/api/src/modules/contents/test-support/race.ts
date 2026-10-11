import { raw, type DatabaseClient } from '@ageniza/database';

import type { ContentsWorld, Reply } from './world.js';

type Holder = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export const backendPid = async (transaction: Holder): Promise<number> => {
  const result = await raw<{ rows: Array<{ pid: number }> }>(transaction, 'select pg_catalog.pg_backend_pid() as pid', []);
  return Number(result.rows[0]?.pid);
};

/** The pid of a backend that waits on a lock held by `blockerPid`; no sleep decides the order, the lock does. */
export const waitForBackendBlockedBy = async (w: ContentsWorld, blockerPid: number): Promise<number> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ pid: number }> }>(w.getOwner().knex, `
      select activity.pid
      from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database()
        and pg_catalog.pg_blocking_pids(activity.pid) @> array[?::int]
      limit 1
    `, [blockerPid]);
    const row = result.rows[0];
    if (row !== undefined) return Number(row.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No backend ever waited on a lock held by ${blockerPid}.`);
};

/** Window 1: the route starts while the archive is uncommitted, waits on the client, and is answered after it commits. */
export const archiveWhileRouteWaits = async (w: ContentsWorld, clientId: string, start: () => Promise<Reply>): Promise<Reply> => {
  const holder = await w.getOwner().knex.transaction();
  let released = false;
  try {
    const locked = await raw<{ rows: Array<{ id: string }> }>(holder, "update public.clients set status = 'archived', archived_at = now() where id = ?::uuid returning id", [clientId]);
    if (locked.rows.length !== 1) throw new Error('The holder did not archive exactly one client.');
    const holderPid = await backendPid(holder);
    const pending = start();
    await waitForBackendBlockedBy(w, holderPid);
    await holder.commit();
    released = true;
    return await pending;
  } finally {
    if (!released) await holder.rollback();
  }
};

/** Window 2: the archive commits right before the statement of the route that moves the row. */
export const archiveBeforeStatement = async (w: ContentsWorld, clientId: string, statement: RegExp, start: () => Promise<Reply>): Promise<Reply> => {
  w.runBeforeStatement(statement, async () => {
    await w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
  });
  try {
    return await start();
  } finally {
    w.clearHook();
  }
};
