import type { CreateContentTaskRequest, UpdateContentTaskRequest } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import type { ContentTransaction } from './service.js';

/*
 * The three functions of the database that move a subtask (migrations 20261007001200 and 20261007001400): each checks who
 * the caller is against the person in charge of the task or of the content, takes the client FOR SHARE before the task and
 * reads it after the wait, so the route decides nothing they decide: it passes the id and what the body carries.
 */

export const deliverContentTask = async (transaction: ContentTransaction, taskId: string): Promise<void> => {
  await raw(transaction, 'select app_private.deliver_content_task(?::uuid)', [taskId]);
};

export const approveContentTask = async (transaction: ContentTransaction, taskId: string): Promise<void> => {
  await raw(transaction, 'select app_private.approve_content_task(?::uuid)', [taskId]);
};

export const returnContentTask = async (transaction: ContentTransaction, input: { readonly taskId: string; readonly comment: string }): Promise<void> => {
  await raw(transaction, 'select app_private.return_content_task(?::uuid, ?)', [input.taskId, input.comment]);
};

/**
 * How many subtasks a content has, counted after the lock of its creators: two creations at the same time wait for each other, so the
 * second counts the first. The lock is per content and has nothing to do with the client's, so it adds no cycle with an archive.
 */
export const countContentTasksLocked = async (transaction: ContentTransaction, contentId: string): Promise<number> => {
  await raw(transaction, 'select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?::text, 0))', [`content_tasks:${contentId}`]);
  const result = await raw<{ rows: Array<{ total: number }> }>(transaction, 'select count(*)::int as total from public.content_tasks where content_id = ?::uuid', [contentId]);
  return Number(result.rows[0]?.total ?? 0);
};

/** The person in charge is the user the link resolved to: the route resolves it, because the column holds a user and no caller is given one. */
export const insertContentTask = async (
  transaction: ContentTransaction,
  input: {
    readonly contentId: string;
    readonly clientId: string;
    readonly body: Omit<CreateContentTaskRequest, 'assigneeMembershipId'>;
    readonly assigneeUserId: string;
  }
): Promise<string> => {
  const { body } = input;
  const result = await raw<{ rows: Array<{ id: string }> }>(transaction, `
    insert into public.content_tasks (content_id, client_id, title, description, assignee_user_id, due_on)
    values (?::uuid, ?::uuid, ?, ?, ?::uuid, ?::date)
    returning id
  `, [input.contentId, input.clientId, body.title, body.description ?? null, input.assigneeUserId, body.dueOn]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Content task insert did not return a row.');
  return row.id;
};

export type ContentTaskChanges = Omit<UpdateContentTaskRequest, 'assigneeMembershipId'> & { readonly assigneeUserId?: string };

/** Body field -> column and cast: the only columns a PATCH writes, the ones the grant of `ageniza_app` allows. */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof ContentTaskChanges, string, string]> = [
  ['title', 'title', ''],
  ['description', 'description', ''],
  ['assigneeUserId', 'assignee_user_id', '::uuid'],
  ['dueOn', 'due_on', '::date']
];

/** `false` when no row of the content matched: the row went away, or the policy no longer lets this person write it. */
export const updateContentTask = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly clientId: string; readonly taskId: string; readonly changes: ContentTaskChanges }
): Promise<boolean> => {
  const assignments: string[] = [];
  const bindings: Array<string | null> = [];
  for (const [key, column, cast] of UPDATABLE_COLUMNS) {
    const value = input.changes[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?${cast}`);
    bindings.push(value);
  }
  if (assignments.length === 0) throw new Error('A content task update carries at least one column.');
  const result = await raw<{ rows: Array<{ id: string }> }>(transaction, `
    update public.content_tasks set ${assignments.join(', ')}
    where id = ?::uuid and content_id = ?::uuid and client_id = ?::uuid
    returning id
  `, [...bindings, input.taskId, input.contentId, input.clientId]);
  return result.rows[0] !== undefined;
};
