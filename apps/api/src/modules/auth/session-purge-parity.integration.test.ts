import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';

import { ACTIVE_SESSION_SQL } from './session-validity.js';

// The rule of "a session that still counts" is written twice: `ACTIVE_SESSION_SQL` (TypeScript, read by the guard, the list and the
// revocation) and `app_private.purge_dead_sessions` (SQL, the worker's retention of decision 2026-11-12). Moving it into one database
// function would change how authentication reads a session, beyond the account, so this test ties the two: over every edge of the
// rule, no session the guard's expression calls active is ever deleted by the purge, and no session it calls dead is kept when it has
// been dead for more than the retention.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const DAY_MS = 86_400_000;
const NOW = Date.now();
const ago = (ms: number): Date => new Date(NOW - ms);
const ahead = (ms: number): Date => new Date(NOW + ms);

let owner: DatabaseClient;
let application: DatabaseClient;
const users: string[] = [];

interface Seeded {
  readonly id: string;
  readonly label: string;
  readonly deadForMoreThanRetention: boolean;
}

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await owner.knex('auth.user').whereIn('id', users).delete();
  await application.close();
  await owner.close();
});

describe('the purge of dead sessions and the guard agree on which sessions are active', () => {
  it('deletes no session the guard calls active, and every session dead for more than 30 days, over the edges of the credential rule', async () => {
    const seeded: Seeded[] = [];
    const userStamps: ReadonlyArray<Date | null> = [null, ago(40 * DAY_MS), ago(10 * DAY_MS)];
    const accountStamps: ReadonlyArray<Date | null> = [null, ago(45 * DAY_MS), ago(2 * DAY_MS)];
    const expiries: ReadonlyArray<readonly [string, Date, boolean]> = [
      ['expired 35d', ago(35 * DAY_MS), true],
      ['expired 1d', ago(DAY_MS), false],
      ['expires in 1d', ahead(DAY_MS), false]
    ];

    for (const userStamp of userStamps) {
      for (const accountStamp of accountStamps) {
        const userId = randomUUID();
        users.push(userId);
        await owner.knex('auth.user').insert({
          id: userId, name: 'Parity', email: `parity-${userId}@example.test`, emailVerified: true,
          ...(userStamp === null ? {} : { passwordChangedAt: userStamp })
        });
        if (accountStamp !== null) {
          await owner.knex('auth.account').insert({ id: randomUUID(), accountId: userId, providerId: 'credential', userId, createdAt: ago(90 * DAY_MS), updatedAt: ago(90 * DAY_MS) });
          await owner.knex('auth.account').where({ userId }).update({ passwordChangedAt: accountStamp });
        }
        const stamps = [userStamp, accountStamp].filter((stamp): stamp is Date => stamp !== null);
        const created: Date[] = [ago(50 * DAY_MS), ago(5 * DAY_MS), ...stamps.flatMap((stamp) => [new Date(stamp.getTime() - 1), stamp, new Date(stamp.getTime() + 1)])];

        for (const createdAt of created) {
          for (const [expiryLabel, expiresAt, expiredBeyond] of expiries) {
            const id = randomUUID();
            await owner.knex('auth.session').insert({ id, token: `parity-${randomUUID()}`, userId, createdAt, expiresAt, updatedAt: new Date() });
            const changedAt = Math.max(...stamps.map((stamp) => stamp.getTime()), Number.NEGATIVE_INFINITY);
            const replacedBeyond = createdAt.getTime() <= changedAt && changedAt < NOW - 30 * DAY_MS;
            seeded.push({ id, label: `${expiryLabel} created ${createdAt.toISOString()} stamps ${stamps.map((s) => s.toISOString()).join('/')}`, deadForMoreThanRetention: expiredBeyond || replacedBeyond });
          }
        }
      }
    }

    const { rows } = await owner.knex.raw<{ rows: Array<{ id: string; active: boolean }> }>(
      `select "session".id, (${ACTIVE_SESSION_SQL}) as active from auth."session" "session" where "session".id = any(?::uuid[])`,
      [seeded.map((session) => session.id)]
    );
    const active = new Map(rows.map((row) => [row.id, row.active]));
    expect(active.size).toBe(seeded.length);
    expect(seeded.some((session) => active.get(session.id) === true)).toBe(true);
    expect(seeded.some((session) => active.get(session.id) === false)).toBe(true);

    for (;;) {
      const result = await application.knex.raw<{ rows: Array<{ purged: number }> }>('select app_private.purge_dead_sessions(now(), 1000) as purged');
      if ((result.rows[0]?.purged ?? 0) < 1000) break;
    }

    const left = new Set((await owner.knex('auth.session').whereIn('id', seeded.map((session) => session.id)).select('id')).map((row: { id: string }) => row.id));
    const activeDeleted = seeded.filter((session) => active.get(session.id) === true && !left.has(session.id)).map((session) => session.label);
    const deadKept = seeded.filter((session) => session.deadForMoreThanRetention && left.has(session.id)).map((session) => session.label);
    const deadForMoreButActive = seeded.filter((session) => session.deadForMoreThanRetention && active.get(session.id) === true).map((session) => session.label);

    expect(activeDeleted).toEqual([]);
    expect(deadKept).toEqual([]);
    expect(deadForMoreButActive).toEqual([]);
  });
});
