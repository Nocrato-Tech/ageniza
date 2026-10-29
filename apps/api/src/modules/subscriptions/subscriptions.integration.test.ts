import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from '../auth/test-support/harness.js';
import { SUBSCRIPTION_PERMISSION } from './policy.js';
import { BILLING_STATEMENT, createRecorder, createWorld, type Person, type World } from './test-support/world.js';

// Issue #772 (epic #770): billing through the API. The plan and the ceilings change only from a provider confirmation, the Owner
// alone asks for anything, and every call of the database runs in a transaction of its own.
const recorder = createRecorder();
let app: TestApp;
let world: World;

let ownerA: Person;
let agencyA: string;
let admin: Person;
let oneKey: Person;
let outsider: Person;

const GIB = 1_073_741_824;
const essencial = { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 };

interface ErrorBody { error: { code: string } }
const errorCode = (response: { json: () => unknown }): string => (response.json() as ErrorBody).error.code;

const base = (agencyId: string) => `/agencies/${agencyId}/subscription`;

const pay = async (who: Person, agencyId: string, change: Record<string, unknown>, outcome: 'approved' | 'declined' = 'approved') => {
  const opened = await world.call(who, 'POST', `${base(agencyId)}/charges`, change);
  expect(opened.statusCode).toBe(201);
  const chargeId = opened.json<{ chargeId: string }>().chargeId;
  const paid = await world.call(who, 'POST', `${base(agencyId)}/charges/${chargeId}/simulated-payment`, { outcome });
  expect(paid.statusCode).toBe(200);
  return { chargeId, status: paid.json<{ status: string }>().status };
};

beforeAll(async () => {
  app = await buildTestApp({ wrapDatabase: recorder.wrap });
  world = createWorld(() => app);
  ownerA = await world.person('sub-owner');
  agencyA = await world.agency(ownerA);
  admin = await world.person('sub-admin');
  await world.withRole(agencyA, admin.user.id, 'admin');
  oneKey = await world.person('sub-onekey');
  await world.withPermissions(agencyA, oneKey.user.id, 'cliente.operar');
  outsider = await world.person('sub-outsider');
});

afterAll(async () => {
  await world.teardown();
  await app.close();
});

beforeEach(() => {
  recorder.reset();
});

describe('who may touch billing', () => {
  const routes = (agencyId: string, chargeId: string): Array<{ name: string; method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> => [
    { name: 'plans', method: 'GET', url: `${base(agencyId)}/plans` },
    { name: 'overview', method: 'GET', url: base(agencyId) },
    { name: 'quote', method: 'POST', url: `${base(agencyId)}/quote`, payload: essencial },
    { name: 'charge', method: 'POST', url: `${base(agencyId)}/charges`, payload: essencial },
    { name: 'cancel', method: 'POST', url: `${base(agencyId)}/cancel` },
    { name: 'reactivate', method: 'POST', url: `${base(agencyId)}/reactivate` },
    { name: 'simulated payment', method: 'POST', url: `${base(agencyId)}/charges/${chargeId}/simulated-payment`, payload: { outcome: 'approved' } },
    { name: 'advance', method: 'POST', url: `${base(agencyId)}/simulated-period-advance` }
  ];
  const someCharge = '11111111-1111-4111-8111-111111111111';

  it('refuses the Admin and a role with one other permission before any billing statement runs', async () => {
    for (const route of routes(agencyA, someCharge)) {
      for (const [label, who] of [['admin', admin], ['role of one permission', oneKey]] as const) {
        const response = await world.call(who, route.method, route.url, route.payload);
        expect(response.statusCode, `${route.name} as ${label}`).toBe(403);
        expect(errorCode(response), `${route.name} as ${label}`).toBe('FORBIDDEN');
      }
    }
    expect(recorder.billingStatements()).toEqual([]);
  });

  it('answers 404 to a person outside the agency and 401 to nobody, with no billing statement', async () => {
    for (const route of routes(agencyA, someCharge)) {
      expect((await world.call(outsider, route.method, route.url, route.payload)).statusCode, `${route.name} outsider`).toBe(404);
      expect((await world.call(undefined, route.method, route.url, route.payload)).statusCode, `${route.name} anonymous`).toBe(401);
    }
    expect(recorder.billingStatements()).toEqual([]);
  });

  // The guard of every route asks for this key. A key the catalog does not have refuses everyone but the Owner too, so the
  // refusals above cannot tell it from the right one: the key is pinned here, by value and against the catalog.
  it('asks for the one permission of the catalog that no role can carry', async () => {
    expect(SUBSCRIPTION_PERMISSION).toBe('assinatura.gerenciar');
    const catalog = await world.owner.knex('permissions').where({ key: SUBSCRIPTION_PERMISSION }).select('key');
    expect(catalog).toEqual([{ key: 'assinatura.gerenciar' }]);
  });
});

describe('plans and prices', () => {
  it('lists the three plans in order with the extras, from the tables', async () => {
    const response = await world.call(ownerA, 'GET', `${base(agencyA)}/plans`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plans: [
        { key: 'essencial', name: 'Essencial', clientLimit: 10, storageBytes: 20 * GIB, monthlyCents: 9700 },
        { key: 'profissional', name: 'Profissional', clientLimit: 30, storageBytes: 100 * GIB, monthlyCents: 19700 },
        { key: 'agencia', name: 'Agência', clientLimit: 60, storageBytes: 300 * GIB, monthlyCents: 39700 }
      ],
      extraClientCents: 600,
      extraStorageGibCents: 40,
      maxExtra: 10_000
    });
  });
});

