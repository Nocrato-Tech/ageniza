import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, type DatabaseClient } from '../src/index.js';

import { createContentWorld } from './support/content-world.js';

// Issue #252 (specs/conteudo.md §5 rule 8 and §8): the notification queue. Every attack of the application runs as
// `ageniza_app`; the worker is `ageniza_app` too, with no actor bound to the transaction, which is how `asWorker` opens
// one. RLS filters silently, so a read is checked by the rows it returns and a write by the state left in the table.
// The timing rules are checked by moving `sent_at`, `claimed_at` and `send_after` with the owner connection, to the
// minute: the boundary on each side of a number is a test of its own, so the number cannot move unseen.
const w = createContentWorld('conteudo-notification-queue');
const { ids } = w;

const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';
let worker: DatabaseClient;

const extraClients: string[] = [];

// The active links of the portal to clientA1 (dualRemoved has a removed one, and portalA2 and portalB belong to other clients).
const PEOPLE_OF_A1 = [ids.portalA1, ids.portalA1Second, ids.dualBare, ids.dualFull, ids.crossDual].sort();

const worldClients = (): string[] => [ids.clientA1, ids.clientA2, ids.clientArchived, ids.clientB, ids.clientSuspended, ...extraClients];

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
});

beforeEach(async () => {
  await w.getOwner().knex('notification_queue').whereIn('client_id', worldClients()).delete();
});

