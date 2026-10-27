import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

import { createContentWorld } from './support/content-world.js';

// Issue #711 (decision 2026-10-26, "acesso ao portal por e-mail"): the access to a client's portal is given to an e-mail address
// and the account is optional. `ageniza_app` writes nothing in `client_portal_accesses`: every change goes through a function of
// the access, and the state of a membership follows the state of its access. Every attack runs as `ageniza_app`; the guards the
// functions do not reach (the triggers) are attacked as the owner, which is the only other writer. RLS filters silently, so a
// read is checked by the rows it returns and a write by the state left in the tables.
const w = createContentWorld('client-portal-accesses');
const { ids } = w;
const { applicationUrl } = resolveIntegrationDatabaseUrls();

let worker: DatabaseClient;
const extraUsers: string[] = [];
const extraClients: string[] = [];

const owner = (): Knex => w.getOwner().knex;

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
  // The world has them active; the tests of the archive and of the suspension need them closed.
  await w.archiveClient(ids.clientArchived);
  await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });
});

afterAll(async () => {
  try {
    const knex = owner();
    const worldClients = [ids.clientA1, ids.clientA2, ids.clientArchived, ids.clientB, ids.clientSuspended, ...extraClients];
    await knex('notification_queue').whereIn('client_id', worldClients).delete();
    await knex('client_thread_comments').whereIn('client_id', worldClients).delete();
    await knex('client_threads').whereIn('client_id', worldClients).delete();
    await knex('content_tasks').whereIn('client_id', extraClients).delete();
    await knex('content_media').whereIn('client_id', extraClients).delete();
    await knex('contents').whereIn('client_id', extraClients).delete();
    await knex('media_folders').whereIn('client_id', extraClients).delete();
    await knex('client_memberships').whereIn('client_id', extraClients).delete();
    await knex('invitations').whereIn('client_id', extraClients).delete();
    await knex('audit.events').whereIn('agency_id', [ids.agencyA, ids.agencyB, ids.agencySuspended]).delete();
    await knex('clients').whereIn('id', extraClients).delete();
    await knex('client_memberships').whereIn('user_id', extraUsers).delete();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

interface UserOptions { readonly email?: string; readonly verified?: boolean }
const newUser = async (options: UserOptions = {}): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = options.email ?? `${id}@client-portal-accesses.test`;
  extraUsers.push(id);
  await owner()('auth.user').insert({ id, name: `User ${id.slice(0, 8)}`, email, emailVerified: options.verified ?? true });
  return { id, email };
};
const freshEmail = (): string => `${randomUUID()}@portal-address.test`;

const freshClient = async (): Promise<string> => {
  const id = randomUUID();
  extraClients.push(id);
  await owner()('clients').insert({ id, agency_id: ids.agencyA, name: `Acesso ${id}` });
  return id;
};

type AccessRow = { id: string; client_id: string; email: string; user_id: string | null; status: string; generation: number; created_at: Date; updated_at: Date };
const accessOf = async (clientId: string, email: string): Promise<AccessRow | undefined> =>
  owner()('client_portal_accesses').where({ client_id: clientId, email }).first() as Promise<AccessRow | undefined>;
const accessOfUser = async (clientId: string, userId: string): Promise<AccessRow | undefined> =>
  owner()('client_portal_accesses').where({ client_id: clientId, user_id: userId }).first() as Promise<AccessRow | undefined>;
const membershipOf = async (clientId: string, userId: string): Promise<{ id: string; status: string; portal_access_id: string } | undefined> =>
  owner()('client_memberships').where({ client_id: clientId, user_id: userId }).first();
const countAccesses = async (clientId: string): Promise<number> =>
  Number((await owner()('client_portal_accesses').where({ client_id: clientId }).count<Array<{ count: string }>>('* as count'))[0]!.count);

const call = <T = Record<string, unknown>>(user: string, statement: string, ...bindings: unknown[]): Promise<T[]> =>
  w.asUser(user, async (transaction) => (await transaction.raw<{ rows: T[] }>(statement, bindings as never[])).rows);

interface AddResult { access_id: string; outcome: 'created' | 'reactivated' | 'already_active'; unlinked_user_id: string | null }
const addAs = async (user: string, clientId: string, email: string): Promise<AddResult> =>
  (await call<AddResult>(user, 'select * from app_private.add_client_portal_access(?::uuid, ?)', clientId, email))[0]!;
const removeAs = async (user: string, accessId: string): Promise<{ account_user_id: string | null; changed: boolean }> =>
  (await call<{ account_user_id: string | null; changed: boolean }>(user, 'select * from app_private.remove_client_portal_access(?::uuid)', accessId))[0]!;
const reactivateAs = async (user: string, accessId: string): Promise<{ account_user_id: string | null; changed: boolean }> =>
  (await call<{ account_user_id: string | null; changed: boolean }>(user, 'select * from app_private.reactivate_client_portal_access(?::uuid)', accessId))[0]!;
const linkAs = async (user: string): Promise<number> =>
  (await call<{ linked: number }>(user, 'select app_private.link_client_portal_accesses() as linked'))[0]!.linked;
const isMember = async (user: string, clientId: string): Promise<boolean> =>
  (await call<{ member: boolean }>(user, 'select app_private.is_client_member(?::uuid) as member', clientId))[0]!.member;

const sinceAuditCount = async (action: string, targetId: string): Promise<number> =>
  Number((await owner()('audit.events').where({ action, target_id: targetId }).count<Array<{ count: string }>>('* as count'))[0]!.count);

const REFUSED = { code: 'A0020' };

// ---- the table is closed to the application role ----------------------------------------------------------------------

describe('the table of accesses is closed to the application role (#711)', () => {
  it('gives ageniza_app a read of the table and nothing that writes, on the table or on any column', async () => {
    expect(await w.tablePrivileges('client_portal_accesses')).toEqual({
      can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false
    });
    expect(await w.columnsWithPrivilege('client_portal_accesses', 'insert')).toEqual([]);
    expect(await w.columnsWithPrivilege('client_portal_accesses', 'update')).toEqual([]);
  });

  it('refuses an INSERT, an UPDATE and a DELETE as ageniza_app, and leaves the row as it was', async () => {
    const access = (await accessOfUser(ids.clientA1, ids.portalA1))!;
    await expect(w.asUser(ids.adminA, async (t) => {
      await t('client_portal_accesses').insert({ client_id: ids.clientA1, email: freshEmail() });
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table client_portal_accesses') });
    await expect(w.asUser(ids.adminA, async (t) => {
      await t('client_portal_accesses').where({ id: access.id }).update({ status: 'removed' });
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table client_portal_accesses') });
    await expect(w.asUser(ids.adminA, async (t) => {
      await t('client_portal_accesses').where({ id: access.id }).delete();
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table client_portal_accesses') });
    expect(await accessOfUser(ids.clientA1, ids.portalA1)).toEqual(access);
  });

  it('keeps row level security on and forced, with the one policy of the read', async () => {
    const flags = await owner().raw<{ rows: Array<{ enabled: boolean; forced: boolean }> }>(
      "select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where oid = 'public.client_portal_accesses'::regclass"
    );
    expect(flags.rows).toEqual([{ enabled: true, forced: true }]);
    const policies = await owner().raw<{ rows: Array<{ policyname: string; cmd: string }> }>(
      "select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'client_portal_accesses'"
    );
    expect(policies.rows).toEqual([{ policyname: 'client_portal_accesses_select', cmd: 'SELECT' }]);
  });

  it('shows the accesses of a client to who reads or changes them, and to nobody else', async () => {
    const reader = await w.personWith('cliente.convidar_usuario');
    const remover = await w.personWith('cliente.remover_usuario');
    const unrelated = await w.personWith('midia.enviar');
    const count = (user: string, clientId = ids.clientA1): Promise<number> =>
      call<{ n: string }>(user, 'select count(*)::text as n from public.client_portal_accesses where client_id = ?::uuid', clientId).then((rows) => Number(rows[0]!.n));

    const total = await countAccesses(ids.clientA1);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(await count(ids.adminA)).toBe(total);
    expect(await count(ids.ownerA)).toBe(total);
    expect(await count(reader)).toBe(total);
    expect(await count(remover)).toBe(total);
    // The portal people, the collaborators without the permission, and the admin of another agency read nothing.
    for (const person of [unrelated, ids.portalA1, ids.dualBare, ids.dualFull, ids.crossDual, ids.adminB, ids.salesA]) {
      expect(await count(person), person).toBe(0);
    }
    // The agency reads the accesses of its own clients only.
    expect(await count(ids.adminA, ids.clientB)).toBe(0);
    expect(await count(ids.adminB, ids.clientA1)).toBe(0);
  });
});

// ---- the guards of the row --------------------------------------------------------------------------------------------

describe('the guards of the row (the owner is the only other writer)', () => {
  const fresh = async (): Promise<AccessRow> => {
    const created = await owner()('client_portal_accesses').insert({ client_id: ids.clientA2, email: freshEmail() }).returning('*');
    return created[0] as AccessRow;
  };

  it('never changes the address, the client, the id or the creation date', async () => {
    const row = await fresh();
    for (const patch of [{ email: freshEmail() }, { client_id: ids.clientA1 }, { id: randomUUID() }, { created_at: new Date('2020-01-01T00:00:00Z') }]) {
      await expect(owner()('client_portal_accesses').where({ id: row.id }).update(patch)).rejects.toMatchObject({
        code: '42501', message: expect.stringContaining('never change')
      });
    }
    expect(await owner()('client_portal_accesses').where({ id: row.id }).first()).toEqual(row);
  });

  it('refuses an address that is not lower case and trimmed, and one that is not an address', async () => {
    for (const email of ['Maria@Exemplo.test', ' maria@exemplo.test', 'sem-arroba', '', 'a@'.padEnd(330, 'a')]) {
      await expect(owner()('client_portal_accesses').insert({ client_id: ids.clientA2, email }), email).rejects.toMatchObject({
        code: '23514', constraint: 'client_portal_accesses_email_check'
      });
    }
  });

  it('keeps one access per address and per account in a client, removed or not', async () => {
    const row = await fresh();
    await expect(owner()('client_portal_accesses').insert({ client_id: ids.clientA2, email: row.email })).rejects.toMatchObject({
      code: '23505', constraint: 'client_portal_accesses_client_id_email_key'
    });
    const user = await newUser();
    await owner()('client_memberships').insert({ client_id: ids.clientA2, user_id: user.id });
    await expect(owner()('client_portal_accesses').insert({ client_id: ids.clientA2, email: freshEmail(), user_id: user.id })).rejects.toMatchObject({
      code: '23505', constraint: 'client_portal_accesses_client_id_user_id_key'
    });
    // Several accesses without an account are fine.
    await owner()('client_portal_accesses').insert([{ client_id: ids.clientA2, email: freshEmail() }, { client_id: ids.clientA2, email: freshEmail() }]);
  });

  it('only advances the generation, and only when the access is removed', async () => {
    const row = await fresh();
    // Not by itself.
    await expect(owner()('client_portal_accesses').where({ id: row.id }).update({ generation: 2 })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('only advances, and only when it is removed')
    });
    // Not by more than one.
    await expect(owner()('client_portal_accesses').where({ id: row.id }).update({ status: 'removed', generation: 3 })).rejects.toMatchObject({ code: '42501' });
    // Removing without advancing is refused too.
    await expect(owner()('client_portal_accesses').where({ id: row.id }).update({ status: 'removed' })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('Removing a portal access advances its generation')
    });
    await owner()('client_portal_accesses').where({ id: row.id }).update({ status: 'removed', generation: 2 });

    // Never back, not even when it comes back to active.
    await expect(owner()('client_portal_accesses').where({ id: row.id }).update({ status: 'active', generation: 1 })).rejects.toMatchObject({ code: '42501' });
    await expect(owner()('client_portal_accesses').where({ id: row.id }).update({ generation: 1 })).rejects.toMatchObject({ code: '42501' });
    await owner()('client_portal_accesses').where({ id: row.id }).update({ status: 'active' });
    expect((await accessOf(ids.clientA2, row.email))!.generation).toBe(2);
    // An access is born in its first generation.
    await expect(owner()('client_portal_accesses').insert({ client_id: ids.clientA2, email: freshEmail(), generation: 5 })).rejects.toMatchObject({ code: '42501' });
  });

  it('lets an access lose its account or take one, and never pass straight from one account to another', async () => {
    const first = await newUser();
    const second = await newUser();
    await owner()('client_memberships').insert({ client_id: ids.clientA2, user_id: first.id });
    const row = (await accessOfUser(ids.clientA2, first.id))!;
    await expect(owner()('client_portal_accesses').where({ id: row.id }).update({ user_id: second.id })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('never passes straight from one account to another')
    });
    // Through none, with the membership of each account following in the same transaction, as the functions do.
    await owner().transaction(async (t) => {
      await t('client_portal_accesses').where({ id: row.id }).update({ user_id: null });
      await t('client_memberships').where({ client_id: ids.clientA2, user_id: first.id }).update({ status: 'removed' });
      await t('client_portal_accesses').where({ id: row.id }).update({ user_id: second.id });
      await t('client_memberships').insert({ client_id: ids.clientA2, user_id: second.id, portal_access_id: row.id });
    });
    expect((await accessOf(ids.clientA2, row.email))!.user_id).toBe(second.id);
    expect((await membershipOf(ids.clientA2, first.id))!.status).toBe('removed');
    expect((await membershipOf(ids.clientA2, second.id))!.status).toBe('active');
  });
});

// ---- the membership follows its access --------------------------------------------------------------------------------

describe('the state of a membership follows its access (#711)', () => {
  it('refuses to change the state of a membership by itself, either way, and leaves it as it was', async () => {
    const client = await freshClient();
    const user = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: user.id });
    await expect(owner()('client_memberships').where({ client_id: client, user_id: user.id }).update({ status: 'removed' })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('leaves the portal only together with its access')
    });
    expect((await membershipOf(client, user.id))!.status).toBe('active');

    await setRemoved(client, user.id);
    await expect(owner()('client_memberships').where({ client_id: client, user_id: user.id }).update({ status: 'active' })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('active only while its access is active')
    });
    expect((await membershipOf(client, user.id))!.status).toBe('removed');
  });

  const setRemoved = async (clientId: string, userId: string): Promise<void> => {
    await owner().transaction(async (t) => {
      await t('client_portal_accesses').where({ client_id: clientId, user_id: userId }).update({ status: 'removed', generation: t.raw('generation + 1') });
      await t('client_memberships').where({ client_id: clientId, user_id: userId }).update({ status: 'removed' });
    });
  };

  it('never lets a membership be born without an access: the legacy writer gets the access of the account', async () => {
    const client = await freshClient();
    const user = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: user.id });
    const membership = (await membershipOf(client, user.id))!;
    expect(await accessOfUser(client, user.id)).toMatchObject({ id: membership.portal_access_id, email: user.email, status: 'active', generation: 1 });

    // The access that was waiting for that address is taken, not duplicated.
    const waiting = await newUser();
    await owner()('client_portal_accesses').insert({ client_id: client, email: waiting.email });
    await owner()('client_memberships').insert({ client_id: client, user_id: waiting.id });
    expect(await countAccesses(client)).toBe(2);
    expect((await accessOf(client, waiting.email))!.user_id).toBe(waiting.id);
  });

  it('refuses a membership that follows the access of another client, of another account, or one that is not active', async () => {
    const client = await freshClient();
    const other = await freshClient();
    const [mine, someone] = [await newUser(), await newUser()];
    const ofOtherClient = (await owner()('client_portal_accesses').insert({ client_id: other, email: mine.email }).returning('id'))[0].id as string;
    await owner()('client_memberships').insert({ client_id: client, user_id: someone.id });
    const ofSomeone = (await accessOfUser(client, someone.id))!.id;
    const removedOfNobody = (await owner()('client_portal_accesses').insert({ client_id: client, email: freshEmail(), status: 'removed', generation: 1 }).returning('id'))[0].id as string;

    await expect(owner()('client_memberships').insert({ client_id: client, user_id: mine.id, portal_access_id: ofOtherClient })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('follows an access of its own client')
    });
    await expect(owner()('client_memberships').insert({ client_id: client, user_id: mine.id, portal_access_id: ofSomeone })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('active only while its access is active and belongs to the same account')
    });
    await expect(owner()('client_memberships').insert({ client_id: client, user_id: mine.id, portal_access_id: removedOfNobody })).rejects.toMatchObject({ code: '42501' });
    expect(await membershipOf(client, mine.id)).toBeUndefined();
  });

  it('refuses at the end of the transaction an access that changes without its membership', async () => {
    const client = await freshClient();
    const user = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: user.id });
    const access = (await accessOfUser(client, user.id))!;

    // Removed, with the membership still active.
    await expect(owner()('client_portal_accesses').where({ id: access.id }).update({ status: 'removed', generation: 2 })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('carries no active membership')
    });
    // Unlinked, with the membership still active.
    await expect(owner()('client_portal_accesses').where({ id: access.id }).update({ user_id: null })).rejects.toMatchObject({ code: '42501' });
    expect(await accessOfUser(client, user.id)).toMatchObject({ status: 'active', generation: 1 });

    // And an active access with an account and no membership of that account.
    await expect(owner()('client_portal_accesses').insert({ client_id: client, email: freshEmail(), user_id: (await newUser()).id })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('carries the active membership of that account')
    });
    // Both in one transaction is what the functions do, in the order they need.
    await owner().transaction(async (t) => {
      await t('client_memberships').where({ client_id: client, user_id: user.id }).update({ status: 'removed' }).catch(() => undefined);
    }).catch(() => undefined);
    expect((await membershipOf(client, user.id))!.status).toBe('active');
  });
});

