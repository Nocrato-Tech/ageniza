import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, GIB } from './support/subscriptions.js';

// Issue #771 (epic #770): the plans, the extras, who may touch them and what the application role may read of them.
const h = createHarness('subscription-plans');
const owner = () => h.owner();

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

describe('the plans and the price of an extra', () => {
  it('are the three plans of the owner\'s decision, by value, and the extras at R$ 6 and R$ 0,40', async () => {
    const plans = await owner()('subscription_plans').orderBy('position').select('key', 'name', 'client_limit', 'storage_bytes', 'monthly_price_cents');
    expect(plans).toEqual([
      { key: 'essencial', name: 'Essencial', client_limit: 10, storage_bytes: String(20 * GIB), monthly_price_cents: 9700 },
      { key: 'profissional', name: 'Profissional', client_limit: 30, storage_bytes: String(100 * GIB), monthly_price_cents: 19700 },
      { key: 'agencia', name: 'Agência', client_limit: 60, storage_bytes: String(300 * GIB), monthly_price_cents: 39700 }
    ]);
    expect(await owner()('subscription_extra_prices').orderBy('kind').select('kind', 'unit_price_cents'))
      .toEqual([{ kind: 'client', unit_price_cents: 600 }, { kind: 'storage_gib', unit_price_cents: 40 }]);
  });

  it('price a monthly total as the plan plus each extra, and the screen\'s example adds up', async () => {
    const total = async (plan: string, clients: number, gib: number) =>
      (await owner().raw('select app_private.subscription_monthly_cents(?, ?::integer, ?::integer) as cents', [plan, clients, gib])).rows[0].cents as number | null;
    // R$ 197 + R$ 42 = R$ 239/mês: 5 extra clients (R$ 30) and 30 extra GiB (R$ 12).
    expect(await total('profissional', 5, 30)).toBe(23900);
    expect(await total('essencial', 0, 0)).toBe(9700);
    expect(await total('agencia', 1, 1)).toBe(39700 + 600 + 40);
    expect(await total('inexistente', 0, 0)).toBeNull();
  });

  it('give a limit of clients and of bytes that adds the extras to the plan\'s', async () => {
    const limits = (await owner().raw(
      'select app_private.subscription_client_limit(?, ?::integer) as clients, app_private.subscription_storage_bytes(?, ?::integer) as bytes',
      ['profissional', 7, 'profissional', 11]
    )).rows[0];
    expect(limits).toEqual({ clients: 37, bytes: String(111 * GIB) });
  });

  it('are readable and never writable by the application role', async () => {
    const person = await h.person();
    const { agencyId } = await h.trialAgency();
    expect(await h.asUser(person, (t) => t('subscription_plans').select('key'))).toHaveLength(3);
    expect(await h.asNobody((t) => t('subscription_plans').select('key'))).toHaveLength(0);
    const writes: Array<[string, (t: Knex.Transaction) => Promise<unknown>]> = [
      ['plans insert', (t) => t('subscription_plans').insert({ key: 'extra', name: 'Extra', client_limit: 1, storage_bytes: 1, monthly_price_cents: 1, position: 9 })],
      ['plans update', (t) => t('subscription_plans').where({ key: 'essencial' }).update({ monthly_price_cents: 1 })],
      ['plans delete', (t) => t('subscription_plans').where({ key: 'essencial' }).delete()],
      ['prices update', (t) => t('subscription_extra_prices').where({ kind: 'client' }).update({ unit_price_cents: 1 })],
      ['prices insert', (t) => t('subscription_extra_prices').insert({ kind: 'client', unit_price_cents: 1 })],
      ['subscription insert', (t) => t('agency_subscriptions').insert({ agency_id: agencyId, plan_key: 'agencia', provider: 'simulado', current_period_start: new Date() })],
      ['charge insert', (t) => t('subscription_charges').insert({ agency_id: agencyId, kind: 'subscribe', plan_key: 'agencia', extra_clients: 0, extra_storage_gib: 0, amount_cents: 0, expires_at: new Date() })]
    ];
    for (const [name, write] of writes) {
      await expect(h.asUser(person, write), name).rejects.toMatchObject({ code: '42501' });
    }
    expect(await owner()('subscription_plans').where({ key: 'essencial' }).first('monthly_price_cents')).toEqual({ monthly_price_cents: 9700 });
  });

  it('never let the application role rewrite a subscription it can read', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedSubscription(agencyId, 'essencial');
    for (const [name, write] of [
      ['plan', (t: Knex.Transaction) => t('agency_subscriptions').where({ agency_id: agencyId }).update({ plan_key: 'agencia' })],
      ['extras', (t: Knex.Transaction) => t('agency_subscriptions').where({ agency_id: agencyId }).update({ extra_clients: 100 })],
      ['period', (t: Knex.Transaction) => t('agency_subscriptions').where({ agency_id: agencyId }).update({ current_period_end: new Date('2099-01-01') })],
      ['delete', (t: Knex.Transaction) => t('agency_subscriptions').where({ agency_id: agencyId }).delete()]
    ] as const) {
      await expect(h.asUser(ownerId, write), name).rejects.toMatchObject({ code: '42501' });
    }
    expect(await h.subscriptionOf(agencyId)).toMatchObject({ plan_key: 'essencial', extra_clients: 0 });
  });
});