afterAll(async () => {
  try {
    const knex = w.getOwner().knex;
    await knex('notification_queue').whereIn('client_id', worldClients()).delete();
    for (const table of ['content_tasks', 'content_media', 'contents', 'media_assets', 'media_folders', 'client_memberships']) {
      await knex(table).whereIn('client_id', extraClients).delete();
    }
    await knex('audit.events').whereIn('target_id', extraClients).delete();
    await knex('clients').whereIn('id', extraClients).delete();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

const owner = (): Knex => w.getOwner().knex;

const sqlText = async (query: string, bindings: readonly unknown[] = []): Promise<string> => {
  const { rows } = await owner().raw<{ rows: Array<{ value: string }> }>(query, [...bindings]);
  return rows[0]!.value;
};
const today = (): Promise<string> => sqlText("select ((now() at time zone 'America/Sao_Paulo')::date)::text as value");

const fn = (user: string, signature: string, ...args: unknown[]): Promise<unknown> =>
  w.asUser(user, (transaction) => transaction.raw(`select app_private.${signature}`, args as never[]));
const submitAs = (user: string, id: string) => fn(user, 'submit_content(?::uuid)', id);
const publishAs = async (user: string, id: string) => fn(user, 'publish_content(?::uuid, ?::date)', id, await today());
const unpublishAs = (user: string, id: string) => fn(user, 'unpublish_content(?::uuid)', id);
const cancelAs = (user: string, id: string) => fn(user, 'cancel_content(?::uuid)', id);
// The item is due at once: what the tests of the worker want when they are not about the 15 minutes.
const sendDue = async (user: string, id: string): Promise<void> => {
  await submitAs(user, id);
  await owner().raw('update public.notification_queue set send_after = created_at where content_id = ?::uuid', [id]);
};
// The content was sent for approval `minutes` ago: its item opened then and is due 15 minutes after it.
const sentAgo = (contentId: string, minutes: number): Promise<unknown> =>
  owner().raw(
    "update public.notification_queue set created_at = now() - (?::integer * interval '1 minute'), send_after = now() - (?::integer * interval '1 minute') + interval '15 minutes' where content_id = ?::uuid",
    [minutes, minutes, contentId]
  );
const approveAs = async (user: string, id: string) => fn(user, 'approve_content(?::uuid, ?::integer)', id, (await w.contentRow(id)).revision);

// A content that can be sent: a reels with one video attached.
const readyContent = async (clientId: string = ids.clientA1, status: 'in_production' | 'approved' = 'in_production', publishOn?: string, owner?: string): Promise<string> => {
  const folder = await w.folderOf(clientId);
  const id = await w.seedContent(clientId, { status, ...(publishOn === undefined ? {} : { publishOn }), ...(owner === undefined ? {} : { owner }) });
  await w.attach(id, [await w.seedAsset(clientId, folder, { category: 'video' })]);
  return id;
};

type Row = Record<string, unknown>;
const itemsOf = (contentId: string): Promise<Row[]> =>
  owner()('notification_queue').where({ content_id: contentId }).orderBy('recipient_user_id') as unknown as Promise<Row[]>;
const openRecipients = async (contentId: string, type?: string): Promise<string[]> =>
  (await itemsOf(contentId))
    .filter((row) => row.sent_at === null && row.discarded_at === null && (type === undefined || row.type === type))
    .map((row) => row.recipient_user_id as string);
const itemOf = async (contentId: string, recipient: string): Promise<Row> => {
  const row = (await itemsOf(contentId)).find((item) => item.recipient_user_id === recipient);
  if (row === undefined) throw new Error(`No item of ${recipient} for ${contentId}.`);
  return row;
};
const setItems = (contentId: string, patch: Record<string, unknown>, recipient?: string): Promise<number> =>
  owner()('notification_queue').where({ content_id: contentId, ...(recipient === undefined ? {} : { recipient_user_id: recipient }) }).update(patch);
const setItemsAgo = (contentId: string, column: 'sent_at' | 'claimed_at' | 'send_after', minutes: number): Promise<unknown> =>
  owner().raw(`update public.notification_queue set ${column} = now() - (?::integer * interval '1 minute') where content_id = ?::uuid`, [minutes, contentId]);

// The worker: ageniza_app, no actor.
const asWorker = <T>(work: (transaction: Knex.Transaction) => Promise<T>, isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'): Promise<T> =>
  worker.knex.transaction(work, isolationLevel === undefined ? {} : { isolationLevel });

interface Claimed {
  item_id: string; claim_token: string; notification_type: string; client_id: string; client_name: string; agency_name: string;
  recipient_user_id: string; recipient_email: string; content_id: string; content_title: string; content_publish_on: string;
}
const CLAIM_SQL = `select item_id, claim_token, notification_type, client_id, client_name, agency_name, recipient_user_id, recipient_email,
  content_id, content_title, content_publish_on::text as content_publish_on from app_private.claim_notification_batch(?::integer)`;
const claimIn = async (transaction: Knex.Transaction, limit = 100): Promise<Claimed[]> =>
  (await transaction.raw<{ rows: Claimed[] }>(CLAIM_SQL, [limit])).rows.filter((row) => worldClients().includes(row.client_id));
const claim = (limit = 100): Promise<Claimed[]> => asWorker((transaction) => claimIn(transaction, limit));
// The token of the claim that holds these items, as the worker received it; a test of the token passes its own.
const tokenOf = async (ids_: readonly string[]): Promise<string | null> =>
  ((await owner()('notification_queue').whereIn('id', [...ids_]).whereNotNull('claim_token').first('claim_token'))?.claim_token as string | undefined) ?? null;
const markSent = async (ids_: readonly string[], token?: string | null): Promise<number> => {
  const claimToken = token === undefined ? await tokenOf(ids_) : token;
  return asWorker(async (t) => Number((await t.raw<{ rows: Array<{ marked: number }> }>('select app_private.mark_notifications_sent(?::uuid[], ?::uuid) as marked', [ids_ as never, claimToken])).rows[0]!.marked));
};
const fail = async (ids_: readonly string[], code: string | null, token?: string | null): Promise<number> => {
  const claimToken = token === undefined ? await tokenOf(ids_) : token;
  return asWorker(async (t) => Number((await t.raw<{ rows: Array<{ failed: number }> }>('select app_private.fail_notifications(?::uuid[], ?::uuid, ?::text) as failed', [ids_ as never, claimToken, code])).rows[0]!.failed));
};
const forContent = (rows: readonly Claimed[], contentId: string): Claimed[] => rows.filter((row) => row.content_id === contentId);

const freshClient = async (people: readonly string[] = [ids.portalA1, ids.portalA1Second]): Promise<string> => {
  const id = randomUUID();
  extraClients.push(id);
  await owner()('clients').insert({ id, agency_id: ids.agencyA, name: `Fila ${id}` });
  await owner()('client_memberships').insert(people.map((user) => ({ client_id: id, user_id: user })));
  return id;
};

const NOT_THE_WORKER = { code: '42501', message: expect.stringContaining('worker') };

// ---- the table is closed to the application role ---------------------------------------------------------------------

describe('the queue is reachable only through its functions (issue #252)', () => {
  it('gives ageniza_app no privilege on the table or on any column of it', async () => {
    expect(await w.tablePrivileges('notification_queue')).toEqual({
      can_select: false, table_insert: false, table_update: false, can_delete: false, can_truncate: false
    });
    const { rows } = await owner().raw<{ rows: Array<{ column_name: string; privilege: string }> }>(`
      select a.attname as column_name, p.privilege
      from pg_catalog.pg_attribute a
      cross join (values ('select'), ('insert'), ('update'), ('references')) as p(privilege)
      where a.attrelid = 'public.notification_queue'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('ageniza_app', 'public.notification_queue'::regclass, a.attnum, p.privilege)
    `);
    expect(rows).toEqual([]);
  });

  it.each([
    ['select', (t: Knex.Transaction) => t('notification_queue').select('id')],
    ['select of the recipients', (t: Knex.Transaction) => t.raw('select recipient_user_id from public.notification_queue')],
    ['insert', (t: Knex.Transaction) => t('notification_queue').insert({ type: 'content_published', client_id: ids.clientA1, recipient_user_id: ids.portalA1, content_id: randomUUID(), send_after: new Date() })],
    ['update', (t: Knex.Transaction) => t('notification_queue').update({ sent_at: new Date() })],
    ['delete', (t: Knex.Transaction) => t('notification_queue').delete()]
  ])('refuses %s to a person of the agency, of the portal and to the worker', async (_label, statement) => {
    await submitAs(ids.productionA, await readyContent());
    for (const attempt of [
      () => w.asUser(ids.adminA, async (t) => { await statement(t); }),
      () => w.asUser(ids.portalA1, async (t) => { await statement(t); }),
      () => asWorker(async (t) => { await statement(t); })
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for table notification_queue') });
    }
  });

  it('would still show and take nothing if the privilege were granted: row level security is on, forced, and has no policy', async () => {
    await submitAs(ids.productionA, await readyContent());
    expect(Number((await owner()('notification_queue').whereIn('client_id', worldClients()).count<Array<{ count: string }>>('* as count'))[0]!.count)).toBe(PEOPLE_OF_A1.length);

    const flags = await owner().raw<{ rows: Array<{ enabled: boolean; forced: boolean; policies: string }> }>(`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::text as policies
      from pg_class c where c.oid = 'public.notification_queue'::regclass
    `);
    expect(flags.rows).toEqual([{ enabled: true, forced: true, policies: '0' }]);

    const seen: Record<string, unknown> = {};
    await owner().transaction(async (t) => {
      await t.raw('grant all on public.notification_queue to ageniza_app');
      await t.raw('set local role ageniza_app');
      seen.visible = (await t.raw<{ rows: Array<{ count: string }> }>('select count(*) as count from public.notification_queue')).rows[0]!.count;
      seen.updated = await t('notification_queue').update({ attempts: 3 });
      seen.deleted = await t('notification_queue').delete();
      seen.inserted = await t.transaction(async (inner) => {
        await inner('notification_queue').insert({ type: 'content_published', client_id: ids.clientA1, recipient_user_id: ids.portalA1, content_id: randomUUID(), send_after: new Date() });
      }).then(() => 'inserted', (error: unknown) => error);
      throw new Error('rolled back on purpose');
    }).catch((error: unknown) => { if ((error as Error).message !== 'rolled back on purpose') throw error; });

    expect(seen).toMatchObject({ visible: '0', updated: 0, deleted: 0, inserted: { code: '42501', message: expect.stringContaining('row-level security') } });

    expect(await w.tablePrivileges('notification_queue')).toMatchObject({ can_select: false, can_delete: false });
    expect(Number((await owner()('notification_queue').whereIn('client_id', worldClients()).count<Array<{ count: string }>>('* as count'))[0]!.count)).toBe(PEOPLE_OF_A1.length);
  });

  it('pins the shape of the table', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ column_name: string; data_type: string; is_nullable: string }> }>(`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'notification_queue' order by column_name collate "C"
    `);
    expect(rows).toEqual([
      { column_name: 'attempts', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'claim_token', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'claimed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'client_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'content_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'discarded_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'last_error', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'recipient_user_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'send_after', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'sent_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'type', data_type: 'text', is_nullable: 'NO' }
    ]);
  });

  describe('the constraints of a row', () => {
    const base = (): Row => ({ type: 'content_published', client_id: ids.clientA1, recipient_user_id: ids.portalA1, send_after: new Date() });

    it('accepts a valid row, and refuses each invalid one by the constraint that owns the rule', async () => {
      const content = await w.seedContent(ids.clientA1);
      const other = await w.seedContent(ids.clientA2);
      const good = { ...base(), content_id: content };
      await owner()('notification_queue').insert(good);

      const refused = async (patch: Row): Promise<unknown> =>
        owner()('notification_queue').insert({ ...good, recipient_user_id: ids.portalA1Second, ...patch }).then(() => 'inserted', (error: unknown) => error);

      expect(await refused({ type: 'content_unknown', content_id: null })).toMatchObject({ code: '23514', constraint: 'notification_queue_type_check' });
      expect(await refused({ content_id: null })).toMatchObject({ code: '23514', constraint: 'notification_queue_reference_check' });
      expect(await refused({ attempts: -1 })).toMatchObject({ code: '23514', constraint: 'notification_queue_attempts_check' });
      expect(await refused({ claimed_at: new Date() })).toMatchObject({ code: '23514', constraint: 'notification_queue_claim_shape' });
      expect(await refused({ claim_token: randomUUID() })).toMatchObject({ code: '23514', constraint: 'notification_queue_claim_shape' });
      expect(await refused({ sent_at: new Date(), discarded_at: new Date() })).toMatchObject({ code: '23514', constraint: 'notification_queue_closed_once' });
      expect(await refused({ content_id: other })).toMatchObject({ code: '23503', constraint: 'notification_queue_content_fk' });
      expect(await refused({ recipient_user_id: randomUUID() })).toMatchObject({ code: '23503' });
      expect(await refused({ recipient_user_id: ids.portalA1 })).toMatchObject({ code: '23505', constraint: 'notification_queue_open_item_key' });
      for (const text of ['Mailbox pessoa@exemplo.test full', 'UPPER', 'with space', '', 'x'.repeat(65)]) {
        expect(await refused({ last_error: text })).toMatchObject({ code: '23514', constraint: 'notification_queue_last_error_check' });
      }
      expect(await refused({ last_error: 'x'.repeat(64) })).toBe('inserted');
    });

    it('opens another item for the same person and content once the first one is sent or discarded', async () => {
      const content = await w.seedContent(ids.clientA1);
      const row = { ...base(), content_id: content };
      await owner()('notification_queue').insert({ ...row, sent_at: new Date() });
      await owner()('notification_queue').insert({ ...row, discarded_at: new Date() });
      await owner()('notification_queue').insert(row);
      expect(await owner()('notification_queue').where({ content_id: content }).count<Array<{ count: string }>>('* as count')).toEqual([{ count: '3' }]);
    });

    it('goes with its content when the content is purged', async () => {
      const content = await w.seedContent(ids.clientA1);
      await owner()('notification_queue').insert({ ...base(), content_id: content });
      await owner()('contents').where({ id: content }).delete();
      expect(await owner()('notification_queue').where({ content_id: content })).toEqual([]);
    });
  });
});

describe('the catalog of the queue (issue #252)', () => {
  const WORKER_FUNCTIONS = [
    'app_private.claim_notification_batch(integer)',
    'app_private.mark_notifications_sent(uuid[], uuid)',
    'app_private.fail_notifications(uuid[], uuid, text)'
  ];
  const INTERNAL = [
    'app_private.contents_enqueue_notification()',
    'app_private.notification_max_wait(text)',
    'app_private.notification_group_ready(uuid, uuid, text)',
    'app_private.notification_send_after(text, timestamptz)'
  ];

  const privilegesOf = async (signature: string) => {
    const { rows } = await owner().raw<{ rows: Array<{ app: boolean; public_acl: boolean; definer: boolean; config: string[] | null }> }>(
      `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
              coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.oid = ?::regprocedure`, [signature]
    );
    return rows[0];
  };

  it.each(WORKER_FUNCTIONS)('%s is security definer with a fixed search_path, closed to PUBLIC and open to the application role', async (signature) => {
    expect(await privilegesOf(signature)).toEqual({ app: true, public_acl: false, definer: true, config: ['search_path=""'] });
  });

  it.each(INTERNAL)('%s is closed to the application role and to PUBLIC', async (signature) => {
    expect(await privilegesOf(signature)).toMatchObject({ app: false, public_acl: false, config: ['search_path=""'] });
  });

  it('keeps the enqueue out of reach of a request: the only writer of the queue is a trigger', async () => {
    await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.contents_enqueue_notification()'))).rejects.toMatchObject({ code: '42501' });
    const writers = await owner().raw<{ rows: Array<{ proname: string }> }>(
      `select p.proname from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.prosrc ilike '%insert into public.notification_queue%' order by p.proname`
    );
    expect(writers.rows).toEqual([{ proname: 'contents_enqueue_notification' }]);
  });

  it('fires the enqueue after any update of a content that changes its status, and not only when the column is named', async () => {
    const { rows } = await owner().raw<{ rows: Array<Record<string, unknown>> }>(`
      select t.tgname, (t.tgtype & 2) as before_bit, (t.tgtype & 16) as update_bit, (t.tgtype & 1) as row_bit,
             cardinality(string_to_array(nullif(t.tgattr::text, ''), ' ')) as columns, t.tgenabled as enabled,
             pg_get_triggerdef(t.oid) like '% WHEN %' as has_when
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'public.contents'::regclass and p.proname = 'contents_enqueue_notification' and not t.tgisinternal
    `);
    expect(rows).toEqual([{ tgname: '9_contents_enqueue_notification', before_bit: 0, update_bit: 16, row_bit: 1, columns: null, enabled: 'O', has_when: true }]);
  });

  it('puts the lock of the client first among the AFTER INSERT triggers of the queue, as every child of the client', async () => {
    const triggers = await owner().raw<{ rows: Array<{ tgname: string; fn: string }> }>(
      `select t.tgname, p.proname as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.notification_queue'::regclass
         and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 4) = 4 and t.tgenabled = 'O'
       order by t.tgname collate "C"`
    );
    expect(triggers.rows[0]).toEqual({ tgname: '0_notification_queue_lock_active_client', fn: 'lock_active_client_of_child' });
    expect(triggers.rows.some((trigger) => trigger.tgname.startsWith('RI_ConstraintTrigger_c_'))).toBe(true);
  });

  it('refuses a row for a client that is not active even when the privilege and a policy are granted: the lock trigger answers A0020', async () => {
    const archived = await freshClient();
    const active = await freshClient();
    const insertAs = async (client: string, content: string): Promise<unknown> =>
      owner().transaction(async (t) => {
        await t.raw('grant insert on public.notification_queue to ageniza_app');
        await t.raw('create policy temporary_insert on public.notification_queue for insert to ageniza_app with check (true)');
        await t.raw('set local session authorization ageniza_app');
        await t('notification_queue').insert({ type: 'content_published', client_id: client, recipient_user_id: ids.portalA1, content_id: content, send_after: new Date() });
        throw new Error('rolled back on purpose');
      }).then(() => 'inserted', (error: unknown) => error);

    const contentOfArchived = await w.seedContent(archived);
    const contentOfActive = await w.seedContent(active);
    await w.archiveClient(archived);

    expect(await insertAs(archived, contentOfArchived)).toMatchObject({ code: 'A0020' });
    expect(await insertAs(active, contentOfActive)).toMatchObject({ message: 'rolled back on purpose' });
    expect(await owner()('notification_queue').whereIn('client_id', [archived, active])).toEqual([]);
  });
});

// ---- who is told, and when ------------------------------------------------------------------------------------------

describe('the clock of an item (issue #252)', () => {
  const sendAfter = (type: string, instant: string): Promise<string> =>
    sqlText(`select to_char(app_private.notification_send_after(?::text, ?::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as value`, [type, instant]);

  it.each([
    ['22:30 in Brasília of the 7th', '2026-10-08T01:30:00Z', '2026-10-08T03:00:00Z'],
    ['one second before midnight in Brasília', '2026-10-08T02:59:59Z', '2026-10-08T03:00:00Z'],
    ['midnight in Brasília exactly', '2026-10-08T03:00:00Z', '2026-10-09T03:00:00Z'],
    ['noon in Brasília', '2026-10-08T15:00:00Z', '2026-10-09T03:00:00Z']
  ])('the summary of "published" opened at %s is due at the end of that day in Brasília', async (_label, instant, expected) => {
    expect(await sendAfter('content_published', instant)).toBe(expected);
  });

  it('"contents to approve" are due 15 minutes after they open', async () => {
    expect(await sendAfter('content_awaiting_approval', '2026-10-08T01:30:00Z')).toBe('2026-10-08T01:45:00Z');
    expect(await sendAfter('content_awaiting_approval', '2026-10-08T02:50:00Z')).toBe('2026-10-08T03:05:00Z');
  });

  it('lets a burst of "contents to approve" be postponed for up to 60 minutes, and does not debounce the summary', async () => {
    expect(await sqlText(`select app_private.notification_max_wait('content_awaiting_approval')::text as value`)).toBe('01:00:00');
    expect(await sqlText(`select coalesce(app_private.notification_max_wait('content_published')::text, 'none') as value`)).toBe('none');
  });
});

describe('who is enqueued, and by what (issue #252)', () => {
  it('enqueues one item per ACTIVE person of the portal of that client when a content is sent for approval, and nobody else', async () => {
    const id = await readyContent();

    await submitAs(ids.productionA, id);

    const items = await itemsOf(id);
    expect(items.map((item) => item.recipient_user_id)).toEqual(PEOPLE_OF_A1);
    for (const item of items) {
      expect(item).toMatchObject({
        type: 'content_awaiting_approval', client_id: ids.clientA1, content_id: id, claimed_at: null, attempts: 0, last_error: null, sent_at: null, discarded_at: null
      });
      expect((item.send_after as Date).getTime() - (item.created_at as Date).getTime()).toBe(15 * 60_000);
    }
    // Left out: the removed link (dualRemoved), the people of other clients, and everyone of the agency with no link.
    for (const absent of [ids.dualRemoved, ids.portalA2, ids.portalB, ids.portalArchived, ids.adminA, ids.ownerA, ids.productionA, ids.managerA, ids.adminB]) {
      expect(items.map((item) => item.recipient_user_id)).not.toContain(absent);
    }
  });

  it('enqueues the summary of "published" for the same people, due when the day ends in Brasília', async () => {
    const id = await readyContent(ids.clientA1, 'approved');

    await publishAs(ids.productionA, id);

    const items = await itemsOf(id);
    expect(items.map((item) => item.recipient_user_id)).toEqual(PEOPLE_OF_A1);
    // The same rule written again, from the moment the item itself was queued and the fixed offset of Brasília (no daylight saving
    // since 2019): the day of the item, not the clock of this process, so a run that crosses midnight cannot flip it.
    for (const item of items) {
      expect(item).toMatchObject({ type: 'content_published', client_id: ids.clientA1, content_id: id, sent_at: null, discarded_at: null });
      const brasilia = new Date((item.created_at as Date).getTime() - 3 * 3_600_000);
      expect((item.send_after as Date).getTime()).toBe(Date.UTC(brasilia.getUTCFullYear(), brasilia.getUTCMonth(), brasilia.getUTCDate() + 1, 3, 0, 0));
    }
  });

  it('enqueues again when the database itself returns an approved content to "awaiting approval" because the caption changed', async () => {
    const id = await readyContent(ids.clientA1, 'approved');
    expect(await itemsOf(id)).toEqual([]);

    await w.asUser(ids.productionA, (t) => t('contents').where({ id }).update({ caption: 'Legenda corrigida' }));

    expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval' });
    expect(await openRecipients(id, 'content_awaiting_approval')).toEqual(PEOPLE_OF_A1);
  });

  it('keeps ONE open item per person when the content is sent, taken back and sent again before the e-mail goes', async () => {
    const id = await readyContent();
    await submitAs(ids.productionA, id);
    const first = (await itemsOf(id)).map((item) => item.id);

    await owner().transaction(async (t) => {
      await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await t('contents').where({ id }).update({ status: 'adjusting' });
    });
    await submitAs(ids.productionA, id);

    expect((await itemsOf(id)).map((item) => item.id)).toEqual(first);
  });

  it('moves the window of the open item when the content is sent again, and keeps the moment it was first queued', async () => {
    const id = await readyContent();
    await submitAs(ids.productionA, id);
    await sentAgo(id, 10);
    const before = await itemsOf(id);
    await owner().transaction(async (t) => {
      await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await t('contents').where({ id }).update({ status: 'adjusting' });
    });

    await submitAs(ids.productionA, id);

    const after = await itemsOf(id);
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect(after.map((item) => item.created_at)).toEqual(before.map((item) => item.created_at));
    const wait = await sqlText('select extract(epoch from (min(send_after) - now()))::integer::text as value from public.notification_queue where content_id = ?::uuid', [id]);
    expect(Number(wait)).toBeGreaterThan(14 * 60 - 30);
    expect(Number(wait)).toBeLessThanOrEqual(15 * 60);
  });

  it('does not touch an item that an e-mail is leaving with when the content is sent again', async () => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);
    const batch = await claim();
    expect(forContent(batch, id)).toHaveLength(PEOPLE_OF_A1.length);
    const claimedAt = (await itemsOf(id)).map((item) => item.claimed_at);
    const sendAfter = (await itemsOf(id)).map((item) => item.send_after);
    await owner().transaction(async (t) => {
      await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await t('contents').where({ id }).update({ status: 'adjusting' });
    });

    await submitAs(ids.productionA, id);

    expect((await itemsOf(id)).map((item) => item.claimed_at)).toEqual(claimedAt);
    expect((await itemsOf(id)).map((item) => item.send_after)).toEqual(sendAfter);
  });

  it('opens a new item when a content is sent again after its e-mail left', async () => {
    const id = await readyContent();
    await submitAs(ids.productionA, id);
    await setItems(id, { sent_at: new Date() });

    await owner().transaction(async (t) => {
      await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await t('contents').where({ id }).update({ status: 'adjusting' });
    });
    await submitAs(ids.productionA, id);

    const items = await itemsOf(id);
    expect(items).toHaveLength(PEOPLE_OF_A1.length * 2);
    expect(await openRecipients(id)).toEqual(PEOPLE_OF_A1);
  });

  it.each([
    ['the client approves', async () => { const id = await readyContent(); await submitAs(ids.productionA, id); await w.getOwner().knex('notification_queue').where({ content_id: id }).delete(); return { id, act: () => approveAs(ids.portalA1, id) }; }],
    ['the agency cancels', async () => { const id = await readyContent(); return { id, act: () => cancelAs(ids.adminA, id) }; }],
    ['a publication is undone', async () => { const id = await readyContent(ids.clientA1, 'approved'); await publishAs(ids.productionA, id); await owner()('notification_queue').where({ content_id: id }).delete(); return { id, act: () => unpublishAs(ids.productionA, id) }; }],
    ['the caption of a content in production changes', async () => { const id = await readyContent(); return { id, act: () => w.asUser(ids.productionA, (t) => t('contents').where({ id }).update({ caption: 'Outra legenda' })) }; }],
    ['the caption of a content that is already awaiting approval changes after its e-mail left', async () => {
      const id = await readyContent(); await submitAs(ids.productionA, id); await setItems(id, { sent_at: new Date() });
      return { id, act: async () => { await w.asUser(ids.productionA, (t) => t('contents').where({ id }).update({ caption: 'Legenda corrigida depois do e-mail' })); expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', revision: 2 }); } };
    }],
    ['the date of a content that is already awaiting approval moves after its e-mail left', async () => {
      const id = await readyContent(); await submitAs(ids.productionA, id); await setItems(id, { sent_at: new Date() });
      return { id, act: async () => { await w.asUser(ids.productionA, (t) => t('contents').where({ id }).update({ publish_on: '2026-12-01' })); expect((await w.contentRow(id)).status).toBe('awaiting_approval'); } };
    }],
    ['the media of a content in production is replaced', async () => { const id = await readyContent(); const asset = await w.seedAsset(ids.clientA1, await w.folderOf(ids.clientA1), { category: 'video' }); return { id, act: () => fn(ids.productionA, 'set_content_media(?::uuid, ?::uuid[])', id, [asset]) }; }]
  ])('enqueues nothing new when %s', async (_label, prepare) => {
    const { id, act } = await prepare();
    const before = (await itemsOf(id)).map((item) => item.id);
    await act();
    expect((await itemsOf(id)).map((item) => item.id)).toEqual(before);
    expect(await openRecipients(id)).toEqual([]);
  });

  it('enqueues nothing for an archived client, but does for the same flow on an active one', async () => {
    const control = await freshClient();
    const archived = await freshClient();
    const moveToApproval = async (client: string): Promise<string> => {
      const id = await w.seedContent(client);
      await owner().transaction(async (t) => {
        await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
        await t('contents').where({ id }).update({ status: 'awaiting_approval' });
      });
      return id;
    };
    await w.archiveClient(archived);

    expect(await openRecipients(await moveToApproval(control))).toEqual([ids.portalA1, ids.portalA1Second].sort());
    expect(await openRecipients(await moveToApproval(archived))).toEqual([]);
  });

  it('enqueues nothing for a suspended agency, but does for the same flow on an active one', async () => {
    // Both are seeded while the agency is active: a suspended agency has no collaborator who may own a content.
    const control = await w.seedContent(ids.clientSuspended, { owner: ids.adminSuspended });
    const suspended = await w.seedContent(ids.clientSuspended, { owner: ids.adminSuspended });
    const moveToApproval = (id: string): Promise<void> =>
      owner().transaction(async (t) => {
        await t.raw('select app_private.bind_actor(?::uuid)', [ids.adminSuspended]);
        await t('contents').where({ id }).update({ status: 'awaiting_approval' });
      });

    await moveToApproval(control);
    expect(await openRecipients(control)).toEqual([ids.portalSuspended]);

    await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });
    try {
      await moveToApproval(suspended);
    } finally {
      await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
    }
    expect(await openRecipients(suspended)).toEqual([]);
  });
});

