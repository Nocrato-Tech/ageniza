import { AUTH_SESSION_LIST_MAX, type AuthActiveSession } from '@ageniza/contracts';
import { raw, type DatabaseClient } from '@ageniza/database';

import { ACTIVE_SESSION_SQL } from './session-revocation.js';
import { describeUserAgent } from './user-agent.js';

type SessionExecutor = DatabaseClient['knex'];

interface SessionRow {
  readonly id: string;
  readonly user_agent: string | null;
  readonly city: string | null;
  readonly last_used_at: Date;
  readonly created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the text can name a session at all: anything else is a session that does not exist, never a different answer. */
export const isSessionId = (value: string): boolean => UUID.test(value);

/**
 * The active sessions of one account, the most recently created first, at most `AUTH_SESSION_LIST_MAX`: the session that asked and
 * the newest others, so the one the person is using is always on the list however many are open. It reads only the columns it
 * shows or turns into a name: the address and the token are never selected, and the `userAgent` goes no further than
 * `describeUserAgent`.
 */
export const listActiveSessions = async (executor: SessionExecutor, userId: string, currentSessionId: string): Promise<AuthActiveSession[]> => {
  const result = await raw<{ rows: SessionRow[] }>(executor, `
    select id, user_agent, city, last_used_at, created_at from (
      (select id, "userAgent" as user_agent, city, "updatedAt" as last_used_at, "createdAt" as created_at
       from auth."session"
       where "userId" = ?::uuid and id = ?::uuid and ${ACTIVE_SESSION_SQL})
      union all
      (select id, "userAgent" as user_agent, city, "updatedAt" as last_used_at, "createdAt" as created_at
       from auth."session"
       where "userId" = ?::uuid and id <> ?::uuid and ${ACTIVE_SESSION_SQL}
       order by "createdAt" desc, id desc
       limit ?)
    ) as shown
    order by created_at desc, id desc
  `, [userId, currentSessionId, userId, currentSessionId, AUTH_SESSION_LIST_MAX - 1]);
  return result.rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    ...describeUserAgent(row.user_agent),
    city: row.city,
    lastUsedAt: row.last_used_at.toISOString(),
    createdAt: row.created_at.toISOString()
  }));
};

/**
 * Ends one active session of the account, other than the one the request holds. It is one statement that names the account, so
 * the session of another account, one that does not exist and one that already ended are the same nothing: it answers `false`
 * for all of them, and the current session is the caller's to refuse before it gets here.
 */
export const revokeOwnSession = async (executor: SessionExecutor, userId: string, currentSessionId: string, sessionId: string): Promise<boolean> => {
  const result = await raw<{ rowCount?: number | null }>(executor, `
    delete from auth."session"
    where id = ?::uuid and "userId" = ?::uuid and id <> ?::uuid and ${ACTIVE_SESSION_SQL}
  `, [sessionId, userId, currentSessionId]);
  return (result.rowCount ?? 0) > 0;
};