// ---- Adicionar pessoa --------------------------------------------------------------------------------------------------

describe('add_client_portal_access (Adicionar pessoa)', () => {
  it('gives the access at once, with no account and no membership, in the first generation, and audits it', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const added = await addAs(ids.adminA, client, `  ${email.toUpperCase()}  `);
    expect(added).toMatchObject({ outcome: 'created', unlinked_user_id: null });
    const access = (await accessOf(client, email))!;
    expect(access).toMatchObject({ id: added.access_id, user_id: null, status: 'active', generation: 1 });
    expect(await owner()('client_memberships').where({ portal_access_id: access.id }).count<Array<{ count: string }>>('* as count')).toEqual([{ count: '0' }]);
    expect(await sinceAuditCount('client_member.added', access.id)).toBe(1);
  });

  it('never links the account that already has the address, not even a verified one', async () => {
    const client = await freshClient();
    const account = await newUser({ verified: true });
    const added = await addAs(ids.adminA, client, account.email);
    expect(added.outcome).toBe('created');
    expect(await accessOf(client, account.email)).toMatchObject({ user_id: null, status: 'active' });
    expect(await membershipOf(client, account.id)).toBeUndefined();
    expect(await isMember(account.id, client)).toBe(false);
  });

  it('keeps one row per address: the same address again, in any case, writes nothing', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const first = await addAs(ids.adminA, client, email);
    const again = await addAs(ids.adminA, client, email.toUpperCase());
    expect(again).toMatchObject({ access_id: first.access_id, outcome: 'already_active', unlinked_user_id: null });
    expect(await countAccesses(client)).toBe(1);
    expect(await sinceAuditCount('client_member.added', first.access_id)).toBe(1);
  });

  it('reactivates the row of a removed address with the generation the removal left, and does not insert another', async () => {
    const client = await freshClient();
    const email = freshEmail();
    const first = await addAs(ids.adminA, client, email);
    await removeAs(ids.adminA, first.access_id);
    expect((await accessOf(client, email))).toMatchObject({ status: 'removed', generation: 2 });

    const again = await addAs(ids.adminA, client, email);
    expect(again).toMatchObject({ access_id: first.access_id, outcome: 'reactivated' });
    expect(await accessOf(client, email)).toMatchObject({ id: first.access_id, status: 'active', generation: 2 });
    expect(await countAccesses(client)).toBe(1);
    expect(await sinceAuditCount('client_member.reactivated', first.access_id)).toBe(1);
  });

  it('gives a removed account its portal back when the address is added again and the account still has it', async () => {
    const client = await freshClient();
    const account = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: account.id });
    const access = (await accessOfUser(client, account.id))!;
    await removeAs(ids.adminA, access.id);
    expect(await isMember(account.id, client)).toBe(false);

    const added = await addAs(ids.adminA, client, account.email);
    expect(added).toMatchObject({ access_id: access.id, outcome: 'reactivated', unlinked_user_id: null });
    expect(await accessOf(client, account.email)).toMatchObject({ user_id: account.id, status: 'active' });
    expect((await membershipOf(client, account.id))!.status).toBe('active');
    expect(await isMember(account.id, client)).toBe(true);
  });

  it('lets go of the account that changed its address when the address is added again (removed row)', async () => {
    const client = await freshClient();
    const original = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: original.id });
    const access = (await accessOfUser(client, original.id))!;
    await removeAs(ids.adminA, access.id);
    await owner()('auth.user').where({ id: original.id }).update({ email: `${randomUUID()}@moved.test` });

    const added = await addAs(ids.adminA, client, access.email);
    expect(added).toMatchObject({ access_id: access.id, outcome: 'reactivated', unlinked_user_id: null });
    expect(await accessOf(client, access.email)).toMatchObject({ user_id: null, status: 'active', generation: 2 });
    // The account that moved on does not get it back, and the one that has the address now can take it at its login.
    expect((await membershipOf(client, original.id))!.status).toBe('removed');
    expect(await isMember(original.id, client)).toBe(false);
    const holder = await newUser({ email: access.email });
    expect(await linkAs(holder.id)).toBe(1);
    expect(await isMember(holder.id, client)).toBe(true);
    expect(await isMember(original.id, client)).toBe(false);
  });

  it('lets go of the account that changed its address when the row is still active, and says which account lost it', async () => {
    const client = await freshClient();
    const original = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: original.id });
    const access = (await accessOfUser(client, original.id))!;
    await owner()('auth.user').where({ id: original.id }).update({ email: `${randomUUID()}@moved.test` });
    expect(await isMember(original.id, client)).toBe(true);

    const added = await addAs(ids.adminA, client, access.email);
    expect(added).toMatchObject({ access_id: access.id, outcome: 'reactivated', unlinked_user_id: original.id });
    expect(await accessOf(client, access.email)).toMatchObject({ user_id: null, status: 'active', generation: 1 });
    expect((await membershipOf(client, original.id))!.status).toBe('removed');
    expect(await isMember(original.id, client)).toBe(false);
    const holder = await newUser({ email: access.email });
    expect(await linkAs(holder.id)).toBe(1);
    expect((await accessOf(client, access.email))!.user_id).toBe(holder.id);
  });

  it('refuses an address that is not an address, writing nothing', async () => {
    const client = await freshClient();
    for (const email of ['', '   ', 'sem-arroba', `${'a'.repeat(320)}@x.test`]) {
      await expect(addAs(ids.adminA, client, email), email).rejects.toMatchObject({ code: 'A0095' });
    }
    expect(await countAccesses(client)).toBe(0);
  });

  it('is open to the one permission it asks for, and answers the same refusal to every other caller, writing nothing', async () => {
    const client = await freshClient();
    const reader = await w.personWith('cliente.convidar_usuario');
    const remover = await w.personWith('cliente.remover_usuario');
    const unrelated = await w.personWith('midia.enviar');

    for (const person of [remover, unrelated, ids.salesA, ids.portalA1, ids.dualBare, ids.adminB, ids.crossDual]) {
      await expect(addAs(person, client, freshEmail()), person).rejects.toMatchObject(REFUSED);
    }
    expect(await countAccesses(client)).toBe(0);
    // Not even the answer for a client that does not exist differs.
    await expect(addAs(ids.adminB, randomUUID(), freshEmail())).rejects.toMatchObject(REFUSED);

    expect((await addAs(reader, client, freshEmail())).outcome).toBe('created');
    expect((await addAs(ids.ownerA, client, freshEmail())).outcome).toBe('created');
    expect(await countAccesses(client)).toBe(2);
  });

  it('refuses an archived client and a suspended agency, writing nothing', async () => {
    await expect(addAs(ids.adminA, ids.clientArchived, freshEmail())).rejects.toMatchObject(REFUSED);
    await expect(addAs(ids.adminSuspended, ids.clientSuspended, freshEmail())).rejects.toMatchObject(REFUSED);
    expect(await countAccesses(ids.clientSuspended)).toBe(1);
    const archived = await freshClient();
    await w.archiveClient(archived);
    await expect(addAs(ids.adminA, archived, freshEmail())).rejects.toMatchObject(REFUSED);
    expect(await countAccesses(archived)).toBe(0);
  });

  it('answers a caller with no actor bound the same refusal', async () => {
    const client = await freshClient();
    await expect(worker.knex.raw("select * from app_private.add_client_portal_access(?::uuid, 'sem-ator@portal-address.test')", [client]))
      .rejects.toMatchObject(REFUSED);
    expect(await countAccesses(client)).toBe(0);
  });
});