// ---- the worker reads, marks and fails ------------------------------------------------------------------------------

describe('what the worker may call (issue #252)', () => {
  it.each([
    ['claim_notification_batch', (t: Knex.Transaction) => t.raw('select * from app_private.claim_notification_batch(?::integer)', [10])],
    ['mark_notifications_sent', (t: Knex.Transaction) => t.raw('select app_private.mark_notifications_sent(?::uuid[], ?::uuid)', [[randomUUID()] as never, randomUUID()])],
    ['fail_notifications', (t: Knex.Transaction) => t.raw('select app_private.fail_notifications(?::uuid[], ?::uuid, ?::text)', [[randomUUID()] as never, randomUUID(), 'smtp_timeout'])]
  ])('%s refuses a request: a transaction with an actor bound is never the worker', async (_name, call) => {
    await sendDue(ids.productionA, await readyContent());
    const people = [ids.adminA, ids.ownerA, ids.portalA1, ids.dualFull, await w.personWith('conteudo.visualizar', 'conteudo.operar')];
    for (const person of people) {
      await expect(w.asUser(person, async (t) => { await call(t); })).rejects.toMatchObject(NOT_THE_WORKER);
    }
    expect(await owner()('notification_queue').whereIn('client_id', worldClients()).where('attempts', '>', 0)).toEqual([]);
    expect(await owner()('notification_queue').whereIn('client_id', worldClients()).whereNotNull('claimed_at')).toEqual([]);
  });

  it.each(['repeatable read', 'serializable'] as const)('refuses every function under %s with 40001: they lock and read again, which only READ COMMITTED sees', async (level) => {
    const call = (sql: string, bindings: unknown[]) => asWorker(async (t) => { await t.raw('select 1'); await t.raw(sql, bindings as never[]); }, level);
    await expect(call('select * from app_private.claim_notification_batch(?::integer)', [10])).rejects.toMatchObject({ code: '40001' });
    await expect(call('select app_private.mark_notifications_sent(?::uuid[], ?::uuid)', [[randomUUID()], randomUUID()])).rejects.toMatchObject({ code: '40001' });
    await expect(call('select app_private.fail_notifications(?::uuid[], ?::uuid, ?::text)', [[randomUUID()], randomUUID(), 'smtp_timeout'])).rejects.toMatchObject({ code: '40001' });
  });

  it.each([null, 0, -1, 101])('claims at most 1 to 100 groups: %s is refused', async (limit) => {
    await expect(claim(limit as number)).rejects.toMatchObject({ code: '22023' });
  });

  it('accepts the limits 1 and 100', async () => {
    await expect(claim(1)).resolves.toBeDefined();
    await expect(claim(100)).resolves.toBeDefined();
  });
});

