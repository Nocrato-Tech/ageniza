import type { ChargeRequest, ChargeResult, PaymentProvider } from '@ageniza/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, TEST_APP_PUBLIC_URL, type TestApp } from '../auth/test-support/harness.js';
import { createRecorder, createWorld, type Person, type World } from './test-support/world.js';

// Issue #772 and the contracts of the security review of #781: the simulated payment is the only path that confirms a charge here.
// It fails closed, it ties the charge to the agency of the Owner who pays before it confirms anything, it validates what the provider
// answers before the database sees it, and no part of a card reaches the server.
const recorder = createRecorder();
const requests: ChargeRequest[] = [];
let answer: (request: ChargeRequest) => ChargeResult | Promise<ChargeResult>;
const approve = (request: ChargeRequest): ChargeResult => request.testOutcome === 'declined'
  ? { status: 'declined', reason: 'card_declined' }
  : { status: 'approved', providerRef: `sim:${request.idempotencyKey}`, paidCents: request.amountCents };

// A fake that answers like the provider would and records what it was asked: it is never told what the code should compute.
const provider: PaymentProvider = {
  name: 'simulado',
  charge: async (request) => {
    requests.push(request);
    return answer(request);
  }
};

let app: TestApp;
let world: World;
let ownerA: Person;
let agencyA: string;

const base = (agencyId: string) => `/agencies/${agencyId}/subscription`;
const essencial = { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 };
const errorCode = (response: { json: () => unknown }): string => (response.json() as { error: { code: string } }).error.code;

const open = async (who: Person, agencyId: string, change: Record<string, unknown> = essencial): Promise<string> => {
  const response = await world.call(who, 'POST', `${base(agencyId)}/charges`, change);
  expect(response.statusCode).toBe(201);
  return response.json<{ chargeId: string }>().chargeId;
};
const payUrl = (agencyId: string, chargeId: string) => `${base(agencyId)}/charges/${chargeId}/simulated-payment`;
const statusOf = async (chargeId: string): Promise<string | undefined> =>
  (await world.owner.knex('subscription_charges').where({ id: chargeId }).first('status'))?.status as string | undefined;

beforeAll(async () => {
  app = await buildTestApp({ wrapDatabase: recorder.wrap, paymentProvider: provider });
  world = createWorld(() => app);
  ownerA = await world.person('simpay-owner');
  agencyA = await world.agency(ownerA);
});

afterAll(async () => {
  await world.teardown();
  await app.close();
});

beforeEach(() => {
  recorder.reset();
  requests.length = 0;
  answer = approve;
});

describe('the charge has to be the one of the Owner who pays', () => {
  it('refuses an Owner of another agency who names a neighbour\'s charge, and the charge stays pending and unpaid', async () => {
    const chargeId = await open(ownerA, agencyA);
    const ownerB = await world.person('simpay-owner-b');
    const agencyB = await world.agency(ownerB);
    recorder.reset();

    const response = await world.call(ownerB, 'POST', payUrl(agencyB, chargeId), { outcome: 'approved' });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('NOT_FOUND');
    expect(await statusOf(chargeId)).toBe('pending');
    expect(requests).toEqual([]);
    expect(recorder.running(/confirm_subscription_charge/)).toEqual([]);
    expect(await world.subscriptionOf(agencyA)).toBeUndefined();
    expect(await world.subscriptionOf(agencyB)).toBeUndefined();
  });

  it('refuses the same Owner who names the charge of one agency on the route of another they also own', async () => {
    const other = await world.plainAgency(ownerA.user.id);
    const chargeId = await open(ownerA, agencyA);
    recorder.reset();

    const response = await world.call(ownerA, 'POST', payUrl(other, chargeId), { outcome: 'approved' });
    expect(response.statusCode).toBe(404);
    expect(await statusOf(chargeId)).toBe('pending');
    expect(requests).toEqual([]);
    expect(recorder.running(/confirm_subscription_charge/)).toEqual([]);
    await world.owner.knex('subscription_charges').where({ id: chargeId }).update({ status: 'expired' });
  });

  it('answers a charge that does not exist like one that is not theirs', async () => {
    const response = await world.call(ownerA, 'POST', payUrl(agencyA, '99999999-9999-4999-8999-999999999999'), { outcome: 'approved' });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('NOT_FOUND');
    expect(requests).toEqual([]);
  });
});

