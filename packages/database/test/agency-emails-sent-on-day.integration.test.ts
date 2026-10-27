import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issue #727: the daily e-mail count of an agency is a function of an instant, so the cut of the day is tested at fixed
// instants instead of against the database clock. São Paulo is UTC-3 all year (no daylight saving since 2019).
const w = createContentWorld('agency-emails-sent-on-day');

const DAILY_LIMIT = { code: 'A0095' };

const extraUsers: string[] = [];
const extraAgencies: string[] = [];

const owner = (): Knex => w.getOwner().knex;

const person = async (): Promise<string> => {
  const id = randomUUID();
  extraUsers.push(id);
  await owner()('auth.user').insert({ id, name: `Pessoa ${id.slice(0, 8)}`, email: `${id}@agency-emails-sent-on-day.test`, emailVerified: true });
  return id;
};

const agencyWithClient = async (): Promise<{ creator: string; agencyId: string; clientId: string }> => {
  const creator = await person();
  const agencyId = await w.asUser(creator, async (transaction) => {
    const { rows } = await transaction.raw<{ rows: Array<{ id: string }> }>('select app_private.create_trial_agency(?) as id', [`Agência ${randomUUID().slice(0, 8)}`]);
    return rows[0]!.id;
  });
  extraAgencies.push(agencyId);
  await owner()('agencies').where({ id: agencyId }).update({ plan: 'isenta', trial_ends_at: null });
  const clientId = await w.asUser(creator, async (transaction) => {
    const [row] = await transaction('clients').insert({ agency_id: agencyId, name: `Cliente ${randomUUID().slice(0, 8)}` }).returning('id');
    return row.id as string;
  });
  return { creator, agencyId, clientId };
};

/** Rows the owner writes as if sent at `at`, without going through the limit. */
const invitationsAt = async (agencyId: string, clientId: string, actor: string, at: ReadonlyArray<string | Date>): Promise<void> => {
  await owner()('invitations').insert(
    at.map((created_at) => ({
      agency_id: agencyId, purpose: 'client_invite', client_id: clientId, email: `antes-${randomUUID()}@agency-emails-sent-on-day.test`,
      token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: actor, created_at
    }))
  );
};

const eventsAt = async (agencyId: string, actor: string, action: string, at: ReadonlyArray<string>): Promise<void> => {
  await owner()('audit.events').insert(at.map((occurred_at) => ({ agency_id: agencyId, action, actor_user_id: actor, occurred_at })));
};

const sentOnDay = async (agencyId: string, at: string): Promise<number> => {
  const { rows } = await owner().raw<{ rows: Array<{ n: string }> }>('select app_private.agency_emails_sent_on_day(?, ?::timestamptz) as n', [agencyId, at]);
  return Number(rows[0]!.n);
};

beforeAll(async () => {
  await w.setup();
});

afterAll(async () => {
  const knex = owner();
  if (extraAgencies.length > 0) {
    const clientIds = (await knex('clients').whereIn('agency_id', extraAgencies).select('id')).map((row) => row.id as string);
    await knex('invitations').whereIn('agency_id', extraAgencies).delete();
    await knex('media_folders').whereIn('client_id', clientIds).delete();
    await knex('clients').whereIn('id', clientIds).delete();
    await knex('agency_storage_quotas').whereIn('agency_id', extraAgencies).delete();
    await knex('agency_memberships').whereIn('agency_id', extraAgencies).delete();
    await knex('agencies').whereIn('id', extraAgencies).delete();
    await knex.raw('delete from audit.events where agency_id = any(?::uuid[])', [extraAgencies]);
  }
  await knex('legal_acceptances').whereIn('user_id', extraUsers).delete();
  await knex('auth.user').whereIn('id', extraUsers).delete();
  await w.teardown();
});

