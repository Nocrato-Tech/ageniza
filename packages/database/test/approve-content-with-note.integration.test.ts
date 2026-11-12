import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, waitForBackendsBlockedBy } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';

// Scope redesign-igual, subtask A2, decision of 2026-11-11 "a rodada mostra o remetente e aceita recado ao aprovar": the person of the
// portal approves a content with an optional note, which becomes a comment of the client in the conversation of the content in the same
// transaction. Every attack runs as `ageniza_app` with the actor of a real person; the owner prepares the world and reads what was left.
const w = createContentWorld('approve-with-note');
const { ids } = w;
const f = createApprovalFixtures(w);
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

const THE_NOTE = 'Gostei muito, pode agendar para sexta.';

/** A content of client A1 that waits for the approval of its portal, sent by a person of the agency. */
const waiting = async (client = ids.clientA1): Promise<string> => {
  const content = await f.readyContent(client);
  await f.submit(ids.productionA, content, null, 'Recado da agência');
  return content;
};

const revisionOf = async (content: string): Promise<number> => (await w.contentRow(content)).revision as number;
const statusOf = async (content: string): Promise<string> => (await w.contentRow(content)).status as string;

const approveAs = async (user: string, content: string, note: string | null, revision?: number): Promise<unknown> => {
  const read = revision ?? (await revisionOf(content));
  return w.asUser(user, (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, read, note]));
};

interface CommentRow { thread_id: string; body: string; author_user_id: string; author_side: string; client_id: string }
const commentsOf = async (content: string): Promise<CommentRow[]> =>
  (await owner()('client_thread_comments as comment')
    .join('client_threads as thread', 'thread.id', 'comment.thread_id')
    .where('thread.content_id', content)
    .orderBy('comment.created_at')
    .select('comment.thread_id', 'comment.body', 'comment.author_user_id', 'comment.author_side', 'comment.client_id')) as CommentRow[];
const threadsOf = async (content: string): Promise<Array<{ id: string; opened_side: string; opened_by: string }>> =>
  (await owner()('client_threads').where({ content_id: content }).select('id', 'opened_side', 'opened_by')) as Array<{ id: string; opened_side: string; opened_by: string }>;

/** Nothing of a refused approval is left: the content waits as it did and the conversation has no thread and no comment. */
const expectUntouched = async (content: string, status = 'awaiting_approval'): Promise<void> => {
  expect(await statusOf(content)).toBe(status);
  expect(await threadsOf(content)).toEqual([]);
  expect(await commentsOf(content)).toEqual([]);
};

