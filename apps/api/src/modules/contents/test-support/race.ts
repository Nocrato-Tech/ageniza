import { backendPid, raw, waitForBackendsBlockedBy } from '@ageniza/database';

import type { ContentsWorld, Reply } from './world.js';

export { backendPid };

/** The pid of a backend that waits on a lock held by `blockerPid`; no sleep decides the order, the lock does. */
export const waitForBackendBlockedBy = async (w: ContentsWorld, blockerPid: number): Promise<number> =>
  (await waitForBackendsBlockedBy(w.getOwner().knex, blockerPid))[0]!;

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
