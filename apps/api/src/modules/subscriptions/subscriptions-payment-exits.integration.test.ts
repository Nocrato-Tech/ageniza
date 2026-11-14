import type { DatabaseClient } from '@ageniza/database';
import type { ChargeRequest, ChargeResult, PaymentProvider } from '@ageniza/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, TEST_APP_PUBLIC_URL, type TestApp } from '../auth/test-support/harness.js';
import { createRecorder, createWorld, type Person, type World } from './test-support/world.js';

// Decision 2026-11-12: a declined payment is recorded by the charge, and a declined charge is never paid again. The payment is the flow
// that leaves the app, so each way out of it has a test of its own: approved, declined, failed, abandoned, and the entry that follows.
type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const recorder = createRecorder();
const requests: ChargeRequest[] = [];
let answer: (request: ChargeRequest) => ChargeResult | Promise<ChargeResult>;
let fault: { readonly pattern: RegExp; readonly code: string } | undefined;
const approve = (request: ChargeRequest): ChargeResult => request.testOutcome === 'declined'
  ? { status: 'declined', reason: 'card_declined' }
  : { status: 'approved', providerRef: `sim:${request.idempotencyKey}`, paidCents: request.amountCents };

const provider: PaymentProvider = {
  name: 'simulado',
  charge: async (request) => {
    requests.push(request);
    return answer(request);
  },
  refund: async () => { throw new Error('the API never refunds a charge'); }
};

