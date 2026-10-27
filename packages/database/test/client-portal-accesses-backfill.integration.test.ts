import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveIntegrationDatabaseUrls } from '../src/index.js';

// Issue #711: the migration that gives the access to an e-mail address must carry what already exists. The database is built with
// the migrations up to the one before this change, filled the way the old code filled it, and then upgraded: the memberships
// (removed ones too) become accesses, the open items of the queue name the access, and a portal invitation that was pending when
// the change shipped is still accepted afterwards.
const { ownerUrl } = resolveIntegrationDatabaseUrls();
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const FIRST_OF_THIS_CHANGE = '20261027040100_client_portal_accesses.mjs';

const databaseName = `ageniza_backfill_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
let admin: Knex;
let upgrade: Knex;
const workDir = mkdtempSync(join(tmpdir(), 'ageniza-backfill-'));

const ids = {
  agency: randomUUID(), suspendedAgency: randomUUID(),
  clientOne: randomUUID(), clientTwo: randomUUID(), archivedClient: randomUUID(),
  active: randomUUID(), removed: randomUUID(), both: randomUUID(), upperCased: randomUUID(), invitee: randomUUID(),
  activeTwo: randomUUID(), archivedMember: randomUUID(),
  invitedLater: randomUUID(), collaborator: randomUUID()
};
const emailOf = (id: string): string => `${id}@backfill.test`;

const rowsOf = async (table: string, where: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> =>
  upgrade(table).where(where) as unknown as Promise<Array<Record<string, unknown>>>;

let contentOne: string;
let contentTwo: string;
const queued: Record<string, string> = {};
let membershipBefore: Array<Record<string, unknown>> = [];
const invitationToken = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');

beforeAll(async () => {
  // The migrations before this change, in a directory of their own: knex runs only what is in the directory it is given.
  const earlier = join(workDir, 'earlier');
  mkdirSync(earlier);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.mjs') && name < FIRST_OF_THIS_CHANGE)) {
    cpSync(join(migrationsDir, file), join(earlier, file));
  }

  admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
  await admin.raw(`create database "${databaseName}"`);
  const target = new URL(ownerUrl);
  target.pathname = `/${databaseName}`;
  upgrade = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 2 } });
  await upgrade.migrate.latest({ directory: earlier, loadExtensions: ['.mjs'] });
  expect(await upgrade.schema.hasTable('client_portal_accesses')).toBe(false);

  // The world as the old code left it.
  const user = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, email: emailOf(id), emailVerified: true, ...extra });
  await upgrade('auth.user').insert([
    user(ids.active, 'Ativa'), user(ids.removed, 'Removida'), user(ids.both, 'Nos dois'), user(ids.invitee, 'Convidada'),
    user(ids.activeTwo, 'Ativa Dois'), user(ids.archivedMember, 'Do arquivado'), user(ids.invitedLater, 'Convidada Depois', { emailVerified: false }),
    user(ids.collaborator, 'Colaboradora')
  ]);
  await upgrade('agencies').insert([
    { id: ids.agency, name: `Backfill ${ids.agency}`, owner_user_id: null },
    { id: ids.suspendedAgency, name: `Backfill suspensa ${ids.suspendedAgency}`, owner_user_id: null, status: 'suspended' }
  ]);
  await upgrade('clients').insert([
    { id: ids.clientOne, agency_id: ids.agency, name: `Cliente Um ${ids.clientOne}` },
    { id: ids.clientTwo, agency_id: ids.agency, name: `Cliente Dois ${ids.clientTwo}` },
    { id: ids.archivedClient, agency_id: ids.agency, name: `Arquivado ${ids.archivedClient}`, status: 'archived', archived_at: new Date() }
  ]);
  // The person in charge of a content is an active collaborator of the agency who can see Conteúdo.
  await upgrade('agency_memberships').insert({
    agency_id: ids.agency, user_id: ids.collaborator, role_id: (await upgrade('roles').whereNull('agency_id').where({ key: 'admin' }).first('id')).id
  });
  const created = new Date('2026-09-01T12:00:00.000Z');
  const touched = new Date('2026-09-02T12:00:00.000Z');
  await upgrade('client_memberships').insert([
    { client_id: ids.clientOne, user_id: ids.active, status: 'active', created_at: created, updated_at: touched },
    { client_id: ids.clientOne, user_id: ids.removed, status: 'removed', created_at: created, updated_at: touched },
    { client_id: ids.clientOne, user_id: ids.both, status: 'active', created_at: created, updated_at: touched },
    { client_id: ids.clientTwo, user_id: ids.both, status: 'removed', created_at: created, updated_at: touched },
    { client_id: ids.clientTwo, user_id: ids.activeTwo, status: 'active', created_at: created, updated_at: touched },
    { client_id: ids.archivedClient, user_id: ids.archivedMember, status: 'active', created_at: created, updated_at: touched }
  ]);
  membershipBefore = await rowsOf('client_memberships');

  // A pending portal invitation for an address that has an account and no link yet, and the queue of two contents.
  await upgrade('invitations').insert({
    agency_id: ids.agency, purpose: 'client_invite', email: emailOf(ids.invitedLater), client_id: ids.clientOne,
    token_hash: invitationToken, expires_at: new Date(Date.now() + 7 * 86_400_000)
  });
  const folder = async (clientId: string): Promise<string> => (await upgrade('media_folders').where({ client_id: clientId, is_default: true }).first('id')).id as string;
  contentOne = randomUUID();
  contentTwo = randomUUID();
  await upgrade('contents').insert([
    { id: contentOne, client_id: ids.clientOne, title: 'Um', platform: 'instagram', format: 'reels', publish_on: '2026-10-20', folder_id: await folder(ids.clientOne), owner_user_id: ids.collaborator, status: 'awaiting_approval' },
    { id: contentTwo, client_id: ids.clientTwo, title: 'Dois', platform: 'instagram', format: 'reels', publish_on: '2026-10-20', folder_id: await folder(ids.clientTwo), owner_user_id: ids.collaborator, status: 'awaiting_approval' }
  ]);
  const base = { type: 'content_awaiting_approval', send_after: new Date('2026-10-01T12:00:00.000Z') };
  const item = (key: string, extra: Record<string, unknown>) => ({ id: (queued[key] = randomUUID()), ...base, ...extra });
  await upgrade('notification_queue').insert([
    item('open', { client_id: ids.clientOne, content_id: contentOne, recipient_user_id: ids.active }),
    item('openRemoved', { client_id: ids.clientOne, content_id: contentOne, recipient_user_id: ids.removed }),
    item('sent', { client_id: ids.clientTwo, content_id: contentTwo, recipient_user_id: ids.activeTwo, sent_at: new Date('2026-10-02T12:00:00.000Z') }),
    item('discarded', { client_id: ids.clientTwo, content_id: contentTwo, recipient_user_id: ids.both, discarded_at: new Date('2026-10-02T12:00:00.000Z') })
  ]);

  // The change itself.
  await upgrade.migrate.latest({ directory: migrationsDir, loadExtensions: ['.mjs'] });
}, 240_000);

afterAll(async () => {
  try {
    await upgrade?.destroy();
    await admin?.raw(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin?.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('the backfill of the accesses from the memberships (#711)', () => {
  it('turns every membership into an access of the same client, account, state and dates, removed ones included', async () => {
    const accesses = await rowsOf('client_portal_accesses');
    expect(accesses).toHaveLength(membershipBefore.length);
    for (const membership of membershipBefore) {
      const access = accesses.find((row) => row.client_id === membership.client_id && row.user_id === membership.user_id);
      expect(access, `${membership.client_id}/${membership.user_id}`).toMatchObject({
        email: emailOf(membership.user_id as string),
        status: membership.status,
        generation: 1,
        created_at: membership.created_at,
        updated_at: membership.updated_at
      });
    }
    // Both memberships of the person of two clients became two accesses, one active and one removed.
    expect((await rowsOf('client_portal_accesses', { user_id: ids.both })).map((row) => row.status).sort()).toEqual(['active', 'removed']);
  });

  it('ties every membership to its access, with its own id, state and onboarding date as they were', async () => {
    const after = await rowsOf('client_memberships');
    expect(after).toHaveLength(membershipBefore.length);
    for (const before of membershipBefore) {
      const now = after.find((row) => row.id === before.id)!;
      expect(now).toMatchObject({ client_id: before.client_id, user_id: before.user_id, status: before.status, onboarding_seen_at: before.onboarding_seen_at });
      const access = (await rowsOf('client_portal_accesses', { id: now.portal_access_id }))[0]!;
      expect(access).toMatchObject({ client_id: before.client_id, user_id: before.user_id, status: before.status });
    }
  });

  it('points every item of the queue, open or closed, at the access of its person and client, and drops the column of the account', async () => {
    const accessOf = async (clientId: string, userId: string): Promise<string> => (await rowsOf('client_portal_accesses', { client_id: clientId, user_id: userId }))[0]!.id as string;
    const expected: Record<string, string> = {
      open: await accessOf(ids.clientOne, ids.active),
      openRemoved: await accessOf(ids.clientOne, ids.removed),
      sent: await accessOf(ids.clientTwo, ids.activeTwo),
      discarded: await accessOf(ids.clientTwo, ids.both)
    };
    for (const [key, access] of Object.entries(expected)) {
      expect((await rowsOf('notification_queue', { id: queued[key] }))[0], key).toMatchObject({ recipient_portal_access_id: access });
    }
    expect(await upgrade.schema.hasColumn('notification_queue', 'recipient_user_id')).toBe(false);
    // The item of a person who was removed is judged at the claim, as before: the access is removed, so it is dropped.
    await upgrade.raw('update public.notification_queue set send_after = created_at');
    const claimed = await upgrade.raw<{ rows: Array<{ item_id: string }> }>('select item_id from app_private.claim_notification_batch(100)');
    expect(claimed.rows.map((row) => row.item_id)).toEqual([queued.open]);
    expect((await rowsOf('notification_queue', { id: queued.openRemoved }))[0]!.discarded_at).toBeInstanceOf(Date);
  });

  it('keeps the open item of the queue unique per access, as it was per person', async () => {
    const access = (await rowsOf('notification_queue', { id: queued.open }))[0]!.recipient_portal_access_id;
    await upgrade('notification_queue').where({ id: queued.open }).update({ claimed_at: null, claim_token: null });
    await expect(upgrade('notification_queue').insert({
      type: 'content_awaiting_approval', client_id: ids.clientOne, content_id: contentOne, recipient_portal_access_id: access, send_after: new Date()
    })).rejects.toMatchObject({ code: '23505', constraint: 'notification_queue_open_item_key' });
  });

  it('leaves the people of the portal where they were: the memberships still open the portal', async () => {
    const asUser = async (userId: string, clientId: string): Promise<boolean> => upgrade.transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [userId]);
      return (await transaction.raw<{ rows: Array<{ member: boolean }> }>('select app_private.is_client_member(?::uuid) as member', [clientId])).rows[0]!.member;
    });
    expect(await asUser(ids.active, ids.clientOne)).toBe(true);
    expect(await asUser(ids.removed, ids.clientOne)).toBe(false);
    expect(await asUser(ids.both, ids.clientOne)).toBe(true);
    expect(await asUser(ids.both, ids.clientTwo)).toBe(false);
    // Archived clients keep their link and their access, which the archive never touched.
    expect((await rowsOf('client_portal_accesses', { client_id: ids.archivedClient }))).toHaveLength(1);
  });
});

describe('a portal invitation that was pending when the change shipped (#711)', () => {
  it('is still accepted afterwards: it creates the access of its address and links the account, in the same transaction', async () => {
    const accepted = await upgrade.transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.invitedLater]);
      return (await transaction.raw<{ rows: Array<{ status: string; agency_id: string; client_id: string }> }>(
        'select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', [invitationToken, ids.invitedLater]
      )).rows[0]!;
    });
    expect(accepted).toMatchObject({ status: 'accepted', agency_id: ids.agency, client_id: ids.clientOne });

    const access = (await rowsOf('client_portal_accesses', { client_id: ids.clientOne, email: emailOf(ids.invitedLater) }))[0]!;
    expect(access).toMatchObject({ user_id: ids.invitedLater, status: 'active', generation: 1 });
    expect((await rowsOf('client_memberships', { client_id: ids.clientOne, user_id: ids.invitedLater }))[0]).toMatchObject({ status: 'active', portal_access_id: access.id });
    expect((await rowsOf('invitations', { token_hash: invitationToken }))[0]).toMatchObject({ accepted_by_user_id: ids.invitedLater });
  });
});
