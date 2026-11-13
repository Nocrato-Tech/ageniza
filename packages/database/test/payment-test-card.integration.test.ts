import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { buildBillingWorld, type BillingWorld } from './support/billing-people.js';
import { createHarness } from './support/subscriptions.js';

// Scope redesign-igual, subtask W5-S1: the test card of an agency (decision 2026-11-11, "pagamento simulado no dev"). The table keeps the
// last four digits, the expiry and the brand `test`; the application role reads it through the policy of `assinatura.gerenciar` and writes
// it only through `save_agency_test_card`.
const h = createHarness('payment-test-card');
const owner = () => h.owner();

const CARD = { last4: '4242', expMonth: 8, expYear: 2028, brand: 'test' } as const;
type Card = { last4: unknown; expMonth: unknown; expYear: unknown; brand: unknown };
interface SavedCard { last4: string; exp_month: number; exp_year: number; brand: string }

const agencies: string[] = [];
const worlds: BillingWorld[] = [];

const save = (user: string, agencyId: string, card: Card = CARD): Promise<SavedCard> =>
  h.asUser(user, async (transaction) => (await transaction.raw<{ rows: SavedCard[] }>(
    'select * from app_private.save_agency_test_card(?::uuid, ?, ?::integer, ?::integer, ?)', [agencyId, card.last4, card.expMonth, card.expYear, card.brand]
  )).rows[0]!);

const saveIn = async (transaction: Knex.Transaction, agencyId: string, card: Card = CARD): Promise<SavedCard> =>
  (await transaction.raw<{ rows: SavedCard[] }>(
    'select * from app_private.save_agency_test_card(?::uuid, ?, ?::integer, ?::integer, ?)', [agencyId, card.last4, card.expMonth, card.expYear, card.brand]
  )).rows[0]!;

const COLUMNS = ['agency_id', 'last4', 'exp_month', 'exp_year', 'brand'] as const;
const read = (user: string | undefined, agencyId?: string): Promise<Array<Record<(typeof COLUMNS)[number], unknown>>> => {
  const work = (transaction: Knex.Transaction) => {
    const query = transaction('agency_test_cards').select(...COLUMNS);
    if (agencyId !== undefined) void query.where({ agency_id: agencyId });
    return query;
  };
  return user === undefined ? h.asNobody(work) : h.asUser(user, work);
};

const rowOf = (agencyId: string) => owner()('agency_test_cards').where({ agency_id: agencyId }).first();
const events = (agencyId: string) => owner()('audit.events').where({ agency_id: agencyId, action: 'subscription.test_card_saved' }).orderBy('id');

const newAgency = async () => {
  const world = await h.trialAgency();
  agencies.push(world.agencyId);
  return world;
};

beforeAll(async () => {
  await h.setup();
});

afterAll(async () => {
  try {
    await owner()('agency_test_cards').whereIn('agency_id', agencies).delete();
    for (const world of worlds) await world.cleanUp();
  } finally {
    await h.teardown();
  }
});

