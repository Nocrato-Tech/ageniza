import { randomBytes } from 'node:crypto';

import { raw, type DatabaseClient } from '@ageniza/database';

/**
 * Two sessions already open for one demo user, so the list of active sessions of the account has something to show: one with the
 * approximate city the creation of a session records, one without (a session made where no city arrived). The tokens are random and
 * belong to no cookie, so they sign nobody in; the seed deletes a user's sessions whenever it rotates the password, so a rerun
 * recreates the same two instead of adding more.
 */

const SESSIONS = [
  { city: 'São Paulo', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', ipAddress: '203.0.113.10', createdHoursAgo: 2 },
  { city: null, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', ipAddress: '203.0.113.20', createdHoursAgo: 52 }
] as const;

export const ensureDemoSessions = async (database: DatabaseClient, userId: string): Promise<void> => {
  await database.transaction(async (transaction) => {
    await raw(transaction, 'delete from auth."session" where "userId" = ?::uuid', [userId]);
    for (const session of SESSIONS) {
      await raw(transaction, `
        insert into auth."session" (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", city)
        values (gen_random_uuid(), now() + interval '30 days', ?, now() - make_interval(hours => ?::integer), now() - make_interval(hours => ?::integer), ?, ?, ?::uuid, ?)
      `, [randomBytes(32).toString('base64url'), session.createdHoursAgo, session.createdHoursAgo, session.ipAddress, session.userAgent, userId, session.city]);
    }
  });
};