// Makes a statement of the database refuse the way the database does, so the routes' translation is proved end to end.
const faulty = (database: DatabaseClient): DatabaseClient => new Proxy(database, {
  get(target, property, receiver) {
    if (property === 'transaction') {
      return (work: (transaction: Transaction) => Promise<unknown>) => target.transaction((transaction) => work(new Proxy(transaction, {
        get(inner, name, innerReceiver) {
          if (name === 'raw') {
            return (statement: string, bindings?: Parameters<Transaction['raw']>[1]) => {
              if (fault !== undefined && fault.pattern.test(statement)) throw Object.assign(new Error(`detail of ${fault.code}: secret-detail`), { code: fault.code });
              return inner.raw(statement, bindings ?? []);
            };
          }
          const value = Reflect.get(inner, name, innerReceiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
        }
      })));
    }
    if (property === 'knex') return target.knex;
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  }
});

let app: TestApp;
let world: World;
let owner: Person;
let agency: string;

const base = `/agencies`;
const sub = (agencyId: string): string => `${base}/${agencyId}/subscription`;
const essencial = { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 };
const errorOf = (response: { json: () => unknown }): { code: string; message: string } => (response.json() as { error: { code: string; message: string } }).error;
const payUrl = (agencyId: string, chargeId: string): string => `${sub(agencyId)}/charges/${chargeId}/simulated-payment`;
const open = async (who: Person, agencyId: string, change: Record<string, unknown> = essencial): Promise<string> => {
  const response = await world.call(who, 'POST', `${sub(agencyId)}/charges`, change);
  expect(response.statusCode).toBe(201);
  return response.json<{ chargeId: string }>().chargeId;
};
const pay = (who: Person, agencyId: string, chargeId: string, outcome: 'approved' | 'declined') => world.call(who, 'POST', payUrl(agencyId, chargeId), { outcome });
const rowOf = async (chargeId: string): Promise<{ status: string; declined_at: Date | null }> =>
  await world.owner.knex('subscription_charges').where({ id: chargeId }).first('status', 'declined_at') as { status: string; declined_at: Date | null };
const invoiceStates = async (who: Person, agencyId: string): Promise<Array<[string, string]>> =>
  (await world.call(who, 'GET', `${sub(agencyId)}/invoices`)).json<{ data: Array<{ id: string; status: string }> }>().data.map((invoice) => [invoice.id, invoice.status]);
const fresh = async (): Promise<{ owner: Person; agency: string }> => {
  const person = await world.person('exit-payer');
  return { owner: person, agency: await world.agency(person) };
};
const declining = (): number => recorder.running(/decline_subscription_charge/).length;

beforeAll(async () => {
  app = await buildTestApp({ wrapDatabase: (database) => recorder.wrap(faulty(database)), paymentProvider: provider });
  world = createWorld(() => app);
  owner = await world.person('exit-owner');
  agency = await world.agency(owner);
});

afterAll(async () => {
  await world.teardown();
  await app.close();
});

beforeEach(() => {
  recorder.reset();
  requests.length = 0;
  answer = approve;
  fault = undefined;
});

describe('every way out of the payment', () => {
  it('approved: the plan changes, the charge is paid, and nothing is recorded as a refusal', async () => {
    const { owner, agency } = await fresh();
    const chargeId = await open(owner, agency);
    recorder.reset();
    expect((await pay(owner, agency, chargeId, 'approved')).json()).toEqual({ status: 'confirmed' });
    expect(declining()).toBe(0);
    expect(await rowOf(chargeId)).toMatchObject({ status: 'confirmed', declined_at: null });
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'essencial' });
    expect((await invoiceStates(owner, agency))[0]).toEqual([chargeId, 'paid']);
  });

  it('declined: nothing changes but the charge, which records the refusal once, in a transaction of its own, and shows as declined', async () => {
    const { owner, agency } = await fresh();
    const chargeId = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    recorder.reset();
    const response = await pay(owner, agency, chargeId, 'declined');
    expect(response.json()).toEqual({ status: 'declined' });
    expect(declining()).toBe(1);
    const decline = recorder.running(/decline_subscription_charge/)[0]!;
    expect(decline.statements.filter((statement) => /subscription|simulated_period/i.test(statement))).toHaveLength(1);
    expect(decline.statements[0]).toMatch(/bind_actor/);
    expect(recorder.running(/confirm_subscription_charge|request_subscription_change|renew_subscription/)).toEqual([]);
    expect(await rowOf(chargeId)).toMatchObject({ status: 'pending' });
    expect((await rowOf(chargeId)).declined_at).toBeInstanceOf(Date);
    expect(await world.subscriptionOf(agency)).toBeUndefined();
    expect((await invoiceStates(owner, agency))[0]).toEqual([chargeId, 'declined']);
  });

  it('declined, then the entry that follows: the same charge is refused without the provider, and a new one is paid', async () => {
    const { owner, agency } = await fresh();
    const declined = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    await pay(owner, agency, declined, 'declined');
    requests.length = 0;
    recorder.reset();
    for (const outcome of ['declined', 'approved'] as const) {
      const again = await pay(owner, agency, declined, outcome);
      expect(again.statusCode, outcome).toBe(409);
      expect(errorOf(again).code, outcome).toBe('CHARGE_NOT_OPEN');
    }
    expect(requests).toEqual([]);
    expect(declining()).toBe(0);
    expect(recorder.running(/confirm_subscription_charge/)).toEqual([]);

    const retry = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect(retry).not.toBe(declined);
    expect((await pay(owner, agency, retry, 'declined')).json()).toEqual({ status: 'declined' });
    const last = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect((await pay(owner, agency, last, 'approved')).json()).toEqual({ status: 'confirmed' });
    expect(await world.subscriptionOf(agency)).toMatchObject({ plan_key: 'profissional' });
    expect((await invoiceStates(owner, agency)).slice(0, 3)).toEqual([[last, 'paid'], [retry, 'declined'], [declined, 'declined']]);
  });

  it('failed: a provider that breaks, or that answers a bad reference, leaves the charge open, unrecorded and payable', async () => {
    const { owner, agency } = await fresh();
    const chargeId = await open(owner, agency, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });
    for (const broken of [
      () => { throw new Error('the provider is down'); },
      () => ({ status: 'approved', providerRef: '', paidCents: 1 }) as ChargeResult
    ]) {
      answer = broken;
      recorder.reset();
      const response = await pay(owner, agency, chargeId, 'approved');
      expect(response.statusCode).toBe(502);
      expect(errorOf(response).code).toBe('PAYMENT_PROVIDER_FAILED');
      expect(declining()).toBe(0);
      expect(await rowOf(chargeId)).toMatchObject({ status: 'pending', declined_at: null });
      expect((await invoiceStates(owner, agency))[0]).toEqual([chargeId, 'open']);
    }
    answer = approve;
    expect((await pay(owner, agency, chargeId, 'approved')).json()).toEqual({ status: 'confirmed' });
  });

  it('abandoned: a charge nobody paid expires, shows as expired, is refused without the provider, and a new request opens another', async () => {
    const { owner, agency } = await fresh();
    const abandoned = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    await world.owner.knex('subscription_charges').where({ id: abandoned }).update({ expires_at: new Date(Date.now() - 1000) });
    expect((await invoiceStates(owner, agency))[0]).toEqual([abandoned, 'expired']);
    requests.length = 0;
    const late = await pay(owner, agency, abandoned, 'approved');
    expect(late.statusCode).toBe(409);
    expect(errorOf(late).code).toBe('CHARGE_NOT_OPEN');
    expect(await rowOf(abandoned)).toMatchObject({ declined_at: null });
    const replacement = await open(owner, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect(replacement).not.toBe(abandoned);
    expect((await pay(owner, agency, replacement, 'approved')).json()).toEqual({ status: 'confirmed' });
  });
});