describe('paying', () => {
  let owner: Person;
  let agency: string;

  beforeAll(async () => {
    owner = await world.person('simpay-flow-owner');
    agency = await world.agency(owner);
  });

  it('asks the provider for exactly what the charge costs, with the charge as the reference, then confirms it in a transaction of its own', async () => {
    const chargeId = await open(owner, agency, { planKey: 'essencial', extraClients: 3, extraStorageGib: 10 });
    recorder.reset();
    const response = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
    expect(response.json()).toEqual({ status: 'confirmed' });
    expect(requests).toEqual([{ idempotencyKey: chargeId, amountCents: 9700 + 3 * 600 + 10 * 40, reference: chargeId, testOutcome: 'approved' }]);
    expect(await statusOf(chargeId)).toBe('confirmed');
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'essencial', extra_clients: 3, extra_storage_gib: 10, provider: 'simulado' });

    // One transaction reads the charge as the person; another confirms with nobody bound. The database refuses a confirmation
    // that comes with a person, so joining the two is not an option, and neither one runs the other's statement.
    const reading = recorder.running(/from public\.subscription_charges/);
    const confirming = recorder.running(/confirm_subscription_charge/);
    expect(reading).toHaveLength(1);
    expect(confirming).toHaveLength(1);
    expect(reading[0]).not.toBe(confirming[0]);
    expect(reading[0]!.statements.some((statement) => /bind_actor/.test(statement))).toBe(true);
    expect(confirming[0]!.statements).toHaveLength(1);
    expect(confirming[0]!.statements.some((statement) => /bind_actor/.test(statement))).toBe(false);
    expect(reading[0]!.statements.some((statement) => /confirm_subscription_charge/.test(statement))).toBe(false);
  });

  it('does not charge twice: a charge already confirmed answers 409 and the provider is not asked again', async () => {
    const chargeId = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect((await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' })).statusCode).toBe(200);
    requests.length = 0;
    const again = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('CHARGE_NOT_OPEN');
    expect(requests).toEqual([]);
  });

  it('declines the test card without changing anything, and the same charge can still be paid', async () => {
    const chargeId = await open(owner, agency, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });
    const declined = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'declined' });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toEqual({ status: 'declined' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ testOutcome: 'declined' });
    expect(await statusOf(chargeId)).toBe('pending');
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'profissional' });
    expect(recorder.running(/confirm_subscription_charge/)).toEqual([]);

    const approved = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
    expect(approved.json()).toEqual({ status: 'confirmed' });
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'agencia' });
  });

  it('refuses an expired charge and one that a newer request replaced', async () => {
    const first = await open(owner, agency, { planKey: 'agencia', extraClients: 1, extraStorageGib: 0 });
    const second = await open(owner, agency, { planKey: 'agencia', extraClients: 2, extraStorageGib: 0 });
    expect(await statusOf(first)).toBe('expired');
    requests.length = 0;
    const replaced = await world.call(owner, 'POST', payUrl(agency, first), { outcome: 'approved' });
    expect(replaced.statusCode).toBe(409);
    expect(errorCode(replaced)).toBe('CHARGE_NOT_OPEN');
    await world.owner.knex('subscription_charges').where({ id: second }).update({ expires_at: new Date(Date.now() - 1000) });
    const late = await world.call(owner, 'POST', payUrl(agency, second), { outcome: 'approved' });
    expect(late.statusCode).toBe(409);
    expect(errorCode(late)).toBe('CHARGE_NOT_OPEN');
  });
});