describe('claiming a batch (issue #252)', () => {
  it('returns exactly what an e-mail needs, per person, and claims what it returns', async () => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);
    const content = await w.contentRow(id);

    const batch = await claim();

    expect(batch).toHaveLength(PEOPLE_OF_A1.length);
    expect(Object.keys(batch[0]!).sort()).toEqual([
      'agency_name', 'claim_token', 'client_id', 'client_name', 'content_id', 'content_publish_on', 'content_title', 'item_id',
      'notification_type', 'recipient_email', 'recipient_user_id'
    ]);
    const queue = await itemsOf(id);
    const expected = queue.map((item) => ({
      item_id: item.id,
      claim_token: batch[0]!.claim_token,
      notification_type: 'content_awaiting_approval',
      client_id: ids.clientA1,
      client_name: `Cliente A1 ${ids.clientA1}`,
      agency_name: `conteudo-notification-queue A ${ids.agencyA}`,
      recipient_user_id: item.recipient_user_id,
      recipient_email: `${item.recipient_user_id as string}@conteudo-notification-queue.test`,
      content_id: id,
      content_title: content.title,
      content_publish_on: '2026-10-20'
    }));
    expect([...batch].sort((a, b) => a.recipient_user_id.localeCompare(b.recipient_user_id))).toEqual(expected);
    for (const item of await itemsOf(id)) {
      expect(item).toMatchObject({ attempts: 1, sent_at: null, discarded_at: null });
      expect(item.claimed_at).toBeInstanceOf(Date);
    }
  });

  it('returns the same person and client once, with every content of the group, and counts the limit in groups', async () => {
    const first = await readyContent();
    const second = await readyContent();
    const third = await readyContent();
    for (const content of [first, second, third]) await sendDue(ids.productionA, content);

    const one = await claim(1);
    const people = new Set(one.map((row) => row.recipient_user_id));
    expect(people.size).toBe(1);
    expect(one).toHaveLength(3);
    expect(new Set(one.map((row) => row.content_id))).toEqual(new Set([first, second, third]));

    // Two groups of three rows each: a limit of 2 counts groups, so it is not used up by the first three rows.
    const two = await claim(2);
    expect(new Set(two.map((row) => row.recipient_user_id)).size).toBe(2);
    expect(two).toHaveLength(6);

    const rest = await claim(100);
    expect(new Set(rest.map((row) => row.recipient_user_id)).size).toBe(PEOPLE_OF_A1.length - 3);
    expect(rest).toHaveLength(3 * (PEOPLE_OF_A1.length - 3));
    expect(await claim(100)).toEqual([]);
  });

  it('claims the items of one client at a time: a limit of one group does not take the other client of the same person', async () => {
    const north = await freshClient([ids.portalA1]);
    const south = await freshClient([ids.portalA1]);
    await sendDue(ids.productionA, await readyContent(north));
    await sendDue(ids.productionA, await readyContent(south));

    const batch = await claim(1);

    expect(batch).toHaveLength(1);
    expect(await claim(1)).toHaveLength(1);
    expect(await claim(1)).toEqual([]);
  });

  it('holds the lock of a group per person and per client: another client of the same person is claimed meanwhile', async () => {
    const north = await freshClient([ids.portalA1]);
    const south = await freshClient([ids.portalA1]);
    await sendDue(ids.productionA, await readyContent(north));
    const holder = await worker.knex.transaction();
    try {
      expect(await claimIn(holder)).toHaveLength(1);
      await sendDue(ids.productionA, await readyContent(south));

      const outcome = await Promise.race([claim(), new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 3_000))]);

      expect((outcome as Claimed[]).map((row) => row.client_id)).toEqual([south]);
    } finally {
      await holder.commit();
    }
  });

  it('takes the lock of a group only when the group has something to claim: none for items that are not due, exhausted or under a lease', async () => {
    const later = await readyContent(ids.clientA1, 'approved');
    await publishAs(ids.productionA, later);
    const exhausted = await readyContent(await freshClient([ids.portalA1]));
    await sendDue(ids.productionA, exhausted);
    await setItems(exhausted, { attempts: 5 });
    const leased = await readyContent(await freshClient([ids.portalA1]));
    await sendDue(ids.productionA, leased);
    await owner().raw("update public.notification_queue set claimed_at = now() - interval '1 minute', claim_token = gen_random_uuid() where content_id = ?::uuid", [leased]);
    const due = await readyContent(await freshClient([ids.portalA1]));
    await sendDue(ids.productionA, due);

    const holder = await worker.knex.transaction();
    try {
      const pid = Number((await holder.raw<{ rows: Array<{ pid: number }> }>('select pg_backend_pid() as pid')).rows[0]!.pid);
      expect(forContent(await claimIn(holder), due)).toHaveLength(1);
      const locks = await owner().raw<{ rows: Array<{ count: string }> }>("select count(*) as count from pg_locks where locktype = 'advisory' and pid = ?::integer", [pid]);
      expect(locks.rows[0]!.count).toBe('1');
    } finally {
      await holder.commit();
    }
  });

  it('leaves out an item that is not due yet, and takes it once it is', async () => {
    const id = await readyContent(ids.clientA1, 'approved');
    await publishAs(ids.productionA, id);

    expect(await claim()).toEqual([]);

    await setItemsAgo(id, 'send_after', 1);
    expect(forContent(await claim(), id)).toHaveLength(PEOPLE_OF_A1.length);
  });

  it('does not return what a claim already holds, in a second claim or while the first is still open', async () => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);

    const held = await asWorker(async (first) => {
      const batch = await claimIn(first);
      expect(await claim()).toEqual([]);
      return batch;
    });

    expect(held).toHaveLength(PEOPLE_OF_A1.length);
    expect(await claim()).toEqual([]);
  });

  it('gives two workers different items: the second does not wait for the first and takes nothing the first took', async () => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);

    const first = await worker.knex.transaction();
    try {
      const batch = await claimIn(first);
      expect(batch).toHaveLength(PEOPLE_OF_A1.length);

      const second = claim();
      const outcome = await Promise.race([second, new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 3_000))]);
      expect(outcome).toEqual([]);
    } finally {
      await first.commit();
    }
    for (const item of await itemsOf(id)) expect(item.attempts).toBe(1);
  });

  it('does not make a second worker wait for what the first is dropping or claiming', async () => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);
    await owner()('client_memberships').where({ client_id: ids.clientA1, user_id: ids.portalA1Second }).update({ status: 'removed' });

    const first = await worker.knex.transaction();
    try {
      expect(await claimIn(first)).toHaveLength(PEOPLE_OF_A1.length - 1);
      expect((await itemOf(id, ids.portalA1Second)).discarded_at).toBeNull();

      const outcome = await Promise.race([claim(), new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 3_000))]);
      expect(outcome).toEqual([]);
    } finally {
      await first.commit();
      await owner()('client_memberships').where({ client_id: ids.clientA1, user_id: ids.portalA1Second }).update({ status: 'active' });
    }
    expect((await itemOf(id, ids.portalA1Second)).discarded_at).toBeInstanceOf(Date);
  });

  it('does not let a second worker claim what arrived in a group the first still holds', async () => {
    const first = await readyContent();
    await sendDue(ids.productionA, first);
    const holder = await worker.knex.transaction();
    let arrivedId = '';
    try {
      expect(forContent(await claimIn(holder), first)).toHaveLength(PEOPLE_OF_A1.length);
      // The first claim is not committed: its claimed_at is invisible to the second worker, which would take this one as a new group.
      arrivedId = await readyContent();
      await sendDue(ids.productionA, arrivedId);

      const outcome = await Promise.race([claim(), new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 3_000))]);

      expect(outcome).toEqual([]);
    } finally {
      await holder.commit();
    }
    for (const item of await itemsOf(first)) expect(item.attempts).toBe(1);
    for (const item of await itemsOf(arrivedId)) expect(item).toMatchObject({ attempts: 0, claimed_at: null, claim_token: null });
  });

  it('holds only the groups it claims: a claim of one group leaves the others to a second worker', async () => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);
    const holder = await worker.knex.transaction();
    let second: Claimed[];
    let firstBatch: Claimed[];
    try {
      firstBatch = await claimIn(holder, 1);
      second = (await Promise.race([asWorker((t) => claimIn(t, 1)), new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 3_000))])) as Claimed[];
    } finally {
      await holder.commit();
    }

    expect(firstBatch).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.recipient_user_id).not.toBe(firstBatch[0]!.recipient_user_id);
    expect(second[0]!.claim_token).not.toBe(firstBatch[0]!.claim_token);
  });

  describe('the debounce of "contents to approve": ONE e-mail, 15 minutes after the last send (issue #252)', () => {
    const send = async (): Promise<string> => {
      const id = await readyContent();
      await submitAs(ids.productionA, id);
      return id;
    };

    it('lets nothing leave at once', async () => {
      await send();

      expect(await claim()).toEqual([]);
    });

    it('turns three sends five minutes apart into ONE e-mail, 15 minutes after the third', async () => {
      const first = await send();
      const second = await send();
      const third = await send();

      // 14 minutes after the third (and 19 and 24 after the others): the third is still inside its window, so nothing leaves.
      await sentAgo(first, 24);
      await sentAgo(second, 19);
      await sentAgo(third, 14);
      expect(await claim()).toEqual([]);

      // 16 minutes after the third: ONE e-mail per person, with the three contents.
      await sentAgo(first, 26);
      await sentAgo(second, 21);
      await sentAgo(third, 16);
      const batch = await claim();
      expect(batch).toHaveLength(3 * PEOPLE_OF_A1.length);
      for (const person of PEOPLE_OF_A1) {
        expect(batch.filter((row) => row.recipient_user_id === person).map((row) => row.content_id).sort()).toEqual([first, second, third].sort());
      }
      expect(await claim()).toEqual([]);
    });

    it('postpones the e-mail of an earlier send when a new one arrives inside its window', async () => {
      const earlier = await send();
      const later = await send();
      await sentAgo(earlier, 20);
      await sentAgo(later, 1);

      expect(await claim()).toEqual([]);

      await sentAgo(later, 16);
      expect(await claim()).toHaveLength(2 * PEOPLE_OF_A1.length);
    });

    it.each([
      ['59 minutes old: the burst is still held', 59, false],
      ['61 minutes old: the burst leaves, with what is due', 61, true]
    ])('stops postponing once the oldest send of the burst is %s', async (_label, oldest, leaves) => {
      const old = await send();
      const recent = await send();
      await sentAgo(old, oldest);
      await sentAgo(recent, 1);

      const batch = await claim();

      expect(batch.map((row) => row.content_id)).toEqual(leaves ? Array(PEOPLE_OF_A1.length).fill(old) : []);
      // What was not due stays open for the next window.
      for (const item of await itemsOf(recent)) expect(item).toMatchObject({ claimed_at: null, sent_at: null, discarded_at: null, attempts: 0 });
    });

    it('does not count an e-mail that already left, or one that was dropped, as the start of the burst', async () => {
      const left = await send();
      const dropped = await send();
      const due = await send();
      const recent = await send();
      await sentAgo(left, 100);
      await sentAgo(dropped, 100);
      await sentAgo(due, 20);
      await sentAgo(recent, 1);
      await setItems(left, { sent_at: new Date() });
      await setItems(dropped, { discarded_at: new Date() });

      expect(await claim()).toEqual([]);
    });

    it('does not count an exhausted item as the start of the burst', async () => {
      const exhausted = await send();
      const due = await send();
      const recent = await send();
      await sentAgo(exhausted, 100);
      await sentAgo(due, 20);
      await sentAgo(recent, 1);
      await setItems(exhausted, { attempts: 5 });

      expect(await claim()).toEqual([]);
    });

    it('debounces each client apart: a client that went quiet is not held by another that is still sending', async () => {
      const busy = await send();
      const otherClient = await freshClient([ids.portalA1]);
      const quiet = await readyContent(otherClient);
      await submitAs(ids.productionA, quiet);
      await sentAgo(busy, 1);
      await sentAgo(quiet, 16);

      expect((await claim()).map((row) => [row.content_id, row.recipient_user_id])).toEqual([[quiet, ids.portalA1]]);
    });

    it('debounces each person apart: a person whose window is still open does not hold the others', async () => {
      const id = await send();
      await sentAgo(id, 16);
      await owner().raw("update public.notification_queue set created_at = now() - interval '1 minute', send_after = now() + interval '14 minutes' where content_id = ?::uuid and recipient_user_id = ?::uuid", [id, ids.portalA1]);

      expect((await claim()).map((row) => row.recipient_user_id).sort()).toEqual(PEOPLE_OF_A1.filter((person) => person !== ids.portalA1));
    });

    it('does not let a summary of "published" that is not due yet hold the e-mail of "contents to approve"', async () => {
      const published = await readyContent(ids.clientA1, 'approved');
      await publishAs(ids.productionA, published);
      const id = await send();
      await sentAgo(id, 16);

      expect(forContent(await claim(), id)).toHaveLength(PEOPLE_OF_A1.length);
      expect(forContent(await claim(), published)).toEqual([]);
    });

    it('does not hold the summary of "published" for the sends of "contents to approve"', async () => {
      const pending = await send();
      await sentAgo(pending, 1);
      const published = await readyContent(ids.clientA1, 'approved');
      await publishAs(ids.productionA, published);
      await setItemsAgo(published, 'send_after', 1);

      expect(forContent(await claim(), published)).toHaveLength(PEOPLE_OF_A1.length);
      expect(await itemsOf(pending)).toHaveLength(PEOPLE_OF_A1.length);
    });

    it('does not debounce the summary: what is due leaves while the next day is not due', async () => {
      const yesterday = await readyContent(ids.clientA1, 'approved');
      const tomorrow = await readyContent(ids.clientA1, 'approved');
      await publishAs(ids.productionA, yesterday);
      await publishAs(ids.productionA, tomorrow);
      await setItemsAgo(yesterday, 'send_after', 1);

      const batch = await claim();

      expect(forContent(batch, yesterday)).toHaveLength(PEOPLE_OF_A1.length);
      expect(forContent(batch, tomorrow)).toEqual([]);
    });
  });

  describe('an e-mail in flight', () => {
    it('keeps a second e-mail of the group from leaving while the lease of the first runs, and hands both over when it ends', async () => {
      const first = await readyContent();
      await sendDue(ids.productionA, first);
      expect(forContent(await claim(), first)).toHaveLength(PEOPLE_OF_A1.length);
      const second = await readyContent();
      await sendDue(ids.productionA, second);

      expect(forContent(await claim(), second)).toEqual([]);

      await setItemsAgo(first, 'claimed_at', 9);
      expect(forContent(await claim(), second)).toEqual([]);
      expect(forContent(await claim(), first)).toEqual([]);

      await setItemsAgo(first, 'claimed_at', 11);
      const batch = await claim();
      expect(forContent(batch, first)).toHaveLength(PEOPLE_OF_A1.length);
      expect(forContent(batch, second)).toHaveLength(PEOPLE_OF_A1.length);
      for (const item of await itemsOf(first)) expect(item.attempts).toBe(2);
      for (const item of await itemsOf(second)) expect(item.attempts).toBe(1);
    });
  });

  describe('attempts', () => {
    it.each([
      [4, true, 5],
      [5, false, 5]
    ])('an item tried %s times is claimed: %s (it ends with %s attempts)', async (attempts, claimed, ending) => {
      const id = await readyContent();
      await sendDue(ids.productionA, id);
      await setItems(id, { attempts });

      expect(forContent(await claim(), id)).toHaveLength(claimed ? PEOPLE_OF_A1.length : 0);
      for (const item of await itemsOf(id)) expect(item.attempts).toBe(ending);
    });

    it('leaves an exhausted item out of a group that has fresh ones', async () => {
      const exhausted = await readyContent();
      const fresh = await readyContent();
      await sendDue(ids.productionA, exhausted);
      await sendDue(ids.productionA, fresh);
      await setItems(exhausted, { attempts: 5 });

      const batch = await claim();

      expect(forContent(batch, exhausted)).toEqual([]);
      expect(forContent(batch, fresh)).toHaveLength(PEOPLE_OF_A1.length);
      for (const item of await itemsOf(exhausted)) expect(item).toMatchObject({ attempts: 5, claimed_at: null, claim_token: null });
    });

    it('stops handing over an item whose fifth attempt lease ended', async () => {
      const id = await readyContent();
      await sendDue(ids.productionA, id);
      await setItems(id, { attempts: 4 });
      expect(forContent(await claim(), id)).toHaveLength(PEOPLE_OF_A1.length);

      await setItemsAgo(id, 'claimed_at', 11);

      expect(forContent(await claim(), id)).toEqual([]);
    });
  });

  describe('what stopped being true is discarded, not held', () => {
    const discardedOf = async (contentId: string): Promise<string[]> =>
      (await itemsOf(contentId)).filter((item) => item.discarded_at !== null).map((item) => item.recipient_user_id as string).sort();

    it('a client archived after the item was queued: nothing is sent, and reactivating does not bring the item back', async () => {
      const client = await freshClient();
      const id = await readyContent(client);
      await sendDue(ids.productionA, id);
      await w.archiveClient(client);

      expect(await claim()).toEqual([]);
      expect(await discardedOf(id)).toEqual([ids.portalA1, ids.portalA1Second].sort());

      await w.reactivateClient(client);
      expect(await claim()).toEqual([]);
    });

    it('an agency suspended after the item was queued', async () => {
      const id = await readyContent(ids.clientSuspended, 'in_production', undefined, ids.adminSuspended);
      await sendDue(ids.adminSuspended, id);
      await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'suspended' });
      try {
        expect(await claim()).toEqual([]);
      } finally {
        await owner()('agencies').where({ id: ids.agencySuspended }).update({ status: 'active' });
      }
      expect(await discardedOf(id)).toEqual([ids.portalSuspended]);
    });

    it('a person removed from the portal after the item was queued: only that person is dropped', async () => {
      const id = await readyContent();
      await sendDue(ids.productionA, id);
      await owner()('client_memberships').where({ client_id: ids.clientA1, user_id: ids.portalA1Second }).update({ status: 'removed' });
      try {
        const batch = await claim();
        expect(batch.map((row) => row.recipient_user_id).sort()).toEqual(PEOPLE_OF_A1.filter((person) => person !== ids.portalA1Second));
      } finally {
        await owner()('client_memberships').where({ client_id: ids.clientA1, user_id: ids.portalA1Second }).update({ status: 'active' });
      }
      expect(await discardedOf(id)).toEqual([ids.portalA1Second]);
    });

    it.each([
      ['approved by the client', (id: string) => approveAs(ids.portalA1, id)],
      ['cancelled by the agency', (id: string) => cancelAs(ids.adminA, id)]
    ])('a content %s before the e-mail left: its item is dropped and the other content is still sent', async (_label, act) => {
      const gone = await readyContent();
      const kept = await readyContent();
      await sendDue(ids.productionA, gone);
      await sendDue(ids.productionA, kept);
      await act(gone);

      const batch = await claim();

      expect(forContent(batch, gone)).toEqual([]);
      expect(forContent(batch, kept)).toHaveLength(PEOPLE_OF_A1.length);
      expect(await discardedOf(gone)).toEqual(PEOPLE_OF_A1);
      expect(await discardedOf(kept)).toEqual([]);
    });

    it('a publication undone the same day: the summary does not list it', async () => {
      const undone = await readyContent(ids.clientA1, 'approved');
      const kept = await readyContent(ids.clientA1, 'approved');
      await publishAs(ids.productionA, undone);
      await publishAs(ids.productionA, kept);
      await unpublishAs(ids.productionA, undone);
      await setItemsAgo(undone, 'send_after', 1);
      await setItemsAgo(kept, 'send_after', 1);

      const batch = await claim();

      expect(forContent(batch, undone)).toEqual([]);
      expect(forContent(batch, kept)).toHaveLength(PEOPLE_OF_A1.length);
      expect(await discardedOf(undone)).toEqual(PEOPLE_OF_A1);
    });

    it('an item under a running lease is not touched, so the e-mail that is leaving can still be marked sent', async () => {
      const client = await freshClient();
      const id = await readyContent(client);
      await sendDue(ids.productionA, id);
      const batch = await claim();
      expect(batch).toHaveLength(2);
      await w.archiveClient(client);

      expect(await claim()).toEqual([]);
      expect((await itemsOf(id)).map((item) => item.discarded_at)).toEqual([null, null]);
      expect(await markSent(batch.map((row) => row.item_id))).toBe(2);
    });
  });
});

