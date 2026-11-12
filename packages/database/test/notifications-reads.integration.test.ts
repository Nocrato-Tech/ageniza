import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { createContentWorld } from './support/content-world.js';
import { createNotificationFixtures, type NotificationKind } from './support/notification-fixtures.js';

// Scope redesign-igual, subtask W1-S3 (specs/notificacoes.md, rules 1, 2, 3 and 5; decision 2026-11-11 "notificações só dentro do app com cinco
// eventos"): a notification is the person's, read only by them, with the permission of its subject held at every read, and written by no
// role of the application. Every read and every attempt runs as `ageniza_app` with the person bound; the owner plants the rows (it is the
// only role that may) and reads what was left. RLS filters silently, so a read is judged by the rows it returns and a write by the table.
const w = createContentWorld('notif-reads');
const f = createNotificationFixtures(w);
const { ids } = w;
const owner = (): Knex => w.getOwner().knex;

beforeAll(async () => {
  await w.setup();
}, 300_000);

afterAll(async () => {
  try {
    await f.cleanUp();
  } finally {
    await w.teardown();
  }
});

const permissionDenied = (relation: string): { code: string; message: unknown } => ({
  code: '42501', message: expect.stringMatching(new RegExp(`permission denied for (table|function) ${relation}`))
});

const KINDS_BY_SUBJECT: ReadonlyArray<readonly [NotificationKind, string, 'collaborator_invite' | 'client_invite' | undefined]> = [
  ['content_approved', 'conteudo.visualizar', undefined],
  ['content_changes_requested', 'conteudo.visualizar', undefined],
  ['approval_deadline_passed', 'conteudo.visualizar', undefined],
  ['material_request_answered', 'cliente.visualizar', undefined],
  ['invitation_accepted', 'colaborador.visualizar', 'collaborator_invite'],
  ['invitation_accepted', 'cliente.convidar_usuario', 'client_invite']
];

const adminRole = async (): Promise<string> => (await owner()('roles').whereNull('agency_id').where({ key: 'admin' }).first('id'))!.id as string;

const customRoleOf = async (user: string): Promise<string> =>
  (await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: user }).first('role_id'))!.role_id as string;

