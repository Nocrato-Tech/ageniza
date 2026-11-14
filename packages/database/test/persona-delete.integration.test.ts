import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentWorld } from './support/content-world.js';

// Issue #891 (decision 2026-11-12): a persona is deleted, with its conversation, and never archived. Every attack is `ageniza_app`
// through a person; the owner only plants the rows and reads what is left.
const w = createContentWorld('persona-delete');
const { ids } = w;
const owner = () => w.getOwner().knex;

const personaIds: string[] = [];

beforeAll(async () => {
  await w.setup();
});

afterAll(async () => {
  try {
    await owner()('audit.events').where({ action: 'persona.deleted' }).whereIn('target_id', personaIds).delete().catch(() => undefined);
    await owner()('client_personas').whereIn('id', personaIds).delete();
  } finally {
    await w.teardown();
  }
});

const seedPersona = async (clientId: string = ids.clientA1): Promise<string> => {
  const id = randomUUID();
  personaIds.push(id);
  await owner()('client_personas').insert({ id, client_id: clientId, name: `Persona ${id}`, updated_by: clientId === ids.clientB ? ids.adminB : ids.adminA });
  return id;
};

const seedThread = async (clientId: string, subject: { personaId?: string; sectionKey?: string }, comments = 2): Promise<{ threadId: string; commentIds: string[] }> => {
  const threadId = randomUUID();
  await owner()('client_threads').insert({
    id: threadId,
    client_id: clientId,
    persona_id: subject.personaId ?? null,
    section_key: subject.sectionKey ?? null,
    opened_by: ids.adminA,
    opened_side: 'agency'
  });
  const commentIds: string[] = [];
  for (let index = 0; index < comments; index += 1) {
    const id = randomUUID();
    commentIds.push(id);
    await owner()('client_thread_comments').insert({
      id,
      thread_id: threadId,
      client_id: clientId,
      author_user_id: index % 2 === 0 ? ids.adminA : ids.portalA1,
      author_side: index % 2 === 0 ? 'agency' : 'client',
      body: `Mensagem ${index + 1}`
    });
  }
  return { threadId, commentIds };
};

const exists = async (table: string, id: string): Promise<boolean> => (await owner()(table).where({ id }).first('id')) !== undefined;
const remove = (id: string) => (t: Knex.Transaction) => t('client_personas').where({ id }).delete();

describe('deleting a persona takes its conversation and nothing else (issue #891)', () => {
  it('deletes the persona, its threads, their comments and their notifications, in one statement, and leaves the rest', async () => {
    const target = await seedPersona();
    const sibling = await seedPersona();
    const otherClient = await seedPersona(ids.clientA2);
    const otherAgency = await seedPersona(ids.clientB);
    const doomed = await seedThread(ids.clientA1, { personaId: target }, 3);
    const doomedSecond = await seedThread(ids.clientA1, { personaId: target }, 1);
    const survivors = [
      await seedThread(ids.clientA1, { personaId: sibling }),
      await seedThread(ids.clientA1, { sectionKey: 'personas' }),
      await seedThread(ids.clientA2, { personaId: otherClient }),
      await seedThread(ids.clientB, { personaId: otherAgency })
    ];
    const notified = await owner()('notifications').insert({
      agency_id: ids.agencyA, recipient_user_id: ids.adminA, kind: 'material_request_answered', thread_id: doomed.threadId,
      client_id: ids.clientA1, summary: 'Resposta'
    }).returning('id');

    await expect(w.asUser(ids.adminA, remove(target))).resolves.toBe(1);

    expect(await exists('client_personas', target)).toBe(false);
    for (const thread of [doomed, doomedSecond]) {
      expect(await exists('client_threads', thread.threadId)).toBe(false);
      for (const commentId of thread.commentIds) expect(await exists('client_thread_comments', commentId)).toBe(false);
    }
    expect(await exists('notifications', notified[0]!.id)).toBe(false);
    for (const personaId of [sibling, otherClient, otherAgency]) expect(await exists('client_personas', personaId)).toBe(true);
    for (const thread of survivors) {
      expect(await exists('client_threads', thread.threadId)).toBe(true);
      for (const commentId of thread.commentIds) expect(await exists('client_thread_comments', commentId)).toBe(true);
    }
  });

  it('leaves no thread without its persona and no comment without its thread', async () => {
    const target = await seedPersona();
    await seedThread(ids.clientA1, { personaId: target });
    await w.asUser(ids.adminA, remove(target));

    const orphans = await owner().raw(`
      select
        (select count(*) from public.client_threads t where t.persona_id is not null and not exists (select 1 from public.client_personas p where p.id = t.persona_id)) as threads,
        (select count(*) from public.client_thread_comments c where not exists (select 1 from public.client_threads t where t.id = c.thread_id)) as comments
    `);
    expect(orphans.rows).toEqual([{ threads: '0', comments: '0' }]);
  });

  it('writes persona.deleted to the audit trail, in the same transaction, with the actor and the agency', async () => {
    const target = await seedPersona();
    await w.asUser(ids.adminA, remove(target));

    const events = await owner()('audit.events').where({ action: 'persona.deleted', target_id: target }).select('actor_user_id', 'agency_id', 'target_type');
    expect(events).toEqual([{ actor_user_id: ids.adminA, agency_id: ids.agencyA, target_type: 'client_persona' }]);
  });

  it('writes no audit event when the delete rolls back', async () => {
    const target = await seedPersona();
    const transaction = await w.openTransactionAs(ids.adminA);
    await transaction('client_personas').where({ id: target }).delete();
    await transaction.rollback();

    expect(await owner()('audit.events').where({ action: 'persona.deleted', target_id: target }).first('id')).toBeUndefined();
    expect(await exists('client_personas', target)).toBe(true);
  });
});

