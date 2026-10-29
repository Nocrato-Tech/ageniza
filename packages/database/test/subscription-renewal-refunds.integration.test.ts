import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';
import { createHarness } from './support/subscriptions.js';

// Issue #772 (epic #770), review of #790: a refund of a renewal is a fact the database knows. It is recorded before the provider is
// asked, it counts as an attempt of the period (the idempotency key of the next charge carries it), and the reference that was
// refunded can never renew anything. Without these, a renewal that was refunded was confirmed later with the refunded reference and
// the period came out without money.
const h = createHarness('subscription-renewal-refunds');
const owner = () => h.owner();

interface Refund {
  agency_id: string; provider: string; provider_ref: string; period_end: Date; amount_cents: number; reason: string; status: string;
  failure: string | null; settled_at: Date | null;
}

const record = (agencyId: string, ref: string, options: { provider?: string; periodEnd?: Date; cents?: number; reason?: string } = {}) =>
  h.asNobody((t) => t.raw('select app_private.record_renewal_refund(?::uuid, ?, ?, ?::timestamptz, ?::integer, ?)', [
    agencyId, options.provider ?? 'simulado', ref, options.periodEnd ?? new Date('2026-12-01T00:00:00Z'), options.cents ?? 9700, options.reason ?? 'A0115'
  ]));
const settle = async (ref: string, status: string, failure: string | null = null, provider = 'simulado'): Promise<boolean> =>
  (await h.asNobody((t) => t.raw<{ rows: Array<{ settled: boolean }> }>('select app_private.settle_renewal_refund(?, ?, ?, ?) as settled', [provider, ref, status, failure]))).rows[0]!.settled;
const refundsOf = async (agencyId: string): Promise<Refund[]> =>
  (await owner().raw<{ rows: Refund[] }>('select * from public.subscription_renewal_refunds where agency_id = ? order by created_at, provider_ref', [agencyId])).rows;
const attemptOf = async (agencyId: string): Promise<number | undefined> =>
  (await h.asNobody((t) => t.raw<{ rows: Array<{ attempt: number }> }>('select attempt from app_private.renewal_quote(?::uuid)', [agencyId]))).rows[0]?.attempt;
const renew = (agencyId: string, ref: string, cents: number) =>
  h.asNobody((t) => t.raw<{ rows: Array<{ renewed: boolean }> }>('select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed', [agencyId, 'simulado', ref, cents]))
    .then((result) => result.rows[0]!.renewed);
const dueAgency = async (plan = 'essencial'): Promise<{ agencyId: string; ownerId: string }> => {
  const agency = await h.trialAgency();
  await h.subscribe(agency.ownerId, agency.agencyId, plan);
  await h.setPeriod(agency.agencyId, 29, 1);
  return agency;
};

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  await h.teardown();
});

describe('subscription_renewal_refunds', () => {
  it('is closed to the application role: not even a read, only the functions below touch it', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const { rows } = await owner().raw<{ rows: Array<{ granted: boolean }> }>("select has_table_privilege('ageniza_app', 'public.subscription_renewal_refunds', ?) as granted", [privilege]);
      expect(rows[0]!.granted, privilege).toBe(false);
    }
    const { rows: columns } = await owner().raw<{ rows: Array<{ granted: boolean }> }>(
      `select has_column_privilege('ageniza_app', 'public.subscription_renewal_refunds', c.column_name, 'SELECT') as granted
       from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'subscription_renewal_refunds'`
    );
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((column) => column.granted)).toEqual([]);
    await expect(h.asNobody((t) => t.raw('select * from public.subscription_renewal_refunds'))).rejects.toMatchObject({ code: '42501' });
  });

  it('lets only the server execute the two functions: not the public role, and never a person', async () => {
    for (const signature of ['app_private.record_renewal_refund(uuid, text, text, timestamptz, integer, text)', 'app_private.settle_renewal_refund(text, text, text, text)']) {
      const { rows } = await owner().raw<{ rows: Array<{ app: boolean; anyone: boolean }> }>(
        "select has_function_privilege('ageniza_app', ?, 'EXECUTE') as app, has_function_privilege('public', ?, 'EXECUTE') as anyone", [signature, signature]
      );
      expect(rows[0], signature).toEqual({ app: true, anyone: false });
    }
    const { agencyId, ownerId } = await dueAgency();
    await expect(h.asUser(ownerId, (t) => t.raw('select app_private.record_renewal_refund(?::uuid, ?, ?, now(), 9700, ?)', [agencyId, 'simulado', 'sim:person', 'A0115'])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(h.asUser(ownerId, (t) => t.raw("select app_private.settle_renewal_refund('simulado', 'sim:person', 'refunded', null)")))
      .rejects.toMatchObject({ code: '42501' });
    expect(await refundsOf(agencyId)).toEqual([]);
  });
});

