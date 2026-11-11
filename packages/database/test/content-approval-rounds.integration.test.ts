import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, waitForBackendsBlockedBy, type DatabaseClient } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createContentWorld } from './support/content-world.js';

// Scope telas-melhorias, decision 1 of 2026-11-10: the approval round (one row per content sent for approval), the send in a batch and
// the portal reading the round. Every attack runs as `ageniza_app` with the actor of a real person; the owner prepares the world and
// reads what was left. RLS filters silently, so a read is checked by the rows it returns and a write by the state left in the tables.
const w = createContentWorld('approval-rounds');
const { ids } = w;
const f = createApprovalFixtures(w);
const { applicationUrl } = resolveIntegrationDatabaseUrls();
let app: DatabaseClient;

const owner = (): Knex => w.getOwner().knex;

beforeAll(async () => {
  await w.setup();
  await f.waitForQuietClock();
  app = createLocalTestDatabaseClient(applicationUrl);
}, 300_000);

afterAll(async () => {
  try {
    await f.cleanUp();
  } finally {
    await app.close();
    await w.teardown();
  }
});

const submitAs = f.submit;
const batchAs = f.submitBatch;
const contentStatus = async (id: string): Promise<string> => (await w.contentRow(id)).status as string;
const queueItems = (contentIds: readonly string[]): Promise<number> =>
  owner()('notification_queue').whereIn('content_id', [...contentIds]).count<Array<{ count: string }>>('* as count').then((rows) => Number(rows[0]!.count));
const roundCount = (contentIds: readonly string[]): Promise<number> =>
  owner()('content_approval_rounds').whereIn('content_id', [...contentIds]).count<Array<{ count: string }>>('* as count').then((rows) => Number(rows[0]!.count));

/** Nothing of a refused send is left: the contents keep their state, and there is no round and no queued e-mail. */
const expectUntouched = async (contentIds: readonly string[], status = 'in_production'): Promise<void> => {
  for (const id of contentIds) expect(await contentStatus(id)).toBe(status);
  expect(await roundCount(contentIds)).toBe(0);
  expect(await queueItems(contentIds)).toBe(0);
};

const THE_ROUNDS_TABLE = 'content_approval_rounds';
// The active accesses of client A1 (portalA1, portalA1Second, dualBare, dualFull, crossDual): one queued e-mail each.
const PEOPLE_OF_A1 = 5;

/** A content that cannot be sent: it has no media. */
const withoutMedia = async (): Promise<string> => {
  const id = randomUUID();
  await owner()('contents').insert({
    id, client_id: ids.clientA1, title: 'Sem mídia', platform: 'instagram', format: 'reels', publish_on: '2026-12-01',
    folder_id: await w.folderOf(ids.clientA1), owner_user_id: ids.productionA
  });
  return id;
};

// ---- the table is closed to writes ---------------------------------------------------------------------------------------

describe('the table of rounds is closed to the application role', () => {
  it('has RLS enabled and forced, and grants ageniza_app a SELECT and nothing else, on the table or on a column', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.content_approval_rounds'::regclass"
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await w.tablePrivileges(THE_ROUNDS_TABLE)).toEqual({ can_select: true, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
    expect(await w.columnsWithPrivilege(THE_ROUNDS_TABLE, 'insert')).toEqual([]);
    expect(await w.columnsWithPrivilege(THE_ROUNDS_TABLE, 'update')).toEqual([]);
    const references = await owner().raw<{ rows: Array<{ has: boolean }> }>(
      "select has_table_privilege('ageniza_app', 'public.content_approval_rounds', 'references') as has"
    );
    expect(references.rows[0]!.has).toBe(false);
  });

  it('refuses an INSERT, an UPDATE and a DELETE by an Admin who reads the row, and leaves the row as it was', async () => {
    const content = await f.readyContent();
    await submitAs(ids.adminA, content, await f.day(5), 'Antes de sexta');
    const [before] = await f.roundsOf(content);

    await expect(w.asUser(ids.adminA, (t) => t(THE_ROUNDS_TABLE).where({ content_id: content }).select('*'))).resolves.toHaveLength(1);
    await expect(w.asUser(ids.adminA, (t) => t(THE_ROUNDS_TABLE).insert({
      batch_id: randomUUID(), client_id: ids.clientA1, content_id: content, sequence: 2, sent_by: ids.adminA
    }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t(THE_ROUNDS_TABLE).where({ content_id: content }).update({ due_on: '2030-01-01' }))).rejects.toMatchObject({ code: '42501' });
    await expect(w.asUser(ids.adminA, (t) => t(THE_ROUNDS_TABLE).where({ content_id: content }).delete())).rejects.toMatchObject({ code: '42501' });

    expect(await f.roundsOf(content)).toEqual([before]);
  });

  // The grant and a permissive policy are taken only inside a rolled-back transaction: what is left to refuse is the trigger.
  const insertWithGrant = async (clientId: string, contentId: string, actor?: string): Promise<unknown> =>
    owner().transaction(async (t) => {
      await t.raw('grant insert on public.content_approval_rounds to ageniza_app');
      await t.raw('grant execute on function app_private.approval_note_is_valid(text) to ageniza_app');
      await t.raw('create policy temporary_insert on public.content_approval_rounds for insert to ageniza_app with check (true)');
      await t.raw('set local session authorization ageniza_app');
      if (actor !== undefined) await t.raw('select app_private.bind_actor(?::uuid)', [actor]);
      await t(THE_ROUNDS_TABLE).insert({ batch_id: randomUUID(), client_id: clientId, content_id: contentId, sequence: 1, sent_by: ids.adminA });
      throw new Error('rolled back on purpose');
    }).then(() => 'inserted', (error: unknown) => error);

  it('refuses an INSERT for a read-only agency with A0090, which is the trigger and not the policy, and takes it back once the agency pays', async () => {
    const client = await f.freshClient();
    const content = await f.readyContent(client);
    const before = await owner()('agencies').where({ id: ids.agencyA }).first('status', 'plan', 'trial_ends_at', 'trial_owner_email_key');
    await owner()('agencies').where({ id: ids.agencyA }).update({
      plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
    });
    try {
      expect(await insertWithGrant(client, content, ids.adminA)).toMatchObject({ code: 'A0090' });
    } finally {
      await owner()('agencies').where({ id: ids.agencyA }).update(before);
    }
    expect(await insertWithGrant(client, content, ids.adminA)).toMatchObject({ message: 'rolled back on purpose' });
    expect(await roundCount([content])).toBe(0);
  });

  describe('the constraints of a row', () => {
    const insertAsOwner = async (row: Record<string, unknown>): Promise<unknown> => {
      const transaction = await owner().transaction();
      try {
        await transaction(THE_ROUNDS_TABLE).insert(row);
        return 'inserted';
      } catch (error) {
        return error;
      } finally {
        await transaction.rollback();
      }
    };
    const row = (content: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
      ({ batch_id: randomUUID(), client_id: ids.clientA1, content_id: content, sequence: 1, sent_by: ids.adminA, ...extra });

    it('refuses a sequence below 1, a second round with the number of another, and a round whose client is not the content\'s', async () => {
      const content = await f.readyContent();
      await submitAs(ids.adminA, content);

      expect(await insertAsOwner(row(content, { sequence: 2 }))).toBe('inserted');
      expect(await insertAsOwner(row(content, { sequence: 0 }))).toMatchObject({ code: '23514', constraint: 'content_approval_rounds_sequence_check' });
      expect(await insertAsOwner(row(content, { sequence: 1 }))).toMatchObject({ code: '23505', constraint: 'content_approval_rounds_content_sequence_key' });
      expect(await insertAsOwner(row(content, { sequence: 2, client_id: ids.clientA2 }))).toMatchObject({ code: '23503', constraint: 'content_approval_rounds_content_fk' });
    });

    it('goes with its content: deleting the content deletes its rounds and nothing else', async () => {
      const kept = await f.readyContent();
      const gone = await w.seedContent(ids.clientA1);
      await owner()(THE_ROUNDS_TABLE).insert([row(kept, { sequence: 1 }), row(gone, { sequence: 1 }), row(gone, { sequence: 2 })]);

      await owner()('contents').where({ id: gone }).delete();

      expect(await roundCount([gone])).toBe(0);
      expect(await roundCount([kept])).toBe(1);
    });
  });

  it('takes the lock of the active client on every INSERT: a round for an archived client is refused with A0020', async () => {
    const archived = await f.freshClient();
    const active = await f.freshClient();
    const contentOfArchived = await f.readyContent(archived);
    const contentOfActive = await f.readyContent(active);
    await w.archiveClient(archived);

    expect(await insertWithGrant(archived, contentOfArchived)).toMatchObject({ code: 'A0020' });
    expect(await insertWithGrant(active, contentOfActive)).toMatchObject({ message: 'rolled back on purpose' });
    expect(await roundCount([contentOfArchived, contentOfActive])).toBe(0);
  });

  it('makes the lock of the client the first AFTER INSERT trigger of the table, and refuses a write of a read-only agency before anything else', async () => {
    const triggers = await owner().raw<{ rows: Array<{ tgname: string; fn: string; is_before: boolean }> }>(
      `select t.tgname, p.proname as fn, (t.tgtype & 2) = 2 as is_before
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.content_approval_rounds'::regclass and not t.tgisinternal and t.tgenabled = 'O'
       order by t.tgname collate "C"`
    );
    expect(triggers.rows).toEqual([
      { tgname: '00_content_approval_rounds_agency_accepts_writes', fn: 'refuse_write_to_read_only_agency', is_before: true },
      { tgname: '0_content_approval_rounds_lock_active_client', fn: 'lock_active_client_of_child', is_before: false }
    ]);
    const definition = await f.sql('select pg_get_triggerdef(oid) as value from pg_trigger where tgname = ?', ['00_content_approval_rounds_agency_accepts_writes']);
    expect(definition).toContain("refuse_write_to_read_only_agency('client_id')");
    expect(definition).toMatch(/BEFORE INSERT OR DELETE OR UPDATE/);
  });

  it('opens to the application role the two functions of the send, and keeps the rule of sending and the validation internal', async () => {
    const privileges = async (signature: string) =>
      (await owner().raw<{ rows: Array<{ app: boolean; public_acl: boolean; config: string[] | null; definer: boolean }> }>(
        `select has_function_privilege('ageniza_app', p.oid, 'execute') as app,
                coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_acl, p.proconfig as config, p.prosecdef as definer
         from pg_proc p where p.oid = ?::regprocedure`, [signature]
      )).rows[0];
    for (const signature of [
      'app_private.submit_content(uuid, timestamptz, text)',
      'app_private.submit_contents(uuid[], timestamptz, text)',
      'app_private.portal_contents(uuid, date, date, text[], uuid)',
      'app_private.portal_approval_contents(text)'
    ]) {
      expect(await privileges(signature), signature).toEqual({ app: true, public_acl: false, config: ['search_path=""'], definer: true });
    }
    // The rule of sending runs as its owner (it writes a table the application role cannot write); the checks are read-only helpers.
    expect(await privileges('app_private.send_content_for_approval(public.contents, uuid, timestamptz, text)')).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: true });
    for (const signature of ['app_private.check_approval_round_deadline(timestamptz, text, timestamptz)', 'app_private.approval_note_is_valid(text)']) {
      expect(await privileges(signature), signature).toEqual({ app: false, public_acl: false, config: ['search_path=""'], definer: false });
    }
    // The old signatures are gone: one function by each name, so the API calls the same one with or without a deadline.
    for (const name of ['submit_content', 'submit_contents', 'send_content_for_approval']) {
      expect(await f.sql(`select count(*)::text as value from pg_proc where pronamespace = 'app_private'::regnamespace and proname = '${name}'`), name).toBe('1');
    }
  });
});