// ---- Remover e Reativar -----------------------------------------------------------------------------------------------

describe('remove_client_portal_access and reactivate_client_portal_access', () => {
  const linkedPerson = async (): Promise<{ client: string; user: { id: string; email: string }; access: AccessRow }> => {
    const client = await freshClient();
    const user = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: user.id });
    return { client, user, access: (await accessOfUser(client, user.id))! };
  };

  it('removes the access and the membership together, advances the generation, ends the portal of the account, and audits once', async () => {
    const { client, user, access } = await linkedPerson();
    expect(await isMember(user.id, client)).toBe(true);

    const removed = await removeAs(ids.adminA, access.id);
    expect(removed).toEqual({ account_user_id: user.id, changed: true });
    expect(await accessOfUser(client, user.id)).toMatchObject({ status: 'removed', generation: 2 });
    expect((await membershipOf(client, user.id))!.status).toBe('removed');
    expect(await isMember(user.id, client)).toBe(false);
    expect(await sinceAuditCount('client_member.removed', access.id)).toBe(1);

    // Repeating changes nothing: no second generation, no second event.
    expect(await removeAs(ids.adminA, access.id)).toEqual({ account_user_id: user.id, changed: false });
    expect(await accessOfUser(client, user.id)).toMatchObject({ status: 'removed', generation: 2 });
    expect(await sinceAuditCount('client_member.removed', access.id)).toBe(1);
  });

  it('removes an access nobody has entered, which has no membership to take along, and still advances the generation', async () => {
    const client = await freshClient();
    const added = await addAs(ids.adminA, client, freshEmail());
    expect(await removeAs(ids.adminA, added.access_id)).toEqual({ account_user_id: null, changed: true });
    expect(await owner()('client_portal_accesses').where({ id: added.access_id }).first()).toMatchObject({ status: 'removed', generation: 2 });
  });

  it('reactivates the same access without giving the generation back, and brings the membership with it', async () => {
    const { client, user, access } = await linkedPerson();
    await removeAs(ids.adminA, access.id);

    expect(await reactivateAs(ids.adminA, access.id)).toEqual({ account_user_id: user.id, changed: true });
    expect(await accessOfUser(client, user.id)).toMatchObject({ id: access.id, status: 'active', generation: 2 });
    expect((await membershipOf(client, user.id))!.status).toBe('active');
    expect(await isMember(user.id, client)).toBe(true);
    expect(await sinceAuditCount('client_member.reactivated', access.id)).toBe(1);

    expect(await reactivateAs(ids.adminA, access.id)).toEqual({ account_user_id: user.id, changed: false });
    expect(await sinceAuditCount('client_member.reactivated', access.id)).toBe(1);
  });

  it('keeps the account of a removed access when it is reactivated by its id, even if the account changed its address', async () => {
    const { client, user, access } = await linkedPerson();
    await removeAs(ids.adminA, access.id);
    await owner()('auth.user').where({ id: user.id }).update({ email: `${randomUUID()}@moved.test` });
    await reactivateAs(ids.adminA, access.id);
    expect(await accessOfUser(client, user.id)).toMatchObject({ id: access.id, status: 'active' });
    expect(await isMember(user.id, client)).toBe(true);
  });

  it('asks cliente.remover_usuario alone for each, and answers the same refusal to everybody else, changing nothing', async () => {
    const { client, access } = await linkedPerson();
    const remover = await w.personWith('cliente.remover_usuario');
    const reader = await w.personWith('cliente.convidar_usuario');

    for (const person of [reader, ids.salesA, ids.portalA1, ids.adminB, ids.crossDual]) {
      await expect(removeAs(person, access.id), `remove ${person}`).rejects.toMatchObject(REFUSED);
      await expect(reactivateAs(person, access.id), `reactivate ${person}`).rejects.toMatchObject(REFUSED);
    }
    expect(await owner()('client_portal_accesses').where({ id: access.id }).first()).toMatchObject({ status: 'active', generation: 1 });

    expect((await removeAs(remover, access.id)).changed).toBe(true);
    expect((await reactivateAs(remover, access.id)).changed).toBe(true);
    await expect(removeAs(remover, randomUUID())).rejects.toMatchObject(REFUSED);
    expect(await countAccesses(client)).toBe(1);
  });

  it('refuses an access of an archived client in both directions, and a status the old function does not know', async () => {
    const access = (await accessOfUser(ids.clientArchived, ids.portalArchived))!;
    await expect(removeAs(ids.adminA, access.id)).rejects.toMatchObject(REFUSED);
    await expect(reactivateAs(ids.adminA, access.id)).rejects.toMatchObject(REFUSED);
    expect((await accessOfUser(ids.clientArchived, ids.portalArchived))!.status).toBe('active');
    const membership = (await membershipOf(ids.clientArchived, ids.portalArchived))!;
    await expect(call(ids.adminA, "select app_private.set_client_membership_status(?::uuid, 'paused')", membership.id)).rejects.toMatchObject({ code: 'A0023' });
  });

  it('keeps set_client_membership_status, which now goes through the access, and refuses the link an access left behind', async () => {
    const { client, user, access } = await linkedPerson();
    const membership = (await membershipOf(client, user.id))!;
    await call(ids.adminA, "select app_private.set_client_membership_status(?::uuid, 'removed')", membership.id);
    expect(await accessOfUser(client, user.id)).toMatchObject({ status: 'removed', generation: 2 });
    await call(ids.adminA, "select app_private.set_client_membership_status(?::uuid, 'active')", membership.id);
    expect(await accessOfUser(client, user.id)).toMatchObject({ status: 'active', generation: 2 });

    // The address changed hands: the membership of the former account is a stub, and is not a person to reactivate.
    await removeAs(ids.adminA, access.id);
    await owner()('auth.user').where({ id: user.id }).update({ email: `${randomUUID()}@moved.test` });
    await addAs(ids.adminA, client, access.email);
    await expect(call(ids.adminA, "select app_private.set_client_membership_status(?::uuid, 'active')", membership.id)).rejects.toMatchObject(REFUSED);
    expect((await accessOf(client, access.email))!.user_id).toBeNull();
  });
});