describe('a notification is read only by the person it is for (acceptance a)', () => {
  it('lets the person read theirs: the responsible of a content, with only the permission to see it', async () => {
    const person = await w.personWith('conteudo.visualizar');
    const mine = await f.seed({ kind: 'content_approved', recipient: person });
    const another = await f.seed({ kind: 'content_approved', recipient: ids.productionA });

    expect(await f.visibleTo(person)).toEqual([mine]);
    expect(await f.visibleTo(ids.productionA)).toEqual([another]);
  });

  it('shows a person of the agency nothing of another person, whatever their role: not the Admin, not the Owner, not who also holds the permission', async () => {
    const theirs = await f.seed({ kind: 'content_changes_requested', recipient: ids.productionA });
    const control = await f.seed({ kind: 'content_changes_requested', recipient: ids.adminA });

    for (const reader of [ids.adminA, ids.ownerA, ids.managerA]) {
      expect(await f.visibleTo(reader), reader).not.toContain(theirs);
    }
    // The same Admin and Owner do read what is theirs: it is the recipient that decides, not a lack of rights.
    expect(await f.visibleTo(ids.adminA)).toContain(control);
    const ownerOwn = await f.seed({ kind: 'content_approved', recipient: ids.ownerA });
    expect(await f.visibleTo(ids.ownerA)).toContain(ownerOwn);
  });

  it('shows a person of another agency nothing, though their role is the Admin of theirs', async () => {
    const theirs = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    const ownOfB = await f.seed({ kind: 'content_approved', recipient: ids.adminB, clientId: ids.clientB, agencyId: ids.agencyB });

    expect(await f.visibleTo(ids.adminB)).toEqual([ownOfB]);
    expect(await f.visibleTo(ids.adminB)).not.toContain(theirs);
  });

  it('shows nothing to a person whose link to the agency was removed, and not what the notification was before either', async () => {
    const person = await w.personWith('conteudo.visualizar');
    const mine = await f.seed({ kind: 'content_approved', recipient: person });
    expect(await f.visibleTo(person)).toEqual([mine]);

    await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: person }).update({ status: 'removed' });
    expect(await f.visibleTo(person)).toEqual([]);

    await owner()('agency_memberships').where({ agency_id: ids.agencyA, user_id: person }).update({ status: 'active' });
    expect(await f.visibleTo(person)).toEqual([mine]);
  });

  it('shows nothing to a person who has only the portal of the client, even when the row is theirs', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.portalA1 });
    const planted2 = await f.seed({ kind: 'material_request_answered', recipient: ids.portalA1 });

    expect(await f.visibleTo(ids.portalA1)).toEqual([]);
    expect(await f.rowsOf(ids.portalA1)).toHaveLength(2);
    expect([planted, planted2]).toHaveLength(2);
  });

  it('shows nothing to the person of two sides whose agency role lacks the permission, though the link to the client is active (dualBare)', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.dualBare });
    const request = await f.seed({ kind: 'material_request_answered', recipient: ids.dualBare });

    // dualBare is Sales: it holds `cliente.visualizar` and no `conteudo.*`, and it holds a link to the client A1.
    expect(await f.visibleTo(ids.dualBare)).toEqual([request]);
    expect(planted).not.toBe(request);
  });

  it('shows nothing to the Admin of another agency who holds a link to a client of this one, though the row is theirs and the client link is active (crossDual)', async () => {
    const aboutA = await f.seed({ kind: 'content_approved', recipient: ids.crossDual });
    const ownOfB = await f.seed({ kind: 'content_approved', recipient: ids.crossDual, clientId: ids.clientB, agencyId: ids.agencyB });

    expect(await f.visibleTo(ids.crossDual)).toEqual([ownOfB]);
    expect(await f.visibleTo(ids.crossDual)).not.toContain(aboutA);
  });

  it('shows the person of two sides, who holds the permission in the agency, what is theirs, and the portal side adds nothing to anyone else (dualFull)', async () => {
    const mine = await f.seed({ kind: 'content_approved', recipient: ids.dualFull });
    const theirs = await f.seed({ kind: 'content_approved', recipient: ids.productionA });

    expect(await f.visibleTo(ids.dualFull)).toEqual([mine]);
    expect(await f.visibleTo(ids.dualFull)).not.toContain(theirs);
  });

  it('shows nothing when the call has no actor: a read with nobody bound reads no row', async () => {
    await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    const transaction = await w.getOwner().knex.transaction();
    try {
      await transaction.raw('set local role ageniza_app');
      const rows = await transaction('notifications').select('id');
      expect(rows).toEqual([]);
    } finally {
      await transaction.rollback();
    }
  });
});

