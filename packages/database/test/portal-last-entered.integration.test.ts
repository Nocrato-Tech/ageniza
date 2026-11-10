import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

import { createContentWorld } from './support/content-world.js';

// Scope telas-melhorias, subtask S2 (decision 2026-11-10, "último acesso ao portal por cliente"): the access of a person to the portal
// of a client keeps the last time that person entered it, by the context of the client or by the approval link of the e-mail.
// `ageniza_app` writes nothing in `client_portal_accesses`: the value is stamped by `record_portal_access_entry`, which the two entrances
// call. Every attack runs as `ageniza_app`; what a function does not reach is attacked as the owner, the only other writer. RLS
// filters silently, so a read is checked by the rows it returns and a write by the state left in the table.
const w = createContentWorld('portal-last-entered');
const { ids } = w;
const { applicationUrl } = resolveIntegrationDatabaseUrls();

let worker: DatabaseClient;
const extraUsers: string[] = [];
const extraClients: string[] = [];

const owner = (): Knex => w.getOwner().knex;
const asApp = <T>(work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> => worker.knex.transaction(work);

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  try {
    const knex = owner();
    await knex('client_portal_approval_links').whereIn('client_id', extraClients).delete();
    await knex('notification_queue').whereIn('client_id', extraClients).delete();
    await knex('client_thread_comments').whereIn('client_id', extraClients).delete();
    await knex('client_threads').whereIn('client_id', extraClients).delete();
    await knex('contents').whereIn('client_id', extraClients).delete();
    await knex('media_folders').whereIn('client_id', extraClients).delete();
    await knex('client_memberships').whereIn('client_id', extraClients).delete();
    await knex('invitations').whereIn('client_id', extraClients).delete();
    await knex('audit.events').whereIn('agency_id', [ids.agencyA]).delete();
    await knex('clients').whereIn('id', extraClients).delete();
    await knex('client_memberships').whereIn('user_id', extraUsers).delete();
    await knex('auth.user').whereIn('id', extraUsers).delete();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

const newUser = async (options: { email?: string; verified?: boolean } = {}): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = options.email ?? `${id}@last-entered.test`;
  extraUsers.push(id);
  await owner()('auth.user').insert({ id, name: `User ${id.slice(0, 8)}`, email, emailVerified: options.verified ?? true });
  return { id, email };
};
const freshEmail = (): string => `${randomUUID()}@last-entered-address.test`;

const freshClient = async (): Promise<string> => {
  const id = randomUUID();
  extraClients.push(id);
  await owner()('clients').insert({ id, agency_id: ids.agencyA, name: `Último acesso ${id}` });
  return id;
};

const call = <T = Record<string, unknown>>(user: string, statement: string, ...bindings: unknown[]): Promise<T[]> =>
  w.asUser(user, async (transaction) => (await transaction.raw<{ rows: T[] }>(statement, bindings as never[])).rows);
const addAs = async (user: string, clientId: string, email: string): Promise<string> =>
  (await call<{ access_id: string }>(user, 'select * from app_private.add_client_portal_access(?::uuid, ?)', clientId, email))[0]!.access_id;
const removeAs = (user: string, accessId: string) => call(user, 'select * from app_private.remove_client_portal_access(?::uuid)', accessId);
const reactivateAs = (user: string, accessId: string) => call(user, 'select * from app_private.reactivate_client_portal_access(?::uuid)', accessId);
const linkAs = async (user: string): Promise<number> =>
  (await call<{ linked: number }>(user, 'select app_private.link_client_portal_accesses() as linked'))[0]!.linked;
const markAs = (user: string, clientId: string) => call(user, 'select app_private.mark_client_portal_entered(?::uuid)', clientId);

interface Entry { first: Date | null; last: Date | null; user_id: string | null }
const entryOf = async (accessId: string): Promise<Entry> => {
  const row = await owner()('client_portal_accesses').where({ id: accessId }).first('first_entered_at', 'last_entered_at', 'user_id');
  return { first: row.first_entered_at as Date | null, last: row.last_entered_at as Date | null, user_id: row.user_id as string | null };
};

/** An account in the portal of a fresh client: the access added by the Admin and linked, not yet entered. */
const accountInPortal = async (): Promise<{ clientId: string; accessId: string; user: { id: string; email: string } }> => {
  const clientId = await freshClient();
  const user = await newUser();
  const accessId = await addAs(ids.adminA, clientId, user.email);
  expect(await linkAs(user.id)).toBe(1);
  return { clientId, accessId, user };
};

const whileReadOnly = async (work: () => Promise<void>): Promise<void> => {
  await owner()('agencies').where({ id: ids.agencyA }).update({
    plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
  });
  try { await work(); } finally {
    await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
  }
};

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const newToken = (): { token: string; hash: string } => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha(token) };
};

