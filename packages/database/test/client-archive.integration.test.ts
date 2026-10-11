import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issues #251 (archiving a client cancels the content planned after the closing) and #284 (a write that races the archive
// of its client does not survive it). Every race uses two real transactions as `ageniza_app`, in both orders; the transaction
// that holds a lock proves it holds one (a client row it reads back, never an actor that RLS would hide).
const w = createContentWorld('archive');
const { ids } = w;

const clients: string[] = [];

const sqlText = async (sql: string, bindings: readonly unknown[] = []): Promise<string> => {
  const result = await w.getOwner().knex.raw<{ rows: Array<{ value: string }> }>(sql, [...bindings]);
  return result.rows[0]!.value;
};
const daysFromToday = (days: number): Promise<string> =>
  sqlText("select ((now() at time zone 'America/Sao_Paulo')::date + ?::integer)::text as value", [days]);

const newClient = async (closingDate?: string): Promise<string> => {
  const id = randomUUID();
  clients.push(id);
  await w.getOwner().knex('clients').insert({
    id, agency_id: ids.agencyA, name: `Arquivo ${id}`, ...(closingDate === undefined ? {} : { closing_date: closingDate })
  });
  await w.getOwner().knex('client_memberships').insert({ client_id: id, user_id: ids.portalA1 });
  return id;
};

const publishOn = async (id: string): Promise<string> => sqlText('select publish_on::text as value from public.contents where id = ?', [id]);
const clientStatus = async (id: string): Promise<string> => sqlText('select status as value from public.clients where id = ?', [id]);
const contentStatus = async (id: string): Promise<string> => String((await w.contentRow(id)).status);
const rowCount = async (table: string, clientId: string): Promise<number> =>
  Number((await w.getOwner().knex(table).where({ client_id: clientId }).count<Array<{ count: string }>>('* as count'))[0]!.count);

const archive = (clientId: string) => (t: Knex.Transaction) => t.raw('select app_private.archive_client(?::uuid)', [clientId]);

// The archive stays open with its new state uncommitted, and `write` runs in a second transaction that still sees the client
// as active; the write is committed or refused only after the archive commits.
const writeWhileArchiving = async (clientId: string, actor: string, write: (t: Knex.Transaction) => Promise<unknown>): Promise<unknown> => {
  const archiving = await w.openTransactionAs(ids.adminA);
  let outcome: Promise<unknown> | undefined;
  try {
    await archive(clientId)(archiving);
    const seen = await archiving.raw('select status from public.clients where id = ?::uuid', [clientId]);
    expect(seen.rows).toEqual([{ status: 'archived' }]);
    outcome = w.asUser(actor, write).then(() => 'written' as const, (error: unknown) => error);
    await w.waitUntilSomeoneWaitsOnALock();
  } finally {
    await archiving.commit();
  }
  return await outcome;
};

// The write holds its locks uncommitted, and the archive starts after it and waits for them.
const archiveWhileWriting = async (clientId: string, actor: string, write: (t: Knex.Transaction) => Promise<unknown>): Promise<unknown> => {
  const writing = await w.openTransactionAs(actor);
  let outcome: Promise<unknown> | undefined;
  try {
    await write(writing);
    outcome = w.asUser(ids.adminA, archive(clientId)).then(() => 'archived' as const, (error: unknown) => error);
    await w.waitUntilSomeoneWaitsOnALock();
  } finally {
    await writing.commit();
  }
  return await outcome;
};

// A transaction that holds the row of a client and proves it read one.
const holdingTheClient = async (clientId: string, work: () => Promise<void>): Promise<void> => {
  const locker = await w.openTransactionAs(ids.adminA);
  try {
    const locked = await locker.raw('select id from public.clients where id = ?::uuid for update', [clientId]);
    expect(locked.rows).toHaveLength(1);
    await work();
  } finally {
    await locker.commit();
  }
};

interface Writer {
  readonly table: string;
  readonly actor: string;
  readonly seed?: (clientId: string) => Promise<string>;
  readonly insert: (t: Knex.Transaction, clientId: string, parentId: string) => Promise<unknown>;
}

const defaultFolder = (clientId: string): Promise<string> => w.folderOf(clientId);

