import { raw, type DatabaseClient } from '@ageniza/database';

import { ACTIVE_SESSION_SQL } from './session-validity.js';

type SessionTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/**
 * Ends every session of a person, in the transaction that took their access away, so the next
 * request of every cookie they hold is a 401 (`cookieCache` is off: Better Auth reads the row on
 * each request). The session is global, so this covers every agency and the portal, not only the
 * one that removed them. `keepSessionId` is the caller's own session, which a removal never ends.
 * Returns how many sessions that were still active were ended (one that expired, or that the guard already refuses, is deleted
 * too, and counts for nothing).
 */
export const revokeUserSessions = async (
  transaction: SessionTransaction,
  userId: string,
  keepSessionId: string
): Promise<number> => {
  const result = await raw<{ rows: Array<{ revoked: number }> }>(
    transaction,
    `
      with ended as (
        delete from auth."session" where "userId" = ?::uuid and id <> ?::uuid
        returning ${ACTIVE_SESSION_SQL} as active
      )
      select count(*) filter (where active)::int as revoked from ended
    `,
    [userId, keepSessionId]
  );
  return result.rows[0]?.revoked ?? 0;
};