// ---- who reads a round ---------------------------------------------------------------------------------------------------

describe('who reads the rounds directly (the agency side, as contents)', () => {
  it('lets the people who read Conteúdo see the row, and nobody else: not an operator without visualizar, not a person of the portal, not another agency', async () => {
    const content = await f.readyContent();
    await submitAs(ids.adminA, content, null, 'Recado');
    const visualizar = await w.personWith('conteudo.visualizar');
    const operarOnly = await w.personWith('conteudo.operar');
    const rowsFor = async (user: string): Promise<number> =>
      (await w.asUser(user, (t) => t(THE_ROUNDS_TABLE).where({ content_id: content }).select('id'))).length;

    expect(await rowsFor(ids.adminA)).toBe(1);
    expect(await rowsFor(visualizar)).toBe(1);
    expect(await rowsFor(ids.ownerA)).toBe(1);
    expect(await rowsFor(operarOnly)).toBe(0);
    // dualBare holds a link to this client and a role of the agency without any conteudo.*; crossDual has a link here and is the Admin of another agency.
    expect(await rowsFor(ids.dualBare)).toBe(0);
    expect(await rowsFor(ids.crossDual)).toBe(0);
    expect(await rowsFor(ids.portalA1)).toBe(0);
    expect(await rowsFor(ids.portalA1Second)).toBe(0);
    expect(await rowsFor(ids.adminB)).toBe(0);
    expect(await rowsFor(ids.adminSuspended)).toBe(0);
  });

  it('has one row of the Admin of the agency that owns the client, and no row of a client of another agency', async () => {
    const content = await f.readyContent(ids.clientA1);
    await submitAs(ids.adminA, content);
    const other = await w.getOwner().knex('contents').where({ client_id: ids.clientB }).first('id');
    expect(other).toBeUndefined();
    expect(await w.asUser(ids.adminB, (t) => t(THE_ROUNDS_TABLE).select('id'))).toEqual([]);
  });
});

// ---- the individual send -------------------------------------------------------------------------------------------------