/** An access with no account, a content waiting, and the link the e-mail would carry; the session is exchanged by the test. */
const linkOfAccess = async (clientId: string, email = freshEmail()): Promise<{ accessId: string; tokenHash: string }> => {
  const [access] = await owner()('client_portal_accesses').insert({ client_id: clientId, email }).returning('id');
  const content = await w.seedContent(clientId, { status: 'awaiting_approval' });
  const claimToken = randomUUID();
  const item = await owner().raw<{ rows: Array<{ id: string }> }>(`
    insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
    values ('content_awaiting_approval', ?, ?, ?, now() - interval '1 minute', now(), ?, 1) returning id
  `, [clientId, access.id, content, claimToken]);
  const { hash } = newToken();
  await asApp((transaction) => transaction.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [[item.rows[0]!.id], claimToken, hash]));
  return { accessId: access.id as string, tokenHash: hash };
};
const exchange = (tokenHash: string): Promise<unknown> =>
  asApp((transaction) => transaction.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, newToken().hash]));

// ---- the column is stamped by the database ----------------------------------------------------------------------------------

describe('the last entry is born read-only to the application role', () => {
  it('is a nullable timestamp with no default, and the application role may not write the table, on any column', async () => {
    const column = await owner().raw<{ rows: unknown[] }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'client_portal_accesses' and column_name = 'last_entered_at'`
    );
    expect(column.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
    expect(await w.tablePrivileges('client_portal_accesses')).toEqual({
      can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false
    });
    expect(await w.columnsWithPrivilege('client_portal_accesses', 'insert')).toEqual([]);
    expect(await w.columnsWithPrivilege('client_portal_accesses', 'update')).toEqual([]);
  });

  it('refuses a direct write of it as ageniza_app, by the owner of the access and by an Admin, and leaves the row as it was', async () => {
    const { accessId, user } = await accountInPortal();
    for (const actor of [user.id, ids.adminA]) {
      await expect(w.asUser(actor, (t) => t('client_portal_accesses').where({ id: accessId }).update({ last_entered_at: new Date('2030-01-01T00:00:00Z') })))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table client_portal_accesses') });
    }
    expect((await entryOf(accessId)).last).toBeNull();
  });

  const privileges = async (signature: string) =>
    (await owner().raw<{ rows: Array<{ app: boolean; public_acl: boolean; config: string[] | null; definer: boolean }> }>(
      `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
              coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl, p.proconfig as config, p.prosecdef as definer
       from pg_proc p where p.oid = ?::regprocedure`, [signature]
    )).rows[0];

  it('keeps the rule of recording internal, and the two entrances open to the application role as before', async () => {
    expect(await privileges('app_private.record_portal_access_entry(uuid, uuid)')).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: true });
    expect(await privileges('app_private.client_portal_access_last_entry_follows_account()')).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: false });
    for (const signature of ['app_private.mark_client_portal_entered(uuid)', 'app_private.exchange_portal_approval_token(text, text)']) {
      expect(await privileges(signature), signature).toEqual({ app: true, public_acl: false, config: ['search_path=""'], definer: true });
    }
  });

  it('is named by no function but the two that stamp and clear it, so no function of the portal can return it', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ proname: string }> }>(
      "select proname from pg_proc where pronamespace in ('app_private'::regnamespace, 'public'::regnamespace) and prosrc ilike '%last_entered_at%' order by 1"
    );
    expect(rows.map((row) => row.proname)).toEqual(['client_portal_access_last_entry_follows_account', 'record_portal_access_entry']);
    const rowTypes = await owner().raw<{ rows: unknown[] }>(
      "select 1 from pg_proc where pronamespace in ('app_private'::regnamespace, 'public'::regnamespace) and pg_get_function_result(oid) ilike '%client_portal_accesses%'"
    );
    expect(rowTypes.rows).toEqual([]);
  });
});

describe('who reads the last entry', () => {
  it.each([
    ['an Admin', () => ids.adminA],
    ['the Owner of the agency, by ownership', () => ids.ownerA]
  ] as const)('shows %s the value, as the list of the agency does', async (_label, user) => {
    const clientId = await freshClient();
    const email = freshEmail();
    const accessId = await addAs(ids.adminA, clientId, email);
    await owner()('client_portal_accesses').where({ id: accessId }).update({ last_entered_at: new Date('2026-11-01T12:00:00Z') });

    const rows = await w.asUser(user(), (t) => t('client_portal_accesses').where({ client_id: clientId }).select('last_entered_at'));
    expect(rows).toEqual([{ last_entered_at: new Date('2026-11-01T12:00:00Z') }]);
  });

  it.each(['cliente.convidar_usuario', 'cliente.remover_usuario'])('shows it to a role with only %s, the permissions that already read the accesses', async (permission) => {
    const reader = await w.personWith(permission);
    const clientId = await freshClient();
    const accessId = await addAs(ids.adminA, clientId, freshEmail());
    await owner()('client_portal_accesses').where({ id: accessId }).update({ last_entered_at: new Date('2026-11-01T12:00:00Z') });

    expect(await w.asUser(reader, (t) => t('client_portal_accesses').where({ client_id: clientId }).select('last_entered_at')))
      .toEqual([{ last_entered_at: new Date('2026-11-01T12:00:00Z') }]);
  });

  it('shows it to nobody else: not a person of the portal, not even about their own access, and not a collaborator or another agency who holds a link here', async () => {
    const clientId = await freshClient();
    const members = [ids.portalA1, ids.portalA1Second, ids.dualBare, ids.dualFull, ids.crossDual];
    await owner()('client_memberships').insert(members.map((user) => ({ client_id: clientId, user_id: user })));
    await owner()('client_portal_accesses').where({ client_id: clientId }).update({ last_entered_at: new Date('2026-11-01T12:00:00Z') });
    expect(await owner()('client_portal_accesses').where({ client_id: clientId }).whereNotNull('last_entered_at')).toHaveLength(members.length);
    const operarVisualizar = await w.personWith('cliente.operar', 'cliente.visualizar', 'cliente.cadastrar', 'cliente.arquivar');

    for (const user of [...members, ids.portalA2, ids.portalB, ids.adminB, ids.salesA, ids.financeA, ids.productionA, ids.managerA, operarVisualizar]) {
      expect(await w.asUser(user, (t) => t('client_portal_accesses').where({ client_id: clientId }).select('last_entered_at')), String(user)).toEqual([]);
      expect(await w.asUser(user, (t) => t('client_portal_accesses').where({ client_id: clientId }).select('*')), String(user)).toEqual([]);
    }
  });
});

// ---- the entry of the account -------------------------------------------------------------------------------------------------

describe('the account enters the portal of the client (mark_client_portal_entered)', () => {
  it('records the first and the last entry at the same instant, and then moves only the last, forward, at every entry', async () => {
    const { accessId, user, clientId } = await accountInPortal();
    expect(await entryOf(accessId)).toEqual({ first: null, last: null, user_id: user.id });

    await markAs(user.id, clientId);
    const entered = await entryOf(accessId);
    expect(entered.first).toBeInstanceOf(Date);
    expect(entered.last).toEqual(entered.first);

    await markAs(user.id, clientId);
    const again = await entryOf(accessId);
    expect(again.first).toEqual(entered.first);
    expect(again.last!.getTime()).toBeGreaterThan(entered.last!.getTime());

    await markAs(user.id, clientId);
    const third = await entryOf(accessId);
    expect(third.first).toEqual(entered.first);
    expect(third.last!.getTime()).toBeGreaterThan(again.last!.getTime());
  });

  it('never moves it back: a transaction that began before another that already recorded does not write the earlier instant', async () => {
    const { accessId, user, clientId } = await accountInPortal();
    const early = await w.openTransactionAs(user.id);
    try {
      // `now()` is the start of the transaction: this one starts before the entry below and commits after it.
      await early.raw('select now()');
      await markAs(user.id, clientId);
      const later = (await entryOf(accessId)).last!;
      await early.raw('select app_private.mark_client_portal_entered(?::uuid)', [clientId]);
      await early.commit();
      expect((await entryOf(accessId)).last!.getTime()).toBe(later.getTime());
    } finally {
      if (!early.isCompleted()) await early.rollback();
    }
  });

  it('records only the access the account holds, in that client, and only while it is active', async () => {
    const { accessId, user, clientId } = await accountInPortal();
    const other = await freshClient();
    const otherAccess = await addAs(ids.adminA, other, user.email);
    await linkAs(user.id);
    const stranger = await newUser();

    await markAs(stranger.id, clientId);
    expect((await entryOf(accessId)).last).toBeNull();
    await markAs(user.id, other);
    expect((await entryOf(accessId)).last).toBeNull();
    expect((await entryOf(otherAccess)).last).toBeInstanceOf(Date);

    await removeAs(ids.adminA, accessId);
    await markAs(user.id, clientId);
    expect(await entryOf(accessId)).toMatchObject({ first: null, last: null });
    await reactivateAs(ids.adminA, accessId);
    await markAs(user.id, clientId);
    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);
  });

  it('records for an account only the access that account holds, even when the rule is asked for another one', async () => {
    const { accessId } = await accountInPortal();
    const stranger = await newUser();

    await owner().raw('select app_private.record_portal_access_entry(?::uuid, ?::uuid)', [accessId, stranger.id]);
    expect(await entryOf(accessId)).toMatchObject({ first: null, last: null });
  });

  it('needs an account, and leaves a read-only agency alone instead of failing the portal', async () => {
    await expect(worker.knex.raw('select app_private.mark_client_portal_entered(?::uuid)', [ids.clientA1])).rejects.toMatchObject({ code: '42501' });

    const { accessId, user, clientId } = await accountInPortal();
    await whileReadOnly(async () => {
      await markAs(user.id, clientId);
      expect(await entryOf(accessId)).toMatchObject({ first: null, last: null });
    });
    await markAs(user.id, clientId);
    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);
  });
});

// ---- the entry by the approval link -------------------------------------------------------------------------------------------

describe('the person opens the approval link (exchange_portal_approval_token)', () => {
  it('records the last entry of the access of the link, and not the first: the link needs no account', async () => {
    const clientId = await freshClient();
    const { accessId, tokenHash } = await linkOfAccess(clientId);
    expect(await entryOf(accessId)).toEqual({ first: null, last: null, user_id: null });

    await exchange(tokenHash);
    const opened = await entryOf(accessId);
    expect(opened.last).toBeInstanceOf(Date);
    expect(opened).toMatchObject({ first: null, user_id: null });

    await exchange(tokenHash);
    expect((await entryOf(accessId)).last!.getTime()).toBeGreaterThan(opened.last!.getTime());
  });

  it('leaves the first entry of an access that has an account as it is: the account did not enter', async () => {
    const clientId = await freshClient();
    const user = await newUser();
    const { accessId, tokenHash } = await linkOfAccess(clientId, user.email);
    expect(await linkAs(user.id)).toBe(1);
    expect(await entryOf(accessId)).toMatchObject({ first: null, last: null, user_id: user.id });

    await exchange(tokenHash);
    expect(await entryOf(accessId)).toMatchObject({ first: null, user_id: user.id });
    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);
  });

  it('records the access of that link and no other of the same client', async () => {
    const clientId = await freshClient();
    const sibling = await addAs(ids.adminA, clientId, freshEmail());
    const { accessId, tokenHash } = await linkOfAccess(clientId);

    await exchange(tokenHash);

    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);
    expect((await entryOf(sibling)).last).toBeNull();
  });

  it('records nothing when the link is not valid: a removed access, a read-only agency, or a token that does not exist', async () => {
    const clientId = await freshClient();
    const removed = await linkOfAccess(clientId);
    await owner()('client_portal_accesses').where({ id: removed.accessId }).update({ status: 'removed', generation: 2 });
    await expect(exchange(removed.tokenHash)).rejects.toMatchObject({ code: 'A0100' });
    expect((await entryOf(removed.accessId)).last).toBeNull();

    const readOnly = await linkOfAccess(await freshClient());
    await whileReadOnly(async () => {
      await expect(exchange(readOnly.tokenHash)).rejects.toMatchObject({ code: 'A0100' });
    });
    expect((await entryOf(readOnly.accessId)).last).toBeNull();

    await expect(exchange(sha('no such token'))).rejects.toMatchObject({ code: 'A0100' });
  });

  it('is recorded by the exchange only: reading the batch with the session records nothing', async () => {
    const clientId = await freshClient();
    const { accessId, tokenHash } = await linkOfAccess(clientId);
    const session = newToken();
    await asApp((transaction) => transaction.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, session.hash]));
    const recorded = (await entryOf(accessId)).last!;

    await asApp((transaction) => transaction.raw('select * from app_private.portal_approval_batch(?)', [session.hash]));
    await asApp((transaction) => transaction.raw('select * from app_private.portal_approval_contents(?)', [session.hash]));

    expect((await entryOf(accessId)).last).toEqual(recorded);
  });

  it('lets two people open the link of the same access at once without a deadlock, because the access is taken for writing up front', async () => {
    const clientId = await freshClient();
    const { accessId, tokenHash } = await linkOfAccess(clientId);

    // An archive in flight holds the client: both exchanges take the access and then wait for the client. Taken FOR SHARE, the two would
    // hold the access together and both wait to write it once the archive lets go, which is a deadlock.
    const archiving = await owner().transaction();
    const first = await worker.knex.transaction();
    const second = await worker.knex.transaction();
    const outcomes: Array<unknown> = [];
    try {
      expect((await archiving.raw('select id from public.clients where id = ?::uuid for update', [clientId])).rows).toHaveLength(1);
      const pids = [await backendPid(first), await backendPid(second)];
      const run = (transaction: Knex.Transaction) =>
        transaction.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, newToken().hash]).then(() => 'opened', (error: unknown) => error);
      const firstRun = run(first);
      // The second waits for the first on the access; in a world where both held it shared, both would wait for the client.
      await waitUntilBlocked([pids[0]!]);
      const secondRun = run(second);
      await waitUntilBlocked(pids);
      await archiving.commit();

      outcomes.push(await firstRun);
      if (outcomes[0] === 'opened') await first.commit(); else await first.rollback();
      outcomes.push(await secondRun);
      if (outcomes[1] === 'opened') await second.commit(); else await second.rollback();
    } finally {
      for (const open of [archiving, first, second]) if (!open.isCompleted()) await open.rollback();
    }

    expect(outcomes).toEqual(['opened', 'opened']);
    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);
    const sessions = await owner()('client_portal_approval_sessions as session')
      .join('client_portal_approval_links as link', 'link.id', 'session.link_id')
      .where('link.token_hash', tokenHash)
      .count<Array<{ count: string }>>('* as count');
    expect(sessions[0]!.count).toBe('2');
  });
});

const waitUntilBlocked = async (pids: readonly number[]): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await owner().raw<{ rows: Array<{ blocked: number }> }>(
      `select count(*)::int as blocked from pg_stat_activity activity
       where activity.datname = current_database() and activity.pid = any(?::int[]) and cardinality(pg_blocking_pids(activity.pid)) > 0`, [[...pids]]
    );
    if (rows[0]!.blocked === pids.length) return;
    if (Date.now() > deadline) throw new Error('The backends never blocked.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// ---- the entry leaves with the account -------------------------------------------------------------------------------------------

describe('the last entry belongs to the account that made it', () => {
  it('is cleared when the address changes hands, and the new holder starts from nothing', async () => {
    const { accessId, user, clientId } = await accountInPortal();
    await markAs(user.id, clientId);
    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);

    await owner()('auth.user').where({ id: user.id }).update({ email: `${randomUUID()}@moved.test` });
    await addAs(ids.adminA, clientId, user.email);
    expect(await entryOf(accessId)).toEqual({ first: null, last: null, user_id: null });

    const holder = await newUser({ email: user.email });
    expect(await linkAs(holder.id)).toBe(1);
    expect(await entryOf(accessId)).toMatchObject({ first: null, last: null, user_id: holder.id });
    await markAs(holder.id, clientId);
    expect(await entryOf(accessId)).toMatchObject({ user_id: holder.id });
    expect((await entryOf(accessId)).last).toBeInstanceOf(Date);
  });

  it('is cleared by any change of the account that held the access, for whoever writes it', async () => {
    const { accessId, user, clientId } = await accountInPortal();
    await markAs(user.id, clientId);
    await owner().transaction(async (transaction) => {
      await transaction('client_portal_accesses').where({ id: accessId }).update({ user_id: null });
      await transaction('client_memberships').where({ portal_access_id: accessId }).update({ status: 'removed' });
    });
    expect(await entryOf(accessId)).toMatchObject({ user_id: null, last: null });
  });

  it('is kept by an access with no account that an account takes later: the link was the entry of the address', async () => {
    const clientId = await freshClient();
    const user = await newUser();
    const { accessId, tokenHash } = await linkOfAccess(clientId, user.email);
    await exchange(tokenHash);
    const opened = (await entryOf(accessId)).last!;

    expect(await linkAs(user.id)).toBe(1);

    expect(await entryOf(accessId)).toEqual({ first: null, last: opened, user_id: user.id });
  });

  it('is kept when the access is removed and brought back, because the person is the same', async () => {
    const { accessId, user, clientId } = await accountInPortal();
    await markAs(user.id, clientId);
    const entered = await entryOf(accessId);

    await removeAs(ids.adminA, accessId);
    expect(await entryOf(accessId)).toEqual(entered);
    await reactivateAs(ids.adminA, accessId);
    expect(await entryOf(accessId)).toEqual(entered);
  });
});