describe('the catalog of the subscription tables', () => {
  const tables = ['subscription_plans', 'subscription_extra_prices', 'agency_subscriptions', 'subscription_charges'];

  it('gives the application role no write on any column or table, and RLS enabled and forced', async () => {
    for (const table of tables) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await owner().raw<{ rows: Array<{ granted: boolean }> }>("select has_table_privilege('ageniza_app', ?::regclass, ?) as granted", [`public.${table}`, privilege]);
        expect(rows[0]!.granted, `${table} ${privilege}`).toBe(false);
      }
      const { rows: columns } = await owner().raw<{ rows: Array<{ column_name: string; insertable: boolean; updatable: boolean }> }>(
        `select c.column_name,
                has_column_privilege('ageniza_app', ?::regclass, c.column_name, 'INSERT') as insertable,
                has_column_privilege('ageniza_app', ?::regclass, c.column_name, 'UPDATE') as updatable
         from information_schema.columns c where c.table_schema = 'public' and c.table_name = ?`, [`public.${table}`, `public.${table}`, table]
      );
      expect(columns.length, table).toBeGreaterThan(0);
      expect(columns.filter((column) => column.insertable || column.updatable), table).toEqual([]);
      const { rows: flags } = await owner().raw<{ rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> }>(
        'select relrowsecurity, relforcerowsecurity from pg_class where oid = ?::regclass', [`public.${table}`]
      );
      expect(flags[0], table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it('lets the application role select exactly the columns the screens read, and not the provider\'s', async () => {
    const selectable = async (table: string): Promise<string[]> => (await owner().raw<{ rows: Array<{ column_name: string }> }>(
      `select c.column_name from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = ? and has_column_privilege('ageniza_app', ?::regclass, c.column_name, 'SELECT')
       order by c.column_name`, [table, `public.${table}`]
    )).rows.map((row) => row.column_name);
    expect(await selectable('subscription_charges')).toEqual([
      'agency_id', 'amount_cents', 'confirmed_at', 'created_at', 'expires_at', 'extra_clients', 'extra_storage_gib', 'id', 'kind', 'period_end', 'period_start', 'plan_key', 'status'
    ]);
    expect(await selectable('agency_subscriptions')).toEqual([
      'agency_id', 'cancel_at_period_end', 'current_period_end', 'current_period_start', 'extra_clients', 'extra_storage_gib', 'pending_extra_clients',
      'pending_extra_storage_gib', 'pending_plan_key', 'plan_key', 'provider'
    ]);
    expect(await selectable('subscription_plans')).toEqual(['client_limit', 'created_at', 'key', 'monthly_price_cents', 'name', 'position', 'storage_bytes', 'updated_at']);
    expect(await selectable('subscription_extra_prices')).toEqual(['created_at', 'kind', 'unit_price_cents', 'updated_at']);
  });
});

describe('who may manage the subscription', () => {
  const holds = (userId: string | null, agencyId: string): Promise<boolean> => {
    const work = async (t: Knex.Transaction): Promise<boolean> =>
      (await t.raw<{ rows: Array<{ ok: boolean }> }>('select app_private.has_agency_permission(?::uuid, ?) as ok', [agencyId, 'assinatura.gerenciar'])).rows[0]!.ok;
    return userId === null ? h.asNobody(work) : h.asUser(userId, work);
  };

  it('is only the Owner: no Admin, no role with another permission, no outsider, and nobody bound', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const admin = await h.withRole(agencyId, 'admin');
    const oneKey = await h.withPermissions(agencyId, 'cliente.cadastrar');
    const outsider = await h.person();
    const otherAgency = await h.trialAgency();

    expect(await holds(ownerId, agencyId)).toBe(true);
    expect(await holds(admin, agencyId)).toBe(false);
    expect(await holds(oneKey, agencyId)).toBe(false);
    expect(await holds(outsider, agencyId)).toBe(false);
    expect(await holds(null, agencyId)).toBe(false);
    // The Owner of another agency is nobody here.
    expect(await holds(otherAgency.ownerId, agencyId)).toBe(false);
  });

  it('is in no preset role: the Owner holds it by possession and the catalog lists it', async () => {
    expect(await owner()('permissions').where({ key: 'assinatura.gerenciar' }).count('* as n').first()).toMatchObject({ n: '1' });
    expect(await owner()('role_permissions').where({ permission_key: 'assinatura.gerenciar' })).toHaveLength(0);
  });

  it('cannot be given to a role: the key refuses to sit in a role', async () => {
    const { agencyId } = await h.trialAgency();
    const roleId = randomUUID();
    await owner()('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Cobrança', is_system: false });
    try {
      await expect(owner()('role_permissions').insert({ role_id: roleId, permission_key: 'assinatura.gerenciar' })).rejects.toMatchObject({ code: '23514' });
    } finally {
      await owner()('roles').where({ id: roleId }).delete();
    }
    expect(await owner()('role_permissions').where({ permission_key: 'assinatura.gerenciar' })).toHaveLength(0);
  });

  it('is the Owner by possession even without a membership', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await owner()('agency_memberships').where({ agency_id: agencyId, user_id: ownerId }).delete();
    expect(await holds(ownerId, agencyId)).toBe(true);
  });

  it('has no door for the application role to the operation\'s, the lock\'s or the terms\' functions, and none for PUBLIC', async () => {
    const person = await h.person();
    const door = (sql: string) => h.asUser(person, (t) => t.raw(sql));
    await expect(door("select app_private.grant_courtesy_subscription(gen_random_uuid(), 'essencial')")).rejects.toMatchObject({ code: '42501' });
    await expect(door("select app_private.apply_subscription_terms(gen_random_uuid(), 'essencial', 0, 0)")).rejects.toMatchObject({ code: '42501' });
    await expect(door('select app_private.lock_plan_limits(gen_random_uuid())')).rejects.toMatchObject({ code: '42501' });
    await expect(door('select app_private.agency_client_limit(gen_random_uuid())')).rejects.toMatchObject({ code: '42501' });
    await expect(door("select app_private.subscription_monthly_cents('essencial', 0, 0)")).rejects.toMatchObject({ code: '42501' });

    const { rows } = await owner().raw<{ rows: Array<{ proname: string; granted: boolean; to_public: boolean; definer: boolean; fixed_path: boolean }> }>(`
      select p.proname,
             has_function_privilege('ageniza_app', p.oid, 'execute') as granted,
             has_function_privilege('public', p.oid, 'execute') as to_public,
             p.prosecdef as definer,
             coalesce(p.proconfig @> array['search_path=""'], false) as fixed_path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in ('agency_storage_used_bytes', 'subscription_monthly_cents', 'subscription_client_limit', 'subscription_storage_bytes',
                          'agency_client_limit', 'lock_plan_limits', 'enforce_client_limit', 'apply_subscription_terms', 'grant_courtesy_subscription')
    `);
    expect(rows.map((row) => row.proname).sort()).toEqual([
      'agency_client_limit', 'agency_storage_used_bytes', 'apply_subscription_terms', 'enforce_client_limit', 'grant_courtesy_subscription',
      'lock_plan_limits', 'subscription_client_limit', 'subscription_monthly_cents', 'subscription_storage_bytes'
    ]);
    for (const row of rows) {
      expect(row.granted, row.proname).toBe(false);
      expect(row.to_public, row.proname).toBe(false);
      expect(row.definer, row.proname).toBe(true);
      expect(row.fixed_path, row.proname).toBe(true);
    }
  });
});