describe('record_renewal_refund', () => {
  it('writes what was asked back as recorded, not yet settled', async () => {
    const { agencyId } = await dueAgency();
    const periodEnd = new Date('2026-12-02T03:04:05Z');
    await record(agencyId, 'sim:one', { periodEnd, cents: 9724, reason: 'A0114' });
    const rows = await refundsOf(agencyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agency_id: agencyId, provider: 'simulado', provider_ref: 'sim:one', amount_cents: 9724, reason: 'A0114', status: 'recorded', failure: null, settled_at: null });
    expect(rows[0]!.period_end.getTime()).toBe(periodEnd.getTime());
  });

  it('is idempotent by the reference and never rewrites what is there', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'sim:twice', { cents: 9700, reason: 'A0115' });
    await settle('sim:twice', 'refunded');
    await record(agencyId, 'sim:twice', { cents: 1, reason: 'A0114', periodEnd: new Date('2027-01-01T00:00:00Z') });
    const rows = await refundsOf(agencyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount_cents: 9700, reason: 'A0115', status: 'refunded' });
  });

  it('keeps one row per reference of one provider, and tells the providers apart', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'ref-shared-name', { provider: 'simulado' });
    await record(agencyId, 'ref-shared-name', { provider: 'asaas' });
    expect((await refundsOf(agencyId)).map((row) => row.provider).sort()).toEqual(['asaas', 'simulado']);
  });

  it('refuses a refund that names no provider, reference, period, amount or reason, and records nothing', async () => {
    const { agencyId } = await dueAgency();
    const call = (provider: string | null, ref: string | null, periodEnd: Date | null, cents: number | null, reason: string | null) =>
      h.asNobody((t) => t.raw('select app_private.record_renewal_refund(?::uuid, ?, ?, ?::timestamptz, ?::integer, ?)', [agencyId, provider, ref, periodEnd, cents, reason]));
    const end = new Date('2026-12-01T00:00:00Z');
    const invalid = { code: 'A0114' };
    await expect(call('stripe', 'r', end, 100, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call(null, 'r', end, 100, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', null, end, 100, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', '   ', end, 100, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'x'.repeat(201), end, 100, 'A0115')).rejects.toMatchObject(invalid);
    // The limit is in bytes: 101 characters of two bytes are 202.
    await expect(call('simulado', 'é'.repeat(101), end, 100, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'r', null, 100, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'r', end, null, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'r', end, 0, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'r', end, -1, 'A0115')).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'r', end, 100, null)).rejects.toMatchObject(invalid);
    await expect(call('simulado', 'r', end, 100, 'A0110')).rejects.toMatchObject(invalid);
    expect(await refundsOf(agencyId)).toEqual([]);
    // The limits themselves are accepted: 200 bytes of reference, one cent.
    await call('simulado', 'x'.repeat(200), end, 1, 'A0114');
    await call('simulado', 'é'.repeat(100), end, 1, 'A0114');
    expect(await refundsOf(agencyId)).toHaveLength(2);
  });

  it('refuses an agency that does not exist', async () => {
    await expect(record('00000000-0000-4000-8000-000000000000', 'sim:nobody')).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a reference that holds a confirmed charge: a refund never undoes a renewal that took', async () => {
    const { agencyId } = await dueAgency();
    expect(await renew(agencyId, 'sim:took', 9700)).toBe(true);
    await expect(record(agencyId, 'sim:took')).rejects.toMatchObject({ code: 'A0119' });
    expect(await refundsOf(agencyId)).toEqual([]);
    // The subscription's own first payment is a confirmed charge too, and so is another agency's.
    const other = await dueAgency();
    await expect(record(other.agencyId, 'sim:took')).rejects.toMatchObject({ code: 'A0119' });
  });

  it('does not take a confirmed charge of another provider for the reference of this one', async () => {
    const { agencyId, ownerId } = await dueAgency();
    const confirmed = await h.seedCharge(agencyId, ownerId, 'confirmed');
    await owner().raw("update public.subscription_charges set provider_ref = 'sim:other-provider', provider = 'asaas' where id = ?", [confirmed]);
    await record(agencyId, 'sim:other-provider', { provider: 'simulado' });
    expect((await refundsOf(agencyId)).map((row) => [row.provider, row.provider_ref])).toEqual([['simulado', 'sim:other-provider']]);
    await expect(record(agencyId, 'sim:other-provider', { provider: 'asaas' })).rejects.toMatchObject({ code: 'A0119' });
  });
});