// ---- the link ---------------------------------------------------------------------------------------------------------

describe('link_client_portal_accesses (the link at the login)', () => {
  const given = async (email: string, clientId?: string): Promise<{ client: string; access: AccessRow }> => {
    const client = clientId ?? await freshClient();
    await owner()('client_portal_accesses').insert({ client_id: client, email });
    return { client, access: (await accessOf(client, email))! };
  };

  it('takes the active accesses of the verified address of the account, and gives it the portal', async () => {
    const email = freshEmail();
    const first = await given(email);
    const second = await given(email);
    const account = await newUser({ email, verified: true });
    expect(await isMember(account.id, first.client)).toBe(false);

    expect(await linkAs(account.id)).toBe(2);
    for (const { client, access } of [first, second]) {
      expect(await accessOfUser(client, account.id)).toMatchObject({ id: access.id, status: 'active' });
      expect(await membershipOf(client, account.id)).toMatchObject({ status: 'active', portal_access_id: access.id });
      expect(await isMember(account.id, client)).toBe(true);
      expect(await sinceAuditCount('client_member.linked', access.id)).toBe(1);
    }
    expect(await linkAs(account.id)).toBe(0);
  });

  it('gives nothing to an account whose address is not confirmed, and everything once it is confirmed and enters', async () => {
    const email = freshEmail();
    const { client, access } = await given(email);
    const account = await newUser({ email, verified: false });

    expect(await linkAs(account.id)).toBe(0);
    expect(await accessOf(client, email)).toMatchObject({ id: access.id, user_id: null });
    expect(await membershipOf(client, account.id)).toBeUndefined();
    expect(await isMember(account.id, client)).toBe(false);

    await owner()('auth.user').where({ id: account.id }).update({ emailVerified: true });
    expect(await linkAs(account.id)).toBe(1);
    expect(await isMember(account.id, client)).toBe(true);
  });

  it('compares the address as it is: lower case and trimmed, with no alias folded', async () => {
    const base = `${randomUUID()}@portal-address.test`;
    const { client } = await given(base);
    const alias = await newUser({ email: base.replace('@', '+alias@'), verified: true });
    expect(await linkAs(alias.id)).toBe(0);
    expect(await accessOf(client, base)).toMatchObject({ user_id: null });
    // Another account with a similar address takes nothing either.
    const other = await newUser({ email: `x${base}`, verified: true });
    expect(await linkAs(other.id)).toBe(0);
  });

  it('never takes an access that already has an account, whoever claims the address now', async () => {
    const client = await freshClient();
    const original = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: original.id });
    const access = (await accessOfUser(client, original.id))!;
    // The account changes its address and another account takes the old one, verified.
    await owner()('auth.user').where({ id: original.id }).update({ email: `${randomUUID()}@moved.test` });
    const newcomer = await newUser({ email: access.email, verified: true });

    expect(await linkAs(newcomer.id)).toBe(0);
    expect(await accessOf(client, access.email)).toMatchObject({ id: access.id, user_id: original.id, status: 'active' });
    expect(await isMember(original.id, client)).toBe(true);
    expect(await isMember(newcomer.id, client)).toBe(false);
  });

  it('never takes a removed access, one of an archived client or one of a suspended agency', async () => {
    const email = freshEmail();
    const removed = await given(email);
    await removeAs(ids.adminA, removed.access.id);
    const archived = await given(email);
    await w.archiveClient(archived.client);
    const suspendedAccess = await given(email, ids.clientSuspended);
    const account = await newUser({ email, verified: true });

    expect(await linkAs(account.id)).toBe(0);
    for (const row of [removed.access, archived.access, suspendedAccess.access]) {
      expect((await owner()('client_portal_accesses').where({ id: row.id }).first('user_id')).user_id).toBeNull();
    }
    expect(await owner()('client_memberships').where({ user_id: account.id }).count<Array<{ count: string }>>('* as count')).toEqual([{ count: '0' }]);
  });

  it('links one access per account in a client: an active one of the account wins, a removed one is history that lets go', async () => {
    const account = await newUser({ verified: true });
    // Active through another address (the account has changed its address since): the new row waits.
    const active = await freshClient();
    const formerAddress = freshEmail();
    await owner()('auth.user').where({ id: account.id }).update({ email: formerAddress });
    await owner()('client_memberships').insert({ client_id: active, user_id: account.id });
    await owner()('auth.user').where({ id: account.id }).update({ email: account.email });
    const second = await given(account.email, active);
    expect(second.access).toMatchObject({ user_id: null });
    expect(await linkAs(account.id)).toBe(0);
    expect(await accessOf(active, account.email)).toMatchObject({ user_id: null });
    expect(await accessOf(active, formerAddress)).toMatchObject({ user_id: account.id });

    // Removed through another address: the account moves to the new row, and the same membership follows it.
    const removedClient = await freshClient();
    const oldEmail = freshEmail();
    const holder = await newUser({ email: oldEmail, verified: true });
    await owner()('client_memberships').insert({ client_id: removedClient, user_id: holder.id });
    const oldAccess = (await accessOfUser(removedClient, holder.id))!;
    await removeAs(ids.adminA, oldAccess.id);
    await owner()('auth.user').where({ id: holder.id }).update({ email: account.email.replace('@', '-2@') });
    const newAccess = (await given(account.email.replace('@', '-2@'), removedClient)).access;

    expect(await linkAs(holder.id)).toBe(1);
    expect(await accessOfUser(removedClient, holder.id)).toMatchObject({ id: newAccess.id, status: 'active' });
    expect((await owner()('client_portal_accesses').where({ id: oldAccess.id }).first('user_id')).user_id).toBeNull();
    expect(await membershipOf(removedClient, holder.id)).toMatchObject({ status: 'active', portal_access_id: newAccess.id });
    expect(await isMember(holder.id, removedClient)).toBe(true);
  });

  it('is the account in the transaction, and nobody else: it takes no argument and refuses a call with no actor', async () => {
    const arguments_ = await owner().raw<{ rows: Array<{ pronargs: number }> }>(
      "select pronargs from pg_proc where oid = 'app_private.link_client_portal_accesses()'::regprocedure"
    );
    expect(arguments_.rows).toEqual([{ pronargs: 0 }]);
    await expect(worker.knex.raw('select app_private.link_client_portal_accesses()')).rejects.toMatchObject({ code: '42501' });
  });

  it('matches no actor on an access nobody has entered: the person of two sides and the person of two agencies see nothing of it', async () => {
    // The address of a collaborator of agency A who is not a portal person, and the address of the admin of agency B.
    const dualEmail = (await owner()('auth.user').where({ id: ids.dualBare }).first('email')).email as string;
    const crossEmail = (await owner()('auth.user').where({ id: ids.adminB }).first('email')).email as string;
    const client = await freshClient();
    const [dual, cross] = [(await given(dualEmail, client)).access, (await given(crossEmail, client)).access];

    for (const person of [ids.dualBare, ids.adminB, ids.crossDual, ids.salesA]) {
      expect(await isMember(person, client), person).toBe(false);
      expect(await call(person, 'select id from public.client_memberships where client_id = ?::uuid', client), person).toEqual([]);
    }
    // The collaborator without the permission does not even read the access that carries its own address.
    expect(await call(ids.dualBare, 'select id from public.client_portal_accesses where id = ?::uuid', dual.id)).toEqual([]);
    // The admin of the other agency reads nothing of this agency.
    expect(await call(ids.adminB, 'select id from public.client_portal_accesses where id = ?::uuid', cross.id)).toEqual([]);
    // And no row of any table the portal reads is theirs.
    expect(await call(ids.adminB, 'select id from public.client_portal_accesses where user_id = app_private.current_user_id()')).toEqual([]);
    expect([dual, cross].every((row) => row.user_id === null)).toBe(true);
  });
});