describe('losing the permission of the subject hides the notification, at every read (acceptance b)', () => {
  it.each(KINDS_BY_SUBJECT)('%s: hidden without %s (%s), and back when the person holds it again', async (kind, permission, purpose) => {
    const person = await w.personWith(permission);
    const planted = await f.seed({ kind, recipient: person, ...(purpose === undefined ? {} : { purpose }) });
    expect(await f.visibleTo(person)).toEqual([planted]);

    const role = await customRoleOf(person);
    await owner()('role_permissions').where({ role_id: role, permission_key: permission }).delete();
    expect(await f.visibleTo(person)).toEqual([]);
    expect(await f.rowsOf(person)).toHaveLength(1);

    await owner()('role_permissions').insert({ role_id: role, permission_key: permission });
    expect(await f.visibleTo(person)).toEqual([planted]);
  });

  it.each(KINDS_BY_SUBJECT)('%s: hidden to the person who holds every other permission but %s (%s)', async (kind, permission, purpose) => {
    const others = ['conteudo.visualizar', 'cliente.visualizar', 'colaborador.visualizar', 'cliente.convidar_usuario'].filter((key) => key !== permission);
    const person = await w.personWith(...others);
    await f.seed({ kind, recipient: person, ...(purpose === undefined ? {} : { purpose }) });

    expect(await f.visibleTo(person)).toEqual([]);
    expect(await f.rowsOf(person)).toHaveLength(1);
  });

  it('keeps the Owner reading their own notification of every subject, with no role at all: ownership is the permission', async () => {
    const planted: string[] = [];
    for (const [kind, , purpose] of KINDS_BY_SUBJECT) planted.push(await f.seed({ kind, recipient: ids.ownerA, ...(purpose === undefined ? {} : { purpose }) }));
    expect(await f.visibleTo(ids.ownerA)).toEqual(expect.arrayContaining(planted));
  });

  it('hides the notification of an invitation whose agency is not the one of the notification, whatever the permission', async () => {
    const person = await w.personWith('colaborador.visualizar', 'cliente.convidar_usuario');
    const invitation = await f.invitation({ purpose: 'collaborator_invite', email: `${randomUUID()}@notifications.test`, invitedBy: person });
    await owner()('agency_memberships').insert({ agency_id: ids.agencyB, user_id: person, role_id: await adminRole() });
    await owner()('notifications').insert({
      agency_id: ids.agencyB, recipient_user_id: person, kind: 'invitation_accepted', invitation_id: invitation.id, summary: 'De outra agência'
    });

    expect(await f.visibleTo(person)).toEqual([]);
  });
});

