import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from '../auth/test-support/harness.js';
import { buildBillingPeople, type BillingPeople } from './test-support/people.js';
import { createRecorder, createWorld, type Person, type World } from './test-support/world.js';

// Decision 2026-11-11 (item 3) and 2026-11-12 (item 4): "Ver faturas" lists the charges of the agency, in any environment, with the state of each.
// Only the Owner reads them: the portal and the other agencies never see a cent of it.
const recorder = createRecorder();
let app: TestApp;
let world: World;
let owner: Person;
let agencyId: string;
let people: BillingPeople;

const base = (agency: string): string => `/agencies/${agency}/subscription`;
const invoicesUrl = (agency: string, query = ''): string => `${base(agency)}/invoices${query}`;
const errorCode = (response: { json: () => unknown }): string => (response.json() as { error: { code: string } }).error.code;
const essencial = { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 };

interface Invoice { id: string; date: string; description: string; amountCents: number; status: string }
interface InvoicePage { data: Invoice[]; meta: { page: number; pageSize: number; totalItems: number; totalPages: number } }

const list = async (who: Person, agency: string, query = ''): Promise<InvoicePage> => {
  const response = await world.call(who, 'GET', invoicesUrl(agency, query));
  expect(response.statusCode, query).toBe(200);
  return response.json<InvoicePage>();
};

const open = async (who: Person, agency: string, change: Record<string, unknown> = essencial): Promise<string> => {
  const response = await world.call(who, 'POST', `${base(agency)}/charges`, change);
  expect(response.statusCode).toBe(201);
  return response.json<{ chargeId: string }>().chargeId;
};
const payUrl = (agency: string, chargeId: string): string => `${base(agency)}/charges/${chargeId}/simulated-payment`;

const seedExpired = async (agency: string, requestedBy: string, count: number): Promise<void> => {
  const rows = Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(Date.now() - (index + 10) * 86_400_000);
    return {
      agency_id: agency, kind: 'upgrade', status: 'expired', plan_key: 'essencial', extra_clients: 0, extra_storage_gib: 0, amount_cents: 1000 + index,
      requested_by_user_id: requestedBy, expires_at: new Date(createdAt.getTime() + 1_800_000), created_at: createdAt
    };
  });
  await world.owner.knex('subscription_charges').insert(rows);
};

beforeAll(async () => {
  app = await buildTestApp({ wrapDatabase: recorder.wrap });
  world = createWorld(() => app);
  owner = await world.person('inv-owner');
  agencyId = await world.agency(owner);
  people = await buildBillingPeople(world, agencyId, 'inv');
});

afterAll(async () => {
  await people.cleanUp();
  await world.teardown();
  await app.close();
});

beforeEach(() => {
  recorder.reset();
});

describe('who reads the invoices', () => {
  it('refuses every member without the permission and answers 404 to everybody outside, before any statement of billing, and 401 to nobody', async () => {
    const charge = await open(owner, agencyId);
    for (const { who, person } of people.members) {
      recorder.reset();
      const response = await world.call(person, 'GET', invoicesUrl(agencyId));
      expect(response.statusCode, who).toBe(403);
      expect(errorCode(response), who).toBe('FORBIDDEN');
      expect(response.body, who).not.toContain(charge);
      expect(recorder.billingStatements(), who).toEqual([]);
    }
    for (const { who, person } of people.strangers) {
      recorder.reset();
      const response = await world.call(person, 'GET', invoicesUrl(agencyId));
      expect(response.statusCode, who).toBe(404);
      expect(response.body, who).not.toContain(charge);
      expect(recorder.billingStatements(), who).toEqual([]);
    }
    expect((await world.call(undefined, 'GET', invoicesUrl(agencyId))).statusCode).toBe(401);
    await world.owner.knex('subscription_charges').where({ id: charge }).update({ status: 'expired' });
  });

  it('shows the Owner of another agency, who is a person of a client of this one, only the charges of their own agency', async () => {
    const { crossDual, otherAgencyId } = people;
    expect((await list(crossDual, otherAgencyId)).data).toEqual([]);
    const theirs = await open(crossDual, otherAgencyId);
    expect((await list(crossDual, otherAgencyId)).data.map((invoice) => invoice.id)).toEqual([theirs]);
    expect((await list(owner, agencyId)).data.map((invoice) => invoice.id)).not.toContain(theirs);
    expect((await world.call(crossDual, 'GET', invoicesUrl(agencyId))).statusCode).toBe(404);
    await world.owner.knex('subscription_charges').where({ id: theirs }).update({ status: 'expired' });
  });
});