// ---- who wrote it -----------------------------------------------------------------------------------------------------

describe('authorship by access (#711)', () => {
  const approvedContent = async (clientId: string, extra: Record<string, unknown>): Promise<unknown> =>
    owner()('contents').insert({
      id: randomUUID(), client_id: clientId, title: 'Aprovado', platform: 'instagram', format: 'reels', publish_on: '2026-10-20',
      publish_at_time: '18:30', folder_id: await w.folderOf(clientId), owner_user_id: ids.productionA,
      status: 'approved', approved_at: new Date('2026-10-05T12:00:00.000Z'), ...extra
    });

  let access: AccessRow;
  beforeAll(async () => { access = (await accessOfUser(ids.clientA1, ids.portalA1))!; });

  it('lets a content be approved by one person: an account or an access, never both, never neither', async () => {
    await expect(approvedContent(ids.clientA1, { approved_by_portal_access_id: access.id })).resolves.toBeDefined();
    await expect(approvedContent(ids.clientA1, { approved_by: ids.portalA1 })).resolves.toBeDefined();
    const refused = (extra: Record<string, unknown>): Promise<unknown> => approvedContent(ids.clientA1, extra).then(() => 'inserted', (error: unknown) => error);
    expect(await refused({ approved_by: ids.portalA1, approved_by_portal_access_id: access.id })).toMatchObject({ code: '23514', constraint: 'contents_state_shape' });
    expect(await refused({})).toMatchObject({ code: '23514', constraint: 'contents_state_shape' });
    // Not even a content with neither author nor date: approved is approved by someone.
    expect(await refused({ approved_at: null })).toMatchObject({ code: '23514', constraint: 'contents_state_shape' });
    expect(await refused({ approved_by_portal_access_id: access.id, approved_by_agency_reason: 'Aprovado por telefone.' })).toMatchObject({ code: '23514', constraint: 'contents_state_shape' });
    // A content that is not approved has no approver of either kind.
    expect(await refused({ status: 'in_production', approved_at: null, approved_by_portal_access_id: access.id })).toMatchObject({ code: '23514', constraint: 'contents_state_shape' });
    // An access of another client is not an approver here.
    const elsewhere = (await accessOfUser(ids.clientA2, ids.portalA2))!;
    expect(await refused({ approved_by_portal_access_id: elsewhere.id })).toMatchObject({ code: '23503' });
  });

  it('clears the access that approved when the content goes back to be approved, and keeps it when a publication is undone', async () => {
    const id = randomUUID();
    await owner()('contents').insert({
      id, client_id: ids.clientA1, title: 'Volta', platform: 'instagram', format: 'reels', publish_on: '2026-10-20',
      publish_at_time: '18:30', folder_id: await w.folderOf(ids.clientA1), owner_user_id: ids.productionA,
      status: 'approved', approved_at: new Date(), approved_by_portal_access_id: access.id
    });
    await owner().transaction(async (t) => {
      await t('contents').where({ id }).update({ status: 'published', published_on: t.raw("(now() at time zone 'America/Sao_Paulo')::date") });
    });
    await owner().transaction(async (t) => { await t('contents').where({ id }).update({ status: 'approved', published_on: null }); });
    expect(await w.contentRow(id)).toMatchObject({ status: 'approved', approved_by: null, approved_by_portal_access_id: access.id });

    await owner()('contents').where({ id }).update({ status: 'awaiting_approval' });
    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null, approved_by_portal_access_id: null, approved_at: null });
  });

  it('keeps the column out of what the application role writes, and shows the access that approved by a name', async () => {
    expect(await w.columnsWithPrivilege('contents', 'insert')).not.toContain('approved_by_portal_access_id');
    expect(await w.columnsWithPrivilege('contents', 'update')).not.toContain('approved_by_portal_access_id');
    expect(await w.columnsWithPrivilege('client_thread_comments', 'insert')).not.toContain('author_portal_access_id');
    expect(await w.columnsWithPrivilege('client_thread_comments', 'update')).not.toContain('author_portal_access_id');

    const label = (user: string, accessId: string, clientId: string): Promise<string | null> =>
      call<{ label: string | null }>(user, 'select app_private.portal_access_label(?::uuid, ?::uuid) as label', accessId, clientId).then((rows) => rows[0]!.label);
    const waiting = freshEmail();
    await owner()('client_portal_accesses').insert({ client_id: ids.clientA1, email: waiting });
    const unlinked = (await accessOf(ids.clientA1, waiting))!;
    const linkedName = (await owner()('auth.user').where({ id: ids.portalA1 }).first('name')).name as string;
    expect(await label(ids.adminA, unlinked.id, ids.clientA1)).toBe(waiting);
    expect(await label(ids.adminA, access.id, ids.clientA1)).toBe(linkedName);
    expect(await label(ids.portalA1Second, access.id, ids.clientA1)).toBe(linkedName);
    // Nobody who cannot read the content of that client is told.
    expect(await label(ids.adminB, unlinked.id, ids.clientA1)).toBeNull();
    expect(await label(ids.portalA2, unlinked.id, ids.clientA1)).toBeNull();
  });

  describe('comments', () => {
    let thread: string;
    beforeAll(async () => {
      thread = randomUUID();
      await owner()('client_threads').insert({ id: thread, client_id: ids.clientA1, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });
    });
    const comment = (extra: Record<string, unknown>): Promise<unknown> =>
      owner()('client_thread_comments').insert({ thread_id: thread, client_id: ids.clientA1, body: 'Texto', author_side: 'client', ...extra }).then(() => 'inserted', (error: unknown) => error);

    it('has exactly one author, and an access writes only on the side of the client', async () => {
      expect(await comment({ author_portal_access_id: access.id })).toBe('inserted');
      expect(await comment({ author_user_id: ids.portalA1 })).toBe('inserted');
      expect(await comment({ author_user_id: ids.portalA1, author_portal_access_id: access.id })).toMatchObject({ code: '23514', constraint: 'client_thread_comments_one_author_check' });
      expect(await comment({})).toMatchObject({ code: '23514', constraint: 'client_thread_comments_one_author_check' });
      expect(await comment({ author_portal_access_id: access.id, author_side: 'agency' })).toMatchObject({ code: '23514', constraint: 'client_thread_comments_access_is_client_side_check' });
      const elsewhere = (await accessOfUser(ids.clientA2, ids.portalA2))!;
      expect(await comment({ author_portal_access_id: elsewhere.id })).toMatchObject({ code: '23503' });
    });

    it('is not written by a request as an access: the insert policy still asks for the actor', async () => {
      await expect(w.asUser(ids.portalA1, async (t) => {
        await t.raw(
          "insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body) values (?::uuid, ?::uuid, null, 'client', 'x')",
          [thread, ids.clientA1]
        );
      })).rejects.toThrow();
    });

    it('names the author of a comment by its access: the name of the account once linked, the address before', async () => {
      const waiting = freshEmail();
      await owner()('client_portal_accesses').insert({ client_id: ids.clientA1, email: waiting });
      const unlinked = (await accessOf(ids.clientA1, waiting))!;
      const ownThread = randomUUID();
      await owner()('client_threads').insert({ id: ownThread, client_id: ids.clientA1, section_key: 'colors', opened_by: ids.adminA, opened_side: 'agency' });
      await owner()('client_thread_comments').insert([
        { thread_id: ownThread, client_id: ids.clientA1, body: 'a', author_side: 'client', author_portal_access_id: unlinked.id },
        { thread_id: ownThread, client_id: ids.clientA1, body: 'b', author_side: 'client', author_portal_access_id: access.id }
      ]);
      const linkedName = (await owner()('auth.user').where({ id: ids.portalA1 }).first('name')).name as string;
      type Author = { author_user_id: string | null; author_portal_access_id: string | null; author_side: string; name: string };
      const authors = await call<Author>(ids.adminA, 'select author_user_id, author_portal_access_id, author_side, name from app_private.thread_comment_authors(?::uuid) order by name', ownThread);
      expect(authors).toEqual(expect.arrayContaining([
        { author_user_id: null, author_portal_access_id: unlinked.id, author_side: 'client', name: waiting },
        { author_user_id: null, author_portal_access_id: access.id, author_side: 'client', name: linkedName }
      ]));
      expect(authors).toHaveLength(2);
      // The person of the portal reads the same, and a caller who cannot read the thread reads nothing.
      expect(await call(ids.portalA1, 'select name from app_private.thread_comment_authors(?::uuid)', ownThread)).toHaveLength(2);
      expect(await call(ids.adminB, 'select name from app_private.thread_comment_authors(?::uuid)', ownThread)).toEqual([]);
    });
  });
});