const writers = (): readonly Writer[] => [
  {
    table: 'client_brand_sections', actor: ids.adminA,
    insert: (t, clientId) => t('client_brand_sections').insert({ client_id: clientId, section_key: 'branding', body: 'Marca', updated_by: ids.adminA })
  },
  {
    table: 'client_personas', actor: ids.adminA,
    insert: (t, clientId) => t('client_personas').insert({ client_id: clientId, name: 'Persona', updated_by: ids.adminA })
  },
  {
    table: 'client_threads', actor: ids.adminA,
    insert: (t, clientId) => t('client_threads').insert({ client_id: clientId, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' })
  },
  {
    table: 'client_thread_comments', actor: ids.adminA,
    seed: async (clientId) => {
      const id = randomUUID();
      await w.getOwner().knex('client_threads').insert({ id, client_id: clientId, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });
      return id;
    },
    insert: (t, clientId, threadId) => t('client_thread_comments').insert({
      thread_id: threadId, client_id: clientId, author_user_id: ids.adminA, author_side: 'agency', body: 'Comentário'
    })
  },
  {
    table: 'media_folders', actor: ids.adminA,
    insert: (t, clientId) => t('media_folders').insert({ client_id: clientId, name: 'Pasta da corrida' })
  },
  {
    table: 'media_assets', actor: ids.adminA,
    seed: defaultFolder,
    insert: (t, clientId, folderId) => {
      const id = randomUUID();
      return t('media_assets').insert({
        id, agency_id: ids.agencyA, client_id: clientId, folder_id: folderId, category: 'image', declared_content_type: 'image/png', extension: 'png',
        object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 1_000
      });
    }
  },
  {
    table: 'story_scripts', actor: ids.adminA,
    insert: (t, clientId) => t('story_scripts').insert({ client_id: clientId, script_on: '2026-10-20' })
  },
  {
    table: 'story_script_scenes', actor: ids.adminA,
    seed: async (clientId) => {
      const id = randomUUID();
      await w.getOwner().knex('story_scripts').insert({ id, client_id: clientId, script_on: '2026-10-20' });
      return id;
    },
    insert: (t, clientId, scriptId) => t('story_script_scenes').insert({ script_id: scriptId, client_id: clientId, position: 1, text: 'Cena' })
  },
  {
    table: 'contents', actor: ids.adminA,
    seed: defaultFolder,
    insert: async (t, clientId, folderId) => t('contents').insert({
      client_id: clientId, title: 'Conteúdo da corrida', platform: 'instagram', format: 'reels', publish_on: await daysFromToday(10), folder_id: folderId
    })
  },
  {
    table: 'content_tasks', actor: ids.adminA,
    // Planned today: the archive leaves it alone, so the task reaches the lock instead of the guard of a cancelled content.
    seed: async (clientId) => w.seedContent(clientId, { publishOn: await daysFromToday(0) }),
    insert: (t, clientId, contentId) => t('content_tasks').insert({
      content_id: contentId, client_id: clientId, title: 'Subtarefa da corrida', assignee_user_id: ids.adminA, due_on: '2026-10-15'
    })
  }
];

const cleanup = async (): Promise<void> => {
  const knex = w.getOwner().knex;
  for (const table of [
    'client_thread_comments', 'client_threads', 'content_tasks', 'content_media', 'contents', 'story_script_scenes', 'story_scripts',
    'media_assets', 'media_folders', 'client_personas', 'client_brand_sections', 'client_memberships'
  ]) {
    await knex(table).whereIn('client_id', clients).delete();
  }
  await knex('audit.events').whereIn('target_id', clients).delete();
  await knex('clients').whereIn('id', clients).delete();
};

beforeAll(async () => { await w.setup(); });
afterAll(async () => {
  try { await cleanup(); } finally { await w.teardown(); }
});

describe('a write that races the archive of its client does not survive it (issue #284)', () => {
  for (const writer of writers()) {
    it(`${writer.table}: written while the archive is uncommitted, it is refused as A0020 and no row exists`, async () => {
      const client = await newClient();
      const parent = writer.seed === undefined ? '' : await writer.seed(client);
      const before = await rowCount(writer.table, client);

      const outcome = await writeWhileArchiving(client, writer.actor, (t) => writer.insert(t, client, parent));

      expect(outcome).toMatchObject({ code: 'A0020' });
      expect(await clientStatus(client)).toBe('archived');
      expect(await rowCount(writer.table, client)).toBe(before);
    });

    it(`${writer.table}: written first, it makes the archive wait, and both commit`, async () => {
      const client = await newClient();
      const parent = writer.seed === undefined ? '' : await writer.seed(client);
      const before = await rowCount(writer.table, client);

      const outcome = await archiveWhileWriting(client, writer.actor, (t) => writer.insert(t, client, parent));

      expect(outcome).toBe('archived');
      expect(await clientStatus(client)).toBe('archived');
      expect(await rowCount(writer.table, client)).toBe(before + 1);
    });
  }

  it('contents: a content written first and planned after the closing is cancelled by the archive that waited for it', async () => {
    const client = await newClient();
    const folder = await w.folderOf(client);
    let id = '';

    expect(await archiveWhileWriting(client, ids.adminA, async (t) => {
      [{ id }] = await t('contents').insert({
        client_id: client, title: 'Depois do encerramento', platform: 'instagram', format: 'reels', publish_on: await daysFromToday(10), folder_id: folder
      }).returning('id');
    })).toBe('archived');

    expect(await contentStatus(id)).toBe('cancelled');
  });

  it('media_assets: a media of the library of the agency, which has no client, is not held by the lock', async () => {
    const id = randomUUID();
    try {
      await w.asUser(ids.adminA, (t) => t('media_assets').insert({
        id, agency_id: ids.agencyA, category: 'image', declared_content_type: 'image/png', extension: 'png',
        object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 1_000
      }));
      expect(await w.getOwner().knex('media_assets').where({ id, client_id: null }).select('id')).toHaveLength(1);
    } finally {
      await w.getOwner().knex('media_assets').where({ id }).delete();
    }
  });

  describe('the trigger tells the application role by its login, inside a definer function too', () => {
    it('refuses what a security definer function writes for the application role while the archive is uncommitted', async () => {
      const client = await newClient();
      const knex = w.getOwner().knex;
      await knex.raw(`create function app_private.test_definer_persona(p_client uuid) returns void language sql security definer set search_path = ''
        as $f$ insert into public.client_personas (client_id, name) values (p_client, 'Pelo definer') $f$`);
      await knex.raw('grant execute on function app_private.test_definer_persona(uuid) to ageniza_app');
      try {
        const outcome = await writeWhileArchiving(client, ids.adminA, (t) => t.raw('select app_private.test_definer_persona(?::uuid)', [client]));

        expect(outcome).toMatchObject({ code: 'A0020' });
        expect(await rowCount('client_personas', client)).toBe(0);
      } finally {
        await knex.raw('drop function app_private.test_definer_persona(uuid)');
      }
    });

    it('lets the login of the owner write into an archived client, as the fixtures of the other suites do', async () => {
      const client = await newClient();
      await w.archiveClient(client);

      await w.getOwner().knex('client_personas').insert({ client_id: client, name: 'Pelo dono' });

      expect(await rowCount('client_personas', client)).toBe(1);
    });

    it.each(['set session authorization postgres', 'set role postgres'])('does not let the application role take the login of the owner: %s', async (statement) => {
      await expect(w.asUser(ids.adminA, (t) => t.raw(statement))).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('a content moved into the range the archive cancels', () => {
    it('refuses the move that waited for the archive, and leaves the date', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(0) });

      const outcome = await writeWhileArchiving(client, ids.adminA, async (t) => t('contents').where({ id }).update({ publish_on: await daysFromToday(10) }));

      expect(outcome).toMatchObject({ code: 'A0020' });
      expect(await contentStatus(id)).toBe('in_production');
      expect(await publishOn(id)).toBe(await daysFromToday(0));
    });

    it('is seen by the archive that started after it, which cancels the content on its new date', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(0) });
      const moved = await daysFromToday(10);

      expect(await archiveWhileWriting(client, ids.adminA, (t) => t('contents').where({ id }).update({ publish_on: moved }))).toBe('archived');

      expect(await contentStatus(id)).toBe('cancelled');
    });

    it('takes the lock for a change that leaves the date alone too (issue #408), and not for an UPDATE that changes nothing', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(0) });
      const before = await w.contentRow(id);

      await holdingTheClient(client, async () => {
        const noChange = await w.asUser(ids.adminA, async (t) => {
          await t.raw("set local lock_timeout = '250ms'");
          return t('contents').where({ id }).update({ title: before.title as string });
        });
        expect(noChange).toBe(1);

        await expect(w.asUser(ids.adminA, async (t) => {
          await t.raw("set local lock_timeout = '250ms'");
          await t('contents').where({ id }).update({ title: 'Só o título' });
        })).rejects.toMatchObject({ code: '55P03' });
      });

      expect(await w.contentRow(id)).toEqual(before);
    });
  });

  describe('every edit of a content is serialized with the archive of its client (issue #408)', () => {
    const levels = ['repeatable read', 'serializable'] as const;
    const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };
    // Planned before today: the archive never cancels it, with the edit or without it, so the lock is what decides the edit.
    const edits: ReadonlyArray<readonly [string, (clientId: string) => Promise<Record<string, string>>]> = [
      ['title', async () => ({ title: 'Outro título' })],
      ['caption', async () => ({ caption: 'Outra legenda' })],
      ['format', async () => ({ format: 'image' })],
      ['publish_on', async () => ({ publish_on: await daysFromToday(-2) })],
      ['publish_at_time', async () => ({ publish_at_time: '09:15:00' })],
      ['folder_id', async (clientId) => ({ folder_id: await w.folderOf(clientId, 'Imagens') })],
      ['cover_asset_id', async (clientId) => ({ cover_asset_id: await w.seedAsset(clientId, await w.folderOf(clientId)) })],
      ['owner_user_id', async () => ({ owner_user_id: ids.managerA })]
    ];

    const seed = async (status: 'in_production' | 'approved' = 'in_production'): Promise<{ client: string; id: string }> => {
      const client = await newClient();
      return { client, id: await w.seedContent(client, { status, publishOn: await daysFromToday(-1) }) };
    };
    const edit = (id: string, payload: Record<string, string>) => (t: Knex.Transaction) => t('contents').where({ id }).update(payload);
    const valueOf = (id: string, column: string): Promise<string> => sqlText('select ??::text as value from public.contents where id = ?', [column, id]);

    describe.each(edits)('%s', (column, payloadOf) => {
      it('written while the archive is uncommitted, it is refused as A0020 and the content is as it was', async () => {
        const { client, id } = await seed();
        const payload = await payloadOf(client);
        const before = await w.contentRow(id);

        const outcome = await writeWhileArchiving(client, ids.adminA, edit(id, payload));

        expect(outcome).toMatchObject({ code: 'A0020' });
        expect(await clientStatus(client)).toBe('archived');
        expect(await w.contentRow(id)).toEqual(before);
      });

      it('written first, it makes the archive wait, and both commit', async () => {
        const { client, id } = await seed();
        const payload = await payloadOf(client);

        const outcome = await archiveWhileWriting(client, ids.adminA, async (t) => {
          expect(await edit(id, payload)(t)).toBe(1);
        });

        expect(outcome).toBe('archived');
        expect(await clientStatus(client)).toBe('archived');
        expect(await valueOf(id, column)).toBe(payload[column]);
      });

      it('written after the archive committed, it is refused by the policy and the content is as it was', async () => {
        const { client, id } = await seed();
        const payload = await payloadOf(client);
        const before = await w.contentRow(id);
        await w.asUser(ids.adminA, archive(client));

        await expect(w.asUser(ids.adminA, edit(id, payload))).rejects.toMatchObject(rlsViolation);

        expect(await w.contentRow(id)).toEqual(before);
      });

      it.each(levels)('%s: written from a snapshot older than the archive, it fails with 40001 and the content is as it was', async (level) => {
        const { client, id } = await seed();
        const payload = await payloadOf(client);
        const before = await w.contentRow(id);
        const stale = await w.openTransactionAs(ids.adminA, level);

        try {
          await w.asUser(ids.adminA, archive(client));
          await expect(edit(id, payload)(stale)).rejects.toMatchObject({ code: '40001' });
        } finally {
          await stale.rollback();
        }

        expect(await clientStatus(client)).toBe('archived');
        expect(await w.contentRow(id)).toEqual(before);
      });
    });

    it('an approved content whose caption is edited while the archive is uncommitted stays approved, with the revision it had', async () => {
      const { client, id } = await seed('approved');
      const before = await w.contentRow(id);

      const outcome = await writeWhileArchiving(client, ids.adminA, edit(id, { caption: 'Legenda nova' }));

      expect(outcome).toMatchObject({ code: 'A0020' });
      expect(before).toMatchObject({ status: 'approved', revision: 1, caption: 'Legenda original' });
      expect(await w.contentRow(id)).toEqual(before);
    });

    it('an approved content whose caption is edited first goes back to approval, and the archive that waited for it commits', async () => {
      const { client, id } = await seed('approved');

      const outcome = await archiveWhileWriting(client, ids.adminA, async (t) => {
        expect(await edit(id, { caption: 'Legenda nova' })(t)).toBe(1);
      });

      expect(outcome).toBe('archived');
      expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', revision: 2, caption: 'Legenda nova', approved_by: null });
    });

    it('a content that the archive cancels is refused by the guard, not by the lock, when the edit waited for its row', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(10) });

      const outcome = await writeWhileArchiving(client, ids.adminA, edit(id, { title: 'Depois do arquivo' }));

      expect(outcome).toMatchObject({ code: 'A0062' });
      expect(await contentStatus(id)).toBe('cancelled');
    });

    it('a person of another agency finds no row to edit, so it locks nothing while the client row is held', async () => {
      const { client, id } = await seed();
      const before = await w.contentRow(id);

      await holdingTheClient(client, async () => {
        const updated = await w.asUser(ids.adminB, async (t) => {
          await t.raw("set local lock_timeout = '250ms'");
          return t('contents').where({ id }).update({ title: 'De outra agência' });
        });
        expect(updated).toBe(0);
      });

      expect(await w.contentRow(id)).toEqual(before);
    });

    describe.each([
      ['the caption, then the date', () => ({ caption: 'Legenda do ciclo' }), (t: Knex.Transaction, id: string, day: string) => edit(id, { publish_on: day })(t)],
      ['the date, then the caption', (day: string) => ({ publish_on: day }), (t: Knex.Transaction, id: string) => edit(id, { caption: 'Legenda do ciclo' })(t)],
      ['the caption, then a subtask', () => ({ caption: 'Legenda do ciclo' }), (t: Knex.Transaction, id: string, _day: string, client: string) => t('content_tasks').insert({
        content_id: id, client_id: client, title: 'Subtarefa do ciclo', assignee_user_id: ids.adminA, due_on: '2026-10-15'
      })]
    ] as const)('an approved content planned after the closing, edited in two statements: %s', (_label, first, second) => {
      it('makes the archive wait for the whole transaction instead of deadlocking with it, and then cancels the content', async () => {
        const client = await newClient();
        const id = await w.seedContent(client, { status: 'approved', publishOn: await daysFromToday(10) });
        const later = await daysFromToday(12);
        const editor = await w.openTransactionAs(ids.adminA);
        let archiving: Promise<unknown> | undefined;
        let committed = false;

        try {
          expect(await edit(id, first(later))(editor)).toBe(1);
          archiving = w.asUser(ids.adminA, archive(client)).then(() => 'archived' as const, (error: unknown) => error);
          await w.waitUntilSomeoneWaitsOnALock();

          await second(editor, id, later, client);
          await editor.commit();
          committed = true;
        } finally {
          if (!committed) await editor.rollback();
        }

        expect(await archiving).toBe('archived');
        expect(await clientStatus(client)).toBe('archived');
        expect(await w.contentRow(id)).toMatchObject({ status: 'cancelled', caption: 'Legenda do ciclo' });
      });
    });

    it('a transaction that locks the content row by itself before any edit can still lose the cycle with the archive: one gets 40P01 and nothing is half done', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(10) });
      const before = await w.contentRow(id);
      const editor = await w.openTransactionAs(ids.adminA);
      let archiving: Promise<unknown> | undefined;
      let editing: unknown;

      try {
        const locked = await editor.raw('select id from public.contents where id = ?::uuid for update', [id]);
        expect(locked.rows).toHaveLength(1);
        archiving = w.asUser(ids.adminA, archive(client)).then(() => 'archived' as const, (error: unknown) => error);
        await w.waitUntilSomeoneWaitsOnALock();
        editing = await edit(id, { caption: 'Legenda do ciclo' })(editor).then(() => 'edited' as const, (error: unknown) => error);
      } finally {
        if (editing === 'edited') await editor.commit(); else await editor.rollback();
      }
      const archived = await archiving;

      const failures = [editing, archived].filter((outcome) => outcome !== 'edited' && outcome !== 'archived');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: '40P01' });
      if (editing === 'edited') {
        expect(await clientStatus(client)).toBe('active');
        expect(await w.contentRow(id)).toMatchObject({ caption: 'Legenda do ciclo', status: 'in_production' });
      } else {
        expect(await clientStatus(client)).toBe('archived');
        expect(await w.contentRow(id)).toMatchObject({ caption: before.caption, status: 'cancelled' });
      }
    });
  });

  describe('the functions that move a child take the client first', () => {
    it('approve_content: the portal approval that waited for the archive is "not found" and the content is not approved', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { status: 'awaiting_approval', publishOn: await daysFromToday(0) });

      const outcome = await writeWhileArchiving(client, ids.portalA1, (t) => t.raw('select app_private.approve_content(?::uuid, 1)', [id]));

      expect(outcome).toMatchObject({ code: 'A0060' });
      expect(await w.contentRow(id)).toMatchObject({ status: 'awaiting_approval', approved_by: null });
    });

    it('approve_content: an approval that came first is cancelled by the archive when the content is planned after the closing', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { status: 'awaiting_approval', publishOn: await daysFromToday(10) });

      expect(await archiveWhileWriting(client, ids.portalA1, (t) => t.raw('select app_private.approve_content(?::uuid, 1)', [id]))).toBe('archived');

      expect(await w.contentRow(id)).toMatchObject({ status: 'cancelled', approved_by: null, approved_at: null });
    });

    it('lock_content_for_agency: an agency function that waited for the archive answers A0061 and changes nothing', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(0) });

      const outcome = await writeWhileArchiving(client, ids.adminA, (t) => t.raw('select app_private.cancel_content(?::uuid)', [id]));

      expect(outcome).toMatchObject({ code: 'A0061' });
      expect(await contentStatus(id)).toBe('in_production');
    });

    it('lock_content_task: delivering a subtask that waited for the archive answers A0061 and leaves it pending', async () => {
      const client = await newClient();
      const task = await w.seedTask(await w.seedContent(client, { publishOn: await daysFromToday(0) }), { assignee: ids.adminA });

      const outcome = await writeWhileArchiving(client, ids.adminA, (t) => t.raw('select app_private.deliver_content_task(?::uuid)', [task]));

      expect(outcome).toMatchObject({ code: 'A0061' });
      expect((await w.taskRow(task)).status).toBe('pending');
    });

    it('lock_content_task: a delivery that came first makes the archive wait, and both commit', async () => {
      const client = await newClient();
      const task = await w.seedTask(await w.seedContent(client, { publishOn: await daysFromToday(0) }), { assignee: ids.adminA });

      expect(await archiveWhileWriting(client, ids.adminA, (t) => t.raw('select app_private.deliver_content_task(?::uuid)', [task]))).toBe('archived');

      expect((await w.taskRow(task)).status).toBe('delivered');
      expect(await clientStatus(client)).toBe('archived');
    });

    describe('set_content_media (issue #408)', () => {
      const setMedia = (id: string, asset: string) => (t: Knex.Transaction) =>
        t.raw('select app_private.set_content_media(?::uuid, ?::uuid[])', [id, [asset]]);
      const mediaOf = (id: string): Promise<string[]> => w.getOwner().knex('content_media').where({ content_id: id }).pluck('asset_id');
      const seedWithMedia = async (): Promise<{ client: string; id: string; asset: string }> => {
        const client = await newClient();
        return {
          client,
          id: await w.seedContent(client, { publishOn: await daysFromToday(0) }),
          asset: await w.seedAsset(client, await w.folderOf(client), { category: 'video' })
        };
      };

      it('a swap that waited for the archive answers A0061 and leaves the media as it was', async () => {
        const { client, id, asset } = await seedWithMedia();

        const outcome = await writeWhileArchiving(client, ids.adminA, setMedia(id, asset));

        expect(outcome).toMatchObject({ code: 'A0061' });
        expect(await mediaOf(id)).toEqual([]);
        expect(await contentStatus(id)).toBe('in_production');
      });

      it('a swap that came first makes the archive wait, and both commit', async () => {
        const { client, id, asset } = await seedWithMedia();

        const outcome = await archiveWhileWriting(client, ids.adminA, async (t) => {
          await setMedia(id, asset)(t);
          expect(await t('content_media').where({ content_id: id }).pluck('asset_id')).toEqual([asset]);
        });

        expect(outcome).toBe('archived');
        expect(await mediaOf(id)).toEqual([asset]);
        expect(await clientStatus(client)).toBe('archived');
      });

      it.each(['repeatable read', 'serializable'] as const)('%s: a swap from a snapshot older than the archive fails with 40001 and leaves the media as it was', async (level) => {
        const { client, id, asset } = await seedWithMedia();
        const stale = await w.openTransactionAs(ids.adminA, level);

        try {
          await w.asUser(ids.adminA, archive(client));
          await expect(setMedia(id, asset)(stale)).rejects.toMatchObject({ code: '40001' });
        } finally {
          await stale.rollback();
        }

        expect(await mediaOf(id)).toEqual([]);
      });
    });
  });

  describe('who is not authorized never waits for the lock of another tenant', () => {
    const refusedFast = async (attempt: (t: Knex.Transaction) => Promise<unknown>): Promise<unknown> =>
      w.asUser(ids.adminB, async (t) => {
        await t.raw("set local lock_timeout = '250ms'");
        return attempt(t);
      }).then((value) => value, (error: unknown) => error);

    for (const writer of writers()) {
      it(`${writer.table}: the policy refuses a person of another agency while the client row is locked`, async () => {
        const client = await newClient();
        const parent = writer.seed === undefined ? '' : await writer.seed(client);
        const before = await rowCount(writer.table, client);

        await holdingTheClient(client, async () => {
          const outcome = await refusedFast((t) => writer.insert(t, client, parent));
          // Refused by the policy, or by a BEFORE trigger that locks nothing: never by the wait for the lock of another tenant.
          expect(outcome).toBeInstanceOf(Error);
          expect((outcome as { code?: string }).code).not.toBe('55P03');
        });

        expect(await rowCount(writer.table, client)).toBe(before);
      });
    }

    it('a move of the date of a content of another agency finds no row, so it locks nothing', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(0) });

      await holdingTheClient(client, async () => {
        const updated = await refusedFast(async (t) => t('contents').where({ id }).update({ publish_on: await daysFromToday(10) }));
        expect(updated).toBe(0);
      });

      expect(await publishOn(id)).toBe(await daysFromToday(0));
    });

    it.each([
      ['approve_content', (t: Knex.Transaction, id: string) => t.raw('select app_private.approve_content(?::uuid, 1)', [id])],
      ['cancel_content', (t: Knex.Transaction, id: string) => t.raw('select app_private.cancel_content(?::uuid)', [id])]
    ])('%s answers A0060 to a person of another agency without waiting for the client row', async (_name, call) => {
      const client = await newClient();
      const id = await w.seedContent(client, { status: 'awaiting_approval', publishOn: await daysFromToday(0) });

      await holdingTheClient(client, async () => {
        expect(await refusedFast((t) => call(t, id))).toMatchObject({ code: 'A0060' });
      });
    });

    it('lock_content_task answers A0070 to a person of another agency without waiting for the client row', async () => {
      const client = await newClient();
      const task = await w.seedTask(await w.seedContent(client, { publishOn: await daysFromToday(0) }));

      await holdingTheClient(client, async () => {
        expect(await refusedFast((t) => t.raw('select app_private.deliver_content_task(?::uuid)', [task]))).toMatchObject({ code: 'A0070' });
      });
    });
  });
});