describe('the application role writes nothing of the table (acceptance c)', () => {
  const asApp = async (user: string, statement: string, bindings: readonly unknown[] = []): Promise<unknown> =>
    w.asUser(user, async (t) => {
      await t.raw('savepoint attempt');
      try {
        await t.raw(statement, [...bindings]);
        return 'ok';
      } catch (error) {
        return error;
      }
    });

  it('holds no INSERT, UPDATE, DELETE or TRUNCATE on the table or on any column, and reads it', async () => {
    expect(await w.tablePrivileges('notifications')).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
    expect(await w.columnsWithPrivilege('notifications', 'insert')).toEqual([]);
    expect(await w.columnsWithPrivilege('notifications', 'update')).toEqual([]);
    const { rows } = await owner().raw<{ rows: Array<{ privilege: string }> }>(
      `select privilege from unnest(array['references', 'trigger']) as privilege where has_table_privilege('ageniza_app', 'public.notifications', privilege)`
    );
    expect(rows).toEqual([]);
  });

  it('keeps row level security on and forced, with the one policy of the reads', async () => {
    const flags = await owner().raw<{ rows: Array<{ enabled: boolean; forced: boolean }> }>(
      "select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where oid = 'public.notifications'::regclass"
    );
    expect(flags.rows).toEqual([{ enabled: true, forced: true }]);
    const policies = await owner().raw<{ rows: Array<{ policyname: string; cmd: string; roles: string }> }>(
      "select policyname, cmd, roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'notifications'"
    );
    expect(policies.rows).toEqual([{ policyname: 'notifications_select', cmd: 'SELECT', roles: '{ageniza_app}' }]);
  });

  it('has the indexes of the listing: by person and agency newest first, the partial one of the unread, and the unique one of a deadline for each round', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ indexname: string; indexdef: string }> }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'notifications' order by indexname"
    );
    const definitions = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));

    expect(Object.keys(definitions)).toEqual(['notifications_deadline_round_key', 'notifications_pkey', 'notifications_recipient_idx', 'notifications_unread_idx']);
    expect(definitions.notifications_recipient_idx).toContain('USING btree (recipient_user_id, agency_id, created_at DESC, id DESC)');
    expect(definitions.notifications_unread_idx).toContain('USING btree (recipient_user_id, agency_id) WHERE (read_at IS NULL)');
    expect(definitions.notifications_deadline_round_key).toContain('CREATE UNIQUE INDEX');
    expect(definitions.notifications_deadline_round_key).toContain('USING btree (recipient_user_id, kind, content_id, approval_round_id) WHERE (approval_round_id IS NOT NULL)');
  });

  it('refuses an INSERT of any shape, with the privilege and not with a policy a mistake could open', async () => {
    const content = await w.seedContent(ids.clientA1);
    const error = await asApp(
      ids.adminA,
      `insert into public.notifications (agency_id, recipient_user_id, kind, content_id, client_id, summary)
       values (?::uuid, ?::uuid, 'content_approved', ?::uuid, ?::uuid, 'Forjada')`,
      [ids.agencyA, ids.adminA, content, ids.clientA1]
    );
    expect(error).toMatchObject(permissionDenied('notifications'));
    expect(await f.rowsFor({ contentId: content })).toEqual([]);
  });

  it.each(['read_at', 'summary', 'recipient_user_id', 'kind', 'agency_id', 'created_at'])('refuses an UPDATE of %s on a row the person reads', async (column) => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.adminA });
    const before = await f.row(planted);
    const value = column === 'recipient_user_id' ? ids.productionA : column === 'agency_id' ? ids.agencyB : column === 'kind' ? 'content_changes_requested' : column === 'summary' ? 'Mudada' : new Date().toISOString();
    const error = await asApp(ids.adminA, `update public.notifications set ${column} = ?::${column === 'summary' || column === 'kind' ? 'text' : column === 'created_at' || column === 'read_at' ? 'timestamptz' : 'uuid'} where id = ?::uuid`, [value, planted]);

    expect(error).toMatchObject(permissionDenied('notifications'));
    expect(await f.row(planted)).toEqual(before);
  });

  it('refuses a DELETE, and the row stays', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.adminA });
    const error = await asApp(ids.adminA, 'delete from public.notifications where id = ?::uuid', [planted]);
    expect(error).toMatchObject(permissionDenied('notifications'));
    expect(await f.row(planted)).toBeDefined();
  });

  const NOT_EXECUTABLE = [
    'add_notification(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)',
    'notification_clip(text, integer)',
    'notification_summary(text, text, text)',
    'notify_content_owner(text, uuid, uuid)',
    'notify_material_request_answered(uuid)',
    'notify_invitation_accepted(uuid)',
    'notify_approval_deadlines_passed_at(timestamp with time zone)',
    'notify_on_client_comment()'
  ];
  const EXECUTABLE = [
    'notification_is_readable(uuid, uuid, text, uuid)',
    'read_notification(uuid, uuid)',
    'read_all_notifications(uuid)',
    'notify_approval_deadlines_passed()'
  ];

  it.each(NOT_EXECUTABLE)('does not let the application role execute %s, and fixes its search_path', async (signature) => {
    const { rows } = await owner().raw<{ rows: Array<{ executable: boolean; definer: boolean; fixed: boolean }> }>(
      `select has_function_privilege('ageniza_app', ?::regprocedure, 'execute') as executable, prosecdef as definer,
              coalesce(proconfig::text like '%search_path=%', false) as fixed
       from pg_proc where oid = ?::regprocedure`,
      [`app_private.${signature}`, `app_private.${signature}`]
    );
    const text = signature.startsWith('notification_clip(') || signature.startsWith('notification_summary(');
    expect(rows[0]).toEqual({ executable: false, definer: !text, fixed: true });
  });

  it.each(EXECUTABLE)('lets the application role execute %s, and only the functions that are meant to be called', async (signature) => {
    const { rows } = await owner().raw<{ rows: Array<{ executable: boolean; definer: boolean; fixed: boolean }> }>(
      `select has_function_privilege('ageniza_app', ?::regprocedure, 'execute') as executable, prosecdef as definer,
              coalesce(proconfig::text like '%search_path=%', false) as fixed
       from pg_proc where oid = ?::regprocedure`,
      [`app_private.${signature}`, `app_private.${signature}`]
    );
    expect(rows[0]).toEqual({ executable: true, definer: true, fixed: true });
  });

  it('has no other function of the notifications callable by the application role: the catalog lists exactly the four', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ name: string }> }>(`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name
      from pg_proc p
      where p.pronamespace = 'app_private'::regnamespace
        and (p.proname ~ '^(notify_|add_notification|notification_is_readable|notification_clip|notification_summary|read_notification|read_all_notifications)')
        and has_function_privilege('ageniza_app', p.oid, 'execute')
      order by 1
    `);
    expect(rows.map((row) => row.name)).toEqual([
      'notification_is_readable(p_recipient_user_id uuid, p_agency_id uuid, p_kind text, p_invitation_id uuid)',
      'notify_approval_deadlines_passed()',
      'read_all_notifications(p_agency_id uuid)',
      'read_notification(p_agency_id uuid, p_notification_id uuid)'
    ]);
  });

  it.each([
    ['notify_content_owner', "select app_private.notify_content_owner('content_approved', gen_random_uuid())"],
    ['notify_material_request_answered', 'select app_private.notify_material_request_answered(gen_random_uuid())'],
    ['notify_invitation_accepted', 'select app_private.notify_invitation_accepted(gen_random_uuid())'],
    ['notify_approval_deadlines_passed_at', "select app_private.notify_approval_deadlines_passed_at(now() + interval '30 days')"],
    ['add_notification', "select app_private.add_notification('content_approved', gen_random_uuid(), gen_random_uuid(), null, null, null, null, null, 'Forjada')"]
  ])('refuses a real call of %s as the application role', async (name, statement) => {
    const error = await asApp(ids.adminA, statement);
    expect(error).toMatchObject({ code: '42501', message: expect.stringContaining(`permission denied for function ${name}`) });
  });
});