describe('the e-mails an agency sent on the day of São Paulo that holds an instant (issue #727)', () => {
  // The day of 2026-03-10 in São Paulo runs from 2026-03-10T03:00:00Z to 2026-03-11T02:59:59Z.
  const DAY = {
    afterMidnight: '2026-03-10T00:30:00-03:00',
    noon: '2026-03-10T12:00:00-03:00',
    beforeMidnight: '2026-03-10T23:30:00-03:00'
  };

  it('counts together what was sent at 00:30 and at 23:30, whatever instant of that day asks', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient();
    await invitationsAt(agencyId, clientId, creator, [DAY.afterMidnight, DAY.beforeMidnight]);
    for (const asked of Object.values(DAY)) expect(await sentOnDay(agencyId, asked)).toBe(2);
  });

  it('does not count what was sent at 23:59 of the day before, nor the first minute of the day after', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient();
    await invitationsAt(agencyId, clientId, creator, ['2026-03-09T23:59:00-03:00', DAY.afterMidnight, '2026-03-11T00:00:00-03:00']);
    expect(await sentOnDay(agencyId, DAY.afterMidnight)).toBe(1);
    expect(await sentOnDay(agencyId, DAY.beforeMidnight)).toBe(1);
    expect(await sentOnDay(agencyId, '2026-03-09T12:00:00-03:00')).toBe(1);
  });

  it('turns the day at 00:00 of São Paulo, which is 03:00 UTC, and not at 00:00 UTC', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient();
    // 02:59:59Z is 23:59:59 of the 9th in São Paulo and 03:00:00Z is 00:00:00 of the 10th: one UTC day, two days there.
    await invitationsAt(agencyId, clientId, creator, ['2026-03-10T02:59:59Z', '2026-03-10T03:00:00Z']);
    expect(await sentOnDay(agencyId, '2026-03-10T02:59:59Z')).toBe(1);
    expect(await sentOnDay(agencyId, '2026-03-10T03:00:00Z')).toBe(1);
    // 22:00 in São Paulo is already 01:00 of the 11th in UTC, and still the day of the noon before it.
    await invitationsAt(agencyId, clientId, creator, [DAY.noon, '2026-03-10T22:00:00-03:00']);
    expect(await sentOnDay(agencyId, DAY.noon)).toBe(3);
    expect(await sentOnDay(agencyId, '2026-03-11T04:00:00Z')).toBe(0);
  });

  it('reads the welcome e-mails of the audit events as well, by the same day, and only those of the agency', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient();
    const other = await agencyWithClient();
    await invitationsAt(agencyId, clientId, creator, [DAY.noon]);
    await eventsAt(agencyId, creator, 'client_member.added', [DAY.afterMidnight, '2026-03-09T23:59:00-03:00']);
    await eventsAt(agencyId, creator, 'client_member.readded', [DAY.beforeMidnight]);
    await eventsAt(agencyId, creator, 'client_member.removed', [DAY.noon]);
    await invitationsAt(other.agencyId, other.clientId, other.creator, [DAY.noon]);
    expect(await sentOnDay(agencyId, DAY.noon)).toBe(3);
  });

  it('is not callable by the application role', async () => {
    const { creator, agencyId } = await agencyWithClient();
    await expect(
      w.asUser(creator, (transaction) => transaction.raw('select app_private.agency_emails_sent_on_day(?, now())', [agencyId]))
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the daily limit that the invitations trigger applies (issue #727)', () => {
  const todayAtSaoPaulo = async (time: string): Promise<Date> => {
    const { rows } = await owner().raw<{ rows: Array<{ at: Date }> }>(
      "select ((now() at time zone 'America/Sao_Paulo')::date + ?::time) at time zone 'America/Sao_Paulo' as at",
      [time]
    );
    return rows[0]!.at;
  };
  const portalInvite = (actor: string, agencyId: string, clientId: string) =>
    w.asUser(actor, async (transaction) => {
      const [row] = await transaction('invitations')
        .insert({
          agency_id: agencyId, purpose: 'client_invite', client_id: clientId, email: `portal-${randomUUID()}@agency-emails-sent-on-day.test`,
          token_hash: `hash-${randomUUID()}`, expires_at: new Date(Date.now() + 86_400_000), invited_by_user_id: actor
        })
        .returning('id');
      return row.id as string;
    });

  it('counts the day of São Paulo as a whole: its first and its last minute, and not the last minute of the day before', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient();
    await owner()('agencies').where({ id: agencyId }).update({ daily_email_limit: 3 });
    const yesterdayLastMinute = new Date((await todayAtSaoPaulo('00:00')).getTime() - 60_000);
    await invitationsAt(agencyId, clientId, creator, [yesterdayLastMinute, yesterdayLastMinute, yesterdayLastMinute, yesterdayLastMinute]);
    await invitationsAt(agencyId, clientId, creator, [await todayAtSaoPaulo('00:00'), await todayAtSaoPaulo('23:59')]);
    await expect(portalInvite(creator, agencyId, clientId)).resolves.toEqual(expect.any(String));
    await expect(portalInvite(creator, agencyId, clientId)).rejects.toMatchObject(DAILY_LIMIT);
  });

  it('asks the same count as the function of the day does at now()', async () => {
    const { creator, agencyId, clientId } = await agencyWithClient();
    await invitationsAt(agencyId, clientId, creator, [await todayAtSaoPaulo('00:00'), await todayAtSaoPaulo('12:00'), await todayAtSaoPaulo('23:59')]);
    await eventsAt(agencyId, creator, 'client_member.added', [(await todayAtSaoPaulo('06:00')).toISOString()]);
    const { rows } = await owner().raw<{ rows: Array<{ today: string; onDay: string }> }>(
      'select app_private.agency_emails_today(?) as today, app_private.agency_emails_sent_on_day(?, now()) as "onDay"',
      [agencyId, agencyId]
    );
    expect(Number(rows[0]!.today)).toBe(4);
    expect(Number(rows[0]!.onDay)).toBe(4);
  });

  it('is defined as the function of the day at now(), with no count of its own', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ definition: string }> }>(
      "select pg_catalog.pg_get_functiondef('app_private.agency_emails_today(uuid)'::regprocedure) as definition"
    );
    expect(rows[0]!.definition).toMatch(/app_private\.agency_emails_sent_on_day\(\s*p_agency_id\s*,\s*pg_catalog\.now\(\)\s*\)/);
    expect(rows[0]!.definition).not.toMatch(/\binvitations\b|audit\.events/);
  });
});
