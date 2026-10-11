import { raw } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backendPid, archiveBeforeStatement, archiveWhileRouteWaits, waitForBackendBlockedBy } from './test-support/race.js';
import { createTaskFixtures } from './test-support/task-fixtures.js';
import { createTransitionFixtures } from './test-support/transition-fixtures.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Issue #255 and its requirement for rule 14 (A0020 on every write of a child of the client): a write of a subtask while the client is
// being archived is answered 409 CLIENT_ARCHIVED with nothing written, in BOTH windows of the race, and the client is read after the
// LAST wait. Each window is sequenced by a lock or by the statement, never by a sleep:
//  - the archive is in course (uncommitted): the write waits for the client (the trigger of the edit and of the insert, the function
//    of the three moves) and reads it again;
//  - the archive committed after the route read the client and before the statement that writes: the policy, or the function, no
//    longer finds an active client;
//  - the row of the task is held by another transaction: a move is already sharing the client, so the archive waits for it; an edit
//    waits for the row first, so the archive may commit in between, and the edit is refused.
const w = createContentsWorld('tasks-race');
const f = createTransitionFixtures(w);
const t = createTaskFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A0020|A0061|deadlock|40P01|42501|pg_|relation|process/i;

type Write = 'create' | 'update' | 'deliver' | 'approve' | 'return';
const WRITES: readonly Write[] = ['create', 'update', 'deliver', 'approve', 'return'];
const STATEMENT: Record<Write, RegExp> = {
  create: /insert into public\.content_tasks/,
  update: /update public\.content_tasks/,
  deliver: /app_private\.deliver_content_task/,
  approve: /app_private\.approve_content_task/,
  return: /app_private\.return_content_task/
};

interface Case {
  readonly contentId: string;
  readonly taskId: string | undefined;
  readonly start: () => Promise<Reply>;
  /** What the write would have left: nothing is written when it is refused. */
  readonly written: () => Promise<unknown>;
}

const archived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify(reply.json().error)).not.toMatch(NO_DATABASE_DETAIL);
};

const caseFor = async (write: Write, clientId: string): Promise<Case> => {
  if (write === 'create') {
    const contentId = await w.seedContent(clientId, { ownerUserId: people.manager.id });
    const body = { title: 'Gravar o vídeo', assigneeMembershipId: await t.linkOf('production'), dueOn: '2026-10-15' };
    return {
      contentId,
      taskId: undefined,
      start: () => w.call('POST', people.admin.cookie, t.tasksUrl(clientId, contentId), body),
      written: () => t.countTasks(contentId)
    };
  }

  const status = write === 'deliver' || write === 'update' ? 'pending' : 'delivered';
  const { contentId, taskId } = await t.scenario(clientId, { owner: 'manager', assignee: 'reader', status });
  const url = t.taskUrl(clientId, contentId, taskId, write === 'update' ? undefined : write);
  const [person, body]: ['admin' | 'reader' | 'manager', unknown] = write === 'update'
    ? ['admin', { title: 'Outro título' }]
    : write === 'deliver' ? ['reader', undefined] : write === 'approve' ? ['manager', undefined] : ['manager', { comment: 'Falta algo.' }];
  return {
    contentId,
    taskId,
    start: () => w.call(write === 'update' ? 'PATCH' : 'POST', people[person].cookie, url, body),
    written: async () => {
      const row = await t.taskRow(taskId);
      return [row.status, row.title, row.return_comment];
    }
  };
};

beforeAll(async () => {
  await w.setup();
  await f.setup();
}, 90_000);

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe.each(WRITES)('%s while the client is being archived (issue #255)', (write) => {
  it('answers 409 CLIENT_ARCHIVED while the archive is in course, and writes nothing', async () => {
    const clientId = await w.newClient(`${write}-window-1`);
    const run = await caseFor(write, clientId);
    const before = await run.written();

    const reply = await archiveWhileRouteWaits(w, clientId, run.start);

    archived(reply);
    expect(await run.written()).toEqual(before);
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED when the archive commits after the route read the client and before the statement that writes, and writes nothing', async () => {
    const clientId = await w.newClient(`${write}-window-2`);
    const run = await caseFor(write, clientId);
    const before = await run.written();

    const reply = await archiveBeforeStatement(w, clientId, STATEMENT[write], run.start);

    archived(reply);
    expect(await run.written()).toEqual(before);
  }, 30_000);
});

describe.each(['deliver', 'approve', 'return'] as const)('%s with the row of the task held by another transaction (issue #255)', (write) => {
  it('makes the archive wait for the move when the row is held, and the move is the one that completes first', async () => {
    const clientId = await w.newClient(`${write}-held`);
    const run = await caseFor(write, clientId);
    const taskId = run.taskId as string;

    const holder = await w.getOwner().knex.transaction();
    let released = false;
    try {
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.content_tasks where id = ?::uuid for update', [taskId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one task row.');
      const holderPid = await backendPid(holder);

      const pending = run.start();
      const routePid = await waitForBackendBlockedBy(w, holderPid);
      // The route waits for the row: it already shares the client, so the archive cannot commit now. If it could, this would time
      // out, and the move would be reading a client that is gone.
      const archive = w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() }).then((count) => count);
      await waitForBackendBlockedBy(w, routePid);
      await holder.rollback();
      released = true;

      const reply = await pending;
      expect(reply.statusCode).toBe(200);
      expect(await archive).toBe(1);
      expect((await t.taskRow(taskId)).status).toBe(write === 'deliver' ? 'delivered' : write === 'approve' ? 'approved' : 'pending');
      expect((await w.getOwner().knex('clients').where({ id: clientId }).first('status'))?.status).toBe('archived');
    } finally {
      if (!released) await holder.rollback();
    }
  }, 30_000);
});

describe('an edit that waits for the row of the task while the archive commits (issue #255)', () => {
  it('is refused with 409 CLIENT_ARCHIVED after the wait, and the task keeps what it had', async () => {
    const clientId = await w.newClient('update-held');
    const run = await caseFor('update', clientId);
    const taskId = run.taskId as string;
    const before = await run.written();

    const holder = await w.getOwner().knex.transaction();
    let released = false;
    try {
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.content_tasks where id = ?::uuid for update', [taskId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one task row.');
      const holderPid = await backendPid(holder);

      const pending = run.start();
      await waitForBackendBlockedBy(w, holderPid);
      expect(await w.getOwner().knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() })).toBe(1);
      await holder.rollback();
      released = true;

      archived(await pending);
      expect(await run.written()).toEqual(before);
    } finally {
      if (!released) await holder.rollback();
    }
  }, 30_000);
});