describe('read_notification (acceptance d)', () => {
  const readOne = (user: string, agency: string, notification: string): Promise<boolean> =>
    w.asUser(user, async (t) => (await t.raw<{ rows: Array<{ read: boolean }> }>(
      'select app_private.read_notification(?::uuid, ?::uuid) as read', [agency, notification]
    )).rows[0]!.read);

  it('stamps read_at with the clock of the database, and says it found the notification', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    const startedAt = (await owner().raw<{ rows: Array<{ now: Date }> }>('select clock_timestamp() as now')).rows[0]!.now;

    expect(await readOne(ids.productionA, ids.agencyA, planted)).toBe(true);

    const endedAt = (await owner().raw<{ rows: Array<{ now: Date }> }>('select clock_timestamp() as now')).rows[0]!.now;
    const stamped = (await f.row(planted)).read_at;
    expect(stamped).not.toBeNull();
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1);
    expect(stamped!.getTime()).toBeLessThanOrEqual(endedAt.getTime());
  });

  it('keeps the instant of the first read when it is read again, and still says it found it', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    expect(await readOne(ids.productionA, ids.agencyA, planted)).toBe(true);
    const first = (await f.row(planted)).read_at;

    expect(await readOne(ids.productionA, ids.agencyA, planted)).toBe(true);
    expect((await f.row(planted)).read_at).toEqual(first);
  });

  it('does not touch the notification of another person, and answers "not found": not the Admin, not the Owner, not the portal', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    for (const reader of [ids.adminA, ids.ownerA, ids.managerA, ids.adminB, ids.portalA1, ids.dualFull, ids.crossDual]) {
      expect(await readOne(reader, ids.agencyA, planted), reader).toBe(false);
    }
    expect((await f.row(planted)).read_at).toBeNull();
  });

  it('does not touch the notification of another person when the agency given is the one of the reader', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    expect(await readOne(ids.adminB, ids.agencyB, planted)).toBe(false);
    expect((await f.row(planted)).read_at).toBeNull();
  });

  it('answers "not found" for the notification of the person in another agency than the one given', async () => {
    const person = await w.personWith('conteudo.visualizar');
    await owner()('agency_memberships').insert({ agency_id: ids.agencyB, user_id: person, role_id: await adminRole() });
    const inA = await f.seed({ kind: 'content_approved', recipient: person });

    expect(await readOne(person, ids.agencyB, inA)).toBe(false);
    expect((await f.row(inA)).read_at).toBeNull();
    expect(await readOne(person, ids.agencyA, inA)).toBe(true);
  });

  it('answers "not found" for a notification the person no longer reads, and leaves it unread', async () => {
    const person = await w.personWith('conteudo.visualizar');
    const planted = await f.seed({ kind: 'content_approved', recipient: person });
    await owner()('role_permissions').where({ role_id: await customRoleOf(person) }).delete();

    expect(await readOne(person, ids.agencyA, planted)).toBe(false);
    expect((await f.row(planted)).read_at).toBeNull();
  });

  it('answers "not found" for an id that does not exist', async () => {
    expect(await readOne(ids.productionA, ids.agencyA, randomUUID())).toBe(false);
  });

  it('refuses a call with no actor bound', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    const transaction = await w.getOwner().knex.transaction();
    try {
      await transaction.raw('set local role ageniza_app');
      await expect(transaction.raw('select app_private.read_notification(?::uuid, ?::uuid)', [ids.agencyA, planted]))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('Notifications are read by an account') });
    } finally {
      await transaction.rollback();
    }
    expect((await f.row(planted)).read_at).toBeNull();
  });
});

