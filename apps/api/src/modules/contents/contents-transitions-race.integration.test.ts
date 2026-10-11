import { raw } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, archiveBeforeStatement, archiveWhileRouteWaits, waitForBackendBlockedBy } from './test-support/race.js';
import { createTransitionFixtures } from './test-support/transition-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';
import type { TransitionAction } from './transition-errors.js';

// Issue #256 and its requirement for rule 14: a move of a content while the client is being archived is answered 409
// CLIENT_ARCHIVED with nothing written, in BOTH windows of the race, and the client is read after the LAST wait. Each window
// is sequenced by a lock or by the statement, never by a sleep:
//  - the archive is in course (uncommitted): the function takes the client FOR SHARE and waits for it, then reads it again;
//  - the archive committed after the route read the client and before the function ran: the function finds no active client;
//  - the content row is held by another transaction: the client is already shared by then, so the archive waits for the move
//    to finish instead of committing in the middle of it (the wait for the row is the last one, and it is behind the lock).
const w = createContentsWorld('transitions-race');
const f = createTransitionFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A0020|A0061|deadlock|40P01|42501|pg_|relation|process/i;
const ACTIONS: readonly TransitionAction[] = ['submit', 'approve-by-agency', 'publish', 'unpublish', 'cancel', 'reschedule'];
const FUNCTION_OF: Record<TransitionAction, RegExp> = {
  submit: /app_private\.submit_content/,
  'approve-by-agency': /app_private\.approve_content_by_agency/,
  publish: /app_private\.publish_content/,
  unpublish: /app_private\.unpublish_content/,
  cancel: /app_private\.cancel_content/,
  reschedule: /app_private\.reschedule_content/
};

const archived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

const statusOf = async (contentId: string): Promise<string> => (await w.contentRow(contentId)).status as string;

beforeAll(async () => {
  await w.setup();
  await f.setup();
}, 90_000);

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe.each(ACTIONS)('%s while the client is being archived (issue #256)', (action) => {
  const start = (clientId: string, contentId: string, body: unknown): Promise<Reply> =>
    w.call('POST', people.admin.cookie, f.urlOf(clientId, contentId, action), body);

  it('answers 409 CLIENT_ARCHIVED while the archive is in course, and moves nothing', async () => {
    const clientId = await w.newClient(`${action}-window-1`);
    await f.portalMember(clientId);
    const fixture = await f.fixtureFor(action, clientId);
    const before = await statusOf(fixture.contentId);

    const reply = await archiveWhileRouteWaits(w, clientId, () => start(clientId, fixture.contentId, fixture.body));

    archived(reply);
    expect(await statusOf(fixture.contentId)).toBe(before);
    expect(await f.queueRows(fixture.contentId)).toEqual([]);
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED when the archive commits after the route read the client and before the function ran, and moves nothing', async () => {
    const clientId = await w.newClient(`${action}-window-2`);
    await f.portalMember(clientId);
    const fixture = await f.fixtureFor(action, clientId);
    const before = await statusOf(fixture.contentId);

    const reply = await archiveBeforeStatement(w, clientId, FUNCTION_OF[action], () => start(clientId, fixture.contentId, fixture.body));

    archived(reply);
    expect(await statusOf(fixture.contentId)).toBe(before);
    expect(await f.queueRows(fixture.contentId)).toEqual([]);
  }, 30_000);

  it('makes the archive wait for the move when the row is held, and the move is the one that completes first', async () => {
    const clientId = await w.newClient(`${action}-held`);
    const fixture = await f.fixtureFor(action, clientId);

    const holder = await w.getOwner().knex.transaction();
    let released = false;
    try {
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.contents where id = ?::uuid for update', [fixture.contentId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one content row.');
      const holderPid = await backendPid(holder);

      const pending = start(clientId, fixture.contentId, fixture.body);
      const routePid = await waitForBackendBlockedBy(w, holderPid);
      // The route waits for the row: it already shares the client, so the archive cannot commit now. If it could, this
      // would time out, and the move would be reading a client that is gone.
      const archive = w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() }).then((count) => count);
      await waitForBackendBlockedBy(w, routePid);
      await holder.rollback();
      released = true;

      const reply = await pending;
      expect(reply.statusCode).toBe(200);
      expect(reply.json().status).toBe(f.AFTER[action]);
      expect(await archive).toBe(1);
      expect(await statusOf(fixture.contentId)).toBe(f.AFTER[action]);
      expect((await w.getOwner().knex('clients').where({ id: clientId }).first('status'))?.status).toBe('archived');
    } finally {
      if (!released) await holder.rollback();
    }
  }, 30_000);
});
