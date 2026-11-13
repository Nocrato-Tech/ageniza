import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, captureLogs, TEST_APP_PUBLIC_URL, type TestApp } from '../auth/test-support/harness.js';
import { cardDataSnapshot } from './test-support/card-data-snapshot.js';
import { buildBillingPeople, type BillingPeople } from './test-support/people.js';
import { createRecorder, createWorld, type Person, type World } from './test-support/world.js';

// Decision 2026-11-11 (items 1 and 2): the agency keeps a test card, only where the simulated payment exists. The database keeps the last four
// digits, the expiry and the brand `test`; the number, the code and the name never reach the server, a log or an audit event.
const recorder = createRecorder();
const logs = captureLogs('debug');
let app: TestApp;
let world: World;
let owner: Person;
let agencyId: string;
let people: BillingPeople;

const url = (agency: string): string => `/agencies/${agency}/subscription/test-card`;
const errorCode = (response: { json: () => unknown }): string => (response.json() as { error: { code: string } }).error.code;
const card = { last4: '7391', expMonth: 8, expYear: 2028, brand: 'test' };
const TEST_CARD_STATEMENT = /test_card|agency_test_cards/;

const savedCard = async (agency: string): Promise<Array<Record<string, unknown>>> =>
  await world.owner.knex('agency_test_cards').where({ agency_id: agency }).select('last4', 'exp_month', 'exp_year', 'brand') as Array<Record<string, unknown>>;
const auditCount = async (agency: string): Promise<number> =>
  Number((await world.owner.knex.raw("select count(*) as total from audit.events where agency_id = ? and action = 'subscription.test_card_saved'", [agency])).rows[0].total);

beforeAll(async () => {
  app = await buildTestApp({ wrapDatabase: recorder.wrap, logger: logs.logger });
  world = createWorld(() => app);
  owner = await world.person('card-owner');
  agencyId = await world.agency(owner);
  people = await buildBillingPeople(world, agencyId, 'card');
});

afterAll(async () => {
  await people.cleanUp();
  await world.teardown();
  await app.close();
});

beforeEach(() => {
  recorder.reset();
});

describe('who reads and who saves the card', () => {
  it('lets the Owner read none, save one, read it, and replace it: one card per agency', async () => {
    const empty = await world.call(owner, 'GET', url(agencyId));
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ card: null });

    const saved = await world.call(owner, 'PUT', url(agencyId), card);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ card });
    expect((await world.call(owner, 'GET', url(agencyId))).json()).toEqual({ card });

    const replacement = { last4: '5560', expMonth: 12, expYear: 2031, brand: 'test' };
    expect((await world.call(owner, 'PUT', url(agencyId), replacement)).json()).toEqual({ card: replacement });
    expect((await world.call(owner, 'GET', url(agencyId))).json()).toEqual({ card: replacement });
    expect(await savedCard(agencyId)).toEqual([{ last4: '5560', exp_month: 12, exp_year: 2031, brand: 'test' }]);
    expect(await auditCount(agencyId)).toBe(2);

    await world.call(owner, 'PUT', url(agencyId), card);
  });

  it('refuses every member without the permission, before any statement of the card runs, and never answers a card that is null', async () => {
    const before = await savedCard(agencyId);
    const audited = await auditCount(agencyId);
    for (const { who, person } of people.members) {
      for (const [method, payload] of [['GET', undefined], ['PUT', { ...card, last4: '0001' }]] as const) {
        recorder.reset();
        const response = await world.call(person, method, url(agencyId), payload);
        expect(response.statusCode, `${who}: ${method}`).toBe(403);
        expect(errorCode(response), `${who}: ${method}`).toBe('FORBIDDEN');
        expect(response.json(), `${who}: ${method}`).not.toHaveProperty('card');
        expect(recorder.running(TEST_CARD_STATEMENT), `${who}: ${method}`).toEqual([]);
      }
    }
    expect(await savedCard(agencyId)).toEqual(before);
    expect(await auditCount(agencyId)).toBe(audited);
  });

  it('answers 404 to everybody who is not a member of the agency, 401 to nobody, and changes nothing', async () => {
    const before = await savedCard(agencyId);
    for (const { who, person } of people.strangers) {
      for (const [method, payload] of [['GET', undefined], ['PUT', { ...card, last4: '0002' }]] as const) {
        recorder.reset();
        const response = await world.call(person, method, url(agencyId), payload);
        expect(response.statusCode, `${who}: ${method}`).toBe(404);
        expect(response.json(), `${who}: ${method}`).not.toHaveProperty('card');
        expect(recorder.running(TEST_CARD_STATEMENT), `${who}: ${method}`).toEqual([]);
      }
    }
    for (const [method, payload] of [['GET', undefined], ['PUT', card]] as const) {
      expect((await world.call(undefined, method, url(agencyId), payload)).statusCode, method).toBe(401);
    }
    expect(await savedCard(agencyId)).toEqual(before);
  });

  it('shows the Owner of another agency only that agency\'s own card, and lets them save only there', async () => {
    const { crossDual, otherAgencyId } = people;
    expect((await world.call(crossDual, 'GET', url(otherAgencyId))).json()).toEqual({ card: null });
    const theirs = { last4: '9902', expMonth: 3, expYear: 2030, brand: 'test' };
    expect((await world.call(crossDual, 'PUT', url(otherAgencyId), theirs)).json()).toEqual({ card: theirs });
    expect((await world.call(owner, 'GET', url(agencyId))).json()).toEqual({ card });
    expect(await savedCard(otherAgencyId)).toEqual([{ last4: '9902', exp_month: 3, exp_year: 2030, brand: 'test' }]);
  });
});

