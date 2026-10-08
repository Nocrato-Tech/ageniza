import { raw, type DatabaseClient } from '@ageniza/database';

type SessionTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/**
 * Ends every session of a person, in the transaction that took their access away, so the next
 * request of every cookie they hold is a 401 (`cookieCache` is off: Better Auth reads the row on
 * each request). The session is global, so this covers every agency and the portal, not only the
 * one that removed them. `keepSessionId` is the caller's own session, which a removal never ends.
 * Returns how many sessions were ended.
 */
export const revokeUserSessions = async (
  transaction: SessionTransaction,
  userId: string,
  keepSessionId: string
): Promise<number> => {
  const result = await raw<{ rowCount?: number | null }>(
    transaction,
    'delete from auth."session" where "userId" = ?::uuid and id <> ?::uuid',
    [userId, keepSessionId]
  );
  return result.rowCount ?? 0;
};
