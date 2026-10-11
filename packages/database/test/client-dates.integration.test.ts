import { createHash, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, databaseErrorCode, raw, type DatabaseClient, resolveIntegrationDatabaseUrls } from '../src/index.js';
import { keepsItsOwnDay } from './support/own-day-scan.js';

// Issues #131, #133 and #373. "Today" of a contract is the day in America/Sao_Paulo, and `now()` cannot be
// pinned, so the day is computed by `app_private.sao_paulo_date(instant)` and these tests call it with
// fixed instants. Between 21:00 and 24:00 in Brasília the Brasília date and the UTC date differ, which
// is the only place the mutation Sao_Paulo -> UTC is visible.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await application?.close();
  await owner?.close();
});

const dayOf = async (instant: string, sessionTimeZone?: string): Promise<string> => {
  const transaction = await getOwner().knex.transaction();
  try {
    if (sessionTimeZone !== undefined) await raw(transaction, "select set_config('timezone', ?, true)", [sessionTimeZone]);
    const result = await raw<{ rows: readonly { day: string }[] }>(transaction, 'select app_private.sao_paulo_date(?::timestamptz)::text as day', [instant]);
    return result.rows[0]!.day;
  } finally {
    await transaction.rollback();
  }
};

describe('app_private.sao_paulo_date', () => {
  it('reads the Brasília day at 22:00 there, when UTC is already on the next day', async () => {
    // 2026-10-07 22:00 in Brasília is 2026-10-08 01:00 UTC.
    await expect(dayOf('2026-10-08T01:00:00Z')).resolves.toBe('2026-10-07');
    await expect(dayOf('2026-10-08T00:00:00Z')).resolves.toBe('2026-10-07');
    await expect(dayOf('2026-10-08T02:30:00Z')).resolves.toBe('2026-10-07');
  });

  it('turns the day exactly at Brasília midnight, 03:00 UTC', async () => {
    await expect(dayOf('2026-10-08T02:59:59.999Z')).resolves.toBe('2026-10-07');
    await expect(dayOf('2026-10-08T03:00:00Z')).resolves.toBe('2026-10-08');
    await expect(dayOf('2026-01-01T02:59:59Z')).resolves.toBe('2025-12-31');
    await expect(dayOf('2026-01-01T03:00:00Z')).resolves.toBe('2026-01-01');
  });

  it('reads the Brasília day in the morning, when it agrees with UTC', async () => {
    await expect(dayOf('2026-10-07T15:00:00Z')).resolves.toBe('2026-10-07');
    await expect(dayOf('2026-10-07T03:00:00Z')).resolves.toBe('2026-10-07');
  });

  it('keeps a leap day and a month end on their Brasília side', async () => {
    await expect(dayOf('2028-03-01T02:00:00Z')).resolves.toBe('2028-02-29');
    await expect(dayOf('2026-11-01T02:00:00Z')).resolves.toBe('2026-10-31');
  });

  it('does not depend on the time zone of the session', async () => {
    for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tokyo']) {
      await expect(dayOf('2026-10-08T01:00:00Z', zone), zone).resolves.toBe('2026-10-07');
      await expect(dayOf('2026-10-08T03:00:00Z', zone), zone).resolves.toBe('2026-10-08');
    }
  });

  it('can be called by the application role itself, at a fixed instant', async () => {
    const result = await raw<{ rows: readonly { day: string }[] }>(application!.knex, "select app_private.sao_paulo_date('2026-10-08T01:00:00Z'::timestamptz)::text as day", []);
    expect(result.rows[0]!.day).toBe('2026-10-07');
  });

  it('is open to the application role and closed to PUBLIC, with a fixed search_path', async () => {
    const { rows } = await raw<{ rows: readonly { app: boolean; public_role: boolean; fixed_path: boolean }[] }>(getOwner().knex, `
      select
        has_function_privilege('ageniza_app', 'app_private.sao_paulo_date(timestamptz)', 'execute') as app,
        exists (
          select 1
          from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
          where p.oid = 'app_private.sao_paulo_date(timestamptz)'::regprocedure and acl.grantee = 0
        ) as public_role,
        coalesce((select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p
                  where p.oid = 'app_private.sao_paulo_date(timestamptz)'::regprocedure), false) as fixed_path
    `, []);
    expect(rows[0]).toEqual({ app: true, public_role: false, fixed_path: true });
  });
});