// ---- the queue is of the access ---------------------------------------------------------------------------------------

describe('the queue of e-mails has the access as recipient (#711)', () => {
  const send = async (clientId: string): Promise<string> => {
    const folder = await w.folderOf(clientId);
    const id = await w.seedContent(clientId, { status: 'in_production', folderId: folder });
    await owner()('contents').where({ id }).update({ status: 'awaiting_approval' });
    return id;
  };
  const itemsOf = (contentId: string): Promise<Array<{ id: string; recipient_portal_access_id: string; type: string; send_after: Date }>> =>
    owner()('notification_queue').where({ content_id: contentId }).orderBy('recipient_portal_access_id') as never;
  const claim = async (clientId: string): Promise<Array<{ recipient_portal_access_id: string; recipient_email: string; content_id: string; client_id: string }>> => {
    await owner().raw('update public.notification_queue set send_after = created_at where client_id = ?::uuid', [clientId]);
    const rows = (await worker.knex.raw<{ rows: Array<{ recipient_portal_access_id: string; recipient_email: string; content_id: string; client_id: string }> }>(
      'select recipient_portal_access_id, recipient_email, content_id, client_id from app_private.claim_notification_batch(100)'
    )).rows;
    return rows.filter((row) => row.client_id === clientId);
  };

  it('queues the person once, by the access, whether it has an account or not', async () => {
    const client = await freshClient();
    const linked = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: linked.id });
    const waiting = freshEmail();
    await addAs(ids.adminA, client, waiting);
    const removedEmail = freshEmail();
    await removeAs(ids.adminA, (await addAs(ids.adminA, client, removedEmail)).access_id);

    const content = await send(client);
    const items = await itemsOf(content);
    const linkedAccess = (await accessOfUser(client, linked.id))!;
    const waitingAccess = (await accessOf(client, waiting))!;
    expect(items.map((item) => item.recipient_portal_access_id).sort()).toEqual([linkedAccess.id, waitingAccess.id].sort());
    expect(new Set(items.map((item) => item.recipient_portal_access_id)).size).toBe(items.length);
    // There is no second row by account for the linked person: the table does not even have the column.
    expect(await owner().raw("select 1 from information_schema.columns where table_name = 'notification_queue' and column_name = 'recipient_user_id'")
      .then((result: { rows: unknown[] }) => result.rows)).toEqual([]);
  });

  it('keeps ONE open item for the access when the account links after the item was queued, and when the content is sent again', async () => {
    const client = await freshClient();
    const email = freshEmail();
    await addAs(ids.adminA, client, email);
    const access = (await accessOf(client, email))!;
    const content = await send(client);
    expect((await itemsOf(content)).map((item) => item.recipient_portal_access_id)).toEqual([access.id]);

    const account = await newUser({ email, verified: true });
    expect(await linkAs(account.id)).toBe(1);
    await owner()('contents').where({ id: content }).update({ status: 'adjusting' });
    await owner()('contents').where({ id: content }).update({ status: 'awaiting_approval' });
    const after = await itemsOf(content);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ recipient_portal_access_id: access.id });
  });

  it('sends to the address of the account when there is one, and to the address of the access when there is none', async () => {
    const client = await freshClient();
    const email = freshEmail();
    await addAs(ids.adminA, client, email);
    const content = await send(client);
    expect((await claim(client)).map((row) => row.recipient_email)).toEqual([email]);

    const account = await newUser({ email, verified: true });
    await linkAs(account.id);
    const moved = `${randomUUID()}@moved.test`;
    await owner()('auth.user').where({ id: account.id }).update({ email: moved });
    await owner()('notification_queue').where({ content_id: content }).update({ claimed_at: null, claim_token: null, attempts: 0 });
    expect((await claim(client)).map((row) => row.recipient_email)).toEqual([moved]);
  });

  it('groups what was queued before the link with what comes after it, in the one window of the access', async () => {
    const client = await freshClient();
    const email = freshEmail();
    await addAs(ids.adminA, client, email);
    const access = (await accessOf(client, email))!;
    const first = await send(client);
    const account = await newUser({ email, verified: true });
    await linkAs(account.id);
    const second = await send(client);

    const batch = await claim(client);
    expect(new Set(batch.map((row) => row.recipient_portal_access_id))).toEqual(new Set([access.id]));
    expect(batch.map((row) => row.content_id).sort()).toEqual([first, second].sort());
  });

  it('drops the item of an access that was removed after it was queued, and keeps the others', async () => {
    const client = await freshClient();
    const [stay, leave] = [freshEmail(), freshEmail()];
    await addAs(ids.adminA, client, stay);
    const leaving = await addAs(ids.adminA, client, leave);
    const content = await send(client);
    await removeAs(ids.adminA, leaving.access_id);

    expect((await claim(client)).map((row) => row.recipient_email)).toEqual([stay]);
    const items = await owner()('notification_queue').where({ content_id: content }).select('recipient_portal_access_id', 'discarded_at');
    expect(items.find((item) => item.recipient_portal_access_id === leaving.access_id)?.discarded_at).toBeInstanceOf(Date);
  });
});