describe('the story scripts are serialized with the archive of their client (issue #534)', () => {
  const levels = ['repeatable read', 'serializable'] as const;
  const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };

  const seedScript = async (status: 'draft' | 'sent' = 'draft'): Promise<{ client: string; id: string }> => {
    const client = await newClient();
    const id = randomUUID();
    await w.getOwner().knex('story_scripts').insert({ id, client_id: client, script_on: '2026-10-20', status });
    await w.getOwner().knex('story_script_scenes').insert([
      { script_id: id, client_id: client, position: 1, text: 'Cena 1', guidance: 'Direção' },
      { script_id: id, client_id: client, position: 2, text: 'Cena 2' }
    ]);
    return { client, id };
  };
  const scriptState = async (id: string): Promise<string> => sqlText(
    "select concat_ws('|', s.script_on::text, s.status, (select string_agg(concat_ws(',', c.position::text, c.text, c.guidance), ';' order by c.position) from public.story_script_scenes c where c.script_id = s.id)) as value from public.story_scripts s where s.id = ?",
    [id]
  );

  const edits: ReadonlyArray<readonly [string, (id: string) => (t: Knex.Transaction) => Promise<number>]> = [
    ['script_on', (id) => (t) => t('story_scripts').where({ id }).update({ script_on: '2026-10-21' })],
    ['scene text', (id) => (t) => t('story_script_scenes').where({ script_id: id, position: 1 }).update({ text: 'Cena nova' })],
    ['scene guidance', (id) => (t) => t('story_script_scenes').where({ script_id: id, position: 1 }).update({ guidance: 'Outra direção' })],
    ['scene position', (id) => (t) => t('story_script_scenes').where({ script_id: id, position: 2 }).update({ position: 5 })]
  ];

  describe.each(edits)('an edit of %s', (_column, editOf) => {
    it('written while the archive is uncommitted, it is refused as A0020 and the script is as it was', async () => {
      const { client, id } = await seedScript();
      const before = await scriptState(id);

      const outcome = await writeWhileArchiving(client, ids.adminA, editOf(id));

      expect(outcome).toMatchObject({ code: 'A0020' });
      expect(await clientStatus(client)).toBe('archived');
      expect(await scriptState(id)).toBe(before);
    });

    it('written first, it makes the archive wait, and both commit', async () => {
      const { client, id } = await seedScript();
      const before = await scriptState(id);

      const outcome = await archiveWhileWriting(client, ids.adminA, async (t) => {
        expect(await editOf(id)(t)).toBe(1);
      });

      expect(outcome).toBe('archived');
      expect(await clientStatus(client)).toBe('archived');
      expect(await scriptState(id)).not.toBe(before);
    });

    it('written after the archive committed, it is refused by the policy and the script is as it was', async () => {
      const { client, id } = await seedScript();
      const before = await scriptState(id);
      await w.asUser(ids.adminA, archive(client));

      await expect(w.asUser(ids.adminA, editOf(id))).rejects.toMatchObject(rlsViolation);

      expect(await scriptState(id)).toBe(before);
    });

    it.each(levels)('%s: written from a snapshot older than the archive, it fails with 40001 and the script is as it was', async (level) => {
      const { client, id } = await seedScript();
      const before = await scriptState(id);
      const stale = await w.openTransactionAs(ids.adminA, level);

      try {
        await w.asUser(ids.adminA, archive(client));
        await expect(editOf(id)(stale)).rejects.toMatchObject({ code: '40001' });
      } finally {
        await stale.rollback();
      }

      expect(await scriptState(id)).toBe(before);
    });
  });

  describe.each([
    ['send_story_script', 'draft', ids.adminA, 'A0051', 'sent', 'select app_private.send_story_script(?::uuid)'],
    ['record_story_script', 'sent', ids.portalA1, 'A0050', 'recorded', 'select app_private.record_story_script(?::uuid)']
  ] as const)('%s', (_name, from, actor, refusal, to, call) => {
    const statusOf = (id: string): Promise<string> => sqlText('select status as value from public.story_scripts where id = ?', [id]);
    const run = (id: string) => (t: Knex.Transaction) => t.raw(call, [id]);

    it('a call that waited for the archive is refused and leaves the script as it was', async () => {
      const { client, id } = await seedScript(from);

      const outcome = await writeWhileArchiving(client, actor, run(id));

      expect(outcome).toMatchObject({ code: refusal });
      expect(await statusOf(id)).toBe(from);
    });

    it('a call that came first makes the archive wait, and both commit', async () => {
      const { client, id } = await seedScript(from);

      const outcome = await archiveWhileWriting(client, actor, async (t) => {
        await run(id)(t);
        expect((await t.raw<{ rows: Array<{ status: string }> }>('select status from public.story_scripts where id = ?::uuid', [id])).rows).toEqual([{ status: to }]);
      });

      expect(outcome).toBe('archived');
      expect(await statusOf(id)).toBe(to);
      expect(await clientStatus(client)).toBe('archived');
    });

    it.each(levels)('%s: a call from a snapshot older than the archive fails with 40001 and leaves the script as it was', async (level) => {
      const { client, id } = await seedScript(from);
      const stale = await w.openTransactionAs(actor, level);

      try {
        await w.asUser(ids.adminA, archive(client));
        await expect(run(id)(stale)).rejects.toMatchObject({ code: '40001' });
      } finally {
        await stale.rollback();
      }

      expect(await statusOf(id)).toBe(from);
    });
  });
});