describe('an Owner of two agencies', () => {
  it('reads and saves the card of the agency of the route and no other', async () => {
    const both = await world.person('card-both');
    const first = await world.agency(both);
    const second = await world.plainAgency(both.user.id);
    const firstCard = { last4: '1357', expMonth: 5, expYear: 2029, brand: 'test' };
    expect((await world.call(both, 'PUT', url(first), firstCard)).json()).toEqual({ card: firstCard });
    expect((await world.call(both, 'GET', url(second))).json()).toEqual({ card: null });
    const secondCard = { last4: '2468', expMonth: 6, expYear: 2030, brand: 'test' };
    expect((await world.call(both, 'PUT', url(second), secondCard)).json()).toEqual({ card: secondCard });
    expect((await world.call(both, 'GET', url(first))).json()).toEqual({ card: firstCard });
    expect((await world.call(both, 'GET', url(second))).json()).toEqual({ card: secondCard });
  });
});

describe('what the body of a save can carry', () => {
  // Distinctive values, so that finding one anywhere in an answer or a log is proof that it was echoed.
  const NUMBER = '4111111111111111';
  const CODE = '9137';
  const NAME = 'Maria Teste Silva';
  const refused: Array<[string, unknown]> = [
    ['the card number as an extra field', { ...card, number: NUMBER }],
    ['the security code as an extra field', { ...card, cvc: CODE }],
    ['the name as an extra field', { ...card, name: NAME }],
    ['any other extra field', { ...card, extra: 1 }],
    ['all of them together', { ...card, number: NUMBER, cvc: CODE, name: NAME }],
    ['the whole number in place of the last four digits', { ...card, last4: NUMBER }],
    ['five digits', { ...card, last4: '73910' }],
    ['three digits', { ...card, last4: '739' }],
    ['a newline after the digits', { ...card, last4: '7391\n' }],
    ['full-width digits', { ...card, last4: '７３９１' }],
    ['the last four as a number', { ...card, last4: 7391 }],
    ['a month of zero', { ...card, expMonth: 0 }],
    ['a month of thirteen', { ...card, expMonth: 13 }],
    ['a month with a fraction', { ...card, expMonth: 1.5 }],
    ['a month as text', { ...card, expMonth: '08' }],
    ['the year 1999', { ...card, expYear: 1999 }],
    ['the year 2100', { ...card, expYear: 2100 }],
    ['a real brand', { ...card, brand: 'visa' }],
    ['no brand', { last4: card.last4, expMonth: card.expMonth, expYear: card.expYear }],
    ['no last four', { expMonth: card.expMonth, expYear: card.expYear, brand: 'test' }],
    ['an empty body', {}],
    ['a list', [card]],
    ['null', null]
  ];

  it.each(refused)('refuses %s with 400, before the database, without repeating a value, and keeps the card', async (_label, body) => {
    const before = await savedCard(agencyId);
    const audited = await auditCount(agencyId);
    recorder.reset();
    const response = await app.app.inject({
      method: 'PUT', url: url(agencyId), headers: { origin: TEST_APP_PUBLIC_URL, cookie: owner.cookie, 'content-type': 'application/json' }, payload: JSON.stringify(body)
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('VALIDATION_ERROR');
    for (const secret of [NUMBER, CODE, NAME, '73910', '７３９１']) {
      expect(response.body, `the answer repeats ${secret}`).not.toContain(secret);
    }
    // A short run of digits turns up by chance in a timestamp or an identifier of a log line, so only the value as a JSON string counts there.
    for (const secret of [NUMBER, NAME, '７３９１', `"${CODE}"`, '"73910"']) expect(logs.text(), `the log repeats ${secret}`).not.toContain(secret);
    expect(recorder.running(TEST_CARD_STATEMENT)).toEqual([]);
    expect(await savedCard(agencyId)).toEqual(before);
    expect(await auditCount(agencyId)).toBe(audited);
  });

  it('refuses a __proto__ field out of the JSON text', async () => {
    const response = await app.app.inject({
      method: 'PUT', url: url(agencyId), headers: { origin: TEST_APP_PUBLIC_URL, cookie: owner.cookie, 'content-type': 'application/json' },
      payload: `{"last4":"7391","expMonth":8,"expYear":2028,"brand":"test","__proto__":{"number":"${NUMBER}"}}`
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(NUMBER);
  });

  it('keeps the digits out of the logs and the answers even when the save works', async () => {
    const response = await world.call(owner, 'PUT', url(agencyId), card);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<{ card: Record<string, unknown> }>().card).sort()).toEqual(['brand', 'expMonth', 'expYear', 'last4']);
    expect(logs.text()).not.toContain('"7391"');
    expect(logs.text()).not.toContain('last4');
  });
});

describe('where a card may live', () => {
  // The rule of the decision: the last four digits, the expiry and the test brand are kept, in `agency_test_cards`, and nothing else of a card anywhere.
  it('keeps nothing of the card but its four values in the table of the card, and none of them in the charges, the subscription or the audit', async () => {
    const payer = await world.person('card-payer');
    const agency = await world.agency(payer);
    expect((await world.call(payer, 'PUT', url(agency), card)).statusCode).toBe(200);
    const opened = await world.call(payer, 'POST', `/agencies/${agency}/subscription/charges`, { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 });
    const paid = await world.call(payer, 'POST', `/agencies/${agency}/subscription/charges/${opened.json<{ chargeId: string }>().chargeId}/simulated-payment`, { outcome: 'approved' });
    expect(paid.json()).toEqual({ status: 'confirmed' });

    const elsewhere = cardDataSnapshot([
      await world.chargesOf(agency),
      await world.subscriptionOf(agency),
      (await world.owner.knex.raw('select * from audit.events where agency_id = ?', [agency])).rows
    ]);
    expect(elsewhere).not.toMatch(/4111|card|cart/i);
    expect(elsewhere).not.toContain('"7391"');
    expect(elsewhere).not.toContain('last4');

    const columns = (await world.owner.knex.raw("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'agency_test_cards' order by column_name")).rows
      .map((row: { column_name: string }) => row.column_name);
    expect(columns).toEqual(['agency_id', 'brand', 'exp_month', 'exp_year', 'last4', 'saved_at', 'saved_by_user_id']);
    const audit = (await world.owner.knex.raw("select action, actor_user_id, agency_id, target_type, target_id from audit.events where agency_id = ? and action = 'subscription.test_card_saved'", [agency])).rows;
    expect(audit).toEqual([{ action: 'subscription.test_card_saved', actor_user_id: payer.user.id, agency_id: agency, target_type: 'agency', target_id: agency }]);
  });
});

describe('the card exists only where the simulated payment does', () => {
  const asOwner = (target: TestApp, method: 'GET' | 'PUT', payload?: Record<string, unknown>) => target.app.inject({
    method, url: url(agencyId), headers: { origin: TEST_APP_PUBLIC_URL, cookie: owner.cookie }, ...(payload === undefined ? {} : { payload })
  });

  it('is not registered in production, with a provider handed over, and the invoices still are', async () => {
    const production = await buildTestApp({ subscriptionsProduction: true });
    try {
      expect((await asOwner(production, 'GET')).statusCode).toBe(404);
      expect((await asOwner(production, 'PUT', card)).statusCode).toBe(404);
      expect((await production.app.inject({ method: 'GET', url: `/agencies/${agencyId}/subscription/invoices`, headers: { cookie: owner.cookie } })).statusCode).toBe(200);
    } finally {
      await production.close();
    }
    expect((await savedCard(agencyId))[0]).toMatchObject({ last4: '7391' });
  });

  it('is not registered without a provider, nor with one that is not the simulated one', async () => {
    const bare = await buildTestApp({ paymentProvider: null });
    const real = await buildTestApp({ paymentProvider: {
      name: 'asaas',
      charge: async () => { throw new Error('a real provider is never charged from a test'); },
      refund: async () => { throw new Error('a real provider is never refunded from a test'); }
    } });
    try {
      for (const target of [bare, real]) {
        expect((await asOwner(target, 'GET')).statusCode).toBe(404);
        expect((await asOwner(target, 'PUT', card)).statusCode).toBe(404);
      }
    } finally {
      await bare.close();
      await real.close();
    }
  });
});