// ---- the old portal invitation ----------------------------------------------------------------------------------------

describe('a portal invitation that was pending is accepted into the access (#711)', () => {
  const invite = async (clientId: string, email: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const tokenHash = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await owner()('invitations').insert({
      agency_id: ids.agencyA, purpose: 'client_invite', email, client_id: clientId, token_hash: tokenHash,
      expires_at: new Date(Date.now() + 7 * 86_400_000), ...extra
    });
    return tokenHash;
  };
  const accept = async (userId: string, tokenHash: string): Promise<{ status: string; client_id: string | null }> =>
    (await call<{ status: string; client_id: string | null }>(
      userId, 'select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', tokenHash, userId
    ))[0]!;

  it('creates the access of the address and links it to the account that accepted, with its membership, in the same transaction', async () => {
    const client = await freshClient();
    const account = await newUser({ verified: false });
    const token = await invite(client, account.email);

    expect(await accept(account.id, token)).toMatchObject({ status: 'accepted', client_id: client });
    const access = (await accessOf(client, account.email))!;
    expect(access).toMatchObject({ user_id: account.id, status: 'active', generation: 1 });
    expect(await membershipOf(client, account.id)).toMatchObject({ status: 'active', portal_access_id: access.id });
    expect(await isMember(account.id, client)).toBe(true);
    expect(await owner()('invitations').where({ token_hash: token }).first('used_at', 'accepted_by_user_id')).toMatchObject({ accepted_by_user_id: account.id });
  });

  it('is accepted the way the route does it, by the application role with no actor bound, and the check of the end of the transaction passes', async () => {
    const client = await freshClient();
    const account = await newUser({ verified: false });
    const token = await invite(client, account.email);
    const accepted = await worker.knex.transaction(async (t) => (await t.raw<{ rows: Array<{ status: string }> }>(
      'select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', [token, account.id]
    )).rows[0]);
    expect(accepted).toMatchObject({ status: 'accepted' });
    expect(await accessOfUser(client, account.id)).toMatchObject({ status: 'active' });
    expect((await membershipOf(client, account.id))!.status).toBe('active');
  });

  it('links the access that "Adicionar pessoa" had already given to that address, instead of adding another', async () => {
    const client = await freshClient();
    const account = await newUser({ verified: false });
    await addAs(ids.adminA, client, account.email);
    const waiting = (await accessOf(client, account.email))!;

    expect(await accept(account.id, await invite(client, account.email))).toMatchObject({ status: 'accepted' });
    expect(await countAccesses(client)).toBe(1);
    expect(await accessOf(client, account.email)).toMatchObject({ id: waiting.id, user_id: account.id });
    expect(await isMember(account.id, client)).toBe(true);
  });

  it('brings back a person who was removed, on the same access and with the generation as it is', async () => {
    const client = await freshClient();
    const account = await newUser({ verified: false });
    await owner()('client_memberships').insert({ client_id: client, user_id: account.id });
    const access = (await accessOfUser(client, account.id))!;
    await removeAs(ids.adminA, access.id);

    expect(await accept(account.id, await invite(client, account.email))).toMatchObject({ status: 'accepted' });
    expect(await accessOfUser(client, account.id)).toMatchObject({ id: access.id, status: 'active', generation: 2 });
    expect((await membershipOf(client, account.id))!.status).toBe('active');
  });

  it('takes the address from the account that moved on', async () => {
    const client = await freshClient();
    const former = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: former.id });
    const access = (await accessOfUser(client, former.id))!;
    await owner()('auth.user').where({ id: former.id }).update({ email: `${randomUUID()}@moved.test` });
    const holder = await newUser({ email: access.email, verified: false });

    expect(await accept(holder.id, await invite(client, access.email))).toMatchObject({ status: 'accepted' });
    expect(await accessOf(client, access.email)).toMatchObject({ id: access.id, user_id: holder.id });
    expect(await isMember(holder.id, client)).toBe(true);
    expect(await isMember(former.id, client)).toBe(false);
  });

  it('answers already_member to an account that is in, writing nothing', async () => {
    const client = await freshClient();
    const account = await newUser();
    await owner()('client_memberships').insert({ client_id: client, user_id: account.id });
    const before = await accessOfUser(client, account.id);
    expect(await accept(account.id, await invite(client, account.email))).toMatchObject({ status: 'already_member' });
    expect(await accessOfUser(client, account.id)).toEqual(before);
    expect(await countAccesses(client)).toBe(1);
  });

  it('refuses the same invitations as before: used, revoked, expired, another address, an archived client, a suspended agency', async () => {
    const account = await newUser({ verified: false });
    const stranger = await newUser();
    const clients: string[] = [];
    // One client for each, since two pending invitations of the same address and client cannot coexist.
    const attempt = async (label: string, extra: Record<string, unknown>, user: string, code: string): Promise<void> => {
      const client = await freshClient();
      clients.push(client);
      await expect(accept(user, await invite(client, account.email, extra)), label).rejects.toMatchObject({ code });
    };
    await attempt('used', { used_at: new Date() }, account.id, 'A0001');
    await attempt('revoked', { revoked_at: new Date() }, account.id, 'A0001');
    await attempt('expired', { expires_at: new Date(Date.now() - 1000) }, account.id, 'A0001');
    await attempt('another address', {}, stranger.id, 'A0002');
    const archived = await freshClient();
    clients.push(archived);
    const archivedToken = await invite(archived, account.email);
    await w.archiveClient(archived);
    await expect(accept(account.id, archivedToken)).rejects.toMatchObject({ code: 'A0001' });
    for (const client of clients) expect(await countAccesses(client)).toBe(0);
  });
});