describe('settle_renewal_refund', () => {
  it('settles a recorded refund as refunded, or as failed with the reason, once', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'sim:done');
    await record(agencyId, 'sim:refused');
    expect(await settle('sim:done', 'refunded')).toBe(true);
    expect(await settle('sim:refused', 'failed', '  unknown_charge  ')).toBe(true);
    const rows = Object.fromEntries((await refundsOf(agencyId)).map((row) => [row.provider_ref, row]));
    expect(rows['sim:done']).toMatchObject({ status: 'refunded', failure: null });
    expect(rows['sim:done']!.settled_at).not.toBeNull();
    expect(rows['sim:refused']).toMatchObject({ status: 'failed', failure: 'unknown_charge' });
    expect(rows['sim:refused']!.settled_at).not.toBeNull();
  });

  it('does not settle twice, nor what was never recorded, nor the same name of another provider', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'sim:settled');
    expect(await settle('sim:settled', 'refunded')).toBe(true);
    expect(await settle('sim:settled', 'failed', 'late')).toBe(false);
    expect(await settle('sim:settled', 'refunded')).toBe(false);
    expect(await settle('sim:never-recorded', 'refunded')).toBe(false);
    await record(agencyId, 'sim:provider');
    expect(await settle('sim:provider', 'refunded', null, 'asaas')).toBe(false);
    expect((await refundsOf(agencyId)).find((row) => row.provider_ref === 'sim:provider')!.status).toBe('recorded');
    expect((await refundsOf(agencyId)).find((row) => row.provider_ref === 'sim:settled')).toMatchObject({ status: 'refunded', failure: null });
  });

  it('refuses a status or a reason that does not fit, and leaves the refund recorded', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'sim:strict');
    const invalid = { code: 'A0114' };
    await expect(settle('sim:strict', 'recorded')).rejects.toMatchObject(invalid);
    await expect(settle('sim:strict', 'recorded', 'why')).rejects.toMatchObject(invalid);
    await expect(settle('sim:strict', 'paid')).rejects.toMatchObject(invalid);
    await expect(settle('sim:strict', 'refunded', 'why')).rejects.toMatchObject(invalid);
    await expect(settle('sim:strict', 'failed')).rejects.toMatchObject(invalid);
    await expect(settle('sim:strict', 'failed', '   ')).rejects.toMatchObject(invalid);
    await expect(h.asNobody((t) => t.raw('select app_private.settle_renewal_refund(?, ?, null, null)', ['simulado', 'sim:strict']))).rejects.toMatchObject(invalid);
    expect((await refundsOf(agencyId))[0]).toMatchObject({ status: 'recorded', failure: null, settled_at: null });
  });

  it('keeps a long reason to the 200 characters the column accepts', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'sim:long');
    expect(await settle('sim:long', 'failed', 'y'.repeat(500))).toBe(true);
    expect((await refundsOf(agencyId))[0]!.failure).toBe('y'.repeat(200));
  });
});