describe('the functions that ask for today', () => {
  const definitionOf = async (signature: string): Promise<string> => {
    const { rows } = await raw<{ rows: readonly { definition: string }[] }>(getOwner().knex, 'select pg_catalog.pg_get_functiondef(?::regprocedure) as definition', [signature]);
    return rows[0]!.definition;
  };

  // The one thing the catalog can say is that no function keeps a clock of its own: the day comes
  // from the function above, whose fixed-instant tests are the ones that turn red when the zone
  // changes. A function added later that works the day out inline is the same defect again, so the
  // catalog is read instead of listing the functions known today: functions and procedures, views,
  // the WHEN of a trigger, policies, constraints and column defaults. The reading is by form
  // (`support/own-day-scan.ts`, with a probe for each form in `own-day-scan.test.ts`) and does not
  // prove absence. The probes below prove that each class of object is read and that the catalog's own
  // text of a form (the parentheses and casts it normalises) is still recognised.
  const objectsWithAZoneOfTheirOwn = async (executor: Pick<DatabaseClient['knex'], 'raw'>): Promise<readonly string[]> => {
    const { rows } = await raw<{ rows: readonly { object: string; definition: string | null }[] }>(executor, `
      select p.pronamespace::regnamespace || '.' || p.proname as object, pg_catalog.pg_get_functiondef(p.oid) as definition
      from pg_catalog.pg_proc p
      where p.prokind in ('f', 'p')
        and p.pronamespace::regnamespace::text in ('public', 'app_private', 'audit', 'auth')
        and p.oid <> 'app_private.sao_paulo_date(timestamptz)'::regprocedure
      union all
      select c.oid::regclass || case c.relkind when 'm' then ' materialized view' else ' view' end, pg_catalog.pg_get_viewdef(c.oid)
      from pg_catalog.pg_class c
      where c.relkind in ('v', 'm')
        and c.relnamespace::regnamespace::text in ('public', 'app_private', 'audit', 'auth')
      union all
      select trg.tgrelid::regclass || ' trigger ' || trg.tgname, pg_catalog.pg_get_triggerdef(trg.oid)
      from pg_catalog.pg_trigger trg
      join pg_catalog.pg_class rel on rel.oid = trg.tgrelid
      where not trg.tgisinternal
        and rel.relnamespace::regnamespace::text in ('public', 'app_private', 'audit', 'auth')
      union all
      select pol.polrelid::regclass || ' policy ' || pol.polname,
        coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
      from pg_catalog.pg_policy pol
      union all
      select con.conrelid::regclass || ' constraint ' || con.conname, pg_catalog.pg_get_constraintdef(con.oid)
      from pg_catalog.pg_constraint con
      union all
      select def.adrelid::regclass || ' default ' || att.attname, pg_catalog.pg_get_expr(def.adbin, def.adrelid)
      from pg_catalog.pg_attrdef def
      join pg_catalog.pg_attribute att on att.attrelid = def.adrelid and att.attnum = def.adnum
    `, []);
    return rows.filter((row) => keepsItsOwnDay(row.definition ?? '')).map((row) => row.object);
  };

  it('reads at least one object of each class it is meant to police', async () => {
    const { rows } = await raw<{ rows: readonly { functions: number; triggers: number; policies: number; constraints: number; defaults: number }[] }>(getOwner().knex, `
      select
        (select count(*) from pg_catalog.pg_proc p where p.prokind = 'f' and p.pronamespace::regnamespace::text = 'app_private')::int as functions,
        (select count(*) from pg_catalog.pg_trigger trg where not trg.tgisinternal)::int as triggers,
        (select count(*) from pg_catalog.pg_policy)::int as policies,
        (select count(*) from pg_catalog.pg_constraint)::int as constraints,
        (select count(*) from pg_catalog.pg_attrdef)::int as defaults
    `, []);
    for (const [kind, count] of Object.entries(rows[0]!)) expect(count, kind).toBeGreaterThan(0);
  });

  it('leaves no function, procedure, view, trigger, policy, constraint or default of the application schemas with a time zone of its own', async () => {
    await expect(objectsWithAZoneOfTheirOwn(getOwner().knex)).resolves.toEqual([]);
  });

  // Each probe is created inside a transaction that is rolled back, and the scan must find exactly it.
  const findsProbe = async (create: string, name: string): Promise<readonly string[]> => {
    const transaction = await getOwner().knex.transaction();
    try {
      await raw(transaction, create, []);
      return (await objectsWithAZoneOfTheirOwn(transaction)).filter((object) => object.includes(name));
    } finally {
      await transaction.rollback();
    }
  };

  const functionProbe = (body: string): string =>
    `create function app_private.zone_probe() returns void language plpgsql stable set search_path = '' as $probe$ begin perform ${body}; end $probe$`;

  it.each([
    ['at time zone', "pg_catalog.now() at time zone 'America/Sao_Paulo'"],
    ['current_date', 'current_date'],
    ['localtimestamp', 'localtimestamp'],
    ['localtime', 'localtime'],
    ['date_trunc', "pg_catalog.date_trunc('day', pg_catalog.now())"],
    ['timezone()', "pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())"],
    ['now()::date', 'pg_catalog.now()::pg_catalog.date'],
    ['(now())::date', '(pg_catalog.now())::pg_catalog.date'],
    ['cast(now() as date)', 'cast(pg_catalog.now() as pg_catalog.date)'],
    ['current_timestamp::date', 'current_timestamp::pg_catalog.date'],
    ['clock_timestamp()::date', 'pg_catalog.clock_timestamp()::pg_catalog.date'],
    ['transaction_timestamp()::date', 'pg_catalog.transaction_timestamp()::pg_catalog.date'],
    ['date(now())', 'pg_catalog.date(pg_catalog.now())'],
    ['extract from now()', 'extract(day from pg_catalog.now())'],
    ['date_part on now()', "pg_catalog.date_part('day', pg_catalog.now())"],
    ['to_char of now()', "pg_catalog.to_char(pg_catalog.now(), 'YYYY-MM-DD')"],
    ['now() shifted by hand, then cast', "(pg_catalog.now() - interval '3 hours')::pg_catalog.date"],
    ['now()::timestamp::date', 'pg_catalog.now()::pg_catalog.timestamp::pg_catalog.date'],
    ['now()::timestamptz::date', 'pg_catalog.now()::pg_catalog.timestamptz::pg_catalog.date'],
    ['left(now()::text, 10)', 'pg_catalog.left(pg_catalog.now()::pg_catalog.text, 10)'],
    ['date_bin on now()', "pg_catalog.date_bin('1 day', pg_catalog.now(), timestamptz '2020-01-01 00:00:00+00')"],
    ["'today'::date", "'today'::pg_catalog.date"]
  ])('the catalog scan finds a function that works the day out with %s', async (_form, body) => {
    await expect(findsProbe(functionProbe(body), 'zone_probe')).resolves.toEqual(['app_private.zone_probe']);
  });

  it('the catalog scan finds a procedure that works the day out', async () => {
    await expect(findsProbe(
      "create procedure app_private.zone_probe() language plpgsql set search_path = '' as $probe$ begin perform current_date; end $probe$",
      'zone_probe'
    )).resolves.toEqual(['app_private.zone_probe']);
  });

  it('the catalog scan finds a view and a materialized view that work the day out', async () => {
    const found = await findsProbe(`
      create view app_private.zone_probe_view as select (pg_catalog.now() - interval '3 hours')::pg_catalog.date as today;
      create materialized view app_private.zone_probe_materialized as select pg_catalog.now()::pg_catalog.date as today;
    `, 'zone_probe');
    expect([...found].sort()).toEqual(['app_private.zone_probe_materialized materialized view', 'app_private.zone_probe_view view']);
  });

  it('the catalog scan finds the WHEN of a trigger that works the day out', async () => {
    const found = await findsProbe(`
      create table app_private.zone_probe_table (happened_on date not null);
      create function app_private.zone_probe_noop() returns trigger language plpgsql set search_path = '' as $probe$ begin return new; end $probe$;
      create trigger zone_probe_trigger before update on app_private.zone_probe_table
        for each row when (new.happened_on > (pg_catalog.now() - interval '3 hours')::pg_catalog.date)
        execute function app_private.zone_probe_noop();
    `, 'zone_probe');
    expect(found).toEqual(['app_private.zone_probe_table trigger zone_probe_trigger']);
  });

  it('the catalog scan finds a policy, a constraint and a column default that work the day out inline', async () => {
    const found = await findsProbe(`
      create table app_private.zone_probe_table (
        happened_on date not null default (pg_catalog.now())::pg_catalog.date,
        constraint zone_probe_not_future check (happened_on <= (pg_catalog.now())::pg_catalog.date)
      );
      alter table app_private.zone_probe_table enable row level security;
      create policy zone_probe_policy on app_private.zone_probe_table for select using (happened_on = (pg_catalog.now())::pg_catalog.date);
    `, 'zone_probe_table');
    expect([...found].sort()).toEqual([
      'app_private.zone_probe_table constraint zone_probe_not_future',
      'app_private.zone_probe_table default happened_on',
      'app_private.zone_probe_table policy zone_probe_policy'
    ]);
  });

  it.each([
    ['the pure function of the clock', 'app_private.sao_paulo_date(pg_catalog.now())'],
    ['a plain timestamp from the clock', 'pg_catalog.now()'],
    ['a shifted timestamp from the clock', "pg_catalog.now() - interval '1 day'"],
    ['a text that only mentions a zone', "'timezone, current and local'"],
    ['date_trunc of a constant date', "pg_catalog.date_trunc('month', date '2020-01-15')"],
    ['timezone() of constants', "pg_catalog.timezone('UTC', timestamptz '2020-01-01 00:00:00+00')"],
    ['the age of a row in seconds', "extract(epoch from pg_catalog.now() - timestamptz '2020-01-01 00:00:00+00')"]
  ])('the catalog scan leaves alone %s', async (_form, body) => {
    await expect(findsProbe(functionProbe(body), 'zone_probe')).resolves.toEqual([]);
  });

  it.each([
    'app_private.archive_due_client(uuid)',
    'app_private.due_client_ids()',
    'app_private.set_client_closing_date(uuid, date)',
    'app_private.accept_legal_document(text, text)',
    'app_private.accept_invitation(text, uuid, text, text, boolean)'
  ])('%s asks sao_paulo_date for today and names no time zone of its own', async (signature) => {
    const definition = await definitionOf(signature);
    expect(definition).toContain("app_private.sao_paulo_date(pg_catalog.now())");
    expect(definition).not.toMatch(/at time zone/i);
    expect(definition).not.toMatch(/Sao_Paulo'/);
    expect(definition).not.toMatch(/current_date|localtimestamp/i);
  });

  it.each([
    'app_private.archive_due_clients()',
    'app_private.archive_due_client(uuid)',
    'app_private.due_client_ids()',
    'app_private.set_client_closing_date(uuid, date)',
    'app_private.accept_legal_document(text, text)',
    'app_private.accept_invitation(text, uuid, text, text, boolean)'
  ])('%s is still security definer, with a fixed search_path, closed to PUBLIC and open to the application role', async (signature) => {
    const { rows } = await raw<{ rows: readonly { definer: boolean; fixed_path: boolean; app: boolean; public_role: boolean }[] }>(getOwner().knex, `
      select
        p.prosecdef as definer,
        coalesce(p.proconfig @> array['search_path=""'], false) as fixed_path,
        has_function_privilege('ageniza_app', p.oid, 'execute') as app,
        exists (
          select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl where acl.grantee = 0
        ) as public_role
      from pg_catalog.pg_proc p
      where p.oid = ?::regprocedure
    `, [signature]);
    expect(rows[0], signature).toEqual({ definer: true, fixed_path: true, app: true, public_role: false });
  });
});

// `now()` cannot be pinned, but the day is a function of it: inside a transaction that is rolled back,
// `sao_paulo_date` is replaced by a stand-in that answers a fixed day whatever the instant it is given,
// and records that instant. What each function does with the day it is told is then a fact of its own
// behaviour, and the day is far in the past, so a function that computes today in any zone of its own
// (UTC, Brasília, the session's) disagrees with the pinned one and the test goes red.
describe('what accept_legal_document and accept_invitation do with the day sao_paulo_date answers', () => {
  const PINNED_DAY = '2020-06-15';
  const NEXT_DAY = '2020-06-16';

  type Attempt<TValue> = { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly code: string | undefined; readonly message: string };

  interface Scenario {
    readonly transaction: Knex.Transaction;
    readonly userId: string;
    readonly token: string;
    readonly attempt: <TValue>(work: () => Promise<TValue>) => Promise<Attempt<TValue>>;
    readonly askedWithTheClock: () => Promise<boolean>;
  }

  const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

  const inPinnedDay = async (scenario: (context: Scenario) => Promise<void>): Promise<void> => {
    const transaction = await getOwner().knex.transaction();
    try {
      const userId = randomUUID();
      const token = `token-${userId}`;
      await raw(transaction, 'select app_private.bind_actor(?)', [userId]);
      await transaction('auth.user').insert({ id: userId, name: 'Pinned day', email: `${userId}@example.test`, emailVerified: true });
      const agencyId = randomUUID();
      await transaction('agencies').insert({ id: agencyId, name: `Pinned day ${agencyId}` });
      const role = await transaction('roles').whereNull('agency_id').where({ key: 'production' }).first<{ id: string }>('id');
      await transaction('invitations').insert({
        agency_id: agencyId,
        purpose: 'collaborator_invite',
        email: `${userId}@example.test`,
        role_id: role!.id,
        token_hash: hashOf(token),
        expires_at: new Date(Date.now() + 86_400_000)
      });
      await raw(transaction, `
        create or replace function app_private.sao_paulo_date(p_instant timestamptz) returns date
        language plpgsql volatile set search_path = '' as $stand_in$
        begin
          perform pg_catalog.set_config('test.asked_instant', p_instant::text, true);
          return date '${PINNED_DAY}';
        end
        $stand_in$
      `, []);

      let savepoints = 0;
      const attempt = async <TValue>(work: () => Promise<TValue>): Promise<Attempt<TValue>> => {
        const name = `attempt_${savepoints += 1}`;
        await raw(transaction, `savepoint ${name}`, []);
        try {
          return { ok: true, value: await work() };
        } catch (error) {
          return { ok: false, code: databaseErrorCode(error), message: error instanceof Error ? error.message : String(error) };
        } finally {
          await raw(transaction, `rollback to savepoint ${name}`, []);
        }
      };

      const askedWithTheClock = async (): Promise<boolean> => {
        const { rows } = await raw<{ rows: readonly { asked: boolean }[] }>(transaction, "select pg_catalog.current_setting('test.asked_instant')::timestamptz = pg_catalog.now() as asked", []);
        return rows[0]!.asked;
      };

      await scenario({ transaction, userId, token, attempt, askedWithTheClock });
    } finally {
      await transaction.rollback();
    }
  };

  const acceptLegal = async (transaction: Knex.Transaction, version: string): Promise<boolean> => {
    const { rows } = await raw<{ rows: readonly { recorded: boolean }[] }>(transaction, "select app_private.accept_legal_document('terms', ?) as recorded", [version]);
    return rows[0]!.recorded;
  };

  const acceptInvitation = async (context: Scenario, terms: string, privacy: string): Promise<string> => {
    const { rows } = await raw<{ rows: readonly { status: string }[] }>(
      context.transaction,
      'select status from app_private.accept_invitation(?, ?, ?, ?, true)',
      [hashOf(context.token), context.userId, terms, privacy]
    );
    return rows[0]!.status;
  };

  it('accept_legal_document accepts the day the function answers and refuses the next one, asking it about the clock', async () => {
    await inPinnedDay(async ({ transaction, attempt, askedWithTheClock }) => {
      const today = await attempt(async () => {
        const recorded = await acceptLegal(transaction, PINNED_DAY);
        return { recorded, askedWithTheClock: await askedWithTheClock() };
      });
      expect(today).toEqual({ ok: true, value: { recorded: true, askedWithTheClock: true } });

      const tomorrow = await attempt(() => acceptLegal(transaction, NEXT_DAY));
      expect(tomorrow).toEqual({ ok: false, code: 'A0031', message: expect.stringMatching(/The version is in the future.$/) });

      const yesterday = await attempt(() => acceptLegal(transaction, '2020-06-14'));
      expect(yesterday).toEqual({ ok: true, value: true });
    });
  });

  it('accept_invitation accepts the day the function answers and refuses a terms or privacy version after it, asking it about the clock', async () => {
    await inPinnedDay(async (context) => {
      const today = await context.attempt(async () => {
        const status = await acceptInvitation(context, PINNED_DAY, PINNED_DAY);
        return { status, askedWithTheClock: await context.askedWithTheClock() };
      });
      expect(today).toEqual({ ok: true, value: { status: 'accepted', askedWithTheClock: true } });

      const futureTerms = await context.attempt(() => acceptInvitation(context, NEXT_DAY, PINNED_DAY));
      expect(futureTerms).toEqual({ ok: false, code: 'A0031', message: expect.stringMatching(/The version is in the future.$/) });

      const futurePrivacy = await context.attempt(() => acceptInvitation(context, PINNED_DAY, NEXT_DAY));
      expect(futurePrivacy).toEqual({ ok: false, code: 'A0031', message: expect.stringMatching(/The version is in the future.$/) });
    });
  });
});