describe('subscribing, upgrading, downgrading and canceling', () => {
  let agency: string;
  let owner: Person;

  beforeAll(async () => {
    owner = await world.person('sub-flow-owner');
    agency = await world.agency(owner);
  });

  it('shows no subscription to a trial and prices the first one on the server, extras included', async () => {
    const overview = await world.call(owner, 'GET', base(agency));
    expect(overview.json()).toEqual({ subscription: null, paymentProvider: 'simulado' });
    const quote = await world.call(owner, 'POST', `${base(agency)}/quote`, { planKey: 'essencial', extraClients: 2, extraStorageGib: 5 });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ effect: 'subscribe', monthlyCents: 9700 + 2 * 600 + 5 * 40, amountCents: 9700 + 2 * 600 + 5 * 40 });
    expect(await world.subscriptionOf(agency)).toBeUndefined();
  });

  it('opens a charge without changing anything, and changes the plan only when the provider confirms it', async () => {
    const opened = await world.call(owner, 'POST', `${base(agency)}/charges`, { planKey: 'essencial', extraClients: 2, extraStorageGib: 0 });
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({ effect: 'subscribe', monthlyCents: 10_900, amountCents: 10_900 });
    expect(await world.subscriptionOf(agency)).toBeUndefined();
    expect(await world.chargesOf(agency)).toMatchObject([{ status: 'pending', amount_cents: 10_900 }]);

    const paid = await world.call(owner, 'POST', `${base(agency)}/charges/${opened.json<{ chargeId: string }>().chargeId}/simulated-payment`, { outcome: 'approved' });
    expect(paid.json()).toEqual({ status: 'confirmed' });
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'essencial', extra_clients: 2, provider: 'simulado' });
    const overview = (await world.call(owner, 'GET', base(agency))).json<{ subscription: Record<string, unknown> }>().subscription;
    expect(overview).toMatchObject({
      planKey: 'essencial', extraClients: 2, extraStorageGib: 0, provider: 'simulado', cancelAtPeriodEnd: false, pending: null,
      monthlyCents: 10_900, nextMonthlyCents: 10_900, clientLimit: 12, storageBytes: 20 * GIB, usedClients: 0, usedBytes: 0, graceEndsOn: null
    });
  });

  it('charges the rest of the period when raising, schedules a lowering for the next period and charges nothing', async () => {
    const upgrade = await world.call(owner, 'POST', `${base(agency)}/quote`, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect(upgrade.json()).toMatchObject({ effect: 'upgrade', monthlyCents: 19_700, amountCents: 19_700 - 10_900 });
    await pay(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'profissional', extra_clients: 0 });

    const downgrade = await world.call(owner, 'POST', `${base(agency)}/charges`, essencial);
    expect(downgrade.statusCode).toBe(201);
    const body = downgrade.json<{ chargeId: string | null; effect: string; amountCents: number; effectiveAt: string }>();
    expect(body).toMatchObject({ chargeId: null, effect: 'downgrade', amountCents: 0 });
    const subscription = (await world.call(owner, 'GET', base(agency))).json<{ subscription: { pending: unknown; monthlyCents: number; nextMonthlyCents: number; currentPeriodEnd: string; clientLimit: number } }>().subscription;
    expect(subscription).toMatchObject({ pending: essencial, monthlyCents: 19_700, nextMonthlyCents: 9700, clientLimit: 30 });
    expect(body.effectiveAt).toBe(subscription.currentPeriodEnd);
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'profissional' });
  });

  it('refuses a lowering below the clients in use and below the storage in use, and says nothing was scheduled', async () => {
    await world.clients(agency, 11);
    const clients = await world.call(owner, 'POST', `${base(agency)}/charges`, { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 });
    expect(clients.statusCode).toBe(409);
    expect(errorCode(clients)).toBe('SUBSCRIPTION_BELOW_CLIENTS');

    await world.clearUsage(agency);
    await world.usedBytes(agency, 21 * GIB);
    const storage = await world.call(owner, 'POST', `${base(agency)}/charges`, { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 });
    expect(storage.statusCode).toBe(409);
    expect(errorCode(storage)).toBe('SUBSCRIPTION_BELOW_STORAGE');
    await world.clearUsage(agency);
    expect((await world.subscriptionOf(agency))?.pending_plan_key).toBe('essencial');
  });

  it('refuses a change that changes nothing and one that raises a limit while it lowers another', async () => {
    const same = await world.call(owner, 'POST', `${base(agency)}/quote`, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect(same.statusCode).toBe(409);
    expect(errorCode(same)).toBe('SUBSCRIPTION_UNCHANGED');
    // Essencial has fewer clients and a lower storage than the Profissional the agency has, so adding clients to it mixes both ways.
    const mixed = await world.call(owner, 'POST', `${base(agency)}/quote`, { planKey: 'essencial', extraClients: 40, extraStorageGib: 0 });
    expect(mixed.statusCode).toBe(409);
    expect(errorCode(mixed)).toBe('SUBSCRIPTION_MIXED_CHANGE');
    const unknown = await world.call(owner, 'POST', `${base(agency)}/quote`, { planKey: 'inexistente', extraClients: 0, extraStorageGib: 0 });
    expect(unknown.statusCode).toBe(400);
    expect(errorCode(unknown)).toBe('SUBSCRIPTION_INVALID');
  });

  it('cancels, keeps everything to the end of the period, takes the cancellation back, and refuses a change while canceled', async () => {
    expect((await world.call(owner, 'POST', `${base(agency)}/cancel`)).statusCode).toBe(204);
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'profissional', cancel_at_period_end: true, pending_plan_key: null });
    const refused = await world.call(owner, 'POST', `${base(agency)}/quote`, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('SUBSCRIPTION_NOT_AVAILABLE');
    expect((await world.call(owner, 'POST', `${base(agency)}/reactivate`)).statusCode).toBe(204);
    expect(await world.subscriptionOf(agency)).toMatchObject({ cancel_at_period_end: false });
  });

  it('cancels inside the three days of tolerance and the agency is read-only at once (owner, 2026-10-29), and reactivating there is refused', async () => {
    await world.endPeriod(agency, 24 * 3600);
    const overview = (await world.call(owner, 'GET', base(agency))).json<{ subscription: { graceEndsOn: string | null } }>().subscription;
    expect(overview.graceEndsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await world.call(owner, 'POST', `${base(agency)}/cancel`)).statusCode).toBe(204);
    expect(await world.subscriptionOf(agency)).toMatchObject({ cancel_at_period_end: true });
    const me = await world.call(owner, 'GET', `/agencies/${agency}/me`);
    expect(me.json<{ plan: Record<string, unknown> }>().plan).toMatchObject({ kind: 'ativo', readOnly: true, canceled: true, paidPlanKey: 'profissional', graceEndsOn: null });
    const reactivate = await world.call(owner, 'POST', `${base(agency)}/reactivate`);
    expect(reactivate.statusCode).toBe(409);
    expect(errorCode(reactivate)).toBe('SUBSCRIPTION_NOT_AVAILABLE');
  });

  it('cancels nothing past the tolerance, in a trial, or twice over', async () => {
    await world.endPeriod(agency, 3 * 24 * 3600 + 3600);
    const late = await world.call(owner, 'POST', `${base(agency)}/cancel`);
    expect(late.statusCode).toBe(409);
    expect(errorCode(late)).toBe('SUBSCRIPTION_NOT_AVAILABLE');

    const trialOwner = await world.person('sub-trial-owner');
    const trial = await world.agency(trialOwner);
    const none = await world.call(trialOwner, 'POST', `${base(trial)}/cancel`);
    expect(none.statusCode).toBe(409);
    expect(errorCode(none)).toBe('SUBSCRIPTION_NOT_AVAILABLE');
  });
});

