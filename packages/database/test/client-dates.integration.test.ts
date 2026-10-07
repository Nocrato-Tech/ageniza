import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, raw, type DatabaseClient } from '../src/index.js';

// Issues #131 and #133. "Today" of a contract is the day in America/Sao_Paulo, and `now()` cannot be
// pinned, so the day is computed by `app_private.sao_paulo_date(instant)` and these tests call it with
// fixed instants. Between 21:00 and 24:00 in Brasília the Brasília date and the UTC date differ, which
// is the only place the mutation Sao_Paulo -> UTC is visible.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

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

describe('the closing-date functions', () => {
  const definitionOf = async (signature: string): Promise<string> => {
    const { rows } = await raw<{ rows: readonly { definition: string }[] }>(getOwner().knex, 'select pg_catalog.pg_get_functiondef(?::regprocedure) as definition', [signature]);
    return rows[0]!.definition;
  };

  // `now()` cannot be pinned in a test, so the one thing a test can pin is that neither function
  // keeps a clock of its own: both ask the function above, whose fixed-instant tests are the ones
  // that turn red when the zone changes.
  it.each([
    'app_private.archive_due_clients()',
    'app_private.set_client_closing_date(uuid, date)'
  ])('%s asks sao_paulo_date for today and names no time zone of its own', async (signature) => {
    const definition = await definitionOf(signature);
    expect(definition).toContain("app_private.sao_paulo_date(pg_catalog.now())");
    expect(definition).not.toMatch(/at time zone/i);
    expect(definition).not.toMatch(/Sao_Paulo'/);
    expect(definition).not.toMatch(/current_date|localtimestamp/i);
  });

  it.each([
    'app_private.archive_due_clients()',
    'app_private.set_client_closing_date(uuid, date)'
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