describe('what the application role reads', () => {
  it('lets every member of the agency read its subscription, and only the Owner read the charges', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    const admin = await h.withRole(agencyId, 'admin');
    const outsider = await h.person();
    await h.seedSubscription(agencyId, 'essencial');
    await h.seedCharge(agencyId, ownerId, 'confirmed');

    expect(await h.asUser(ownerId, (t) => t('agency_subscriptions').select('plan_key'))).toEqual([{ plan_key: 'essencial' }]);
    expect(await h.asUser(admin, (t) => t('agency_subscriptions').select('plan_key'))).toEqual([{ plan_key: 'essencial' }]);
    expect(await h.asUser(outsider, (t) => t('agency_subscriptions').select('plan_key'))).toEqual([]);
    expect(await h.asNobody((t) => t('agency_subscriptions').select('plan_key'))).toEqual([]);

    expect(await h.asUser(ownerId, (t) => t('subscription_charges').select('kind', 'status'))).toEqual([{ kind: 'subscribe', status: 'confirmed' }]);
    expect(await h.asUser(admin, (t) => t('subscription_charges').select('kind'))).toEqual([]);
    expect(await h.asUser(outsider, (t) => t('subscription_charges').select('kind'))).toEqual([]);
    expect(await h.asNobody((t) => t('subscription_charges').select('kind'))).toEqual([]);
  });

  it('keeps the provider\'s reference of a charge away from the application role', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedCharge(agencyId, ownerId, 'confirmed');
    await expect(h.asUser(ownerId, (t) => t('subscription_charges').select('provider_ref'))).rejects.toMatchObject({ code: '42501' });
    await expect(h.asUser(ownerId, (t) => t('subscription_charges').select('provider'))).rejects.toMatchObject({ code: '42501' });
    await expect(h.asUser(ownerId, (t) => t('subscription_charges').select('requested_by_user_id'))).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps one pending charge per agency and one agency per provider reference', async () => {
    const { agencyId, ownerId } = await h.trialAgency();
    await h.seedCharge(agencyId, ownerId, 'pending');
    await expect(h.seedCharge(agencyId, ownerId, 'pending')).rejects.toMatchObject({ code: '23505' });
    await h.seedCharge(agencyId, ownerId, 'expired');
    const confirmed = await h.seedCharge(agencyId, ownerId, 'confirmed');
    const { provider_ref: ref } = await owner()('subscription_charges').where({ id: confirmed }).first('provider_ref');
    await expect(owner()('subscription_charges').insert({
      agency_id: agencyId, kind: 'renewal', status: 'confirmed', plan_key: 'essencial', extra_clients: 0, extra_storage_gib: 0, amount_cents: 1, provider: 'simulado', provider_ref: ref,
      expires_at: new Date(), period_start: new Date(), period_end: new Date(Date.now() + 1000), confirmed_at: new Date()
    })).rejects.toMatchObject({ code: '23505' });
  });
});