describe('/me shows the tolerance of an unpaid period', () => {
  it('reports the last day to pay while the agency still writes, then read-only after it', async () => {
    const owner = await world.person('sub-me-owner');
    const agency = await world.agency(owner);
    await pay(owner, agency, essencial);
    const plan = async () => (await world.call(owner, 'GET', `/agencies/${agency}/me`)).json<{ plan: Record<string, unknown> }>().plan;

    expect(await plan()).toMatchObject({ kind: 'ativo', readOnly: false, canceled: false, paidPlanKey: 'essencial', graceEndsOn: null });
    await world.endPeriod(agency, 3600);
    expect(await plan()).toMatchObject({ readOnly: false, graceEndsOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await world.endPeriod(agency, 3 * 24 * 3600 + 3600);
    expect(await plan()).toMatchObject({ readOnly: true, graceEndsOn: null });
  });
});

describe('what reaches the database', () => {
  it('refuses a quantity of extras outside 0..10000 before the database, and takes the edges', async () => {
    const owner = await world.person('sub-limits-owner');
    const agency = await world.agency(owner);
    for (const [field, value] of [['extraClients', -1], ['extraClients', 10_001], ['extraStorageGib', -1], ['extraStorageGib', 10_001], ['extraClients', 1.5], ['extraStorageGib', '5'], ['extraClients', null], ['extraStorageGib', 2 ** 40]] as const) {
      for (const route of ['quote', 'charges'] as const) {
        recorder.reset();
        const response = await world.call(owner, 'POST', `${base(agency)}/${route}`, { ...essencial, [field]: value });
        expect(response.statusCode, `${route} ${field}=${String(value)}`).toBe(400);
        expect(errorCode(response)).toBe('VALIDATION_ERROR');
        expect(recorder.running(/subscription_change/), `${route} ${field}=${String(value)}`).toEqual([]);
      }
    }
    for (const value of [0, 10_000]) {
      const edge = await world.call(owner, 'POST', `${base(agency)}/quote`, { ...essencial, extraClients: value, extraStorageGib: value });
      expect(edge.statusCode, `edge ${value}`).toBe(200);
    }
    const unknownField = await world.call(owner, 'POST', `${base(agency)}/quote`, { ...essencial, card: '4111111111111111' });
    expect(unknownField.statusCode).toBe(400);
  });

  it('refuses a plan key that is not shaped like one before the database, and one that is shaped like one but is no plan with the database\'s answer', async () => {
    const owner = await world.person('sub-plankey-owner');
    const agency = await world.agency(owner);
    for (const planKey of ['', 'Essencial', 'es', 'ES', 'x'.repeat(21), 'essencial1', "essencial'; drop table agencies;--", 'essen cial', 5, null]) {
      for (const route of ['quote', 'charges'] as const) {
        recorder.reset();
        const response = await world.call(owner, 'POST', `${base(agency)}/${route}`, { ...essencial, planKey });
        expect(response.statusCode, `${route} ${String(planKey)}`).toBe(400);
        expect(errorCode(response), `${route} ${String(planKey)}`).toBe('VALIDATION_ERROR');
        expect(recorder.running(/subscription_change/), `${route} ${String(planKey)}`).toEqual([]);
      }
    }
    for (const planKey of ['abc', 'x'.repeat(20)]) {
      const response = await world.call(owner, 'POST', `${base(agency)}/quote`, { ...essencial, planKey });
      expect(response.statusCode, planKey).toBe(400);
      expect(errorCode(response), planKey).toBe('SUBSCRIPTION_INVALID');
    }
  });
});

describe('one transaction per call of the database', () => {
  it('runs cancel, reactivate, advance and the request each alone in a transaction, with the person bound and nothing else of billing', async () => {
    const owner = await world.person('sub-tx-owner');
    const agency = await world.agency(owner);
    await pay(owner, agency, essencial);

    const calls: Array<[string, () => ReturnType<World['call']>, RegExp]> = [
      ['cancel', () => world.call(owner, 'POST', `${base(agency)}/cancel`), /cancel_subscription/],
      ['reactivate', () => world.call(owner, 'POST', `${base(agency)}/reactivate`), /reactivate_subscription/],
      ['advance', () => world.call(owner, 'POST', `${base(agency)}/simulated-period-advance`), /advance_simulated_period/],
      ['request', () => world.call(owner, 'POST', `${base(agency)}/charges`, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 }), /request_subscription_change/]
    ];
    for (const [name, run, pattern] of calls) {
      recorder.reset();
      const response = await run();
      expect(response.statusCode, name).toBeLessThan(300);
      const transactions = recorder.running(pattern);
      expect(transactions, name).toHaveLength(1);
      const billing = transactions[0]!.statements.filter((statement) => BILLING_STATEMENT.test(statement));
      expect(billing, name).toHaveLength(1);
      expect(transactions[0]!.statements[0], name).toMatch(/bind_actor/);
    }
  });
});