describe('what the provider answers is checked before the database sees it', () => {
  let owner: Person;
  let agency: string;

  beforeAll(async () => {
    owner = await world.person('simpay-ref-owner');
    agency = await world.agency(owner);
  });

  it('refuses a reference of more than 200 bytes, counting bytes and not characters, and takes one of exactly 200', async () => {
    for (const [label, providerRef] of [['201 ASCII', 'a'.repeat(201)], ['101 two-byte characters', 'é'.repeat(101)], ['blank', '   '], ['empty', '']] as const) {
      const chargeId = await open(owner, agency);
      answer = (request) => ({ status: 'approved', providerRef, paidCents: request.amountCents });
      recorder.reset();
      const response = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
      expect(response.statusCode, label).toBe(502);
      expect(errorCode(response), label).toBe('PAYMENT_PROVIDER_FAILED');
      expect(recorder.running(/confirm_subscription_charge/), label).toEqual([]);
      expect(await statusOf(chargeId), label).toBe('pending');
    }
    for (const providerRef of ['a'.repeat(200), 'é'.repeat(100)]) {
      const payer = await world.person('simpay-ref-edge');
      const edgeAgency = await world.agency(payer);
      const chargeId = await open(payer, edgeAgency);
      answer = (request) => ({ status: 'approved', providerRef, paidCents: request.amountCents });
      const response = await world.call(payer, 'POST', payUrl(edgeAgency, chargeId), { outcome: 'approved' });
      expect(response.json(), providerRef.slice(0, 3)).toEqual({ status: 'confirmed' });
      expect((await world.owner.knex('subscription_charges').where({ id: chargeId }).first('provider_ref')).provider_ref).toBe(providerRef);
    }
  });

  it('refuses an amount that is not the charge, leaving it open, and a provider that fails', async () => {
    const chargeId = await open(owner, agency);
    answer = (request) => ({ status: 'approved', providerRef: `sim:${request.idempotencyKey}`, paidCents: request.amountCents - 1 });
    const wrong = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
    expect(wrong.statusCode).toBe(409);
    expect(errorCode(wrong)).toBe('CHARGE_NOT_OPEN');
    expect(await statusOf(chargeId)).toBe('pending');

    answer = () => { throw new Error('the provider is down'); };
    const down = await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
    expect(down.statusCode).toBe(502);
    expect(errorCode(down)).toBe('PAYMENT_PROVIDER_FAILED');
    expect(JSON.stringify(down.json())).not.toContain('the provider is down');
    expect(await statusOf(chargeId)).toBe('pending');
  });
});

describe('no part of a card reaches the server', () => {
  it('accepts nothing but the outcome: a body that carries a card number, its last digits or anything else is refused before the provider', async () => {
    const owner = await world.person('simpay-card-owner');
    const agency = await world.agency(owner);
    const chargeId = await open(owner, agency);
    const card = '4111111111111111';
    for (const body of [
      { outcome: 'approved', cardNumber: card },
      { outcome: 'approved', last4: '1111' },
      { outcome: 'approved', card: { number: card } },
      { cardNumber: card },
      { outcome: 'maybe' },
      {}
    ]) {
      const response = await world.call(owner, 'POST', payUrl(agency, chargeId), body);
      expect(response.statusCode, JSON.stringify(Object.keys(body))).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.json())).not.toContain(card);
    }
    expect(requests).toEqual([]);
    expect(await statusOf(chargeId)).toBe('pending');
  });

  it('leaves no card in the charges, the audit or the subscription after a full payment', async () => {
    const owner = await world.person('simpay-trace-owner');
    const agency = await world.agency(owner);
    const chargeId = await open(owner, agency);
    expect((await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' })).statusCode).toBe(200);
    const rows = JSON.stringify([
      await world.chargesOf(agency),
      await world.subscriptionOf(agency),
      (await world.owner.knex.raw('select * from audit.events where agency_id = ?', [agency])).rows
    ]);
    expect(rows).not.toMatch(/4111|card|cart/i);
  });
});