describe('read_all_notifications (acceptance d)', () => {
  const readAll = (user: string, agency: string): Promise<number> =>
    w.asUser(user, async (t) => (await t.raw<{ rows: Array<{ marked: number }> }>('select app_private.read_all_notifications(?::uuid) as marked', [agency])).rows[0]!.marked);

  it('marks the unread ones of the person in the agency, leaves the read ones as they were, and says how many it marked', async () => {
    const person = await w.personWith('conteudo.visualizar', 'cliente.visualizar');
    const unread = [
      await f.seed({ kind: 'content_approved', recipient: person }),
      await f.seed({ kind: 'content_changes_requested', recipient: person }),
      await f.seed({ kind: 'material_request_answered', recipient: person })
    ];
    const alreadyRead = await f.seed({ kind: 'content_approved', recipient: person, readAt: new Date('2026-11-01T12:00:00.000Z') });

    expect(await readAll(person, ids.agencyA)).toBe(3);

    for (const id of unread) expect((await f.row(id)).read_at, id).not.toBeNull();
    expect((await f.row(alreadyRead)).read_at).toEqual(new Date('2026-11-01T12:00:00.000Z'));
    expect(await readAll(person, ids.agencyA)).toBe(0);
  });

  it('stamps all of them with the instant of the call: the one of the transaction, the same for every notification', async () => {
    const person = await w.personWith('conteudo.visualizar', 'cliente.visualizar');
    for (const kind of ['content_approved', 'content_changes_requested', 'material_request_answered'] as const) await f.seed({ kind, recipient: person });

    const stamped = await w.asUser(person, async (t) => {
      await t.raw('select app_private.read_all_notifications(?::uuid)', [ids.agencyA]);
      return (await t.raw<{ rows: Array<{ total: number; at_now: number }> }>(
        `select count(*)::int as total, count(*) filter (where read_at = pg_catalog.now())::int as at_now
         from public.notifications where recipient_user_id = ?::uuid`, [person]
      )).rows[0]!;
    });

    expect(stamped).toEqual({ total: 3, at_now: 3 });
  });

  it('marks nothing of another person of the same agency, the Admin and the Owner included', async () => {
    const theirs = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    for (const reader of [ids.adminA, ids.ownerA, ids.managerA]) {
      await f.seed({ kind: 'content_approved', recipient: reader });
      await readAll(reader, ids.agencyA);
    }
    expect((await f.row(theirs)).read_at).toBeNull();
  });

  it('marks only the notifications of the agency given: the same person in two agencies keeps the other unread', async () => {
    const person = await w.personWith('conteudo.visualizar');
    await owner()('agency_memberships').insert({ agency_id: ids.agencyB, user_id: person, role_id: await adminRole() });
    const inA = await f.seed({ kind: 'content_approved', recipient: person });
    const inB = await f.seed({ kind: 'content_approved', recipient: person, clientId: ids.clientB, agencyId: ids.agencyB });

    expect(await readAll(person, ids.agencyA)).toBe(1);
    expect((await f.row(inA)).read_at).not.toBeNull();
    expect((await f.row(inB)).read_at).toBeNull();
  });

  it('marks nothing of the agency given when the person is of no one but another agency, and nothing of anyone else', async () => {
    const planted = await f.seed({ kind: 'content_approved', recipient: ids.productionA });
    expect(await readAll(ids.adminB, ids.agencyA)).toBe(0);
    expect(await readAll(ids.portalA1, ids.agencyA)).toBe(0);
    expect((await f.row(planted)).read_at).toBeNull();
  });

  it('leaves unread the notifications the person cannot read, which would otherwise come back already read the day they hold the permission again', async () => {
    const person = await w.personWith('conteudo.visualizar');
    const readable = await f.seed({ kind: 'content_approved', recipient: person });
    const hidden = await f.seed({ kind: 'material_request_answered', recipient: person });

    expect(await readAll(person, ids.agencyA)).toBe(1);
    expect((await f.row(readable)).read_at).not.toBeNull();
    expect((await f.row(hidden)).read_at).toBeNull();
  });

  it('refuses a call with no actor bound', async () => {
    const transaction = await w.getOwner().knex.transaction();
    try {
      await transaction.raw('set local role ageniza_app');
      await expect(transaction.raw('select app_private.read_all_notifications(?::uuid)', [ids.agencyA]))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('Notifications are read by an account') });
    } finally {
      await transaction.rollback();
    }
  });
});