describe('who reads and who saves the card (acceptance a)', () => {
  it('lets the Owner save and read the card of the agency, and nobody else with the same words', async () => {
    const world = await buildBillingWorld(h);
    worlds.push(world);
    agencies.push(world.agencyId, world.other.agencyId);
    const { agencyId, ownerId } = world;

    expect(await save(ownerId, agencyId)).toEqual({ last4: '4242', exp_month: 8, exp_year: 2028, brand: 'test' });
    expect(await read(ownerId)).toEqual([{ agency_id: agencyId, last4: '4242', exp_month: 8, exp_year: 2028, brand: 'test' }]);

    for (const { who, user } of world.denied) {
      expect(await read(user), `${who} reads the card`).toEqual([]);
      expect(await read(user, agencyId), `${who} reads the card by agency`).toEqual([]);
      const attempt = user === undefined
        ? h.asNobody((transaction) => saveIn(transaction, agencyId, { ...CARD, last4: '0001' }))
        : save(user, agencyId, { ...CARD, last4: '0001' });
      await expect(attempt, `${who} saves the card`).rejects.toMatchObject({ code: '42501' });
    }
    expect(await rowOf(agencyId)).toMatchObject({ last4: '4242', saved_by_user_id: ownerId });
    expect(await events(agencyId)).toHaveLength(1);
    // The Owner who is also a client's person here still has a card of their own: what stopped them above is the agency, not the person.
    expect(await save(world.other.ownerId, world.other.agencyId, { ...CARD, last4: '5555' })).toMatchObject({ last4: '5555' });
    expect((await read(world.other.ownerId)).map((row) => row.last4)).toEqual(['5555']);
  });

  it('keeps one agency\'s card out of another\'s hands, in both directions, while each Owner keeps their own', async () => {
    const a = await newAgency();
    const b = await newAgency();
    await save(a.ownerId, a.agencyId, { ...CARD, last4: '1111' });
    await save(b.ownerId, b.agencyId, { ...CARD, last4: '2222' });

    expect((await read(a.ownerId)).map((row) => [row.agency_id, row.last4])).toEqual([[a.agencyId, '1111']]);
    expect((await read(b.ownerId)).map((row) => [row.agency_id, row.last4])).toEqual([[b.agencyId, '2222']]);
    expect(await read(b.ownerId, a.agencyId)).toEqual([]);
    await expect(save(b.ownerId, a.agencyId, { ...CARD, last4: '9999' })).rejects.toMatchObject({ code: '42501' });
    await expect(save(a.ownerId, b.agencyId, { ...CARD, last4: '9999' })).rejects.toMatchObject({ code: '42501' });
    expect(await rowOf(a.agencyId)).toMatchObject({ last4: '1111', saved_by_user_id: a.ownerId });
    expect(await rowOf(b.agencyId)).toMatchObject({ last4: '2222', saved_by_user_id: b.ownerId });
  });

  it('lets the Owner of an agency whose trial ended save the card: the purchase starts there', async () => {
    const { agencyId, ownerId } = await newAgency();
    await owner().raw("update public.agencies set trial_ends_at = now() - interval '1 hour' where id = ?", [agencyId]);
    expect(await h.acceptsWrites(agencyId)).toBe(false);
    expect(await save(ownerId, agencyId)).toMatchObject({ last4: '4242' });
    expect(await read(ownerId)).toHaveLength(1);
  });
});

describe('the application role cannot write the table (acceptance b)', () => {
  const TABLE = 'public.agency_test_cards';

  it('has no privilege on the table other than SELECT of the five columns the screen reads', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const { rows } = await owner().raw<{ rows: Array<{ granted: boolean }> }>("select has_table_privilege('ageniza_app', ?::regclass, ?) as granted", [TABLE, privilege]);
      expect(rows[0]!.granted, `table ${privilege}`).toBe(false);
    }
    const { rows: columns } = await owner().raw<{ rows: Array<Record<string, string | boolean>> }>(`
      select a.attname as name,
             has_column_privilege('ageniza_app', ?::regclass, a.attnum, 'SELECT') as can_select,
             has_column_privilege('ageniza_app', ?::regclass, a.attnum, 'INSERT') as can_insert,
             has_column_privilege('ageniza_app', ?::regclass, a.attnum, 'UPDATE') as can_update,
             has_column_privilege('ageniza_app', ?::regclass, a.attnum, 'REFERENCES') as can_reference
      from pg_attribute a where a.attrelid = ?::regclass and a.attnum > 0 and not a.attisdropped order by a.attname
    `, [TABLE, TABLE, TABLE, TABLE, TABLE]);
    expect(columns).toEqual([
      { name: 'agency_id', can_select: true, can_insert: false, can_update: false, can_reference: false },
      { name: 'brand', can_select: true, can_insert: false, can_update: false, can_reference: false },
      { name: 'exp_month', can_select: true, can_insert: false, can_update: false, can_reference: false },
      { name: 'exp_year', can_select: true, can_insert: false, can_update: false, can_reference: false },
      { name: 'last4', can_select: true, can_insert: false, can_update: false, can_reference: false },
      { name: 'saved_at', can_select: false, can_insert: false, can_update: false, can_reference: false },
      { name: 'saved_by_user_id', can_select: false, can_insert: false, can_update: false, can_reference: false }
    ]);
    const { rows: flags } = await owner().raw<{ rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> }>(
      'select relrowsecurity, relforcerowsecurity from pg_class where oid = ?::regclass', [TABLE]
    );
    expect(flags[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('refuses a real INSERT, UPDATE and DELETE of the Owner, by privilege and not by a policy', async () => {
    const { agencyId, ownerId } = await newAgency();
    await save(ownerId, agencyId);
    const attempts: Array<[string, (transaction: Knex.Transaction) => Promise<unknown>]> = [
      ['insert', (t) => t('agency_test_cards').insert({ agency_id: agencyId, last4: '1234', exp_month: 1, exp_year: 2030, saved_by_user_id: ownerId })],
      ['update of the digits', (t) => t('agency_test_cards').where({ agency_id: agencyId }).update({ last4: '9999' })],
      ['update of the actor', (t) => t('agency_test_cards').where({ agency_id: agencyId }).update({ saved_by_user_id: ownerId })],
      ['update of the date', (t) => t('agency_test_cards').where({ agency_id: agencyId }).update({ saved_at: new Date('2000-01-01') })],
      ['delete', (t) => t('agency_test_cards').where({ agency_id: agencyId }).delete()],
      ['truncate', (t) => t.raw('truncate public.agency_test_cards')]
    ];
    for (const [name, attempt] of attempts) {
      await expect(h.asUser(ownerId, attempt), name).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table agency_test_cards') });
    }
    await expect(h.asUser(ownerId, (t) => t('agency_test_cards').select('saved_by_user_id'))).rejects.toMatchObject({ code: '42501' });
    await expect(h.asUser(ownerId, (t) => t('agency_test_cards').select('saved_at'))).rejects.toMatchObject({ code: '42501' });
    expect(await rowOf(agencyId)).toMatchObject({ last4: '4242', exp_month: 8, exp_year: 2028, saved_by_user_id: ownerId });
  });

  it('keeps the writer closed to PUBLIC, open to the application role, a definer with a fixed search_path, and the only one of its name', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ proname: string; public_exec: boolean; app_exec: boolean; definer: boolean; fixed_path: boolean }> }>(`
      select p.proname, has_function_privilege('public', p.oid, 'execute') as public_exec, has_function_privilege('ageniza_app', p.oid, 'execute') as app_exec,
             p.prosecdef as definer, coalesce(p.proconfig @> array['search_path=""'], false) as fixed_path
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname like '%test\\_card%' and n.nspname in ('public', 'app_private')
    `);
    expect(rows).toEqual([{ proname: 'save_agency_test_card', public_exec: false, app_exec: true, definer: true, fixed_path: true }]);
  });
});