describe('marking an item sent or failed (issue #252)', () => {
  const claimed = async (): Promise<{ id: string; batch: Claimed[] }> => {
    const id = await readyContent();
    await sendDue(ids.productionA, id);
    return { id, batch: await claim() };
  };

  it('stamps only what a claim holds, once', async () => {
    const { id, batch } = await claimed();
    const some = batch.slice(0, 2).map((row) => row.item_id);
    const other = await readyContent();
    await sendDue(ids.productionA, other);

    expect(await markSent([...some, ...(await itemsOf(other)).map((item) => item.id as string)])).toBe(2);

    const stamped = (await itemsOf(id)).filter((item) => item.sent_at !== null).map((item) => item.id);
    expect(stamped.sort()).toEqual(some.sort());
    for (const item of await itemsOf(other)) expect(item).toMatchObject({ sent_at: null, claimed_at: null });
    expect(await markSent(some)).toBe(0);
    expect(await markSent([])).toBe(0);
  });

  it('does not stamp an item that was dropped', async () => {
    const { id } = await claimed();
    await setItems(id, { discarded_at: new Date() }, ids.portalA1);

    expect(await markSent([(await itemOf(id, ids.portalA1)).id as string])).toBe(0);
    expect((await itemOf(id, ids.portalA1)).sent_at).toBeNull();
  });

  it('releases the claim, records the code, and pushes the item back by five minutes for each attempt made', async () => {
    const { id, batch } = await claimed();
    const target = batch.filter((row) => row.recipient_user_id === ids.portalA1).map((row) => row.item_id);

    expect(await fail(target, 'smtp_timeout')).toBe(1);

    const failed = await itemOf(id, ids.portalA1);
    expect(failed).toMatchObject({ claimed_at: null, last_error: 'smtp_timeout', attempts: 1, sent_at: null, discarded_at: null });
    const delay = await sqlText('select extract(epoch from (send_after - now()))::integer::text as value from public.notification_queue where id = ?::uuid', [failed.id]);
    expect(Number(delay)).toBeGreaterThan(4 * 60);
    expect(Number(delay)).toBeLessThanOrEqual(5 * 60);
    expect(forContent(await claim(), id).filter((row) => row.recipient_user_id === ids.portalA1)).toEqual([]);

    await setItemsAgo(id, 'send_after', 1);
    const again = forContent(await claim(), id).filter((row) => row.recipient_user_id === ids.portalA1);
    expect(again).toHaveLength(1);
    expect((await itemOf(id, ids.portalA1)).attempts).toBe(2);

    expect(await fail(again.map((row) => row.item_id), 'smtp_rejected')).toBe(1);
    const second = await sqlText('select extract(epoch from (send_after - now()))::integer::text as value from public.notification_queue where id = ?::uuid', [failed.id]);
    expect(Number(second)).toBeGreaterThan(9 * 60);
    expect(Number(second)).toBeLessThanOrEqual(10 * 60);
    expect((await itemOf(id, ids.portalA1)).last_error).toBe('smtp_rejected');
  });

  it('ignores the late answer of a worker whose lease ran out and whose items another claim took', async () => {
    const { id, batch } = await claimed();
    const items = batch.map((row) => row.item_id);
    const first = batch[0]!.claim_token;
    await setItemsAgo(id, 'claimed_at', 11);
    const second = await claim();
    expect(forContent(second, id)).toHaveLength(PEOPLE_OF_A1.length);
    const next = second[0]!.claim_token;
    expect(next).not.toBe(first);

    expect(await fail(items, 'smtp_timeout', first)).toBe(0);
    expect(await markSent(items, first)).toBe(0);
    for (const item of await itemsOf(id)) expect(item).toMatchObject({ sent_at: null, last_error: null, claim_token: next, attempts: 2 });

    expect(await markSent(items, next)).toBe(PEOPLE_OF_A1.length);
  });

  it.each([
    ['a token nobody was given', () => randomUUID()],
    ['no token', () => null]
  ])('stamps and releases nothing with %s', async (_label, token) => {
    const { id, batch } = await claimed();
    const items = batch.map((row) => row.item_id);

    expect(await markSent(items, token())).toBe(0);
    expect(await fail(items, 'smtp_timeout', token())).toBe(0);

    for (const item of await itemsOf(id)) expect(item).toMatchObject({ sent_at: null, last_error: null, claim_token: batch[0]!.claim_token });
  });

  it('touches only what a claim holds', async () => {
    const { id, batch } = await claimed();
    await markSent(batch.slice(0, 1).map((row) => row.item_id));
    const unclaimed = await readyContent();
    await sendDue(ids.productionA, unclaimed);

    expect(await fail([...batch.map((row) => row.item_id), ...(await itemsOf(unclaimed)).map((item) => item.id as string)], 'smtp_timeout')).toBe(batch.length - 1);

    for (const item of await itemsOf(unclaimed)) expect(item).toMatchObject({ last_error: null, attempts: 0 });
    expect((await itemsOf(id)).filter((item) => item.sent_at !== null)).toHaveLength(1);
    expect((await itemsOf(id)).filter((item) => item.sent_at !== null)[0]).toMatchObject({ last_error: null });
  });

  it.each([
    ['text of the provider with an address', 'Mailbox pessoa@exemplo.test full'],
    ['upper case', 'SMTP_TIMEOUT'],
    ['a space', 'smtp timeout'],
    ['empty', ''],
    ['65 characters', 'x'.repeat(65)],
    ['null', null]
  ])('refuses an error that is %s, and leaves the claim as it was', async (_label, code) => {
    const { id, batch } = await claimed();

    await expect(fail(batch.map((row) => row.item_id), code)).rejects.toMatchObject({ code: '22023' });

    for (const item of await itemsOf(id)) expect(item).toMatchObject({ last_error: null, attempts: 1 });
    expect((await itemsOf(id)).every((item) => item.claimed_at instanceof Date)).toBe(true);
  });
});