describe('two reads of the same notifications at the same moment (acceptance h)', () => {
  const settle = (work: Promise<unknown>): Promise<unknown> => work.then(() => 'done', (error: unknown) => error);

  it('two clicks on "mark all as read" wait for each other: the first marks, the second finds nothing left, and none deadlocks', async () => {
    const person = await w.personWith('conteudo.visualizar', 'cliente.visualizar');
    const planted = [
      await f.seed({ kind: 'content_approved', recipient: person }),
      await f.seed({ kind: 'content_changes_requested', recipient: person }),
      await f.seed({ kind: 'material_request_answered', recipient: person })
    ];

    const first = await w.openTransactionAs(person);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      expect((await first.raw<{ rows: Array<{ marked: number }> }>('select app_private.read_all_notifications(?::uuid) as marked', [ids.agencyA])).rows[0]!.marked).toBe(3);
      second = settle(w.asUser(person, async (t) => (await t.raw<{ rows: Array<{ marked: number }> }>('select app_private.read_all_notifications(?::uuid) as marked', [ids.agencyA])).rows[0]!.marked));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toBe('done');
    const stamps = await Promise.all(planted.map(async (id) => (await f.row(id)).read_at));
    expect(stamps.every((stamp) => stamp !== null)).toBe(true);
    expect(new Set(stamps.map((stamp) => stamp!.getTime())).size).toBe(1);
  });

  it('a click on one notification and a click on all of them at the same moment: every notification is read once, with one instant', async () => {
    const person = await w.personWith('conteudo.visualizar');
    const one = await f.seed({ kind: 'content_approved', recipient: person });
    const another = await f.seed({ kind: 'content_changes_requested', recipient: person });

    const first = await w.openTransactionAs(person);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.read_notification(?::uuid, ?::uuid)', [ids.agencyA, one]);
      second = settle(w.asUser(person, (t) => t.raw('select app_private.read_all_notifications(?::uuid)', [ids.agencyA])));
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toBe('done');
    const [readOne, readAnother] = await Promise.all([f.row(one), f.row(another)]);
    expect(readOne.read_at).not.toBeNull();
    expect(readAnother.read_at).not.toBeNull();
  });
});