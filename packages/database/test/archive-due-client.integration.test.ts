import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issue #397. The job archives one client per call, each a short transaction of its own, so a deadlock of one
// client does not take the others of the hour down. `due_client_ids()` says who is due and `archive_due_client(id)`
// holds the rule of one client; `archive_due_clients()` is both of them, and the route stays `archive_client`.
const w = createContentWorld('archive-due-client');
const { ids } = w;

const clients: string[] = [];

const sqlText = async (sql: string, bindings: readonly unknown[] = []): Promise<string> => {
  const result = await w.getOwner().knex.raw<{ rows: Array<{ value: string }> }>(sql, [...bindings]);
  return result.rows[0]!.value;
};
const daysFromToday = (days: number): Promise<string> =>
  sqlText("select ((now() at time zone 'America/Sao_Paulo')::date + ?::integer)::text as value", [days]);

const newClient = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  clients.push(id);
  await w.getOwner().knex('clients').insert({ id, agency_id: ids.agencyA, name: `Vencido ${id}`, ...extra });
  return id;
};

const archiveOne = async (clientId: string): Promise<boolean> =>
  (await w.getOwner().knex.raw<{ rows: Array<{ archived: boolean }> }>('select app_private.archive_due_client(?::uuid) as archived', [clientId])).rows[0]!.archived;

const row = async (clientId: string): Promise<{ status: string; archived_at: Date | null; closing_date: string | null }> =>
  (await w.getOwner().knex('clients').where({ id: clientId }).first('status', 'archived_at', w.getOwner().knex.raw('closing_date::text as closing_date'))) as never;

const dueIds = async (): Promise<string[]> =>
  (await w.getOwner().knex.raw<{ rows: Array<{ id: string }> }>('select app_private.due_client_ids() as id')).rows.map((r) => r.id);

beforeAll(async () => { await w.setup(); });
afterAll(async () => {
  const knex = w.getOwner().knex;
  try {
    for (const id of clients) {
      await knex('audit.events').where({ target_id: id }).delete();
      await knex('invitations').where({ client_id: id }).delete();
      await knex('client_memberships').where({ client_id: id }).delete();
      await knex('contents').where({ client_id: id }).delete();
      await knex('clients').where({ id }).delete();
    }
  } finally {
    await w.teardown();
  }
});

describe('app_private.due_client_ids', () => {
  it('lists the active clients whose closing date is past, oldest first, and not today, the future, no date or an archived client', async () => {
    const yesterday = await newClient({ closing_date: await daysFromToday(-1) });
    const longAgo = await newClient({ closing_date: await daysFromToday(-40) });
    const today = await newClient({ closing_date: await daysFromToday(0) });
    const tomorrow = await newClient({ closing_date: await daysFromToday(1) });
    const never = await newClient();
    const archived = await newClient({ status: 'archived', archived_at: new Date() });

    const due = (await dueIds()).filter((id) => clients.includes(id));

    expect(due).toEqual([longAgo, yesterday]);
    for (const id of [today, tomorrow, never, archived]) expect(due, id).not.toContain(id);
  });
});