describe('who may delete a persona (issue #891)', () => {
  it('takes a person who holds cliente.operar and nothing else', async () => {
    const target = await seedPersona();
    const operator = await w.personWith('cliente.operar');

    await expect(w.asUser(operator, remove(target))).resolves.toBe(1);
  });

  it.each([
    ['a person who only views clients', async () => w.personWith('cliente.visualizar')],
    ['a person with no client permission', async () => w.personWith('conteudo.visualizar')],
    ['the sales preset', async () => ids.salesA],
    ['the finance preset', async () => ids.financeA],
    ['a person of the portal of that client', async () => ids.portalA1],
    ['a person of the portal of another client', async () => ids.portalA2],
    ['an admin of another agency', async () => ids.adminB]
  ])('refuses %s and leaves the persona and its conversation', async (_label, who) => {
    const target = await seedPersona();
    const thread = await seedThread(ids.clientA1, { personaId: target });

    await expect(w.asUser(await who(), remove(target))).resolves.toBe(0);

    expect(await exists('client_personas', target)).toBe(true);
    expect(await exists('client_threads', thread.threadId)).toBe(true);
    for (const commentId of thread.commentIds) expect(await exists('client_thread_comments', commentId)).toBe(true);
  });

  it('refuses a person with no actor bound', async () => {
    const target = await seedPersona();
    const bare = await w.getOwner().knex.transaction();
    try {
      await bare.raw('set local role ageniza_app');
      expect(await bare('client_personas').where({ id: target }).delete()).toBe(0);
    } finally {
      await bare.rollback();
    }
    expect(await exists('client_personas', target)).toBe(true);
  });

  it('refuses the persona of an archived client, with its conversation', async () => {
    const target = await seedPersona(ids.clientArchived);
    const thread = await seedThread(ids.clientArchived, { personaId: target });
    await w.archiveClient(ids.clientArchived);
    try {
      await expect(w.asUser(ids.adminA, remove(target))).resolves.toBe(0);
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }

    expect(await exists('client_personas', target)).toBe(true);
    expect(await exists('client_threads', thread.threadId)).toBe(true);
  });

  it('refuses the persona of a suspended agency', async () => {
    const target = await seedPersona(ids.clientSuspended);

    await expect(w.asUser(ids.adminSuspended, remove(target))).resolves.toBe(0);

    expect(await exists('client_personas', target)).toBe(true);
  });

  it('refuses an agency whose trial has ended (A0090), and the persona stays', async () => {
    const target = await seedPersona();
    const thread = await seedThread(ids.clientA1, { personaId: target });
    await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: ids.agencyA });
    try {
      await expect(w.asUser(ids.adminA, remove(target))).rejects.toMatchObject({ code: 'A0090' });
    } finally {
      await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
    }

    expect(await exists('client_personas', target)).toBe(true);
    expect(await exists('client_threads', thread.threadId)).toBe(true);
  });

  it('takes no grant on the conversation: the application role cannot delete a thread or a comment itself', async () => {
    const target = await seedPersona();
    const thread = await seedThread(ids.clientA1, { personaId: target });

    await expect(w.asUser(ids.adminA, (t) => t('client_thread_comments').where({ id: thread.commentIds[0]! }).delete())).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t('client_threads').where({ id: thread.threadId }).delete())).rejects.toMatchObject({ code: '42501' });
    expect(await w.tablePrivileges('client_threads')).toMatchObject({ can_delete: false });
    expect(await w.tablePrivileges('client_thread_comments')).toMatchObject({ can_delete: false });
    expect(await w.tablePrivileges('client_personas')).toMatchObject({ can_delete: true, can_truncate: false });
  });
});

