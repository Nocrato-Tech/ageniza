import { randomBytes } from 'node:crypto';

import { raw, type DatabaseClient } from '@ageniza/database';

/**
 * The sessions of one demo user, so the list of sessions of the account, "Sair de todas" and the daily cleanup have something to work on:
 * three active ones on different devices (two with the approximate city that the creation of a session records, one made where no city
 * arrived) and one that expired more than 30 days ago, which the cleanup deletes. The tokens are random and belong to no cookie, so they
 * sign nobody in; the seed deletes a user's sessions whenever it rotates the password, so a rerun recreates the same four.
 *
 * A session made at or before the last replacement of the credential is not active (`SESSION_AFTER_CREDENTIAL_SQL`), and the seed has
 * just replaced it: an active session is dated the later of "hours ago" and a few milliseconds after that replacement.
 */

const SESSIONS = [
  { city: 'São Paulo', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', ipAddress: '203.0.113.10', createdHoursAgo: 2, lastUsedMinutesAgo: 3, expired: false },
  { city: null, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', ipAddress: '203.0.113.20', createdHoursAgo: 52, lastUsedMinutesAgo: 95, expired: false },
  { city: 'Campinas', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', ipAddress: '203.0.113.30', createdHoursAgo: 120, lastUsedMinutesAgo: 600, expired: false },
  { city: 'Curitiba', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', ipAddress: '203.0.113.40', createdHoursAgo: 65 * 24, lastUsedMinutesAgo: 36 * 24 * 60, expired: true }
] as const;

export const ensureDemoSessions = async (database: DatabaseClient, userId: string): Promise<void> => {
  await database.transaction(async (transaction) => {
    await raw(transaction, 'delete from auth."session" where "userId" = ?::uuid', [userId]);
    for (const [index, session] of SESSIONS.entries()) {
      await raw(transaction, `
        with credential as (
          select greatest(
            coalesce((select person."passwordChangedAt" from auth."user" person where person.id = ?::uuid), '-infinity'::timestamptz),
            coalesce((select max(account."passwordChangedAt") from auth."account" account where account."userId" = ?::uuid), '-infinity'::timestamptz)
          ) as changed_at
        ), moment as (
          select case
            when ?::boolean then now() - make_interval(hours => ?::integer)
            else least(now(), greatest(now() - make_interval(hours => ?::integer), credential.changed_at + make_interval(secs => 0.001 * ?::integer)))
          end as created_at
          from credential
        )
        insert into auth."session" (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", city)
        select gen_random_uuid(),
          case when ?::boolean then now() - interval '35 days' else now() + interval '30 days' end,
          ?, moment.created_at, greatest(moment.created_at, now() - make_interval(mins => ?::integer)), ?, ?, ?::uuid, ?
        from moment
      `, [
        userId, userId, session.expired, session.createdHoursAgo, session.createdHoursAgo, index + 1,
        session.expired, randomBytes(32).toString('base64url'), session.lastUsedMinutesAgo, session.ipAddress, session.userAgent, userId, session.city
      ]);
    }
  });
};