describe('what an invoice says', () => {
  it('shows paid, declined, expired and open, the newest first, with the plan and the extras written by the server', async () => {
    const payer = await world.person('inv-states');
    const agency = await world.agency(payer);
    const paid = await open(payer, agency);
    expect((await world.call(payer, 'POST', payUrl(agency, paid), { outcome: 'approved' })).json()).toEqual({ status: 'confirmed' });
    const declined = await open(payer, agency, { planKey: 'profissional', extraClients: 5, extraStorageGib: 0 });
    expect((await world.call(payer, 'POST', payUrl(agency, declined), { outcome: 'declined' })).json()).toEqual({ status: 'declined' });
    const lapsed = await open(payer, agency, { planKey: 'profissional', extraClients: 0, extraStorageGib: 30 });
    await world.owner.knex('subscription_charges').where({ id: lapsed }).update({ expires_at: new Date(Date.now() - 1000) });
    const current = await open(payer, agency, { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 });

    const page = await list(payer, agency);
    expect(page.data.map((invoice) => [invoice.id, invoice.status])).toEqual([[current, 'open'], [lapsed, 'expired'], [declined, 'declined'], [paid, 'paid']]);
    expect(page.data.map((invoice) => invoice.description)).toEqual(['Plano Agência', 'Plano Profissional + 30 GB extras', 'Plano Profissional + 5 clientes extras', 'Plano Essencial']);
    expect(page.data.map((invoice) => invoice.amountCents)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number), 9700]);
    expect(page.meta).toEqual({ page: 1, pageSize: 20, totalItems: 4, totalPages: 1 });
    const charges = await world.chargesOf(agency);
    const confirmed = charges.find((charge) => charge.id === paid);
    expect(page.data[3]!.date).toBe((confirmed!.confirmed_at as Date).toISOString());
    expect(page.data[2]!.date).toBe((charges.find((charge) => charge.id === declined)!.created_at as Date).toISOString());
    expect(JSON.stringify(page)).not.toMatch(/provider|requested_by|sim:/);
  });

  it('shows a pending charge whose time ran out as expired even though nothing replaced it, and a declined one as declined', async () => {
    const payer = await world.person('inv-lapsed');
    const agency = await world.agency(payer);
    const lapsed = await open(payer, agency);
    await world.owner.knex('subscription_charges').where({ id: lapsed }).update({ expires_at: new Date(Date.now() - 1000) });
    expect((await world.owner.knex('subscription_charges').where({ id: lapsed }).first('status')).status).toBe('pending');
    expect((await list(payer, agency)).data.map((invoice) => [invoice.id, invoice.status])).toEqual([[lapsed, 'expired']]);

    const declined = await open(payer, agency);
    await world.call(payer, 'POST', payUrl(agency, declined), { outcome: 'declined' });
    await world.owner.knex('subscription_charges').where({ id: declined }).update({ expires_at: new Date(Date.now() - 1000) });
    expect((await list(payer, agency)).data.map((invoice) => [invoice.id, invoice.status])).toEqual([[declined, 'declined'], [lapsed, 'expired']]);
  });

  it('keeps a declined charge declined after the retry replaced it and was paid', async () => {
    const payer = await world.person('inv-retry');
    const agency = await world.agency(payer);
    const first = await open(payer, agency);
    await world.call(payer, 'POST', payUrl(agency, first), { outcome: 'declined' });
    const retry = await open(payer, agency);
    expect((await world.call(payer, 'POST', payUrl(agency, retry), { outcome: 'approved' })).json()).toEqual({ status: 'confirmed' });
    expect((await world.owner.knex('subscription_charges').where({ id: first }).first('status')).status).toBe('expired');
    expect((await list(payer, agency)).data.map((invoice) => [invoice.id, invoice.status])).toEqual([[retry, 'paid'], [first, 'declined']]);
  });
});