describe('the attempt of renewal_quote', () => {
  it('starts at zero and counts the refunds of the period being renewed, whatever their status', async () => {
    const { agencyId } = await dueAgency();
    const periodEnd = (await h.subscriptionOf(agencyId))!.current_period_end as Date;
    expect(await attemptOf(agencyId)).toBe(0);
    await record(agencyId, 'sim:a1', { periodEnd });
    expect(await attemptOf(agencyId)).toBe(1);
    await record(agencyId, 'sim:a2', { periodEnd });
    await settle('sim:a2', 'refunded');
    await record(agencyId, 'sim:a3', { periodEnd });
    await settle('sim:a3', 'failed', 'unknown_charge');
    expect(await attemptOf(agencyId)).toBe(3);
    // Recording the same reference again is not another attempt.
    await record(agencyId, 'sim:a1', { periodEnd });
    expect(await attemptOf(agencyId)).toBe(3);
  });

  it('counts only the refunds of this agency, of this period, and of the provider of the subscription', async () => {
    const { agencyId } = await dueAgency();
    const other = await dueAgency();
    const periodEnd = (await h.subscriptionOf(agencyId))!.current_period_end as Date;
    // The other agency has the same period, so only the agency tells the two apart.
    await owner().raw('update public.agency_subscriptions set current_period_end = ? where agency_id = ?', [periodEnd, other.agencyId]);
    await record(other.agencyId, 'sim:of-the-other', { periodEnd });
    await record(agencyId, 'sim:last-period', { periodEnd: new Date(periodEnd.getTime() - 86_400_000) });
    await record(agencyId, 'sim:next-period', { periodEnd: new Date(periodEnd.getTime() + 86_400_000) });
    await record(agencyId, 'pay_other_provider', { periodEnd, provider: 'asaas' });
    expect(await attemptOf(agencyId)).toBe(0);
    await record(agencyId, 'sim:this', { periodEnd });
    expect(await attemptOf(agencyId)).toBe(1);
    expect(await attemptOf(other.agencyId)).toBe(1);
    expect(await refundsOf(other.agencyId)).toHaveLength(1);
  });

  it('keeps the period to the millisecond, as the worker reads it, whatever precision the caller sends', async () => {
    const { agencyId } = await dueAgency();
    await owner().raw("update public.agency_subscriptions set current_period_end = now() + interval '12 hours' where agency_id = ?", [agencyId]);
    const exact = (await owner().raw<{ rows: Array<{ text: string }> }>(
      "select to_char(current_period_end at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as text from public.agency_subscriptions where agency_id = ?", [agencyId]
    )).rows[0]!.text;
    expect(exact).toMatch(/\.\d{6}Z$/);
    await h.asNobody((t) => t.raw('select app_private.record_renewal_refund(?::uuid, ?, ?, ?::timestamptz, 9700, ?)', [agencyId, 'simulado', 'sim:micro', exact, 'A0115']));
    const [refund] = await refundsOf(agencyId);
    expect(refund!.period_end.getTime()).toBe(((await h.subscriptionOf(agencyId))!.current_period_end as Date).getTime());
    expect(await attemptOf(agencyId)).toBe(1);
  });

  it('goes back to zero when the period moves, so the next month starts a key of its own', async () => {
    const { agencyId } = await dueAgency();
    const periodEnd = (await h.subscriptionOf(agencyId))!.current_period_end as Date;
    await record(agencyId, 'sim:before-renewal', { periodEnd });
    expect(await attemptOf(agencyId)).toBe(1);
    expect(await renew(agencyId, 'sim:renewed-after-a-refund', 9700)).toBe(true);
    await h.setPeriod(agencyId, 29, 1);
    expect(await attemptOf(agencyId)).toBe(0);
  });
});