describe('what the card can hold (acceptance c)', () => {
  it('has exactly the columns of a test card and none for a number, a security code or a name', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ column_name: string; data_type: string }> }>(
      "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'agency_test_cards' order by column_name"
    );
    expect(rows).toEqual([
      { column_name: 'agency_id', data_type: 'uuid' },
      { column_name: 'brand', data_type: 'text' },
      { column_name: 'exp_month', data_type: 'integer' },
      { column_name: 'exp_year', data_type: 'integer' },
      { column_name: 'last4', data_type: 'text' },
      { column_name: 'saved_at', data_type: 'timestamp with time zone' },
      { column_name: 'saved_by_user_id', data_type: 'uuid' }
    ]);
  });

  it('takes no parameter for a number, a code or a name, and answers with the four values it keeps', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ arguments: string; result: string }> }>(`
      select pg_get_function_identity_arguments(p.oid) as arguments, pg_get_function_result(p.oid) as result
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' and p.proname = 'save_agency_test_card'
    `);
    expect(rows).toEqual([{
      arguments: 'p_agency_id uuid, p_last4 text, p_exp_month integer, p_exp_year integer, p_brand text',
      result: 'TABLE(last4 text, exp_month integer, exp_year integer, brand text)'
    }]);
  });

  describe('refuses with A0124, writes nothing and keeps the card it replaces', () => {
    const REFUSED: Array<[string, Card]> = [
      ['three digits', { ...CARD, last4: '424' }],
      ['five digits', { ...CARD, last4: '42424' }],
      ['an empty last four', { ...CARD, last4: '' }],
      ['a letter among the digits', { ...CARD, last4: '42a2' }],
      ['digits and a letter in front', { ...CARD, last4: 'x4242' }],
      ['digits and a letter behind', { ...CARD, last4: '4242x' }],
      ['a space in front', { ...CARD, last4: ' 424' }],
      ['a line break behind', { ...CARD, last4: '4242\n' }],
      ['digits of another script', { ...CARD, last4: '٤٢٤٢' }],
      ['a null last four', { ...CARD, last4: null }],
      ['month zero', { ...CARD, expMonth: 0 }],
      ['month thirteen', { ...CARD, expMonth: 13 }],
      ['a negative month', { ...CARD, expMonth: -1 }],
      ['a month far beyond any range', { ...CARD, expMonth: 70_000 }],
      ['a null month', { ...CARD, expMonth: null }],
      ['year 1999', { ...CARD, expYear: 1999 }],
      ['year 2100', { ...CARD, expYear: 2100 }],
      ['a year of two digits', { ...CARD, expYear: 28 }],
      ['a null year', { ...CARD, expYear: null }],
      ['the brand of a real network', { ...CARD, brand: 'visa' }],
      ['the brand in capitals', { ...CARD, brand: 'TEST' }],
      ['the brand with a space', { ...CARD, brand: 'test ' }],
      ['an empty brand', { ...CARD, brand: '' }],
      ['a null brand', { ...CARD, brand: null }]
    ];

    let filled: { agencyId: string; ownerId: string };
    let empty: { agencyId: string; ownerId: string };
    beforeAll(async () => {
      filled = await newAgency();
      empty = await newAgency();
      await save(filled.ownerId, filled.agencyId, { last4: '1111', expMonth: 2, expYear: 2031, brand: 'test' });
    });

    it.each(REFUSED)('%s', async (_name, card) => {
      const before = await rowOf(filled.agencyId);
      await expect(save(filled.ownerId, filled.agencyId, card)).rejects.toMatchObject({ code: 'A0124' });
      expect(await rowOf(filled.agencyId)).toEqual(before);
      expect(await events(filled.agencyId)).toHaveLength(1);

      await expect(save(empty.ownerId, empty.agencyId, card)).rejects.toMatchObject({ code: 'A0124' });
      expect(await rowOf(empty.agencyId)).toBeUndefined();
      expect(await events(empty.agencyId)).toEqual([]);
    });

    it('turns it into the error of the permission first: a person who cannot save learns nothing about the value', async () => {
      const { agencyId } = await newAgency();
      const stranger = await h.person();
      await expect(save(stranger, agencyId, { ...CARD, last4: '42' })).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('accepts the two ends of each range: the last digits 0000 and 9999, months 1 and 12, years 2000 and 2099', async () => {
    const { agencyId, ownerId } = await newAgency();
    for (const card of [
      { last4: '0000', expMonth: 1, expYear: 2000, brand: 'test' },
      { last4: '9999', expMonth: 12, expYear: 2099, brand: 'test' }
    ]) {
      expect(await save(ownerId, agencyId, card)).toEqual({ last4: card.last4, exp_month: card.expMonth, exp_year: card.expYear, brand: 'test' });
    }
  });

  // The rules live once, in the CHECKs: the writer asks the table. So each one is also attacked on the table itself, as the schema owner.
  it.each([
    ['agency_test_cards_last4_check', { last4: '424' }],
    ['agency_test_cards_last4_check', { last4: '4242x' }],
    ['agency_test_cards_exp_month_check', { exp_month: 13 }],
    ['agency_test_cards_exp_month_check', { exp_month: 0 }],
    ['agency_test_cards_exp_year_check', { exp_year: 2100 }],
    ['agency_test_cards_exp_year_check', { exp_year: 1999 }],
    ['agency_test_cards_brand_check', { brand: 'visa' }]
  ])('stops %s on the table too, whoever writes: %j', async (constraint, change) => {
    const { agencyId, ownerId } = await newAgency();
    await expect(owner()('agency_test_cards').insert({ agency_id: agencyId, last4: '4242', exp_month: 8, exp_year: 2028, saved_by_user_id: ownerId, ...change }))
      .rejects.toMatchObject({ code: '23514', constraint });
  });
});

describe('Trocar replaces the card (acceptance d)', () => {
  it('leaves one row with the values, the actor and the date of the last save', async () => {
    const { agencyId, ownerId } = await newAgency();
    await save(ownerId, agencyId, { last4: '1111', expMonth: 1, expYear: 2027, brand: 'test' });
    const first = (await rowOf(agencyId))!;
    expect(first).toMatchObject({ last4: '1111', exp_month: 1, exp_year: 2027, brand: 'test', saved_by_user_id: ownerId });

    // The agency changes hands: the actor of the next save is the new Owner, taken from the transaction and not from anything the caller sends.
    const newOwner = await h.person();
    await owner()('agencies').where({ id: agencyId }).update({ owner_user_id: newOwner });
    const replaced = await save(newOwner, agencyId, { last4: '2222', expMonth: 12, expYear: 2099, brand: 'test' });
    expect(replaced).toEqual({ last4: '2222', exp_month: 12, exp_year: 2099, brand: 'test' });

    const rows = await owner()('agency_test_cards').where({ agency_id: agencyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ last4: '2222', exp_month: 12, exp_year: 2099, brand: 'test', saved_by_user_id: newOwner });
    expect(rows[0].saved_at.getTime()).toBeGreaterThan(first.saved_at.getTime());
    expect(await read(newOwner)).toEqual([{ agency_id: agencyId, last4: '2222', exp_month: 12, exp_year: 2099, brand: 'test' }]);
    expect(await read(ownerId)).toEqual([]);
  });

  it('keeps one row when the same card is saved again, and still stamps the date', async () => {
    const { agencyId, ownerId } = await newAgency();
    await save(ownerId, agencyId);
    const first = (await rowOf(agencyId))!;
    await save(ownerId, agencyId);
    const rows = await owner()('agency_test_cards').where({ agency_id: agencyId });
    expect(rows).toHaveLength(1);
    expect(rows[0].saved_at.getTime()).toBeGreaterThan(first.saved_at.getTime());
  });

  it('serializes two saves at the same time: one row, the second one wins, no duplicate and no deadlock', async () => {
    const { agencyId, ownerId } = await newAgency();
    const first = await h.openTransactionAs(ownerId);
    const firstPid = await backendPid(first);
    let second: Promise<SavedCard | unknown> | undefined;
    try {
      expect(await saveIn(first, agencyId, { last4: '1111', expMonth: 1, expYear: 2027, brand: 'test' })).toMatchObject({ last4: '1111' });
      second = h.asUser(ownerId, (transaction) => saveIn(transaction, agencyId, { last4: '2222', expMonth: 2, expYear: 2028, brand: 'test' })).then((card) => card, (error: unknown) => error);
      // The second one is stopped by the first one's row, and only by it.
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }
    expect(await second).toEqual({ last4: '2222', exp_month: 2, exp_year: 2028, brand: 'test' });
    const rows = await owner()('agency_test_cards').where({ agency_id: agencyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ last4: '2222', exp_month: 2, exp_year: 2028, saved_by_user_id: ownerId });
    expect(await events(agencyId)).toHaveLength(2);
  });

  it('serializes two replacements of a card that exists, in both orders of arrival', async () => {
    const { agencyId, ownerId } = await newAgency();
    await save(ownerId, agencyId, { last4: '0000', expMonth: 3, expYear: 2030, brand: 'test' });
    for (const [firstLast4, secondLast4] of [['1111', '2222'], ['3333', '4444']] as const) {
      const first = await h.openTransactionAs(ownerId);
      const firstPid = await backendPid(first);
      let second: Promise<SavedCard | unknown> | undefined;
      try {
        await saveIn(first, agencyId, { last4: firstLast4, expMonth: 4, expYear: 2031, brand: 'test' });
        second = h.asUser(ownerId, (transaction) => saveIn(transaction, agencyId, { last4: secondLast4, expMonth: 5, expYear: 2032, brand: 'test' })).then((card) => card, (error: unknown) => error);
        await waitForBackendsBlockedBy(owner(), firstPid);
      } finally {
        await first.commit();
      }
      expect(await second).toMatchObject({ last4: secondLast4, exp_month: 5, exp_year: 2032 });
      expect(await owner()('agency_test_cards').where({ agency_id: agencyId }).select('last4', 'exp_month')).toEqual([{ last4: secondLast4, exp_month: 5 }]);
    }
  });
});

describe('the audit of a save (acceptance e)', () => {
  it('records one event per save with the actor, the agency and the agency as the target, and no digit, expiry or brand', async () => {
    const { agencyId, ownerId } = await newAgency();
    await save(ownerId, agencyId, { last4: '7391', expMonth: 11, expYear: 2046, brand: 'test' });
    await save(ownerId, agencyId, { last4: '5608', expMonth: 3, expYear: 2051, brand: 'test' });

    const rows = await events(agencyId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ action: 'subscription.test_card_saved', actor_user_id: ownerId, agency_id: agencyId, target_type: 'agency', target_id: agencyId, request_id: null });
    }
    // The table of events has no column that could carry a value: what it holds is the five fields above, and the rest is the id and the time.
    const { rows: columns } = await owner().raw<{ rows: Array<{ column_name: string }> }>(
      "select column_name from information_schema.columns where table_schema = 'audit' and table_name = 'events' order by column_name"
    );
    expect(columns.map((column) => column.column_name)).toEqual(['action', 'actor_user_id', 'agency_id', 'id', 'occurred_at', 'request_id', 'target_id', 'target_type']);
  });

  it('records nothing when the save is refused, and the event goes with the card when the transaction is rolled back', async () => {
    const { agencyId, ownerId } = await newAgency();
    await expect(save(ownerId, agencyId, { ...CARD, last4: '12' })).rejects.toMatchObject({ code: 'A0124' });
    expect(await events(agencyId)).toEqual([]);

    const transaction = await h.openTransactionAs(ownerId);
    await saveIn(transaction, agencyId);
    await transaction.rollback();
    expect(await events(agencyId)).toEqual([]);
    expect(await rowOf(agencyId)).toBeUndefined();
  });
});