describe('app_private.archive_due_client', () => {
  it('archives a client whose contract ended, as the job does: no date, the invitation revoked, the event of the job, true', async () => {
    const client = await newClient({ closing_date: await daysFromToday(-1) });
    const invitation = randomUUID();
    await w.getOwner().knex('invitations').insert({
      id: invitation, agency_id: ids.agencyA, purpose: 'client_invite', email: `${invitation}@due.test`, client_id: client,
      token_hash: `hash-${invitation}`, expires_at: new Date(Date.now() + 86_400_000)
    });

    await expect(archiveOne(client)).resolves.toBe(true);

    expect(await row(client)).toMatchObject({ status: 'archived', archived_at: expect.any(Date), closing_date: null });
    expect((await w.getOwner().knex('invitations').where({ id: invitation }).first('revoked_at')).revoked_at).toBeInstanceOf(Date);
    expect(await w.getOwner().knex('audit.events').where({ target_id: client, action: 'client.archived' }).select('actor_user_id', 'request_id'))
      .toEqual([{ actor_user_id: null, request_id: 'job:clients.archive-due' }]);
  });

  it('cancels the content planned after the closing date and keeps what is planned up to it, like the route', async () => {
    const closing = await daysFromToday(-2);
    const client = await newClient({ closing_date: closing });
    const after = await w.seedContent(client, { publishOn: await daysFromToday(3) });
    const onTheLastDay = await w.seedContent(client, { publishOn: closing });

    await expect(archiveOne(client)).resolves.toBe(true);

    expect((await w.contentRow(after)).status).toBe('cancelled');
    expect((await w.contentRow(onTheLastDay)).status).toBe('in_production');
  });

  it.each([
    ['ends today', () => daysFromToday(0)],
    ['ends tomorrow', () => daysFromToday(1)],
    ['has no closing date', async () => undefined]
  ])('answers false and touches nothing for a client that %s', async (_name, closingDate) => {
    const date = await closingDate();
    const client = await newClient(date === undefined ? {} : { closing_date: date });
    const before = await row(client);

    await expect(archiveOne(client)).resolves.toBe(false);

    expect(await row(client)).toEqual(before);
    expect(await w.getOwner().knex('audit.events').where({ target_id: client })).toHaveLength(0);
  });

  it('answers false for a client that is already archived and for an id that does not exist, and archives a due one only once', async () => {
    const archived = await newClient({ status: 'archived', archived_at: new Date(Date.now() - 86_400_000) });
    const before = await row(archived);
    await expect(archiveOne(archived)).resolves.toBe(false);
    expect(await row(archived)).toEqual(before);

    await expect(archiveOne(randomUUID())).resolves.toBe(false);

    const due = await newClient({ closing_date: await daysFromToday(-1) });
    await expect(archiveOne(due)).resolves.toBe(true);
    await expect(archiveOne(due)).resolves.toBe(false);
    expect(await w.getOwner().knex('audit.events').where({ target_id: due, action: 'client.archived' })).toHaveLength(1);
  });

  it('reads the client again after the wait for its lock: one rescheduled into the future meanwhile is left alone', async () => {
    const client = await newClient({ closing_date: await daysFromToday(-1) });
    const tomorrow = await daysFromToday(1);
    const holder = await w.getOwner().knex.transaction();
    let outcome: Promise<boolean> | undefined;
    try {
      const locked = await holder.raw('select id from public.clients where id = ?::uuid for update', [client]);
      expect(locked.rows).toHaveLength(1);
      await holder.raw('update public.clients set closing_date = ?::date where id = ?::uuid', [tomorrow, client]);
      outcome = archiveOne(client);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await holder.commit();
    }

    await expect(outcome).resolves.toBe(false);
    expect(await row(client)).toMatchObject({ status: 'active', archived_at: null, closing_date: tomorrow });
  });

  it('is run by the application role without a user, which is how the worker calls it', async () => {
    const client = await newClient({ closing_date: await daysFromToday(-1) });

    const answer = await w.asUser(ids.portalA1, (t) => t.raw<{ rows: Array<{ archived: boolean }> }>('select app_private.archive_due_client(?::uuid) as archived', [client]));

    expect(answer.rows).toEqual([{ archived: true }]);
    expect((await row(client)).status).toBe('archived');
  });
});

describe('app_private.archive_due_clients, built from the two', () => {
  it('archives every due client and answers how many, leaving the others', async () => {
    const a = await newClient({ closing_date: await daysFromToday(-3) });
    const b = await newClient({ closing_date: await daysFromToday(-1) });
    const today = await newClient({ closing_date: await daysFromToday(0) });

    const answer = await w.getOwner().knex.raw<{ rows: Array<{ archived: number }> }>('select app_private.archive_due_clients() as archived');

    expect(answer.rows[0]!.archived).toBeGreaterThanOrEqual(2);
    expect((await row(a)).status).toBe('archived');
    expect((await row(b)).status).toBe('archived');
    expect((await row(today)).status).toBe('active');
    expect((await dueIds()).filter((id) => clients.includes(id))).toEqual([]);
  });
});
