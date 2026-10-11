import { randomUUID } from 'node:crypto';

import type { ContentsWorld, PersonKey } from './world.js';

export type TaskStatus = 'pending' | 'delivered' | 'approved';
export type TaskMove = 'deliver' | 'approve' | 'return';

export interface SeedTask {
  readonly status?: TaskStatus;
  readonly assignee?: PersonKey;
  readonly dueOn?: string;
  readonly returnComment?: string;
}

/**
 * What the subtask routes of #255 are attacked with, on top of the world of #254: a subtask in the state each move starts from, with
 * the person in charge of the task and the person in charge of the content chosen by the test, so that a move that is refused
 * would have succeeded for the right person.
 */
export const createTaskFixtures = (w: ContentsWorld) => {
  const tasksUrl = (clientId: string, contentId: string, agencyId = w.agencyA): string =>
    `/agencies/${agencyId}/clients/${clientId}/contents/${contentId}/tasks`;
  const taskUrl = (clientId: string, contentId: string, taskId: string, move?: TaskMove, agencyId = w.agencyA): string =>
    `${tasksUrl(clientId, contentId, agencyId)}/${taskId}${move === undefined ? '' : `/${move}`}`;

  const seedTask = async (contentId: string, extra: SeedTask = {}): Promise<string> => {
    const id = randomUUID();
    const status = extra.status ?? 'pending';
    const content = await w.getOwner().knex('contents').where({ id: contentId }).first('client_id');
    await w.getOwner().knex('content_tasks').insert({
      id,
      content_id: contentId,
      client_id: content?.client_id as string,
      title: `Subtarefa ${id.slice(0, 8)}`,
      assignee_user_id: w.people[extra.assignee ?? 'reader'].id,
      due_on: extra.dueOn ?? '2026-10-15',
      status,
      ...(extra.returnComment === undefined ? {} : { return_comment: extra.returnComment }),
      ...(status === 'approved' ? { approved_by: w.people.admin.id, approved_at: new Date('2026-10-06T12:00:00.000Z') } : {})
    });
    return id;
  };

  const taskRow = async (taskId: string): Promise<Record<string, unknown>> => {
    const row = await w.getOwner().knex('content_tasks').where({ id: taskId }).first();
    if (row === undefined) throw new Error(`Task ${taskId} does not exist.`);
    return row as Record<string, unknown>;
  };

  const countTasks = async (contentId: string): Promise<number> =>
    Number((await w.getOwner().knex('content_tasks').where({ content_id: contentId }).count<Array<{ count: string }>>('id as count'))[0]?.count ?? 0);

  const linkOf = async (person: PersonKey, agencyId = w.agencyA): Promise<string> => {
    const row = await w.getOwner().knex('agency_memberships').where({ agency_id: agencyId, user_id: w.people[person].id }).first('id');
    if (row === undefined) throw new Error(`${person} has no link with the agency.`);
    return row.id as string;
  };

  /** Takes the link of a person out of service and puts it back, because the other tests of the file use them. */
  const withRemovedLink = async (person: PersonKey, run: () => Promise<void>): Promise<void> => {
    await w.getOwner().knex('agency_memberships').where({ agency_id: w.agencyA, user_id: w.people[person].id }).update({ status: 'removed' });
    try {
      await run();
    } finally {
      await w.getOwner().knex('agency_memberships').where({ agency_id: w.agencyA, user_id: w.people[person].id }).update({ status: 'active' });
    }
  };

  /** A content with one task in the state a move starts from: in charge of the task `assignee`, in charge of the content `owner`. */
  const scenario = async (
    clientId: string,
    extra: { readonly owner?: PersonKey; readonly assignee?: PersonKey; readonly status?: TaskStatus; readonly content?: Parameters<ContentsWorld['seedContent']>[1] } = {}
  ): Promise<{ readonly contentId: string; readonly taskId: string }> => {
    const contentId = await w.seedContent(clientId, { ownerUserId: w.people[extra.owner ?? 'manager'].id, ...extra.content });
    const taskId = await seedTask(contentId, { status: extra.status ?? 'delivered', assignee: extra.assignee ?? 'production' });
    return { contentId, taskId };
  };

  /**
   * A content that is published or cancelled with tasks that were made while it was not: the database refuses a task on one that already
   * is, so the content is moved there after the tasks, by the transition the database allows.
   */
  const endedContentWithTasks = async (
    clientId: string,
    ended: 'published' | 'cancelled',
    tasks: ReadonlyArray<SeedTask>
  ): Promise<{ readonly contentId: string; readonly taskIds: string[] }> => {
    const contentId = await w.seedContent(clientId, { ownerUserId: w.people.manager.id, status: ended === 'published' ? 'approved' : 'in_production' });
    const taskIds: string[] = [];
    for (const task of tasks) taskIds.push(await seedTask(contentId, task));
    await w.getOwner().knex('contents').where({ id: contentId }).update(ended === 'published' ? { status: 'published', published_on: '2026-10-06' } : { status: 'cancelled' });
    return { contentId, taskIds };
  };

  return { tasksUrl, taskUrl, seedTask, taskRow, countTasks, linkOf, withRemovedLink, scenario, endedContentWithTasks };
};

export type TaskFixtures = ReturnType<typeof createTaskFixtures>;