// Issues #540 and #532. The other children of the client had the lock of the INSERT only, so an edit from a snapshot older than the
// archive (or while it was uncommitted, for the confirmation of a media) was written into a client that no longer takes writes.
describe('every other child of the client is edited under the lock of its client (issues #540 and #532)', () => {
  const levels = ['repeatable read', 'serializable'] as const;
  const rlsViolation = { code: '42501', message: expect.stringContaining('row-level security') };

  interface Child {
    readonly table: string;
    readonly key: (id: string) => Record<string, string>;
    readonly seed: (clientId: string) => Promise<string>;
    readonly edit: (id: string) => (t: Knex.Transaction) => Promise<number>;
    /** After the archive committed: the policy refuses the new row (an error), hides the old one (no row) or, with no say on the client, the trigger raises. */
    readonly afterCommit: Record<string, unknown> | 'no row';
  }

  const rowOf = async (child: Child, id: string): Promise<string> => sqlText(
    `select to_jsonb(row)::text as value from public.${child.table} row where ${Object.keys(child.key(id)).map((column) => `row.${column} = ?::${column === 'section_key' ? 'text' : 'uuid'}`).join(' and ')}`,
    Object.values(child.key(id))
  );

  const children: readonly Child[] = [
    {
      table: 'content_tasks',
      key: (id) => ({ id }),
      // Planned today: the archive leaves the content alone, so the edit reaches the lock instead of the guard of a cancelled content.
      seed: async (clientId) => w.seedTask(await w.seedContent(clientId, { publishOn: await daysFromToday(0) })),
      edit: (id) => (t) => t('content_tasks').where({ id }).update({ title: 'Subtarefa renomeada' }),
      afterCommit: rlsViolation
    },
    {
      table: 'media_folders',
      key: (id) => ({ id }),
      seed: async (clientId) => {
        const id = randomUUID();
        await w.getOwner().knex('media_folders').insert({ id, client_id: clientId, name: 'Pasta de trabalho' });
        return id;
      },
      edit: (id) => (t) => t('media_folders').where({ id }).update({ name: 'Pasta renomeada' }),
      afterCommit: 'no row'
    },
    {
      table: 'client_personas',
      key: (id) => ({ id }),
      seed: async (clientId) => {
        const id = randomUUID();
        await w.getOwner().knex('client_personas').insert({ id, client_id: clientId, name: 'Persona', updated_by: ids.adminA });
        return id;
      },
      edit: (id) => (t) => t('client_personas').where({ id }).update({ name: 'Persona renomeada', updated_by: ids.adminA }),
      afterCommit: 'no row'
    },
    {
      table: 'client_brand_sections',
      key: (clientId) => ({ client_id: clientId, section_key: 'branding' }),
      seed: async (clientId) => {
        await w.getOwner().knex('client_brand_sections').insert({ client_id: clientId, section_key: 'branding', body: 'Marca', updated_by: ids.adminA });
        return clientId;
      },
      edit: (clientId) => (t) => t('client_brand_sections').where({ client_id: clientId, section_key: 'branding' }).update({ body: 'Marca nova', updated_by: ids.adminA }),
      afterCommit: 'no row'
    },
    {
      table: 'client_threads',
      key: (id) => ({ id }),
      seed: async (clientId) => {
        const id = randomUUID();
        await w.getOwner().knex('client_threads').insert({ id, client_id: clientId, section_key: 'branding', opened_by: ids.adminA, opened_side: 'agency' });
        return id;
      },
      edit: (id) => (t) => t('client_threads').where({ id }).update({ resolved_at: new Date(), resolved_by: ids.adminA }),
      afterCommit: 'no row'
    },
    {
      table: 'media_assets',
      key: (id) => ({ id }),
      seed: async (clientId) => w.seedAsset(clientId, await w.folderOf(clientId), { status: 'pending' }),
      edit: (id) => (t) => t('media_assets').where({ id }).update({ status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png' }),
      // The policy of the UPDATE has no say on the client, so the committed archive is refused by the trigger.
      afterCommit: { code: 'A0020' }
    }
  ];

  describe.each(children.map((child) => [child.table, child] as const))('%s', (_table, child) => {
    it('an edit written while the archive is uncommitted is refused as A0020 and the row is as it was', async () => {
      const client = await newClient();
      const id = await child.seed(client);
      const before = await rowOf(child, id);

      const outcome = await writeWhileArchiving(client, ids.adminA, child.edit(id));

      expect(outcome).toMatchObject({ code: 'A0020' });
      expect(await clientStatus(client)).toBe('archived');
      expect(await rowOf(child, id)).toBe(before);
    });

    it('an edit written first makes the archive wait, and both commit', async () => {
      const client = await newClient();
      const id = await child.seed(client);
      const before = await rowOf(child, id);

      const outcome = await archiveWhileWriting(client, ids.adminA, async (t) => {
        expect(await child.edit(id)(t)).toBe(1);
      });

      expect(outcome).toBe('archived');
      expect(await clientStatus(client)).toBe('archived');
      expect(await rowOf(child, id)).not.toBe(before);
    });

    it('an edit written after the archive committed changes nothing: the policy or the trigger refuses it, and the row is as it was', async () => {
      const client = await newClient();
      const id = await child.seed(client);
      const before = await rowOf(child, id);
      await w.asUser(ids.adminA, archive(client));

      if (child.afterCommit === 'no row') await expect(w.asUser(ids.adminA, child.edit(id))).resolves.toBe(0);
      else await expect(w.asUser(ids.adminA, child.edit(id))).rejects.toMatchObject(child.afterCommit);

      expect(await rowOf(child, id)).toBe(before);
    });

    it.each(levels)('%s: an edit from a snapshot older than the archive fails with 40001 and the row is as it was', async (level) => {
      const client = await newClient();
      const id = await child.seed(client);
      const before = await rowOf(child, id);
      const stale = await w.openTransactionAs(ids.adminA, level);

      try {
        await w.asUser(ids.adminA, archive(client));
        await expect(child.edit(id)(stale)).rejects.toMatchObject({ code: '40001' });
      } finally {
        await stale.rollback();
      }

      expect(await rowOf(child, id)).toBe(before);
    });

    // The route reads the client as active, then spends time elsewhere (the CopyObject and the HeadObject of a confirmation, the wait for
    // a quota lock) before the UPDATE, and the archive commits in that time. The UPDATE is a new statement and reads the client again.
    it('an edit after the client was read as active and the archive committed in between is refused, and the row is as it was', async () => {
      const client = await newClient();
      const id = await child.seed(client);
      const before = await rowOf(child, id);
      const writer = await w.openTransactionAs(ids.adminA);

      try {
        const read = await writer.raw<{ rows: Array<{ active: boolean }> }>('select app_private.client_is_active(?::uuid) as active', [client]);
        expect(read.rows).toEqual([{ active: true }]);
        await w.asUser(ids.adminA, archive(client));

        if (child.afterCommit === 'no row') await expect(child.edit(id)(writer)).resolves.toBe(0);
        else await expect(child.edit(id)(writer)).rejects.toMatchObject(child.afterCommit);
      } finally {
        await writer.rollback();
      }

      expect(await rowOf(child, id)).toBe(before);
    });

    // The edit waits for the lock of its own row, held by another transaction, and the archive commits during the wait. The statement
    // keeps the snapshot that saw the client as active, so it is the trigger, after the wait, that reads the client again: A0020 for
    // every one of the six, the policy having no say in this window.
    it('an edit that waits for the lock of its row while the archive commits is refused as A0020, and the row is as it was', async () => {
      const client = await newClient();
      const id = await child.seed(client);
      const before = await rowOf(child, id);
      const holder = await w.openTransactionAs(ids.adminA);
      let outcome: Promise<unknown> | undefined;

      try {
        const key = child.key(id);
        const held = await holder.raw(`select 1 from public.${child.table} where ${Object.keys(key).map((column) => `${column} = ?`).join(' and ')} for update`, Object.values(key));
        expect(held.rows).toHaveLength(1);
        outcome = w.asUser(ids.adminA, child.edit(id)).then(() => 'written' as const, (error: unknown) => error);
        await w.waitUntilSomeoneWaitsOnALock();
        await w.asUser(ids.adminA, archive(client));
      } finally {
        await holder.commit();
      }

      expect(await outcome).toMatchObject({ code: 'A0020' });
      expect(await clientStatus(client)).toBe('archived');
      expect(await rowOf(child, id)).toBe(before);
    });

    it('holds the client row shared while the edit is uncommitted: the locker has the row, and a lock that waits fails with 55P03', async () => {
      const client = await newClient();
      const id = await child.seed(client);
      const writing = await w.openTransactionAs(ids.adminA);

      try {
        expect(await child.edit(id)(writing)).toBe(1);
        const probe = await w.openTransactionAs(ids.adminA);
        try {
          await probe.raw("set local lock_timeout = '250ms'");
          await expect(probe.raw('select id from public.clients where id = ?::uuid for update nowait', [client])).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await probe.rollback();
        }
      } finally {
        await writing.rollback();
      }
    });
  });

  it('media_assets: a media of the library of the agency, which has no client, is confirmed with no lock on any client', async () => {
    const id = randomUUID();
    try {
      await w.getOwner().knex('media_assets').insert({
        id, agency_id: ids.agencyA, category: 'image', declared_content_type: 'image/png', extension: 'png',
        object_key: `${ids.agencyA}/${id}/original.png`, upload_object_key: `staging/${ids.agencyA}/${id}/upload.png`, declared_size_bytes: 1_000,
        created_by_user_id: ids.adminA
      });

      const confirmed = await w.asUser(ids.adminA, (t) => t('media_assets').where({ id }).update({ status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: 'image/png' }));

      expect(confirmed).toBe(1);
    } finally {
      await w.getOwner().knex('media_assets').where({ id }).delete();
    }
  });

  // The worker and the rejection of an upload are writes of the same login that the lock must leave alone: refusing them for an archived
  // client would leave a video processing forever, or an upload neither confirmed nor rejected.
  it('media_assets: the processing of a video that was confirmed before the archive still ends after it', async () => {
    const client = await newClient();
    const id = await w.seedAsset(client, await w.folderOf(client), { category: 'video' });
    await w.getOwner().knex('media_assets').where({ id }).update({ video_processing_status: 'processing' });
    await w.asUser(ids.adminA, archive(client));

    const updated = await w.asUser(ids.adminA, (t) => t('media_assets').where({ id }).update({ video_processing_status: 'failed', video_processing_error: 'processing_failed', video_processed_at: new Date() }));

    expect(updated).toBe(1);
    expect(await w.getOwner().knex('media_assets').where({ id }).first('video_processing_status')).toEqual({ video_processing_status: 'failed' });
  });

  it('media_assets: a pending upload of a client archived meanwhile can still be rejected', async () => {
    const client = await newClient();
    const id = await w.seedAsset(client, await w.folderOf(client), { status: 'pending' });
    await w.asUser(ids.adminA, archive(client));

    const updated = await w.asUser(ids.adminA, (t) => t('media_assets').where({ id }).update({ status: 'rejected', rejected_reason: 'too_large' }));

    expect(updated).toBe(1);
    expect(await w.getOwner().knex('media_assets').where({ id }).first('status')).toEqual({ status: 'rejected' });
  });
});

describe('archiving a client cancels the content planned after its closing (issue #251)', () => {
  const seedFour = async (clientId: string, publishOn: string): Promise<Record<'in_production' | 'awaiting_approval' | 'adjusting' | 'approved', string>> => ({
    in_production: await w.seedContent(clientId, { status: 'in_production', publishOn }),
    awaiting_approval: await w.seedContent(clientId, { status: 'awaiting_approval', publishOn }),
    adjusting: await w.seedContent(clientId, { status: 'adjusting', publishOn }),
    approved: await w.seedContent(clientId, { status: 'approved', publishOn })
  });

  it('cancels, in the archive route, every open state planned after today, and leaves what is planned today or before', async () => {
    const client = await newClient();
    const later = await seedFour(client, await daysFromToday(1));
    const sameDay = await seedFour(client, await daysFromToday(0));
    const earlier = await w.seedContent(client, { status: 'awaiting_approval', publishOn: await daysFromToday(-3) });

    await w.asUser(ids.adminA, archive(client));

    expect(await contentStatus(later.in_production)).toBe('cancelled');
    expect(await w.contentRow(later.awaiting_approval)).toMatchObject({ status: 'cancelled', approved_by: null, approved_at: null });
    expect(await contentStatus(later.adjusting)).toBe('cancelled');
    expect(await w.contentRow(later.approved)).toMatchObject({ status: 'cancelled', approved_by: null, approved_at: null, approved_by_agency_reason: null });
    expect(await contentStatus(sameDay.in_production)).toBe('in_production');
    expect(await contentStatus(sameDay.awaiting_approval)).toBe('awaiting_approval');
    expect(await contentStatus(sameDay.adjusting)).toBe('adjusting');
    expect(await w.contentRow(sameDay.approved)).toMatchObject({ status: 'approved', approved_by: ids.portalA1 });
    expect(await contentStatus(earlier)).toBe('awaiting_approval');
    expect((await w.contentRow(later.in_production)).cancelled_at).toBeInstanceOf(Date);
  });

  it('does not touch a published content, nor the moment an already cancelled one was cancelled', async () => {
    const client = await newClient();
    const published = await w.seedContent(client, { status: 'published', publishOn: await daysFromToday(5) });
    const cancelled = await w.seedContent(client, { status: 'cancelled', publishOn: await daysFromToday(5) });
    const cancelledAt = (await w.contentRow(cancelled)).cancelled_at;

    await w.asUser(ids.adminA, archive(client));

    expect(await w.contentRow(published)).toMatchObject({ status: 'published', approved_by: ids.portalA1 });
    expect((await w.contentRow(cancelled)).cancelled_at).toEqual(cancelledAt);
  });

  it('cancels only the contents of the client it archives', async () => {
    const client = await newClient();
    const other = await newClient();
    const own = await w.seedContent(client, { publishOn: await daysFromToday(5) });
    const foreign = await w.seedContent(other, { publishOn: await daysFromToday(5) });

    await w.asUser(ids.adminA, archive(client));

    expect(await contentStatus(own)).toBe('cancelled');
    expect(await contentStatus(foreign)).toBe('in_production');
  });

  it('archiving now is a closing today: a closing date still ahead does not keep what is planned before it', async () => {
    const client = await newClient(await daysFromToday(20));
    const beforeClosing = await w.seedContent(client, { publishOn: await daysFromToday(10) });
    const today = await w.seedContent(client, { publishOn: await daysFromToday(0) });

    await w.asUser(ids.adminA, archive(client));

    expect(await contentStatus(beforeClosing)).toBe('cancelled');
    expect(await contentStatus(today)).toBe('in_production');
  });

  it('cuts at the closing date when it is already past and the job has not run yet', async () => {
    const client = await newClient(await daysFromToday(-3));
    const onClosing = await w.seedContent(client, { publishOn: await daysFromToday(-3) });
    const afterClosing = await w.seedContent(client, { publishOn: await daysFromToday(-2) });

    await w.asUser(ids.adminA, archive(client));

    expect(await contentStatus(onClosing)).toBe('in_production');
    expect(await contentStatus(afterClosing)).toBe('cancelled');
  });

  it('is done by the job as well: planned on the closing date stays, planned after is cancelled, and a client that is not due is not touched', async () => {
    const due = await newClient(await daysFromToday(-1));
    const notDue = await newClient(await daysFromToday(5));
    const onClosing = await w.seedContent(due, { publishOn: await daysFromToday(-1) });
    const afterClosing = await w.seedContent(due, { publishOn: await daysFromToday(0) });
    const published = await w.seedContent(due, { status: 'published', publishOn: await daysFromToday(3) });
    const other = await w.seedContent(notDue, { publishOn: await daysFromToday(8) });

    const archived = await w.getOwner().knex.raw<{ rows: Array<{ archived: number }> }>('select app_private.archive_due_clients() as archived');

    expect(archived.rows[0]!.archived).toBeGreaterThanOrEqual(1);
    expect(await clientStatus(due)).toBe('archived');
    expect(await contentStatus(onClosing)).toBe('in_production');
    expect(await contentStatus(afterClosing)).toBe('cancelled');
    expect(await contentStatus(published)).toBe('published');
    expect(await clientStatus(notDue)).toBe('active');
    expect(await contentStatus(other)).toBe('in_production');
  });

  it('is not undone by reactivating the client, which leaves every content as it found it', async () => {
    const client = await newClient();
    const cancelled = await w.seedContent(client, { publishOn: await daysFromToday(5) });
    const kept = await w.seedContent(client, { publishOn: await daysFromToday(0) });

    await w.asUser(ids.adminA, archive(client));
    await w.asUser(ids.adminA, (t) => t.raw('select app_private.reactivate_client(?::uuid)', [client]));

    expect(await clientStatus(client)).toBe('active');
    expect(await contentStatus(cancelled)).toBe('cancelled');
    expect(await contentStatus(kept)).toBe('in_production');
  });

  describe('the cancellation without a permission is reachable only from the archive', () => {
    it('refuses a direct UPDATE of the state to the application role, with a permission it holds or not', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(5) });

      await expect(w.asUser(ids.adminA, (t) => t('contents').where({ id }).update({ status: 'cancelled' }))).rejects.toMatchObject({ code: '42501' });
      await expect(w.asUser(ids.ownerA, (t) => t('contents').where({ id }).update({ cancelled_at: new Date() }))).rejects.toMatchObject({ code: '42501' });
      expect(await contentStatus(id)).toBe('in_production');
    });

    it('does not let a caller without conteudo.cancelar cancel through the function that does it with one', async () => {
      const client = await newClient();
      const id = await w.seedContent(client, { publishOn: await daysFromToday(5) });
      const person = await w.personWithAllBut('conteudo.cancelar');

      await expect(w.asUser(person, (t) => t.raw('select app_private.cancel_content(?::uuid)', [id]))).rejects.toMatchObject({ code: 'A0060' });
      expect(await contentStatus(id)).toBe('in_production');
    });

    it('is written by cancel_content and by the helper of the archive, and the helper is called by the archive of one client, from the route and from the job, only', async () => {
      const knex = w.getOwner().knex;
      const writers = await knex.raw<{ rows: Array<{ proname: string }> }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app_private' and p.prosrc ~ 'set\\s+status\\s*=\\s*''cancelled''' order by p.proname`
      );
      const callers = await knex.raw<{ rows: Array<{ proname: string }> }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app_private' and p.prosrc like '%cancel_contents_after%' order by p.proname`
      );

      expect(writers.rows.map((row) => row.proname)).toEqual(['cancel_content', 'cancel_contents_after']);
      expect(callers.rows.map((row) => row.proname)).toEqual(['archive_client', 'archive_due_client']);
    });

    it('does not let the application role, or PUBLIC, call the helper', async () => {
      const grants = await w.getOwner().knex.raw<{ rows: Array<{ app: boolean; public_acl: boolean }> }>(
        `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
                coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl
         from pg_proc p where p.oid = 'app_private.cancel_contents_after(uuid, date)'::regprocedure`
      );
      expect(grants.rows).toEqual([{ app: false, public_acl: false }]);

      const client = await newClient();
      await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.cancel_contents_after(?::uuid, ?::date)', [client, '2000-01-01']))).rejects.toMatchObject({ code: '42501' });
    });
  });

  it.each([
    ['archive_client', 'app_private.archive_client(uuid)', true],
    ['archive_due_clients', 'app_private.archive_due_clients()', true],
    ['archive_due_client', 'app_private.archive_due_client(uuid)', true],
    ['due_client_ids', 'app_private.due_client_ids()', true],
    ['cancel_contents_after', 'app_private.cancel_contents_after(uuid, date)', false],
    ['lock_active_client_of_child', 'app_private.lock_active_client_of_child()', false],
    ['lock_content_for_agency', 'app_private.lock_content_for_agency(uuid, text)', false],
    ['approve_content', 'app_private.approve_content(uuid, integer)', true],
    ['lock_content_task', 'app_private.lock_content_task(uuid, boolean)', false]
  ])('%s stays security definer, with a fixed search_path and no execute for PUBLIC (application role: %s)', async (_name, signature, applicationMayCall) => {
    const row = await w.getOwner().knex.raw<{ rows: Array<{ definer: boolean; config: string[] | null; public_execute: boolean; app_execute: boolean }> }>(
      `select p.prosecdef as definer, p.proconfig as config,
              coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_execute,
              has_function_privilege('ageniza_app', p.oid, 'execute') as app_execute
       from pg_proc p where p.oid = ?::regprocedure`, [signature]
    );
    expect(row.rows).toEqual([{ definer: true, config: ['search_path=""'], public_execute: false, app_execute: applicationMayCall }]);
  });
});

// Issues #408 and #534. The list of columns of each edit trigger repeats by hand what the application role may write, so a
// writable column added later would escape the lock with no test turning red; the catalog says it instead.
describe('the edit lock covers every column the application role may write (issues #408, #534 and #540)', () => {
  it.each([
    ['contents', '0_contents_edit_lock_active_client'],
    ['story_scripts', '0_story_scripts_edit_lock_active_client'],
    ['story_script_scenes', '0_story_script_scenes_edit_lock_active_client'],
    ['content_tasks', '0_content_tasks_edit_lock_active_client'],
    ['media_folders', '0_media_folders_edit_lock_active_client'],
    ['client_personas', '0_client_personas_edit_lock_active_client'],
    ['client_brand_sections', '0_client_brand_sections_edit_lock_active_client'],
    ['client_threads', '0_client_threads_edit_lock_active_client']
  ])('%s: the columns of %s are exactly the ones ageniza_app has UPDATE on, and the WHEN compares each of them', async (table, trigger) => {
    const writable = await w.getOwner().knex.raw<{ rows: Array<{ name: string }> }>(
      `select a.attname as name from pg_attribute a
       where a.attrelid = ?::regclass and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('ageniza_app', a.attrelid, a.attnum, 'UPDATE')
       order by a.attname collate "C"`, [`public.${table}`]
    );
    const locked = await w.getOwner().knex.raw<{ rows: Array<{ name: string; definition: string; enabled: string; after_update_row: boolean }> }>(
      `select a.attname as name, pg_get_triggerdef(t.oid) as definition, t.tgenabled as enabled,
              (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 16) = 16 as after_update_row
       from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
       where t.tgrelid = ?::regclass and t.tgname = ? and not t.tgisinternal
       order by a.attname collate "C"`, [`public.${table}`, trigger]
    );

    expect(writable.rows.length).toBeGreaterThan(0);
    expect(locked.rows.map((row) => row.name)).toEqual(writable.rows.map((row) => row.name));
    expect(locked.rows.every((row) => row.enabled === 'O' && row.after_update_row)).toBe(true);
    const condition = locked.rows[0]!.definition.split(' WHEN ')[1] ?? '';
    for (const row of locked.rows) {
      // The catalog quotes a reserved word (`position`).
      const mentions = (side: string): boolean => condition.includes(`${side}.${row.name}`) || condition.includes(`${side}."${row.name}"`);
      expect({ column: row.name, compared: mentions('old') && mentions('new') }).toEqual({ column: row.name, compared: true });
    }
  });

  // Issue #532. Not every granted column: the worker and the rejection write the same table after the confirmation, and the archive
  // must not refuse them. Only the confirmation is serialized, and the test says so by naming what is out.
  it('media_assets: the confirmation alone is locked, on the status, and the columns the worker writes are not', async () => {
    const locked = await w.getOwner().knex.raw<{ rows: Array<{ name: string; definition: string; enabled: string }> }>(
      `select a.attname as name, pg_get_triggerdef(t.oid) as definition, t.tgenabled as enabled
       from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
       where t.tgrelid = 'public.media_assets'::regclass and t.tgname = '0_media_assets_confirm_lock_active_client' and not t.tgisinternal`
    );

    expect(locked.rows.map((row) => row.name)).toEqual(['status']);
    expect(locked.rows[0]!.enabled).toBe('O');
    expect(locked.rows[0]!.definition).toContain("new.status = 'confirmed'");
    const writable = await w.columnsWithPrivilege('media_assets', 'update');
    for (const column of ['video_processing_status', 'video_processing_error', 'thumbnail_object_key', 'preview_object_key', 'rejected_reason']) {
      expect(writable).toContain(column);
    }
  });
});

describe('the lock of the children is the first AFTER INSERT trigger of each table (issue #284)', () => {
  it.each([
    'client_brand_sections', 'client_personas', 'client_threads', 'client_thread_comments', 'media_folders', 'media_assets',
    'story_scripts', 'story_script_scenes', 'contents', 'content_tasks'
  ])('%s fires it for each row, enabled, ahead of the triggers of its foreign keys and of its own rules', async (table) => {
    const triggers = await w.getOwner().knex.raw<{ rows: Array<{ tgname: string; fn: string }> }>(
      `select t.tgname, p.proname as fn
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = ?::regclass
         and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 4) = 4 and t.tgenabled = 'O'
       order by t.tgname collate "C"`, [`public.${table}`]
    );
    expect(triggers.rows[0]).toEqual({ tgname: `0_${table}_lock_active_client`, fn: 'lock_active_client_of_child' });
    expect(triggers.rows.some((trigger) => trigger.tgname.startsWith('RI_ConstraintTrigger_c_'))).toBe(true);
  });
});