describe('submit_content opens a round', () => {
  it('opens round 1 of a batch of one, with the actor and the clock of the transaction, and no deadline or note when the call names none', async () => {
    const content = await f.readyContent();
    const before = await f.sql('select now()::text as value');
    await w.asUser(ids.productionA, (t) => t.raw('select app_private.submit_content(?::uuid)', [content]));

    expect(await contentStatus(content)).toBe('awaiting_approval');
    const [round, ...rest] = await f.roundsOf(content);
    expect(rest).toEqual([]);
    expect(round).toMatchObject({
      client_id: ids.clientA1, content_id: content, sequence: 1, due_on: null, note: null, sent_by: ids.productionA,
      reminded_due_soon_at: null, reminded_overdue_at: null
    });
    expect(typeof round!.batch_id).toBe('string');
    expect((round!.sent_at as Date).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() - 1000);
    expect((round!.sent_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('keeps the deadline and the note the person gave, and the person who sent is the actor whoever the content belongs to', async () => {
    const content = await f.readyContent();
    const dueOn = await f.day(3);
    await submitAs(ids.managerA, content, dueOn, 'Pode aprovar até quinta?');

    const [round] = await f.roundsOf(content);
    expect(round).toMatchObject({ sent_by: ids.managerA, note: 'Pode aprovar até quinta?' });
    expect(round).toMatchObject({ due_on: dueOn });
  });

  describe('for a content that already waits', () => {
    const dayOrNull = (offset: number | null): Promise<string | null> => (offset === null ? Promise.resolve(null) : f.day(offset));
    const waitingWith = async (dueOffset: number | null, note: string | null): Promise<{ content: string; first: Record<string, unknown> }> => {
      const content = await f.readyContent();
      await submitAs(ids.productionA, content, await dayOrNull(dueOffset), note);
      return { content, first: (await f.roundsOf(content))[0]! };
    };
    const expectSameRound = async (content: string, ...rounds: Array<Record<string, unknown>>): Promise<void> => {
      expect(await f.roundsOf(content)).toEqual(rounds);
      expect(await contentStatus(content)).toBe('awaiting_approval');
      expect(await queueItems([content])).toBe(PEOPLE_OF_A1);
    };

    it.each([
      ['the same deadline and the same note', 2, 'Primeiro'],
      ['neither a deadline nor a note (the `{}` body of today)', null, null],
      ['a deadline and no note', 2, null],
      ['a note and no deadline', null, 'Primeiro']
    ])('does nothing when the call repeats the deadline and the note of its round: %s', async (_label, dueOffset, note) => {
      const { content, first } = await waitingWith(dueOffset, note);

      await expect(submitAs(ids.productionA, content, await dayOrNull(dueOffset), note)).resolves.toBeDefined();
      await expect(submitAs(ids.managerA, content, await dayOrNull(dueOffset), note)).resolves.toBeDefined();

      await expectSameRound(content, first);
    });

    it.each([
      ['another deadline', 2, 'Primeiro', 9, 'Primeiro'],
      ['another note', 2, 'Primeiro', 2, 'Segundo'],
      ['a deadline where the round has none', null, 'Primeiro', 2, 'Primeiro'],
      ['a note where the round has none', 2, null, 2, 'Segundo'],
      ['no deadline where the round has one', 2, 'Primeiro', null, 'Primeiro'],
      ['no note where the round has one', 2, 'Primeiro', 2, null],
      ['a deadline and a note where the round has neither', null, null, 3, 'Urgente']
    ])('refuses with A0062 a call that asks for %s, which the batch refuses too, and leaves the round as it was', async (_label, dueOffset, note, askedOffset, askedNote) => {
      const { content, first } = await waitingWith(dueOffset, note);

      await expect(submitAs(ids.productionA, content, await dayOrNull(askedOffset), askedNote)).rejects.toMatchObject({ code: 'A0062', message: expect.stringContaining('already waits') });
      await expect(batchAs(ids.productionA, [content], await dayOrNull(askedOffset), askedNote)).rejects.toMatchObject({ code: 'A0062' });

      await expectSameRound(content, first);
    });

    it('compares the call with the LATEST round: the repeat of the second round is nothing, and the repeat of the first is refused', async () => {
      const { content, first } = await waitingWith(2, 'Primeira');
      await f.requestChanges(ids.portalA1, content);
      await submitAs(ids.productionA, content, await f.day(8), 'Segunda');
      const [, second] = await f.roundsOf(content);

      await expect(submitAs(ids.productionA, content, await f.day(8), 'Segunda')).resolves.toBeDefined();
      await expect(submitAs(ids.productionA, content, await f.day(2), 'Primeira')).rejects.toMatchObject({ code: 'A0062' });

      await expectSameRound(content, first, second!);
    });

    it('treats one that waited before the rounds existed as sent with neither: the call with neither is nothing, any other is refused, and no round is opened', async () => {
      const content = await f.readyContent(ids.clientA1, 'awaiting_approval');
      const queued = await queueItems([content]);

      await expect(submitAs(ids.productionA, content)).resolves.toBeDefined();
      await expect(submitAs(ids.productionA, content, await f.day(2))).rejects.toMatchObject({ code: 'A0062' });
      await expect(submitAs(ids.productionA, content, null, 'Recado')).rejects.toMatchObject({ code: 'A0062' });

      expect(await roundCount([content])).toBe(0);
      expect(await queueItems([content])).toBe(queued);
    });
  });

  it('opens a NEW round when the content is sent again after the adjustment, and keeps the old one as it was', async () => {
    const content = await f.readyContent();
    await submitAs(ids.productionA, content, await f.day(2), 'Primeira');
    const [first] = await f.roundsOf(content);
    await f.requestChanges(ids.portalA1, content);
    expect(await contentStatus(content)).toBe('adjusting');

    await submitAs(ids.productionA, content, await f.day(8), 'Segunda');

    const rounds = await f.roundsOf(content);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toEqual(first);
    expect(rounds[1]).toMatchObject({ sequence: 2, note: 'Segunda' });
    expect(rounds[1]!.id).not.toBe(first!.id);
    expect(rounds[1]!.batch_id).not.toBe(first!.batch_id);
  });

  it('numbers the rounds of a content one by one, also across a cancellation that brings it back to production', async () => {
    const content = await f.readyContent();
    await submitAs(ids.productionA, content);
    await w.asUser(ids.adminA, (t) => t.raw('select app_private.cancel_content(?::uuid)', [content]));
    await owner()('contents').where({ id: content }).update({ status: 'in_production', cancelled_at: null });
    await submitAs(ids.productionA, content);

    expect((await f.roundsOf(content)).map((round) => round.sequence)).toEqual([1, 2]);
  });

  it('stays in the SAME round when the approval is taken back, when the caption of an approved content changes and when the database returns it to waiting', async () => {
    const content = await f.readyContent();
    await submitAs(ids.productionA, content, await f.day(4), 'Uma só rodada');
    const [round] = await f.roundsOf(content);
    const approve = async (): Promise<void> => {
      const revision = (await w.contentRow(content)).revision as number;
      await w.asUser(ids.portalA1, (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer)', [content, revision]));
    };

    await approve();
    expect(await contentStatus(content)).toBe('approved');
    const withdrawnAt = (await w.contentRow(content)).revision as number;
    await w.asUser(ids.portalA1, (t) => t.raw('select app_private.withdraw_content_approval(?::uuid, ?::integer)', [content, withdrawnAt]));
    expect(await contentStatus(content)).toBe('awaiting_approval');
    expect(await f.roundsOf(content)).toEqual([round]);

    await approve();
    await w.asUser(ids.productionA, (t) => t('contents').where({ id: content }).update({ caption: 'Outra legenda' }));
    expect(await contentStatus(content)).toBe('awaiting_approval');
    expect(await f.roundsOf(content)).toEqual([round]);
  });

  it.each([
    ['A0065', 'the media is not complete', withoutMedia],
    ['A0066', 'a subtask is not approved', async () => {
      const content = await f.readyContent();
      await w.seedTask(content, { status: 'pending' });
      return content;
    }],
    ['A0062', 'the content is not in production or adjustment', async () => f.readyContent(ids.clientA1, 'approved')]
  ])('refuses with %s when %s, and opens no round', async (code, _why, prepare) => {
    const content = await prepare();
    await expect(submitAs(ids.productionA, content)).rejects.toMatchObject({ code });
    expect(await roundCount([content])).toBe(0);
  });

  it('refuses a content whose cover was removed with A0065, and opens no round', async () => {
    const content = await f.readyContent();
    const folder = await w.folderOf(ids.clientA1);
    const cover = await w.seedAsset(ids.clientA1, folder);
    await owner()('contents').where({ id: content }).update({ cover_asset_id: cover });
    await owner()('media_assets').where({ id: cover }).update({ removed_at: new Date() });

    await expect(submitAs(ids.productionA, content)).rejects.toMatchObject({ code: 'A0065', message: expect.stringContaining('cover') });
    expect(await roundCount([content])).toBe(0);
  });

  it('stays closed to a person who may not operate or may not read: not found, and no round', async () => {
    const content = await f.readyContent();
    const withoutOperar = await w.personWithAllBut('conteudo.operar');
    const withoutVisualizar = await w.personWithAllBut('conteudo.visualizar');

    for (const user of [withoutOperar, withoutVisualizar, ids.dualBare, ids.crossDual, ids.portalA1, ids.adminB]) {
      await expect(submitAs(user, content)).rejects.toMatchObject({ code: 'A0060' });
    }
    expect(await roundCount([content])).toBe(0);
    expect(await contentStatus(content)).toBe('in_production');
  });
});

// ---- the deadline and the note, at the two entrances ---------------------------------------------------------------------

const ENTRANCES = [
  ['submit_content', async (content: string, dueOn: string | null, note: string | null) => submitAs(ids.productionA, content, dueOn, note)],
  ['submit_contents', async (content: string, dueOn: string | null, note: string | null) => batchAs(ids.productionA, [content], dueOn, note)]
] as const;

// The deadline is an instant: after now and up to 90 days ahead (2160 hours). The entrances read "now" at the instant of the transaction,
// which a test cannot fix, so the edges of the window are tested on the check (below) and these tests keep clear of them.
describe.each(ENTRANCES)('the deadline of %s', (_name, send) => {
  it.each([
    ['a minute ago', -1 / 60, false],
    ['in a minute', 1 / 60, true],
    ['in 48 hours, the standard of the screen', 48, true],
    ['in 89 days', 89 * 24, true],
    ['in 91 days', 91 * 24, false]
  ])('%s is accepted: %s', async (_label, hours, accepted) => {
    const content = await f.readyContent();
    const dueAt = await f.sql<string>('select (pg_catalog.now() + (?::double precision * interval \'1 hour\'))::text as value', [hours]);

    if (accepted) {
      await send(content, dueAt, null);
      const [round] = await f.roundsOf(content);
      expect((round!.due_at as Date).getTime()).toBe(new Date(dueAt).getTime());
      expect(round!.due_on).toBe(await f.sql<string>('select app_private.sao_paulo_date(?::timestamptz)::text as value', [dueAt]));
    } else {
      await expect(send(content, dueAt, null)).rejects.toMatchObject({ code: 'A0120' });
      await expectUntouched([content]);
    }
  });

  it('keeps the hour the person gave, to the second, and the day of São Paulo that hour falls on', async () => {
    const content = await f.readyContent();
    const tomorrow = await f.day(1);
    await send(content, `${tomorrow}T02:30:15-03:00`, null);
    expect((await f.roundsOf(content))[0]).toMatchObject({ due_on: tomorrow, due_at: new Date(`${tomorrow}T05:30:15Z`) });
  });

  it('turns a day into the end of that day in São Paulo: 23:59', async () => {
    const content = await f.readyContent();
    const day = await f.day(3);
    await send(content, day, null);
    const [round] = await f.roundsOf(content);
    expect(round).toMatchObject({ due_on: day });
    expect(await f.sql<string>("select to_char(due_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') as value from content_approval_rounds where id = ?", [round!.id])).toBe(`${day} 23:59:00`);
  });

  it('accepts no deadline at all', async () => {
    const content = await f.readyContent();
    await send(content, null, null);
    expect((await f.roundsOf(content))[0]).toMatchObject({ due_on: null, due_at: null });
  });

  it('is checked for a content that already waits too, so the same call fails the same way every time', async () => {
    const content = await f.readyContent();
    await send(content, null, null);
    await expect(send(content, await f.at(-1), null)).rejects.toMatchObject({ code: 'A0120' });
  });
});

describe('the window of the deadline, at an instant the check is given', () => {
  const NOW = '2026-11-10T15:00:00Z';
  const checkAt = (dueAt: string | null, instant: string | null, note: string | null = null): Promise<unknown> =>
    owner().raw('select app_private.check_approval_round_deadline(?::timestamptz, ?::text, ?::timestamptz)', [dueAt, note, instant]);
  const shifted = (instant: string, seconds: number): string => new Date(new Date(instant).getTime() + seconds * 1000).toISOString();
  const NINETY_DAYS = 90 * 24 * 3600;

  it.each([
    ['one second after now', 1, true],
    ['one minute after now', 60, true],
    ['48 hours after now', 48 * 3600, true],
    ['exactly 90 days after now, the last instant', NINETY_DAYS, true],
    ['one second past 90 days', NINETY_DAYS + 1, false],
    ['exactly now', 0, false],
    ['one second ago', -1, false],
    ['a day ago', -86_400, false]
  ])('%s is %s', async (_label, seconds, accepted) => {
    const outcome = checkAt(shifted(NOW, seconds), NOW);
    if (accepted) await expect(outcome).resolves.toBeDefined();
    else await expect(outcome).rejects.toMatchObject({ code: 'A0120' });
  });

  // São Paulo is three hours behind UTC all year: the window is made of instants, so the edges are the same whatever the day it is there.
  it.each([
    ['12:00', '2026-11-10T15:00:00Z'],
    ['20:59:59', '2026-11-10T23:59:59Z'],
    ['21:00:00, the UTC date turns', '2026-11-11T00:00:00Z'],
    ['23:59:59, the last second of the day', '2026-11-11T02:59:59Z'],
    ['00:00:00, the first second of the next day', '2026-11-11T03:00:00Z']
  ])('at %s of São Paulo, the edges are one second after and 90 days after (and one second past that is refused)', async (_label, instant) => {
    await expect(checkAt(shifted(instant, 1), instant)).resolves.toBeDefined();
    await expect(checkAt(shifted(instant, NINETY_DAYS), instant)).resolves.toBeDefined();
    await expect(checkAt(shifted(instant, NINETY_DAYS + 1), instant)).rejects.toMatchObject({ code: 'A0120' });
    await expect(checkAt(instant, instant)).rejects.toMatchObject({ code: 'A0120' });
    await expect(checkAt(null, instant)).resolves.toBeDefined();
  });

  it('does not depend on the time zone of the session: 90 days is 2160 hours', async () => {
    for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tokyo']) {
      await owner().transaction(async (transaction) => {
        await transaction.raw(`set local time zone '${zone}'`);
        await expect(transaction.raw('select app_private.check_approval_round_deadline(?::timestamptz, null, ?::timestamptz)', [shifted(NOW, NINETY_DAYS), NOW]), zone).resolves.toBeDefined();
        await expect(transaction.raw('select app_private.check_approval_round_deadline(?::timestamptz, null, ?::timestamptz)', [shifted(NOW, NINETY_DAYS + 1), NOW]).catch((error: { code: string }) => error.code), zone).resolves.toBe('A0120');
      });
    }
  });

  it('refuses a missing instant, which would turn the range into a comparison with null that refuses nothing', async () => {
    await expect(checkAt('2031-01-01T00:00:00Z', null)).rejects.toMatchObject({ code: '22023' });
  });

  it('judges the note with the deadline, once the deadline is in the window', async () => {
    await expect(checkAt(shifted(NOW, 3600), NOW, 'a'.repeat(501))).rejects.toMatchObject({ code: 'A0068' });
    await expect(checkAt(shifted(NOW, 3600), NOW, ' ​ ')).rejects.toMatchObject({ code: 'A0068' });
    await expect(checkAt(shifted(NOW, 3600), NOW, 'a'.repeat(500))).resolves.toBeDefined();
    await expect(checkAt(shifted(NOW, -3600), NOW, 'a'.repeat(501))).rejects.toMatchObject({ code: 'A0120' });
  });

  it('is asked by both entrances at the instant of the transaction: the text of each says so', async () => {
    for (const name of ['submit_content', 'submit_contents']) {
      const source = await f.sql<string>(`select pg_get_functiondef(p.oid) as value from pg_proc p where p.pronamespace = 'app_private'::regnamespace and p.proname = ?`, [name]);
      expect(source, name).toContain('check_approval_round_deadline(p_due_at, p_note, pg_catalog.now())');
    }
  });
});

describe.each(ENTRANCES)('the note of %s', (_name, send) => {
  it.each([
    ['500 characters', 'a'.repeat(500), true],
    ['500 characters of two bytes each', 'ã'.repeat(500), true],
    ['501 characters', 'a'.repeat(501), false],
    ['501 characters of two bytes each', 'ã'.repeat(501), false]
  ])('%s is %s', async (_label, note, accepted) => {
    const content = await f.readyContent();

    if (accepted) {
      await send(content, null, note);
      expect((await f.roundsOf(content))[0]).toMatchObject({ note });
    } else {
      await expect(send(content, null, note)).rejects.toMatchObject({ code: 'A0068' });
      await expectUntouched([content]);
    }
  });

  it.each([
    ['only spaces', '   '],
    ['an empty text', ''],
    ['only a zero-width space and a no-break space', '​ '],
    ['a line break and a byte order mark', '\n﻿']
  ])('refuses a note of %s, as it refuses a blank comment', async (_label, note) => {
    const content = await f.readyContent();
    await expect(send(content, null, note)).rejects.toMatchObject({ code: 'A0068' });
    await expectUntouched([content]);
  });

  // Both ends of every range of the rule, and each single character: a mutation of a boundary survives the cases of the middle.
  const hex = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  it.each([
    0x0001, 0x0008, 0x000b, 0x000c, 0x000e, 0x001f, 0x007f, 0x00a0, 0x00ad, 0x1680, 0x180e, 0x2000, 0x200f, 0x2028, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff
  ].map((codePoint) => [hex(codePoint), String.fromCodePoint(codePoint)] as const))(
    'refuses a note made only of the invisible character %s, alone and repeated',
    async (_label, character) => {
      const content = await f.readyContent();
      for (const note of [character, character.repeat(3)]) {
        await expect(send(content, null, note), hex(note.codePointAt(0)!)).rejects.toMatchObject({ code: 'A0068' });
      }
      await expectUntouched([content]);
    }
  );

  it.each([['a letter', 'a'], ['a full stop', '.'], ['a hyphen (U+2010)', '‐'], ['an inverted exclamation mark (U+00A1)', '¡'], ['a letter between invisible characters', '​O​']])(
    'accepts a note that has something to read: %s',
    async (_label, note) => {
      const content = await f.readyContent();
      await send(content, null, note);
      expect((await f.roundsOf(content))[0]).toMatchObject({ note });
    }
  );

  it('keeps the text as written, with its line breaks and its edges', async () => {
    const content = await f.readyContent();
    const note = '  Oi!\nPode ver até sexta?  ';
    await send(content, null, note);
    expect((await f.roundsOf(content))[0]).toMatchObject({ note });
  });
});

describe('the note is also a CHECK of the table', () => {
  it.each([
    ['501 characters', 'a'.repeat(501)],
    ['only spaces', '  '],
    ['an invisible character', '​']
  ])('refuses %s even for the owner of the database', async (_label, note) => {
    const content = await f.readyContent();
    await expect(owner()(THE_ROUNDS_TABLE).insert({
      batch_id: randomUUID(), client_id: ids.clientA1, content_id: content, sequence: 1, note, sent_by: ids.adminA
    })).rejects.toMatchObject({ code: '23514', constraint: 'content_approval_rounds_note_check' });
  });

  it('refuses a round whose client is not the client of its content', async () => {
    const content = await f.readyContent();
    await expect(owner()(THE_ROUNDS_TABLE).insert({
      batch_id: randomUUID(), client_id: ids.clientA2, content_id: content, sequence: 1, sent_by: ids.adminA
    })).rejects.toMatchObject({ code: '23503' });
  });

  it('numbers a content\'s rounds from 1 and never twice', async () => {
    const content = await f.readyContent();
    const row = { batch_id: randomUUID(), client_id: ids.clientA1, content_id: content, sent_by: ids.adminA };
    await expect(owner()(THE_ROUNDS_TABLE).insert({ ...row, sequence: 0 })).rejects.toMatchObject({ code: '23514' });
    await owner()(THE_ROUNDS_TABLE).insert({ ...row, sequence: 1 });
    await expect(owner()(THE_ROUNDS_TABLE).insert({ ...row, sequence: 1 })).rejects.toMatchObject({ code: '23505' });
  });

  it('goes with the content when the owner of the database removes it', async () => {
    const content = await f.readyContent();
    await submitAs(ids.productionA, content);
    await owner()('notification_queue').where({ content_id: content }).delete();
    await owner()('content_media').where({ content_id: content }).delete();
    await owner()('contents').where({ id: content }).delete();
    expect(await f.roundsOf(content)).toEqual([]);
  });
});

describe('the deadline is also a CHECK of the table: the day is the São Paulo day of the instant', () => {
  const insertWith = async (deadline: { due_on: string | null; due_at: string | null }): Promise<unknown> => {
    const content = await f.readyContent();
    return owner()(THE_ROUNDS_TABLE).insert({ batch_id: randomUUID(), client_id: ids.clientA1, content_id: content, sequence: 1, sent_by: ids.adminA, ...deadline });
  };

  it.each([
    ['a day with no instant', { due_on: '2030-01-01', due_at: null }],
    ['an instant with no day', { due_on: null, due_at: '2030-01-01T12:00:00Z' }],
    ['the last second of the day before, which is still the day before in São Paulo', { due_on: '2030-01-01', due_at: '2030-01-01T02:59:59Z' }],
    ['the first second of the day after, which is already the next day in São Paulo', { due_on: '2030-01-01', due_at: '2030-01-02T03:00:00Z' }]
  ])('refuses %s even for the owner of the database', async (_label, deadline) => {
    await expect(insertWith(deadline)).rejects.toMatchObject({ code: '23514', constraint: 'content_approval_rounds_due_check' });
  });

  it.each([
    ['the first second of the day in São Paulo', { due_on: '2030-01-01', due_at: '2030-01-01T03:00:00Z' }],
    ['the last second of the day in São Paulo', { due_on: '2030-01-01', due_at: '2030-01-02T02:59:59Z' }],
    ['no deadline at all', { due_on: null, due_at: null }]
  ])('accepts %s', async (_label, deadline) => {
    await expect(insertWith(deadline)).resolves.toBeDefined();
  });

  it('is not writable by the application role, which has no grant on the column', async () => {
    const content = await f.readyContent();
    await submitAs(ids.adminA, content, await f.day(2));
    await expect(w.asUser(ids.adminA, (t) => t(THE_ROUNDS_TABLE).where({ content_id: content }).update({ due_at: '2030-01-01T12:00:00Z' }))).rejects.toMatchObject({ code: '42501' });
  });
});

// ---- the batch -----------------------------------------------------------------------------------------------------------

describe('submit_contents', () => {
  it('sends the contents of one client together: one batch, one row each with the same batch, deadline, note and sender', async () => {
    const contents = [await f.readyContent(), await f.readyContent(), await f.readyContent()];
    const dueOn = await f.day(6);

    const batchId = await batchAs(ids.managerA, contents, dueOn, 'Os três do mês');

    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    for (const id of contents) {
      expect(await contentStatus(id)).toBe('awaiting_approval');
      const [round, ...rest] = await f.roundsOf(id);
      expect(rest).toEqual([]);
      expect(round).toMatchObject({ batch_id: batchId, sequence: 1, note: 'Os três do mês', sent_by: ids.managerA, client_id: ids.clientA1, due_on: dueOn });
    }
    // The e-mail of "contents to approve" is queued by the database for every content, as with the individual send.
    expect(await queueItems(contents)).toBe(contents.length * PEOPLE_OF_A1);
  });

  it('gives each batch its own id, and a batch of one is a batch', async () => {
    const [a, b] = [await f.readyContent(), await f.readyContent()];
    const first = await batchAs(ids.adminA, [a]);
    const second = await batchAs(ids.adminA, [b]);
    expect(first).not.toBe(second);
    expect((await f.roundsOf(a))[0]!.batch_id).toBe(first);
  });

  it('opens round 2 for a content of the batch that comes back from an adjustment', async () => {
    const [a, b] = [await f.readyContent(), await f.readyContent()];
    await batchAs(ids.adminA, [a, b], null, 'Primeira');
    await f.requestChanges(ids.portalA1, a);

    const second = await batchAs(ids.adminA, [a], null, 'De novo');
    expect((await f.roundsOf(a)).map((round) => round.sequence)).toEqual([1, 2]);
    expect((await f.roundsOf(a))[1]!.batch_id).toBe(second);
    expect((await f.roundsOf(b)).map((round) => round.sequence)).toEqual([1]);
  });

  describe('all or nothing', () => {
    const invalidKinds: ReadonlyArray<readonly [string, string, () => Promise<string>]> = [
      ['A0065', 'a content without a media', withoutMedia],
      ['A0066', 'a content with a subtask that is not approved', async () => {
        const id = await f.readyContent();
        await w.seedTask(id, { status: 'delivered' });
        return id;
      }],
      ['A0062', 'a content that is already waiting (it is refused, not ignored, so a deadline is never dropped)', () => f.readyContent(ids.clientA1, 'awaiting_approval')],
      ['A0062', 'a content that is approved', () => f.readyContent(ids.clientA1, 'approved')],
      ['A0060', 'a content that does not exist', async () => randomUUID()],
      ['A0060', 'a content of another agency', async () => {
        const folder = await w.folderOf(ids.clientB);
        const id = await w.seedContent(ids.clientB, { owner: ids.adminB });
        await w.attach(id, [await w.seedAsset(ids.clientB, folder, { category: 'video' })]);
        return id;
      }]
    ];

    it.each(['first', 'middle', 'last'] as const)(
      'leaves every content, round and queued e-mail untouched when the %s one of the batch is invalid',
      async (position) => {
        const good = [await f.readyContent(), await f.readyContent()];
        for (const [code, , makeInvalid] of invalidKinds) {
          const invalid = await makeInvalid();
          const requested = position === 'first' ? [invalid, ...good] : position === 'last' ? [...good, invalid] : [good[0]!, invalid, good[1]!];

          await expect(batchAs(ids.adminA, requested, await f.day(2), 'Tudo ou nada'), code).rejects.toMatchObject({ code });
          await expectUntouched(good);
          expect(await roundCount([invalid])).toBe(0);
        }
      }
    );

    it('refuses a batch of two clients with A0122 and changes nothing', async () => {
      const [inA1, inA2] = [await f.readyContent(ids.clientA1), await f.readyContent(ids.clientA2)];

      await expect(batchAs(ids.adminA, [inA1, inA2])).rejects.toMatchObject({ code: 'A0122' });
      await expect(batchAs(ids.adminA, [inA2, inA1])).rejects.toMatchObject({ code: 'A0122' });
      await expectUntouched([inA1, inA2]);
    });

    it('does not tell a caller that two contents it may not read belong to two clients: it answers not found', async () => {
      const [inA1, inA2] = [await f.readyContent(ids.clientA1), await f.readyContent(ids.clientA2)];
      const folder = await w.folderOf(ids.clientB);
      const inB = await w.seedContent(ids.clientB, { owner: ids.adminB });
      await w.attach(inB, [await w.seedAsset(ids.clientB, folder, { category: 'video' })]);

      await expect(batchAs(ids.adminA, [inA1, inB])).rejects.toMatchObject({ code: 'A0060' });
      await expect(batchAs(ids.adminB, [inA1, inA2])).rejects.toMatchObject({ code: 'A0060' });
      await expectUntouched([inA1, inA2]);
    });
  });

  it('refuses a person without conteudo.operar or without conteudo.visualizar, and a person of the portal, with not found', async () => {
    const contents = [await f.readyContent(), await f.readyContent()];
    const withoutOperar = await w.personWithAllBut('conteudo.operar');
    const withoutVisualizar = await w.personWithAllBut('conteudo.visualizar');

    for (const user of [withoutOperar, withoutVisualizar, ids.dualBare, ids.crossDual, ids.portalA1, ids.adminB]) {
      await expect(batchAs(user, contents)).rejects.toMatchObject({ code: 'A0060' });
    }
    await expectUntouched(contents);
  });

  it('refuses the contents of an archived client with A0061, and those of a suspended agency with not found', async () => {
    const archivedClient = await f.freshClient();
    const archived = await f.readyContent(archivedClient);
    await w.archiveClient(archivedClient);
    await expect(batchAs(ids.adminA, [archived])).rejects.toMatchObject({ code: 'A0061' });
    await expectUntouched([archived]);

    const suspended = await w.withSuspendedAgencyActive(async () => {
      const folder = await w.folderOf(ids.clientSuspended);
      const id = await w.seedContent(ids.clientSuspended, { owner: ids.adminSuspended });
      await w.attach(id, [await w.seedAsset(ids.clientSuspended, folder, { category: 'video' })]);
      return id;
    });
    await expect(batchAs(ids.adminSuspended, [suspended])).rejects.toMatchObject({ code: 'A0060' });
    await expectUntouched([suspended]);
  });

  it('refuses the write of an agency whose trial has ended with A0090, and sends again once it is back', async () => {
    const contents = [await f.readyContent(), await f.readyContent()];
    await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)') });
    try {
      await expect(batchAs(ids.adminA, contents)).rejects.toMatchObject({ code: 'A0090' });
      await expect(submitAs(ids.adminA, contents[0]!)).rejects.toMatchObject({ code: 'A0090' });
      await expectUntouched(contents);
    } finally {
      await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null });
    }
    await expect(batchAs(ids.adminA, contents)).resolves.toBeDefined();
  });

  describe('the size of a batch', () => {
    it.each([
      ['an empty list', () => []],
      ['a missing list', () => null]
    ])('refuses %s with A0121', async (_label, list) => {
      await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.submit_contents(?::uuid[], null, null)', [list() as never]))).rejects.toMatchObject({ code: 'A0121' });
    });

    it('refuses the same content twice and a null in the list with A0121, before it locks or changes anything', async () => {
      const content = await f.readyContent();
      await expect(batchAs(ids.adminA, [content, content])).rejects.toMatchObject({ code: 'A0121' });
      await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.submit_contents(array[?::uuid, null::uuid], null, null)', [content]))).rejects.toMatchObject({ code: 'A0121' });
      await expectUntouched([content]);
    });

    it('refuses a list of more than one dimension with A0121, and not with the error of the array function that cannot read it', async () => {
      const [a, b] = [await f.readyContent(), await f.readyContent()];
      for (const shape of ['array[[?::uuid, ?::uuid]]', 'array[[?::uuid], [?::uuid]]']) {
        await expect(w.asUser(ids.adminA, (t) => t.raw(`select app_private.submit_contents(${shape}, null, null)`, [a, b])), shape).rejects.toMatchObject({ code: 'A0121' });
      }
      await expectUntouched([a, b]);
    });

    it('sends 30 contents and refuses 31, with every content of the 31 valid', async () => {
      const contents: string[] = [];
      for (let index = 0; index < 31; index += 1) contents.push(await f.readyContent());

      await expect(batchAs(ids.adminA, contents)).rejects.toMatchObject({ code: 'A0121' });
      await expectUntouched(contents);

      const batchId = await batchAs(ids.adminA, contents.slice(0, 30), null, 'Trinta');
      expect(await owner()(THE_ROUNDS_TABLE).where({ batch_id: batchId }).count<Array<{ count: string }>>('* as count').then((rows) => Number(rows[0]!.count))).toBe(30);
      expect(await roundCount([contents[30]!])).toBe(0);
    }, 60_000);
  });

  it.each(['repeatable read', 'serializable'] as const)(
    'refuses %s with 40001, since it locks and reads again, and leaves everything as it was',
    async (level) => {
      const content = await f.readyContent();
      const sending = await w.openTransactionAs(ids.adminA, level);
      let batchOutcome: unknown;
      let singleOutcome: unknown;
      try {
        await sending.raw('select 1');
        batchOutcome = await sending.raw('select app_private.submit_contents(array[?::uuid], null, null)', [content]).then(() => 'sent', (error: unknown) => error);
      } finally {
        await sending.rollback().catch(() => undefined);
      }
      const single = await w.openTransactionAs(ids.adminA, level);
      try {
        await single.raw('select 1');
        singleOutcome = await single.raw('select app_private.submit_content(?::uuid)', [content]).then(() => 'sent', (error: unknown) => error);
      } finally {
        await single.rollback().catch(() => undefined);
      }

      expect(batchOutcome).toMatchObject({ code: '40001' });
      expect(singleOutcome).toMatchObject({ code: '40001' });
      await expectUntouched([content]);
    }
  );
});

// ---- races ----------------------------------------------------------------------------------------------------------------

describe('two sends of the same contents at once', () => {
  it('locks the contents in ascending order whatever the order the caller gave, so a batch holding the first one waits at the first one', async () => {
    const contents = [await f.readyContent(), await f.readyContent()].sort();
    const [low, high] = [contents[0]!, contents[1]!];

    // A second connection holds the HIGH content. The batch is asked as [high, low]: in ascending order it takes `low` first and
    // then waits for `high`; in the order given it would wait at `high` without ever holding `low`.
    const holder = await owner().transaction();
    const sending = await w.openTransactionAs(ids.adminA);
    let outcome: Promise<unknown> | undefined;
    try {
      expect((await holder.raw('select id from public.contents where id = ?::uuid for update', [high])).rows).toHaveLength(1);
      const holderPid = await backendPid(holder);
      outcome = sending.raw('select app_private.submit_contents(array[?::uuid, ?::uuid], null, null)', [high, low]).then(() => 'sent', (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), holderPid);

      await expect(owner().transaction(async (probe) => probe.raw('select id from public.contents where id = ?::uuid for update nowait', [low]))).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.rollback();
    }
    expect(await outcome).toBe('sent');
    await sending.commit();
    expect(await roundCount([low, high])).toBe(2);
  });

  it('makes the second batch wait for the first and then refuse what the first already sent, with no deadlock and one round each', async () => {
    const contents = [await f.readyContent(), await f.readyContent()];
    const first = await w.openTransactionAs(ids.adminA);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.submit_contents(?::uuid[], null, null)', [[...contents]]);
      second = batchAs(ids.managerA, [...contents].reverse()).then(() => 'sent', (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0062' });
    expect(await roundCount(contents)).toBe(2);
    expect((await f.roundsOf(contents[0]!))[0]).toMatchObject({ sent_by: ids.adminA });
  });

  it('keeps the deadline of the first batch, to the hour, when a second one with another deadline arrives at the same moment: the loser leaves no round and changes nothing', async () => {
    const contents = [await f.readyContent(), await f.readyContent()];
    const firstDeadline = await f.at(48);
    const secondDeadline = await f.at(72);
    const first = await w.openTransactionAs(ids.adminA);
    const firstPid = await backendPid(first);
    let second: Promise<unknown> | undefined;
    try {
      await first.raw('select app_private.submit_contents(?::uuid[], ?::timestamptz, ?::text)', [[...contents], firstDeadline, 'Primeiro lote']);
      second = batchAs(ids.managerA, [...contents].reverse(), secondDeadline, 'Segundo lote').then(() => 'sent', (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), firstPid);
    } finally {
      await first.commit();
    }

    expect(await second).toMatchObject({ code: 'A0062' });
    for (const content of contents) {
      const rounds = await f.roundsOf(content);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ sent_by: ids.adminA, note: 'Primeiro lote' });
      expect((rounds[0]!.due_at as Date).getTime()).toBe(new Date(firstDeadline).getTime());
    }
  });

  it('lets two batches of different contents with a deadline each go through together, each keeping its own hour', async () => {
    const [mine, theirs] = [[await f.readyContent()], [await f.readyContent()]];
    const [a, b] = [await f.at(24), await f.at(96)];
    await Promise.all([batchAs(ids.adminA, mine, a, null), batchAs(ids.managerA, theirs, b, null)]);

    expect((await f.roundsOf(mine[0]!))[0]!.due_at).toEqual(new Date(a));
    expect((await f.roundsOf(theirs[0]!))[0]!.due_at).toEqual(new Date(b));
  });

  it('refuses a batch while the archive of the client is uncommitted, with A0061, and sends nothing once the archive commits', async () => {
    const client = await f.freshClient();
    const contents = [await f.readyContent(client), await f.readyContent(client)];

    const archiving = await w.openTransactionAs(ids.adminA);
    const archivingPid = await backendPid(archiving);
    let outcome: Promise<unknown> | undefined;
    try {
      await archiving.raw('select app_private.archive_client(?::uuid)', [client]);
      outcome = batchAs(ids.productionA, contents).then(() => 'sent', (error: unknown) => error);
      await waitForBackendsBlockedBy(owner(), archivingPid);
    } finally {
      await archiving.commit();
    }

    expect(await outcome).toMatchObject({ code: 'A0061' });
    expect(await roundCount(contents)).toBe(0);
  });
});

// ---- what the portal reads --------------------------------------------------------------------------------------------------

describe('what the portal reads of the current round', () => {
  interface PortalRow {
    id: string; status: string; approval_sent_at: Date | null; approval_due_on: string | null; approval_note: string | null;
  }
  const portalRows = (user: string, clientId: string, contentId: string | null = null): Promise<PortalRow[]> =>
    w.asUser(user, async (t) =>
      (await t.raw<{ rows: PortalRow[] }>(
        'select id, status, approval_sent_at, approval_due_on::text as approval_due_on, approval_note from app_private.portal_contents(?::uuid, null::date, null::date, null::text[], ?::uuid)',
        [clientId, contentId]
      )).rows
    );

  it('returns the sent day, the deadline and the note of a content that waits, and nulls for one that was never sent through a round', async () => {
    const sent = await f.readyContent();
    const legacy = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
    const dueOn = await f.day(5);
    await submitAs(ids.productionA, sent, dueOn, 'Para a campanha');
    const round = (await f.roundsOf(sent))[0]!;

    const rows = await portalRows(ids.portalA1, ids.clientA1);
    const mine = rows.find((row) => row.id === sent)!;
    expect(mine).toMatchObject({ status: 'awaiting_approval', approval_note: 'Para a campanha' });
    expect(mine.approval_sent_at).toEqual(round.sent_at);
    expect(mine.approval_due_on).toBe(dueOn);
    expect(rows.find((row) => row.id === legacy)).toMatchObject({ status: 'awaiting_approval', approval_sent_at: null, approval_due_on: null, approval_note: null });
  });

  it('returns the LATEST round once the content was sent again, and the earlier one is not read', async () => {
    const content = await f.readyContent();
    await submitAs(ids.productionA, content, await f.day(2), 'Primeira rodada');
    await f.requestChanges(ids.portalA1, content);
    await submitAs(ids.productionA, content, null, 'Segunda rodada');

    const rows = await portalRows(ids.portalA1, ids.clientA1, content);
    const second = (await f.roundsOf(content))[1]!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approval_due_on: null, approval_note: 'Segunda rodada' });
    expect(rows[0]!.approval_sent_at).toEqual(second.sent_at);
  });

  it('keeps the round of a content that was approved or published, and cuts it for a content in production', async () => {
    const approved = await f.readyContent();
    await submitAs(ids.productionA, approved, null, 'Foi aprovado');
    await w.asUser(ids.portalA1, async (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer)', [approved, (await w.contentRow(approved)).revision]));
    const inProduction = await f.readyContent();
    await owner()(THE_ROUNDS_TABLE).insert({ batch_id: randomUUID(), client_id: ids.clientA1, content_id: inProduction, sequence: 1, note: 'Não pode aparecer', sent_by: ids.adminA });

    expect((await portalRows(ids.portalA1, ids.clientA1, approved))[0]).toMatchObject({ status: 'approved', approval_note: 'Foi aprovado' });
    expect((await portalRows(ids.portalA1, ids.clientA1, inProduction))[0]).toMatchObject({
      status: 'in_production', approval_sent_at: null, approval_due_on: null, approval_note: null
    });
  });

  it('is read only by a person of THIS client: another client\'s portal, another agency\'s and a person without a link read nothing', async () => {
    const content = await f.readyContent();
    await submitAs(ids.productionA, content, null, 'Só do cliente A1');

    expect(await portalRows(ids.portalA1, ids.clientA1, content)).toHaveLength(1);
    expect(await portalRows(ids.dualBare, ids.clientA1, content)).toHaveLength(1);
    for (const user of [ids.portalA2, ids.portalB, ids.dualRemoved, ids.adminB, ids.productionA]) {
      expect(await portalRows(user, ids.clientA1, content), user).toEqual([]);
    }
    // crossDual is the Admin of agency B with a link to client A1 only: nothing of client A2.
    const ofA2 = await f.readyContent(ids.clientA2);
    await submitAs(ids.productionA, ofA2, null, 'Só do cliente A2');
    expect(await portalRows(ids.crossDual, ids.clientA2, ofA2)).toEqual([]);
    expect(await portalRows(ids.crossDual, ids.clientA1, content)).toHaveLength(1);
  });

  it('returns the deadline as the instant the sender gave, and the day it falls on in São Paulo', async () => {
    const content = await f.readyContent();
    const tomorrow = await f.day(1);
    await submitAs(ids.productionA, content, `${tomorrow}T21:30:00-03:00`, null);

    const [row] = await w.asUser(ids.portalA1, async (t) =>
      (await t.raw<{ rows: Array<{ approval_due_at: Date; approval_due_on: string }> }>(
        'select approval_due_at, approval_due_on::text as approval_due_on from app_private.portal_contents(?::uuid, null::date, null::date, null::text[], ?::uuid)', [ids.clientA1, content]
      )).rows
    );
    expect(row!.approval_due_at).toEqual(new Date(`${tomorrow}T21:30:00-03:00`));
    expect(row!.approval_due_on).toBe(tomorrow);
  });

  describe('who sent the round', () => {
    interface SenderRow { id: string; approval_sent_by_name: string | null; approval_sent_by_photo_key: string | null }
    const senderOf = async (user: string, clientId: string, contentId: string): Promise<SenderRow | undefined> =>
      (await w.asUser(user, async (t) =>
        (await t.raw<{ rows: SenderRow[] }>(
          'select id, approval_sent_by_name, approval_sent_by_photo_key from app_private.portal_contents(?::uuid, null::date, null::date, null::text[], ?::uuid)', [clientId, contentId]
        )).rows
      ))[0];

    it('returns the name and the photo key of the person who sent, and of nobody else', async () => {
      const content = await f.readyContent();
      await owner()('auth.user').where({ id: ids.managerA }).update({ image: 'identity/photo-do-gerente.png' });
      await submitAs(ids.managerA, content, null, 'Recado');
      const manager = await owner()('auth.user').where({ id: ids.managerA }).first('name');

      expect(await senderOf(ids.portalA1, ids.clientA1, content)).toEqual({ id: content, approval_sent_by_name: manager.name, approval_sent_by_photo_key: 'identity/photo-do-gerente.png' });
    });

    it('is the sender of the LATEST round: the first person is not read once another sends again', async () => {
      const content = await f.readyContent();
      await submitAs(ids.managerA, content);
      await f.requestChanges(ids.portalA1, content);
      await submitAs(ids.adminA, content);
      const admin = await owner()('auth.user').where({ id: ids.adminA }).first('name');

      expect((await senderOf(ids.portalA1, ids.clientA1, content))?.approval_sent_by_name).toBe(admin.name);
    });

    it('keeps the name of a sender who left the agency, with the name they had', async () => {
      const content = await f.readyContent();
      await submitAs(ids.productionA, content);
      const sender = await owner()('auth.user').where({ id: ids.productionA }).first('name');
      await owner()('agency_memberships').where({ user_id: ids.productionA, agency_id: ids.agencyA }).update({ status: 'removed' });
      try {
        expect((await senderOf(ids.portalA1, ids.clientA1, content))?.approval_sent_by_name).toBe(sender.name);
      } finally {
        await owner()('agency_memberships').where({ user_id: ids.productionA, agency_id: ids.agencyA }).update({ status: 'active' });
      }
    });

    it('is null for a content that waited before the rounds existed and for one in production', async () => {
      const legacy = await w.seedContent(ids.clientA1, { status: 'awaiting_approval' });
      const draft = await f.readyContent();
      await owner()(THE_ROUNDS_TABLE).insert({ batch_id: randomUUID(), client_id: ids.clientA1, content_id: draft, sequence: 1, sent_by: ids.adminA });

      expect(await senderOf(ids.portalA1, ids.clientA1, legacy)).toMatchObject({ approval_sent_by_name: null, approval_sent_by_photo_key: null });
      expect(await senderOf(ids.portalA1, ids.clientA1, draft)).toMatchObject({ approval_sent_by_name: null, approval_sent_by_photo_key: null });
    });

    it('is read only by a person of THIS client: another portal, another agency and a person without a link read no sender', async () => {
      const content = await f.readyContent();
      await submitAs(ids.managerA, content);
      for (const user of [ids.portalA2, ids.portalB, ids.dualRemoved, ids.adminB, ids.productionA, ids.managerA]) {
        expect(await senderOf(user, ids.clientA1, content), user).toBeUndefined();
      }
    });

    it('hands the portal the name and the photo key and nothing else of the sender: no id, e-mail, role or batch', async () => {
      const columns = (await f.sql<string>("select pg_get_function_result('app_private.portal_contents(uuid, date, date, text[], uuid)'::regprocedure) as value")).split(', ').map((column) => column.split(' ')[0]);
      expect(columns.filter((column) => /sent_by|sender/.test(column!))).toEqual(['approval_sent_by_name', 'approval_sent_by_photo_key']);
      expect(columns.join(' ')).not.toMatch(/email|role|batch_id|sequence|reminded|member|user_id/);
    });
  });

  it('hands the link no sender, and no column of the batch', async () => {
    const linkColumns = await f.sql<string>("select pg_get_function_result('app_private.portal_approval_contents(text)'::regprocedure) as value");
    expect(linkColumns).toContain('approval_sent_at timestamp with time zone, approval_due_on date, approval_note text');
    expect(linkColumns).not.toMatch(/sent_by|sender|batch_id|sequence|reminded|email|role/);
  });
});