describe('renew_subscription and a refunded reference', () => {
  it('refuses a reference recorded as refunded, whatever became of the refund, and renews nothing', async () => {
    const { agencyId } = await dueAgency();
    const before = await h.subscriptionOf(agencyId);
    await record(agencyId, 'sim:recorded');
    await record(agencyId, 'sim:refunded');
    await record(agencyId, 'sim:failed');
    await settle('sim:refunded', 'refunded');
    await settle('sim:failed', 'failed', 'unknown_charge');
    for (const ref of ['sim:recorded', 'sim:refunded', 'sim:failed']) {
      await expect(renew(agencyId, ref, 9700), ref).rejects.toMatchObject({ code: 'A0118' });
    }
    expect(await h.subscriptionOf(agencyId)).toEqual(before);
    expect((await owner().raw<{ rows: Array<{ n: string }> }>("select count(*)::text as n from public.subscription_charges where agency_id = ? and kind = 'renewal'", [agencyId])).rows[0]!.n).toBe('0');
  });

  it('refuses it before judging the amount or the period, and for the agency that is not the one that was refunded', async () => {
    const { agencyId } = await dueAgency();
    const other = await dueAgency();
    await record(agencyId, 'sim:refunded-here');
    await expect(renew(agencyId, 'sim:refunded-here', 1)).rejects.toMatchObject({ code: 'A0118' });
    await expect(renew(other.agencyId, 'sim:refunded-here', 9700)).rejects.toMatchObject({ code: 'A0118' });
    await h.setPeriod(other.agencyId, 29, 10);
    await expect(renew(other.agencyId, 'sim:refunded-here', 9700)).rejects.toMatchObject({ code: 'A0118' });
  });

  it('refuses it even when the reference already renewed (the refusal comes before the answer "already renewed")', async () => {
    const { agencyId } = await dueAgency();
    expect(await renew(agencyId, 'sim:renewed-then-flagged', 9700)).toBe(true);
    // Only the schema owner can write a refund over a confirmed reference; the function would never record it. The point is the order.
    await owner().raw(
      "insert into public.subscription_renewal_refunds (agency_id, provider, provider_ref, period_end, amount_cents, reason) values (?, 'simulado', 'sim:renewed-then-flagged', now(), 9700, 'A0115')",
      [agencyId]
    );
    await expect(renew(agencyId, 'sim:renewed-then-flagged', 9700)).rejects.toMatchObject({ code: 'A0118' });
  });

  it('still renews a reference that was not refunded, and answers false for the one it already renewed', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'sim:refunded-first');
    expect(await renew(agencyId, 'sim:fresh-after-the-refund', 9700)).toBe(true);
    expect(await renew(agencyId, 'sim:fresh-after-the-refund', 9700)).toBe(false);
  });

  it('does not take the refund of another provider for the reference of this one', async () => {
    const { agencyId } = await dueAgency();
    await record(agencyId, 'same-name', { provider: 'asaas' });
    expect(await renew(agencyId, 'same-name', 9700)).toBe(true);
  });
});