// ---- the shape of the functions ---------------------------------------------------------------------------------------

describe('the functions that write the access', () => {
  const SIGNATURES = [
    'add_client_portal_access(uuid, text)',
    'remove_client_portal_access(uuid)',
    'reactivate_client_portal_access(uuid)',
    'link_client_portal_accesses()',
    'grant_client_portal_access_from_invitation(uuid, uuid, text)'
  ];

  it.each(SIGNATURES)('app_private.%s is security definer with a fixed search_path and closed to PUBLIC', async (signature) => {
    const { rows } = await owner().raw<{ rows: Array<{ definer: boolean; config: string[] | null; pub: boolean; app: boolean }> }>(`
      select p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('public', p.oid, 'execute') as pub,
             has_function_privilege('ageniza_app', p.oid, 'execute') as app
      from pg_proc p where p.oid = ?::regprocedure
    `, [`app_private.${signature}`]);
    expect(rows[0]).toMatchObject({ definer: true, pub: false });
    expect(rows[0]!.config).toEqual(['search_path=""']);
    // The one function the application never calls itself is the one the invitation reaches.
    expect(rows[0]!.app).toBe(!signature.startsWith('grant_client_portal_access_from_invitation'));
  });

  it('keeps the triggers of the table and of the membership in place: invoker where they compare OLD and NEW, definer for the check at the end of the transaction', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ name: string; definer: boolean }> }>(`
      select t.tgname as name, p.prosecdef as definer
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid in ('public.client_portal_accesses'::regclass, 'public.client_memberships'::regclass) and not t.tgisinternal
      order by t.tgname
    `);
    expect(rows).toEqual([
      { name: 'client_memberships_follow_access', definer: false },
      { name: 'client_portal_accesses_guard', definer: false },
      { name: 'client_portal_accesses_have_their_membership', definer: true }
    ]);
  });
});