describe('the simulated routes fail closed', () => {
  const simulatedRoutes = (agencyId: string) => [
    { url: payUrl(agencyId, '11111111-1111-4111-8111-111111111111'), payload: { outcome: 'approved' } },
    { url: `${base(agencyId)}/simulated-period-advance`, payload: undefined }
  ];

  it('does not register them without a provider, and the overview says nobody can pay', async () => {
    const bare = await buildTestApp({ paymentProvider: null });
    try {
      const callBare = (url: string, method: 'GET' | 'POST', payload?: Record<string, unknown>) => bare.app.inject({
        method, url, headers: { origin: TEST_APP_PUBLIC_URL, cookie: ownerA.cookie }, ...(payload === undefined ? {} : { payload })
      });
      for (const route of simulatedRoutes(agencyA)) expect((await callBare(route.url, 'POST', route.payload)).statusCode, route.url).toBe(404);
      const overview = await callBare(base(agencyA), 'GET');
      expect(overview.statusCode).toBe(200);
      expect(overview.json()).toMatchObject({ paymentProvider: null });
    } finally {
      await bare.close();
    }
  });

  it('does not register them in production even when a provider is handed over', async () => {
    const production = await buildTestApp({ paymentProvider: provider, subscriptionsProduction: true });
    try {
      for (const route of simulatedRoutes(agencyA)) {
        const response = await production.app.inject({
          method: 'POST', url: route.url, headers: { origin: TEST_APP_PUBLIC_URL, cookie: ownerA.cookie }, ...(route.payload === undefined ? {} : { payload: route.payload })
        });
        expect(response.statusCode, route.url).toBe(404);
      }
      const overview = await production.app.inject({ method: 'GET', url: base(agencyA), headers: { origin: TEST_APP_PUBLIC_URL, cookie: ownerA.cookie } });
      expect(overview.statusCode).toBe(200);
    } finally {
      await production.close();
    }
  });

  it('does not register them for a provider that is not the simulated one, and the overview names that provider', async () => {
    const real = await buildTestApp({ paymentProvider: { name: 'asaas', charge: async () => { throw new Error('a real provider is never charged from a test'); } } });
    try {
      for (const route of simulatedRoutes(agencyA)) {
        const response = await real.app.inject({
          method: 'POST', url: route.url, headers: { origin: TEST_APP_PUBLIC_URL, cookie: ownerA.cookie }, ...(route.payload === undefined ? {} : { payload: route.payload })
        });
        expect(response.statusCode, route.url).toBe(404);
      }
      const overview = await real.app.inject({ method: 'GET', url: base(agencyA), headers: { origin: TEST_APP_PUBLIC_URL, cookie: ownerA.cookie } });
      expect(overview.json()).toMatchObject({ paymentProvider: 'asaas' });
    } finally {
      await real.close();
    }
  });
});

describe('advancing the clock of a simulated subscription', () => {
  it('ends the period, then the tolerance, and then does nothing; a subscription of another provider does not move', async () => {
    const owner = await world.person('simpay-advance-owner');
    const agency = await world.agency(owner);
    expect((await world.call(owner, 'POST', `${base(agency)}/simulated-period-advance`)).statusCode).toBe(409);

    const chargeId = await open(owner, agency);
    await world.call(owner, 'POST', payUrl(agency, chargeId), { outcome: 'approved' });
    const plan = async () => (await world.call(owner, 'GET', `/agencies/${agency}/me`)).json<{ plan: { readOnly: boolean; graceEndsOn: string | null } }>().plan;
    expect(await plan()).toMatchObject({ readOnly: false, graceEndsOn: null });

    expect((await world.call(owner, 'POST', `${base(agency)}/simulated-period-advance`)).statusCode).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await plan()).toMatchObject({ readOnly: false, graceEndsOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    expect((await world.call(owner, 'POST', `${base(agency)}/simulated-period-advance`)).statusCode).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await plan()).toMatchObject({ readOnly: true, graceEndsOn: null });

    const asaas = await world.person('simpay-asaas-owner');
    const asaasAgency = await world.agency(asaas);
    await world.owner.knex.raw("select app_private.grant_courtesy_subscription(?::uuid, 'essencial')", [asaasAgency]);
    await world.owner.knex('agency_subscriptions').where({ agency_id: asaasAgency }).update({
      provider: 'asaas', current_period_start: new Date(Date.now() - 86_400_000), current_period_end: new Date(Date.now() + 86_400_000)
    });
    const refused = await world.call(asaas, 'POST', `${base(asaasAgency)}/simulated-period-advance`);
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('SUBSCRIPTION_NOT_AVAILABLE');
  });
});