describe('the pages of the invoices', () => {
  let payer: Person;
  let agency: string;

  beforeAll(async () => {
    payer = await world.person('inv-pages');
    agency = await world.agency(payer);
    await seedExpired(agency, payer.user.id, 27);
  });

  it('gives 20 a page, the newest first, with the total on every page', async () => {
    const first = await list(payer, agency);
    expect(first.data).toHaveLength(20);
    expect(first.meta).toEqual({ page: 1, pageSize: 20, totalItems: 27, totalPages: 2 });
    const second = await list(payer, agency, '?page=2');
    expect(second.data).toHaveLength(7);
    expect(second.meta).toEqual({ page: 2, pageSize: 20, totalItems: 27, totalPages: 2 });
    const dates = [...first.data, ...second.data].map((invoice) => invoice.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(new Set([...first.data, ...second.data].map((invoice) => invoice.id)).size).toBe(27);
  });

  it('keeps the total when the page is past the end, which comes empty', async () => {
    for (const [query, meta] of [
      ['?page=3', { page: 3, pageSize: 20, totalItems: 27, totalPages: 2 }],
      ['?page=7&pageSize=5', { page: 7, pageSize: 5, totalItems: 27, totalPages: 6 }],
      ['?page=1000', { page: 1000, pageSize: 20, totalItems: 27, totalPages: 2 }]
    ] as const) {
      const page = await list(payer, agency, query);
      expect(page.data, query).toEqual([]);
      expect(page.meta, query).toEqual(meta);
    }
    expect((await list(payer, agency, '?page=6&pageSize=5')).data).toHaveLength(2);
  });

  it('says nothing and zero for an agency with no charge, on the first page and past it', async () => {
    const fresh = await world.person('inv-fresh');
    const freshAgency = await world.agency(fresh);
    expect(await list(fresh, freshAgency)).toEqual({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    expect((await list(fresh, freshAgency, '?page=4')).meta).toEqual({ page: 4, pageSize: 20, totalItems: 0, totalPages: 0 });
  });

  it('caps the page size at 100 and refuses a page that is not a positive safe integer', async () => {
    expect((await list(payer, agency, '?pageSize=500')).meta).toEqual({ page: 1, pageSize: 100, totalItems: 27, totalPages: 1 });
    for (const query of ['?page=0', '?page=-1', '?page=abc', '?page=1e20', '?pageSize=0', '?pageSize=x', '?extra=1']) {
      const response = await world.call(payer, 'GET', invoicesUrl(agency, query));
      expect(response.statusCode, query).toBe(400);
      expect(errorCode(response), query).toBe('VALIDATION_ERROR');
    }
  });

  it('shows an Owner of two agencies the charges of the agency of the route and the total of that agency alone', async () => {
    const both = await world.person('inv-both');
    const first = await world.agency(both);
    const second = await world.plainAgency(both.user.id);
    await seedExpired(first, both.user.id, 2);
    await seedExpired(second, both.user.id, 5);
    const ofFirst = await list(both, first);
    const ofSecond = await list(both, second);
    expect([ofFirst.data.length, ofFirst.meta.totalItems, ofSecond.data.length, ofSecond.meta.totalItems]).toEqual([2, 2, 5, 5]);
    expect(ofFirst.data.map((invoice) => invoice.id).filter((id) => ofSecond.data.some((other) => other.id === id))).toEqual([]);
    expect((await list(both, first, '?page=2')).meta.totalItems).toBe(2);
  });

  it('never shows the charges of another agency among the totals', async () => {
    const other = await world.person('inv-other');
    const otherAgency = await world.agency(other);
    await seedExpired(otherAgency, other.user.id, 3);
    expect((await list(other, otherAgency)).meta.totalItems).toBe(3);
    expect((await list(payer, agency)).meta.totalItems).toBe(27);
    expect((await list(other, otherAgency, '?page=2')).meta.totalItems).toBe(3);
  });
});