describe('the table by itself', () => {
  const insert = (values: Record<string, unknown>) => {
    const row = { provider: 'simulado', provider_ref: 'sim:direct', period_end: new Date('2026-12-01T00:00:00Z'), amount_cents: 9700, reason: 'A0115', status: 'recorded', ...values };
    return agencyId().then((id) => owner().raw(
      `insert into public.subscription_renewal_refunds (agency_id, provider, provider_ref, period_end, amount_cents, reason, status, failure, settled_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.provider, row.provider_ref, row.period_end, row.amount_cents, row.reason, row.status, row.failure ?? null, row.settled_at ?? null]
    ));
  };
  let shared: string | undefined;
  const agencyId = async (): Promise<string> => {
    shared ??= (await h.trialAgency()).agencyId;
    return shared;
  };

  it('refuses by its own constraints a row that no function would write', async () => {
    const check = { code: '23514' };
    await expect(insert({ provider: 'stripe' })).rejects.toMatchObject(check);
    await expect(insert({ provider_ref: '  ' })).rejects.toMatchObject(check);
    await expect(insert({ provider_ref: 'x'.repeat(201) })).rejects.toMatchObject(check);
    await expect(insert({ provider_ref: 'ü'.repeat(101) })).rejects.toMatchObject(check);
    await expect(insert({ amount_cents: 0 })).rejects.toMatchObject(check);
    await expect(insert({ amount_cents: -5 })).rejects.toMatchObject(check);
    await expect(insert({ reason: 'A0110' })).rejects.toMatchObject(check);
    await expect(insert({ status: 'paid' })).rejects.toMatchObject(check);
    await expect(insert({ status: 'paid', settled_at: new Date() })).rejects.toMatchObject(check);
    // A refund is settled exactly when it has a settlement time, and failed exactly when it says why.
    await expect(insert({ status: 'recorded', settled_at: new Date() })).rejects.toMatchObject(check);
    await expect(insert({ status: 'recorded', failure: 'why' })).rejects.toMatchObject(check);
    await expect(insert({ status: 'refunded' })).rejects.toMatchObject(check);
    await expect(insert({ status: 'refunded', settled_at: new Date(), failure: 'why' })).rejects.toMatchObject(check);
    await expect(insert({ status: 'failed', settled_at: new Date() })).rejects.toMatchObject(check);
    await expect(insert({ status: 'failed', settled_at: new Date(), failure: '  ' })).rejects.toMatchObject(check);
    await expect(insert({ status: 'failed', settled_at: new Date(), failure: 'y'.repeat(201) })).rejects.toMatchObject(check);
  });

  it('accepts the three states the functions leave it in, and keeps one row for a reference of a provider', async () => {
    await insert({ provider_ref: 'sim:s1' });
    await insert({ provider_ref: 'sim:s2', status: 'refunded', settled_at: new Date() });
    await insert({ provider_ref: 'sim:s3', status: 'failed', settled_at: new Date(), failure: 'why' });
    await insert({ provider_ref: 'z'.repeat(200) });
    await insert({ provider_ref: 'ü'.repeat(100) });
    await expect(insert({ provider_ref: 'sim:s1', amount_cents: 1 })).rejects.toMatchObject({ code: '23505' });
    await insert({ provider_ref: 'sim:s1', provider: 'asaas' });
  });
});

describe('the refund and the renewal of the same reference', () => {
  it('makes the record wait for a renewal in flight and then refuse it: a refund never undoes a renewal that took', async () => {
    const { agencyId } = await dueAgency();
    const holder = await h.openTransactionAsNobody();
    try {
      expect((await holder.raw<{ rows: Array<{ renewed: boolean }> }>('select app_private.renew_subscription(?::uuid, ?, ?, ?::integer) as renewed', [agencyId, 'simulado', 'sim:in-flight', 9700])).rows[0]!.renewed).toBe(true);
      const holderPid = await backendPid(holder);
      let settled = false;
      const waiting = record(agencyId, 'sim:in-flight').finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBackendsBlockedBy(owner(), holderPid);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject({ code: 'A0119' });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await refundsOf(agencyId)).toEqual([]);
  });

  it('makes the renewal wait for a refund being recorded and then refuse the reference', async () => {
    const { agencyId } = await dueAgency();
    const before = await h.subscriptionOf(agencyId);
    const holder = await h.openTransactionAsNobody();
    try {
      await holder.raw('select app_private.record_renewal_refund(?::uuid, ?, ?, now(), 9700, ?)', [agencyId, 'simulado', 'sim:being-recorded', 'A0115']);
      const holderPid = await backendPid(holder);
      let settled = false;
      const waiting = renew(agencyId, 'sim:being-recorded', 9700).finally(() => { settled = true; });
      waiting.catch(() => undefined);
      await waitForBackendsBlockedBy(owner(), holderPid);
      expect(settled).toBe(false);
      await holder.commit();
      await expect(waiting).rejects.toMatchObject({ code: 'A0118' });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(await h.subscriptionOf(agencyId)).toEqual(before);
  });

  it.each(['repeatable read', 'serializable'] as const)('refuses to record and to settle in %s, which would count past the lock', async (level) => {
    const { agencyId } = await dueAgency();
    const ref = `sim:iso-${level}`;
    await record(agencyId, ref);
    const transaction = await h.openTransactionAsNobody(level);
    try {
      await expect(transaction.raw('select app_private.record_renewal_refund(?::uuid, ?, ?, now(), 9700, ?)', [agencyId, 'simulado', `${ref}-new`, 'A0115'])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await transaction.rollback();
    }
    const second = await h.openTransactionAsNobody(level);
    try {
      await expect(second.raw("select app_private.settle_renewal_refund('simulado', ?, 'refunded', null)", [ref])).rejects.toMatchObject({ code: '40001' });
    } finally {
      await second.rollback();
    }
    expect((await refundsOf(agencyId)).map((row) => [row.provider_ref, row.status])).toEqual([[ref, 'recorded']]);
  });
});