describe('approve_content with a note', () => {
  it('approves and writes the note as a comment of the client, with the person who approved as its author, in a conversation opened by the client', async () => {
    const content = await waiting();
    await approveAs(ids.portalA1, content, THE_NOTE);

    expect(await statusOf(content)).toBe('approved');
    expect(await commentsOf(content)).toEqual([{
      thread_id: expect.any(String), body: THE_NOTE, author_user_id: ids.portalA1, author_side: 'client', client_id: ids.clientA1
    }]);
    expect(await threadsOf(content)).toEqual([{ id: expect.any(String), opened_side: 'client', opened_by: ids.portalA1 }]);
  });

  it('writes the note as given, with its line breaks and its edges, and not trimmed', async () => {
    const content = await waiting();
    const note = '  Aprovado!\nSó troque a hashtag.  ';
    await approveAs(ids.portalA1, content, note);
    expect((await commentsOf(content)).map((comment) => comment.body)).toEqual([note]);
  });

  it('approves with no note as before: no conversation is opened, whether the note is null or the call is the one of two arguments', async () => {
    const withNull = await waiting();
    await approveAs(ids.portalA1, withNull, null);
    const twoArguments = await waiting();
    await w.asUser(ids.portalA1, async (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer)', [twoArguments, await revisionOf(twoArguments)]));

    for (const content of [withNull, twoArguments]) {
      expect(await statusOf(content)).toBe('approved');
      expect(await threadsOf(content)).toEqual([]);
      expect(await commentsOf(content)).toEqual([]);
    }
  });

  it('puts the note in the conversation the agency already opened, which stays one conversation', async () => {
    const content = await waiting();
    await w.asUser(ids.adminA, (t) => t.raw(
      "insert into public.client_threads (client_id, content_id, opened_by, opened_side) values (?::uuid, ?::uuid, ?::uuid, 'agency')", [ids.clientA1, content, ids.adminA]
    ));
    const [opened] = await threadsOf(content);

    await approveAs(ids.portalA1, content, THE_NOTE);

    expect(await threadsOf(content)).toEqual([opened]);
    expect((await commentsOf(content)).map((comment) => [comment.thread_id, comment.body])).toEqual([[opened!.id, THE_NOTE]]);
  });

  it('adds the note after the comments that were already there', async () => {
    const content = await waiting();
    await w.asUser(ids.adminA, async (t) => {
      const thread = (await t.raw<{ rows: Array<{ id: string }> }>(
        "insert into public.client_threads (client_id, content_id, opened_by, opened_side) values (?::uuid, ?::uuid, ?::uuid, 'agency') returning id", [ids.clientA1, content, ids.adminA]
      )).rows[0]!;
      await t.raw(
        "insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body) values (?::uuid, ?::uuid, ?::uuid, 'agency', 'Pergunta da agência')",
        [thread.id, ids.clientA1, ids.adminA]
      );
    });
    await approveAs(ids.portalA1, content, THE_NOTE);
    expect((await commentsOf(content)).map((comment) => [comment.author_side, comment.body])).toEqual([['agency', 'Pergunta da agência'], ['client', THE_NOTE]]);
  });

  it('lets the agency and the portal read the note in the conversation of the content, and no person of another client or agency', async () => {
    const content = await waiting();
    await approveAs(ids.portalA1, content, THE_NOTE);
    const threads = (await threadsOf(content)).map((thread) => thread.id);
    const read = (user: string): Promise<string[]> =>
      w.asUser(user, async (t) => (await t('client_thread_comments').whereIn('thread_id', threads).select('body')).map((row: { body: string }) => row.body));

    expect(await read(ids.adminA)).toEqual([THE_NOTE]);
    expect(await read(ids.portalA1)).toEqual([THE_NOTE]);
    expect(await read(ids.portalA1Second)).toEqual([THE_NOTE]);
    const withoutVisualizar = await w.personWithAllBut('conteudo.visualizar');
    for (const user of [ids.portalA2, ids.portalB, ids.adminB, withoutVisualizar]) expect(await read(user), user).toEqual([]);
  });

  describe('the limit and the shape of the note', () => {
    it.each([
      ['500 characters', 'a'.repeat(500)],
      ['500 characters of two bytes each', 'ã'.repeat(500)],
      ['a single character', '.']
    ])('accepts %s', async (_label, note) => {
      const content = await waiting();
      await approveAs(ids.portalA1, content, note);
      expect(await statusOf(content)).toBe('approved');
      expect((await commentsOf(content)).map((comment) => comment.body)).toEqual([note]);
    });

    it.each([
      ['501 characters', 'a'.repeat(501)],
      ['501 characters of two bytes each', 'ã'.repeat(501)],
      ['an empty text', ''],
      ['only spaces', '   '],
      ['a line break and a byte order mark', '\n﻿'],
      ['only a zero-width space and a no-break space', '​ ']
    ])('refuses %s with A0068, and the content keeps waiting with no conversation', async (_label, note) => {
      const content = await waiting();
      await expect(approveAs(ids.portalA1, content, note)).rejects.toMatchObject({ code: 'A0068' });
      await expectUntouched(content);
    });

    it('judges the note after the door: a person who may not read the content is told it was not found, whatever the note', async () => {
      const content = await waiting();
      await expect(approveAs(ids.portalA2, content, 'a'.repeat(501))).rejects.toMatchObject({ code: 'A0060' });
      await expect(approveAs(ids.portalA2, content, THE_NOTE)).rejects.toMatchObject({ code: 'A0060' });
      await expectUntouched(content);
    });
  });

  describe('all or nothing', () => {
    it('leaves the content waiting and no conversation behind when the comment is refused', async () => {
      const content = await waiting();
      await owner().raw(`
        create function public.a2_refuse_comment() returns trigger language plpgsql as $$ begin raise exception using errcode = 'P0001', message = 'comment refused on purpose'; end $$;
        create trigger a2_refuse_comment before insert on public.client_thread_comments for each row when (new.body = 'recusado') execute function public.a2_refuse_comment();
      `);
      try {
        await expect(approveAs(ids.portalA1, content, 'recusado')).rejects.toMatchObject({ code: 'P0001' });
      } finally {
        await owner().raw('drop trigger a2_refuse_comment on public.client_thread_comments; drop function public.a2_refuse_comment();');
      }
      await expectUntouched(content);
    });

    it('leaves no comment behind when the approval is refused for the revision, and no change of state either', async () => {
      const content = await waiting();
      const stale = await revisionOf(content);
      await w.asUser(ids.productionA, (t) => t('contents').where({ id: content }).update({ caption: 'Outra legenda' }));
      expect(await revisionOf(content)).toBeGreaterThan(stale);

      await expect(approveAs(ids.portalA1, content, THE_NOTE, stale)).rejects.toMatchObject({ code: 'A0063' });
      await expectUntouched(content);
    });

    it('refuses a content in adjustment with A0062, and writes no comment: the only conversation is the one of the request for changes', async () => {
      const content = await waiting();
      await f.requestChanges(ids.portalA1, content);
      const before = await commentsOf(content);

      await expect(approveAs(ids.portalA1, content, THE_NOTE)).rejects.toMatchObject({ code: 'A0062' });
      expect(await statusOf(content)).toBe('adjusting');
      expect(await commentsOf(content)).toEqual(before);
    });

    it('does not find a content in production, which the portal cannot read, and writes nothing', async () => {
      const content = await f.readyContent();
      await expect(approveAs(ids.portalA1, content, THE_NOTE, 1)).rejects.toMatchObject({ code: 'A0060' });
      await expectUntouched(content, 'in_production');
    });
  });

  describe('a content that is already approved', () => {
    it('keeps the first person who approved and the first note, and a second click with another note adds none', async () => {
      const content = await waiting();
      await approveAs(ids.portalA1, content, 'Primeira nota');
      const revision = await revisionOf(content);

      await expect(approveAs(ids.portalA1, content, 'Primeira nota', revision)).resolves.toBeDefined();
      await expect(approveAs(ids.portalA1Second, content, 'Outra nota', revision)).resolves.toBeDefined();

      expect(await statusOf(content)).toBe('approved');
      expect((await commentsOf(content)).map((comment) => [comment.author_user_id, comment.body])).toEqual([[ids.portalA1, 'Primeira nota']]);
    });

    it('does not write the comment of a call that is refused by its note even when the content is already approved', async () => {
      const content = await waiting();
      await approveAs(ids.portalA1, content, null);
      await expect(approveAs(ids.portalA1, content, 'a'.repeat(501))).rejects.toMatchObject({ code: 'A0068' });
      expect(await commentsOf(content)).toEqual([]);
    });
  });

  describe('two people approve at the same moment', () => {
    it('lets the first approve with its note and the second find it approved: one state change, one comment', async () => {
      const content = await waiting();
      const revision = await revisionOf(content);

      const first = await w.openTransactionAs(ids.portalA1);
      const firstPid = await backendPid(first);
      let second: Promise<unknown> | undefined;
      try {
        await first.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, revision, 'Nota da primeira']);
        second = approveAs(ids.portalA1Second, content, 'Nota da segunda', revision).then(() => 'done', (error: unknown) => error);
        await waitForBackendsBlockedBy(owner(), firstPid);
      } finally {
        await first.commit();
      }

      expect(await second).toBe('done');
      expect(await statusOf(content)).toBe('approved');
      expect((await commentsOf(content)).map((comment) => [comment.author_user_id, comment.body])).toEqual([[ids.portalA1, 'Nota da primeira']]);
      expect(await threadsOf(content)).toHaveLength(1);
    });

    it('lets the second find the conversation the first opened, when the agency and the portal open it together', async () => {
      const content = await waiting();
      const opening = await w.openTransactionAs(ids.adminA);
      const openingPid = await backendPid(opening);
      let approving: Promise<unknown> | undefined;
      try {
        await opening.raw(
          "insert into public.client_threads (client_id, content_id, opened_by, opened_side) values (?::uuid, ?::uuid, ?::uuid, 'agency')", [ids.clientA1, content, ids.adminA]
        );
        approving = approveAs(ids.portalA1, content, THE_NOTE).then(() => 'done', (error: unknown) => error);
        await waitForBackendsBlockedBy(owner(), openingPid);
      } finally {
        await opening.commit();
      }

      expect(await approving).toBe('done');
      expect(await threadsOf(content)).toHaveLength(1);
      expect((await commentsOf(content)).map((comment) => comment.body)).toEqual([THE_NOTE]);
    });
  });

  describe('who may approve', () => {
    it('is closed to everyone but an active person of the portal of this client: not found, and nothing written', async () => {
      const content = await waiting();
      const withoutVisualizar = await w.personWithAllBut('conteudo.visualizar');
      const people = [
        ['a person of the portal of another client', ids.portalA2],
        ['a person of the portal of another agency', ids.portalB],
        ['a person whose access to the portal was removed', ids.dualRemoved],
        ['the Admin of the agency, who has no access to the portal', ids.adminA],
        ['the owner of the agency', ids.ownerA],
        ['a collaborator who produced the content', ids.productionA],
        ['the Admin of another agency', ids.adminB],
        ['a person of the agency without permission on the content', withoutVisualizar]
      ] as const;

      for (const [label, user] of people) {
        await expect(approveAs(user, content, THE_NOTE), label).rejects.toMatchObject({ code: 'A0060' });
      }
      await expectUntouched(content);
    });

    it('treats a person who has an access to the portal of another client of the same agency as a stranger to this one', async () => {
      const content = await waiting(ids.clientA1);
      await expect(approveAs(ids.portalA2, content, THE_NOTE)).rejects.toMatchObject({ code: 'A0060' });
      await expectUntouched(content);
    });

    it('lets a collaborator who is also a person of the portal approve as the client, and writes the comment as the client', async () => {
      const content = await waiting();
      await approveAs(ids.dualBare, content, THE_NOTE);
      expect(await commentsOf(content)).toEqual([expect.objectContaining({ author_user_id: ids.dualBare, author_side: 'client' })]);
    });

    it('is closed to a person of the portal of a client that is archived: not found, and nothing written', async () => {
      const client = await f.freshClient([ids.portalA1]);
      const content = await f.readyContent(client);
      await f.submit(ids.productionA, content, null, 'Antes de arquivar');
      await owner()('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() });

      await expect(approveAs(ids.portalA1, content, THE_NOTE)).rejects.toMatchObject({ code: 'A0060' });
      expect(await commentsOf(content)).toEqual([]);
      expect(await threadsOf(content)).toEqual([]);
    });

    // The person still passes the door (the archive is not committed), so only the lock on the client can tell: it waits for the archive and reads the client after it.
    it('finds the client archived by an archive that was in course when it asked: not found, and nothing written', async () => {
      const client = await f.freshClient([ids.portalA1]);
      const content = await f.readyContent(client);
      await f.submit(ids.productionA, content, null, 'Durante o arquivamento');

      const archiving = await owner().transaction();
      const archivingPid = await backendPid(archiving);
      let approving: Promise<unknown> | undefined;
      try {
        await archiving('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() });
        approving = approveAs(ids.portalA1, content, THE_NOTE).then(() => 'done', (error: unknown) => error);
        await waitForBackendsBlockedBy(owner(), archivingPid);
      } finally {
        await archiving.commit();
      }

      expect(await approving).toMatchObject({ code: 'A0060' });
      expect(await statusOf(content)).toBe('awaiting_approval');
      expect(await commentsOf(content)).toEqual([]);
      expect(await threadsOf(content)).toEqual([]);
    });

    it('is refused for an agency whose trial has ended (A0090), and the content keeps waiting with no conversation', async () => {
      const content = await waiting();
      const before = await owner()('agencies').where({ id: ids.agencyA }).first('status', 'plan', 'trial_ends_at', 'trial_owner_email_key');
      await owner()('agencies').where({ id: ids.agencyA }).update({
        plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
      });
      try {
        await expect(approveAs(ids.portalA1, content, THE_NOTE)).rejects.toMatchObject({ code: 'A0090' });
      } finally {
        await owner()('agencies').where({ id: ids.agencyA }).update(before);
      }
      await expectUntouched(content);
    });
  });

  describe('the functions', () => {
    const privileges = async (signature: string) =>
      (await owner().raw<{ rows: Array<{ app: boolean; public_acl: boolean; config: string[] | null; definer: boolean }> }>(
        `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
                coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl, p.proconfig as config, p.prosecdef as definer
         from pg_proc p where p.oid = ?::regprocedure`, [signature]
      )).rows[0];

    it.each(['app_private.approve_content(uuid, integer)', 'app_private.approve_content(uuid, integer, text)'])(
      '%s is open to the application role and closed to PUBLIC, security definer with a fixed search_path',
      async (signature) => {
        expect(await privileges(signature)).toEqual({ app: true, public_acl: false, config: ['search_path=""'], definer: true });
      }
    );

    it('has one copy of the rule of the approval: the call without a note goes through the one with a note', async () => {
      const source = (await owner().raw<{ rows: Array<{ definition: string }> }>(
        "select pg_get_functiondef('app_private.approve_content(uuid, integer)'::regprocedure) as definition"
      )).rows[0]!.definition;
      expect(source).toContain('app_private.approve_content(p_content_id, p_revision, null::text)');
      expect(source).not.toMatch(/update\s+public\.contents/);
    });

    it('judges the note with the same function as the note of the agency, which is the one rule of the limit', async () => {
      const source = (await owner().raw<{ rows: Array<{ definition: string }> }>(
        "select pg_get_functiondef('app_private.approve_content(uuid, integer, text)'::regprocedure) as definition"
      )).rows[0]!.definition;
      expect(source).toContain('app_private.approval_note_is_valid(p_note)');
    });
  });
});