describe('what the database refuses with, as the routes tell it', () => {
  it('answers 409 CHARGE_NOT_OPEN, not the declined of the provider, when the charge ran out between the provider\'s answer and the record', async () => {
    const chargeId = await open(owner, agency, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });
    answer = async (request) => {
      await world.owner.knex('subscription_charges').where({ id: request.idempotencyKey }).update({ expires_at: new Date(Date.now() - 1000) });
      return { status: 'declined', reason: 'card_declined' };
    };
    const response = await pay(owner, agency, chargeId, 'declined');
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('CHARGE_NOT_OPEN');
    expect(await rowOf(chargeId)).toMatchObject({ declined_at: null });
    expect((await invoiceStates(owner, agency))[0]).toEqual([chargeId, 'expired']);
  });

  it.each([
    ['A0125', 409, 'CHARGE_NOT_OPEN'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN'],
    ['42501', 403, 'FORBIDDEN']
  ])('answers %s from the record of a refusal with %i %s, never a 500 and never the detail', async (code, status, publicCode) => {
    const chargeId = await open(owner, agency, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });
    fault = { pattern: /decline_subscription_charge/, code };
    const response = await pay(owner, agency, chargeId, 'declined');
    expect(response.statusCode).toBe(status);
    expect(errorOf(response).code).toBe(publicCode);
    expect(response.body).not.toMatch(/secret-detail|detail of/);
    fault = undefined;
    expect(await rowOf(chargeId)).toMatchObject({ declined_at: null });
  });

  it('answers A0114 of the confirmation with 409 CHARGE_NOT_OPEN, and A0124 of the card with 400 in Portuguese', async () => {
    const chargeId = await open(owner, agency, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });
    fault = { pattern: /confirm_subscription_charge/, code: 'A0114' };
    const confirmation = await pay(owner, agency, chargeId, 'approved');
    expect(confirmation.statusCode).toBe(409);
    expect(errorOf(confirmation).code).toBe('CHARGE_NOT_OPEN');

    fault = { pattern: /save_agency_test_card/, code: 'A0124' };
    const card = await app.app.inject({
      method: 'PUT', url: `${sub(agency)}/test-card`, headers: { origin: TEST_APP_PUBLIC_URL, cookie: owner.cookie },
      payload: { last4: '7391', expMonth: 8, expYear: 2028, brand: 'test' }
    });
    expect(card.statusCode).toBe(400);
    expect(errorOf(card)).toMatchObject({ code: 'TEST_CARD_INVALID', message: expect.stringMatching(/cartão de teste/) });
    expect(card.body).not.toMatch(/secret-detail|detail of|7391/);

    for (const code of ['42501', '40P01']) {
      fault = { pattern: /save_agency_test_card/, code };
      const refused = await app.app.inject({
        method: 'PUT', url: `${sub(agency)}/test-card`, headers: { origin: TEST_APP_PUBLIC_URL, cookie: owner.cookie },
        payload: { last4: '7391', expMonth: 8, expYear: 2028, brand: 'test' }
      });
      expect(refused.statusCode, code).toBe(code === '42501' ? 403 : 409);
      expect(refused.body, code).not.toMatch(/secret-detail|detail of/);
    }
  });
});