describe('a persona cannot be archived (issue #891)', () => {
  it('refuses the write of status, with a grant error for the application role', async () => {
    const target = await seedPersona();

    await expect(w.asUser(ids.adminA, (t) => t('client_personas').where({ id: target }).update({ status: 'archived', updated_by: ids.adminA }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t('client_personas').where({ id: target }).update({ status: 'active', updated_by: ids.adminA }))).rejects.toMatchObject({ code: '42501' });
    expect(await w.columnsWithPrivilege('client_personas', 'update')).not.toContain('status');
    expect(await w.columnsWithPrivilege('client_personas', 'insert')).not.toContain('status');
  });

  it('refuses the status archived to the owner too, on insert and on update', async () => {
    const target = await seedPersona();

    await expect(owner()('client_personas').where({ id: target }).update({ status: 'archived' })).rejects.toMatchObject({ code: '23514', constraint: 'client_personas_status_check' });
    await expect(owner()('client_personas').insert({ client_id: ids.clientA1, name: 'Arquivada', status: 'archived', updated_by: ids.adminA })).rejects.toMatchObject({ code: '23514' });
  });

  it('still edits the persona and keeps the edit lock on the columns the application role may write', async () => {
    const target = await seedPersona();

    await expect(w.asUser(ids.adminA, (t) => t('client_personas').where({ id: target }).update({ name: 'Outro nome', updated_by: ids.adminA }))).resolves.toBe(1);

    const locked = (await owner().raw(`
      select array(select a.attname::text from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr)
                   where t.tgrelid = 'public.client_personas'::regclass and t.tgname = '0_client_personas_edit_lock_active_client' order by 1) as columns
    `)).rows[0].columns as string[];
    expect(locked).toEqual((await w.columnsWithPrivilege('client_personas', 'update')).sort());
  });
});

describe('what points at a conversation (issue #891)', () => {
  it('lists every foreign key that reaches the threads and the comments, and what each one does when the row goes', async () => {
    const { rows } = await owner().raw(`
      select conrelid::regclass::text as child, confrelid::regclass::text as parent, confdeltype as on_delete
      from pg_constraint
      where contype = 'f' and confrelid in ('public.client_personas'::regclass, 'public.client_threads'::regclass, 'public.client_thread_comments'::regclass)
      order by 1, 2
    `);
    expect(rows).toEqual([
      { child: 'client_thread_comments', parent: 'client_threads', on_delete: 'c' },
      { child: 'client_threads', parent: 'client_personas', on_delete: 'c' },
      { child: 'media_assets', parent: 'client_threads', on_delete: 'a' },
      { child: 'notifications', parent: 'client_threads', on_delete: 'c' }
    ]);
  });

  it('has two trigger functions with an empty search_path, none executable by public', async () => {
    const { rows } = await owner().raw(`
      select p.proname as name, p.prosecdef as definer, p.proconfig as config, has_function_privilege('public', p.oid, 'execute') as public_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname in ('lock_active_client_of_deleted_persona', 'audit_persona_deleted')
      order by 1
    `);
    expect(rows).toEqual([
      { name: 'audit_persona_deleted', definer: false, config: ['search_path=""'], public_execute: false },
      { name: 'lock_active_client_of_deleted_persona', definer: true, config: ['search_path=""'], public_execute: false }
    ]);
  });

  it('keeps row level security forced on the three tables', async () => {
    const { rows } = await owner().raw(`
      select relname, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class
      where oid in ('public.client_personas'::regclass, 'public.client_threads'::regclass, 'public.client_thread_comments'::regclass) order by 1
    `);
    expect(rows).toEqual([
      { relname: 'client_personas', enabled: true, forced: true },
      { relname: 'client_thread_comments', enabled: true, forced: true },
      { relname: 'client_threads', enabled: true, forced: true }
    ]);
  });
});

describe('a delete that was open when the client was archived (issue #891)', () => {
  it('waits for the archive and is then refused with A0020, leaving the persona and its conversation', async () => {
    const target = await seedPersona();
    const thread = await seedThread(ids.clientA1, { personaId: target });
    const archiving = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [ids.clientA1]);
      outcome = w.asUser(ids.adminA, remove(target)).then(() => 'deleted' as const, (error: unknown) => error);
      await w.waitUntilSomeoneWaitsOnALock();
    } finally {
      await archiving.commit();
      await w.reactivateClient(ids.clientA1);
    }

    expect(await outcome).toMatchObject({ code: 'A0020' });
    expect(await exists('client_personas', target)).toBe(true);
    expect(await exists('client_threads', thread.threadId)).toBe(true);
  });

  it('does not constrain the owner, like the other locks of the children', async () => {
    const target = await seedPersona(ids.clientArchived);

    await expect(owner()('client_personas').where({ id: target }).delete()).resolves.toBe(1);
  });
});