// ---- races -----------------------------------------------------------------------------------------------------------

describe('races with the archive of the client (issue #252)', () => {
  const archive = (clientId: string) => (t: Knex.Transaction) => t.raw('select app_private.archive_client(?::uuid)', [clientId]);

  it('a content sent while the archive is uncommitted is refused after it and queues nothing', async () => {
    const client = await freshClient();
    const id = await readyContent(client, 'in_production', await today());

    const archiving = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown>;
    try {
      await archive(client)(archiving);
      outcome = submitAs(ids.productionA, id).then(() => 'sent', (error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0061' });
    expect(await itemsOf(id)).toEqual([]);
  });

  it('a content sent first makes the archive wait; both commit, and the items it left are dropped by the next claim', async () => {
    const client = await freshClient();
    const id = await readyContent(client, 'in_production', await today());

    const sending = await w.openTransactionAs(ids.productionA);
    let outcome: Promise<unknown>;
    try {
      await sending.raw('select app_private.submit_content(?::uuid)', [id]);
      outcome = w.asUser(ids.adminA, archive(client)).then(() => 'archived', (error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await sending.commit();
    }

    expect(await outcome).toBe('archived');
    expect(await openRecipients(id)).toEqual([ids.portalA1, ids.portalA1Second].sort());
    expect(await claim()).toEqual([]);
    expect((await itemsOf(id)).every((item) => item.discarded_at !== null)).toBe(true);
  });

  // The caption of an approved content moves it back to "awaiting approval" by a plain UPDATE, which takes no lock of the client:
  // the lock is the AFTER INSERT lock of the queue, which waits for the archive and then refuses the row. How the edit itself ends is
  // the business of rule 14, not of this issue; the queue is what is asserted.
  it('an approved content whose caption changes while the archive is uncommitted queues nothing once the archive commits', async () => {
    const client = await freshClient();
    const id = await readyContent(client, 'approved', await today());

    const archiving = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown>;
    try {
      await archive(client)(archiving);
      outcome = w.asUser(ids.productionA, (t) => t('contents').where({ id }).update({ caption: 'Legenda nova' })).then(() => 'edited', (error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiving.commit();
    }

    // How the edit itself ends (rule 14, a plain UPDATE takes no lock of the client) is not this issue: only the queue is asserted.
    await outcome;
    expect(await itemsOf(id)).toEqual([]);
  });

  it('the same edit under REPEATABLE READ does not queue either: it fails with 40001 or is refused, and leaves the content as it was', async () => {
    const client = await freshClient();
    const id = await readyContent(client, 'approved', await today());

    const editing = await w.openTransactionAs(ids.productionA, 'repeatable read');
    let outcome: unknown;
    try {
      await editing.raw('select 1');
      await w.asUser(ids.adminA, archive(client));
      outcome = await editing('contents').where({ id }).update({ caption: 'Legenda nova' }).then(() => 'edited', (error: unknown) => error);
    } finally {
      await editing.rollback().catch(() => undefined);
    }

    expect(outcome).toMatchObject({ code: '40001' });
    expect(await itemsOf(id)).toEqual([]);
    expect(await w.contentRow(id)).toMatchObject({ status: 'approved', caption: 'Legenda original' });
  });
});