describe('what the approval link reads of the current round', () => {
  const sha = async (value: string): Promise<string> => (await import('node:crypto')).createHash('sha256').update(value, 'utf8').digest('hex');

  /** A session of a link tied to `contents`, built the way the worker and the portal build it: items of a claim, the link, the session. */
  const sessionOf = async (clientId: string, contents: readonly string[]): Promise<string> => {
    const access = (await owner()('client_portal_accesses').insert({ client_id: clientId, email: `${randomUUID()}@rodadas.test` }).returning('id'))[0] as { id: string };
    const claimToken = randomUUID();
    const itemIds: string[] = [];
    for (const contentId of contents) {
      const inserted = await owner().raw<{ rows: Array<{ id: string }> }>(
        `insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
         values ('content_awaiting_approval', ?, ?, ?, now() - interval '1 minute', now(), ?, 1) returning id`,
        [clientId, access.id, contentId, claimToken]
      );
      itemIds.push(inserted.rows[0]!.id);
    }
    const tokenHash = await sha(randomUUID());
    const sessionHash = await sha(randomUUID());
    await app.knex.transaction(async (t) => {
      await t.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [itemIds, claimToken, tokenHash]);
    });
    await app.knex.transaction(async (t) => {
      await t.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, sessionHash]);
    });
    return sessionHash;
  };

  it('returns the current round of each content of the batch, and nothing of the sender', async () => {
    const client = await f.freshClient();
    const [first, second, legacy] = [await f.readyContent(client), await f.readyContent(client), await w.seedContent(client, { status: 'awaiting_approval' })];
    const draft = await f.readyContent(client);
    await owner()(THE_ROUNDS_TABLE).insert({ batch_id: randomUUID(), client_id: client, content_id: draft, sequence: 1, note: 'Não pode aparecer', sent_by: ids.adminA });
    const dueOn = await f.day(7);
    await f.submitBatch(ids.adminA, [first, second], dueOn, 'Conforme combinado');
    await f.requestChanges(ids.portalA1, second);
    await submitAs(ids.adminA, second, null, 'Rodada nova do segundo');
    const sessionHash = await sessionOf(client, [first, second, legacy, draft]);

    const rows = (await app.knex.transaction(async (t) =>
      (await t.raw<{ rows: Array<Record<string, unknown>> }>('select id, status, approval_sent_at, approval_due_on::text as approval_due_on, approval_note from app_private.portal_approval_contents(?)', [sessionHash])).rows
    ));
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(first)).toMatchObject({ approval_note: 'Conforme combinado', status: 'awaiting_approval' });
    expect(byId.get(first)).toMatchObject({ approval_due_on: dueOn });
    expect(byId.get(first)!.approval_sent_at).toEqual((await f.roundsOf(first))[0]!.sent_at);
    expect(byId.get(second)).toMatchObject({ approval_note: 'Rodada nova do segundo', approval_due_on: null });
    expect(byId.get(second)!.approval_sent_at).toEqual((await f.roundsOf(second))[1]!.sent_at);
    expect(byId.get(draft)).toMatchObject({ status: 'in_production', approval_note: null, approval_due_on: null, approval_sent_at: null });
    expect(byId.get(legacy)).toMatchObject({ approval_note: null, approval_due_on: null, approval_sent_at: null });
  });

  it('does not show a round of another batch: the batch of another link reads only its own contents', async () => {
    const client = await f.freshClient();
    const [mine, theirs] = [await f.readyContent(client), await f.readyContent(client)];
    await f.submitBatch(ids.adminA, [mine, theirs], null, 'Para os dois');
    const sessionHash = await sessionOf(client, [mine]);

    const rows = await app.knex.transaction(async (t) =>
      (await t.raw<{ rows: Array<{ id: string }> }>('select id from app_private.portal_approval_contents(?)', [sessionHash])).rows
    );
    expect(rows.map((row) => row.id)).toEqual([mine]);
  });
});
