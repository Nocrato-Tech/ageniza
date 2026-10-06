import type { ConversationSectionKey, ThreadComment, ThreadListItem, ThreadSide, ThreadState, ThreadSubject } from '@ageniza/contracts';
import { raw, type SqlBinding } from '@ageniza/database';

import { latestCommentSideSql, openThreadSql } from './thread-state.js';
import type { ClientTransaction } from './service.js';

/**
 * The conversation service (specs/clientes.md sections 3 and 4). It is generic in the subject: the
 * thread is persisted from a `ThreadSubject` (one section or one persona) and everything else --
 * the derived state, the first comment, the author reading -- does not depend on which subject it
 * is. #130 reuses it with `side = 'client'`, and Conteúdo adds a `contentId` subject variant.
 */

export interface ThreadRow {
  readonly id: string;
  readonly section_key: string | null;
  readonly persona_id: string | null;
  readonly opened_side: ThreadSide;
  readonly opened_by_name: string | null;
  readonly resolved_at: Date | null;
  readonly resolved_by_name: string | null;
  readonly last_comment_side: ThreadSide | null;
  readonly last_comment_at: Date | null;
  readonly last_comment_excerpt: string | null;
  readonly comment_count: string | number;
  readonly is_open: boolean;
  readonly created_at: Date;
}

export interface CommentRow {
  readonly id: string;
  readonly body: string;
  readonly author_side: ThreadSide;
  readonly author_name: string | null;
  readonly author_image: string | null;
  readonly created_at: Date;
}

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** Characters of the last comment shown in the list; the frontend only needs a preview. */
const LAST_COMMENT_EXCERPT_CHARS = 160;

/**
 * A user's name resolved only through the comment's own side: the agency membership for `agency`,
 * the client membership for `client`. `auth."user"` has no RLS, so reading it by a loose id would
 * expose a person from another tenant; the membership check is the tie that authorizes the read.
 */
const authorNameSql = (userIdExpression: string, sideExpression: string, agencyIdExpression: string, clientIdExpression: string): string => `
  (select "user".name from auth."user" "user"
   where "user".id = ${userIdExpression}
     and (
       (${sideExpression} = 'agency' and exists (
         select 1 from public.agency_memberships membership
         where membership.agency_id = ${agencyIdExpression} and membership.user_id = ${userIdExpression}))
       or (${sideExpression} = 'client' and exists (
         select 1 from public.client_memberships membership
         where membership.client_id = ${clientIdExpression} and membership.user_id = ${userIdExpression}))
     ))`;

const authorImageSql = (userIdExpression: string, sideExpression: string, agencyIdExpression: string, clientIdExpression: string): string => `
  (select "user".image from auth."user" "user"
   where "user".id = ${userIdExpression}
     and (
       (${sideExpression} = 'agency' and exists (
         select 1 from public.agency_memberships membership
         where membership.agency_id = ${agencyIdExpression} and membership.user_id = ${userIdExpression}))
       or (${sideExpression} = 'client' and exists (
         select 1 from public.client_memberships membership
         where membership.client_id = ${clientIdExpression} and membership.user_id = ${userIdExpression}))
     ))`;

/** Only `cliente.operar` resolves, so the resolver is always read through the agency membership. */
const resolvedByNameSql = `
  (select "user".name from auth."user" "user"
   where "user".id = thread.resolved_by
     and exists (select 1 from public.agency_memberships membership
                 where membership.agency_id = client.agency_id and membership.user_id = thread.resolved_by))`;

const THREAD_COLUMNS = `
  thread.id,
  thread.section_key,
  thread.persona_id,
  thread.opened_side,
  ${authorNameSql('thread.opened_by', 'thread.opened_side', 'client.agency_id', 'thread.client_id')} as opened_by_name,
  thread.resolved_at,
  ${resolvedByNameSql} as resolved_by_name,
  ${latestCommentSideSql('thread')} as last_comment_side,
  (select max(comment.created_at) from public.client_thread_comments comment where comment.thread_id = thread.id) as last_comment_at,
  (select left(comment.body, ${LAST_COMMENT_EXCERPT_CHARS}) from public.client_thread_comments comment
   where comment.thread_id = thread.id order by comment.created_at desc, comment.id desc limit 1) as last_comment_excerpt,
  (select count(*) from public.client_thread_comments comment where comment.thread_id = thread.id) as comment_count,
  ${openThreadSql('thread')} as is_open,
  thread.created_at
`;

const COMMENT_COLUMNS = `
  comment.id,
  comment.body,
  comment.author_side,
  ${authorNameSql('comment.author_user_id', 'comment.author_side', 'client.agency_id', 'comment.client_id')} as author_name,
  ${authorImageSql('comment.author_user_id', 'comment.author_side', 'client.agency_id', 'comment.client_id')} as author_image,
  comment.created_at
`;

const subjectFilter = (subject: ThreadSubject): { readonly clause: string; readonly binding: SqlBinding } =>
  'sectionKey' in subject
    ? { clause: 'thread.section_key = ?', binding: subject.sectionKey }
    : { clause: 'thread.persona_id = ?::uuid', binding: subject.personaId };

const subjectColumns = (subject: ThreadSubject): { readonly section_key: string | null; readonly persona_id: string | null } =>
  'sectionKey' in subject
    ? { section_key: subject.sectionKey, persona_id: null }
    : { section_key: null, persona_id: subject.personaId };

const stateFilter = (state: ThreadState | undefined): string => {
  if (state === 'open') return `and ${openThreadSql('thread')}`;
  if (state === 'resolved') return `and not ${openThreadSql('thread')}`;
  return '';
};

export const loadThreads = async (
  transaction: ClientTransaction,
  input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly subject: ThreadSubject;
    readonly state?: ThreadState;
    readonly pageSize: number;
    readonly offset: number;
  }
): Promise<{ readonly items: ThreadRow[]; readonly totalItems: number }> => {
  const subjectCondition = subjectFilter(input.subject);
  const from = `
    from public.client_threads thread
    join public.clients client on client.id = thread.client_id
    where thread.client_id = ?::uuid and client.agency_id = ?::uuid
      and ${subjectCondition.clause}
      ${stateFilter(input.state)}
  `;
  const countResult = await raw<RawRows<{ total: string | number }>>(transaction,
    `select count(*) as total ${from}`, [input.clientId, input.agencyId, subjectCondition.binding]);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);

  const itemsResult = await raw<RawRows<ThreadRow>>(transaction, `
    select ${THREAD_COLUMNS}
    ${from}
    order by last_comment_at desc nulls last, thread.created_at desc, thread.id desc
    limit ? offset ?
  `, [input.clientId, input.agencyId, subjectCondition.binding, input.pageSize, input.offset]);
  return { items: [...itemsResult.rows], totalItems };
};

export const loadThreadItem = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly threadId: string }
): Promise<ThreadRow | undefined> => {
  const result = await raw<RawRows<ThreadRow>>(transaction, `
    select ${THREAD_COLUMNS}
    from public.client_threads thread
    join public.clients client on client.id = thread.client_id
    where thread.id = ?::uuid and thread.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.threadId, input.clientId, input.agencyId]);
  return result.rows[0];
};

export const loadThreadComments = async (
  transaction: ClientTransaction,
  input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly threadId: string;
    readonly pageSize: number;
    readonly offset: number;
  }
): Promise<{ readonly items: CommentRow[]; readonly totalItems: number }> => {
  const from = `
    from public.client_thread_comments comment
    join public.clients client on client.id = comment.client_id
    where comment.thread_id = ?::uuid and comment.client_id = ?::uuid and client.agency_id = ?::uuid
  `;
  const countResult = await raw<RawRows<{ total: string | number }>>(transaction,
    `select count(*) as total ${from}`, [input.threadId, input.clientId, input.agencyId]);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);

  const itemsResult = await raw<RawRows<CommentRow>>(transaction, `
    select ${COMMENT_COLUMNS}
    ${from}
    order by comment.created_at asc, comment.id asc
    limit ? offset ?
  `, [input.threadId, input.clientId, input.agencyId, input.pageSize, input.offset]);
  return { items: [...itemsResult.rows], totalItems };
};

export const loadThreadComment = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly commentId: string }
): Promise<CommentRow | undefined> => {
  const result = await raw<RawRows<CommentRow>>(transaction, `
    select ${COMMENT_COLUMNS}
    from public.client_thread_comments comment
    join public.clients client on client.id = comment.client_id
    where comment.id = ?::uuid and comment.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.commentId, input.clientId, input.agencyId]);
  return result.rows[0];
};

/** Creates the thread and its first comment in one transaction; the side is chosen by the route. */
export const createThreadWithFirstComment = async (
  transaction: ClientTransaction,
  input: {
    readonly clientId: string;
    readonly actorUserId: string;
    readonly side: ThreadSide;
    readonly subject: ThreadSubject;
    readonly body: string;
  }
): Promise<{ readonly threadId: string; readonly commentId: string } | undefined> => {
  const columns = subjectColumns(input.subject);
  const threadResult = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.client_threads (client_id, section_key, persona_id, opened_by, opened_side)
    values (?::uuid, ?, ?::uuid, ?::uuid, ?)
    returning id
  `, [input.clientId, columns.section_key, columns.persona_id, input.actorUserId, input.side]);
  const threadId = threadResult.rows[0]?.id;
  if (threadId === undefined) return undefined;

  const commentResult = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
    values (?::uuid, ?::uuid, ?::uuid, ?, ?)
    returning id
  `, [threadId, input.clientId, input.actorUserId, input.side, input.body]);
  const commentId = commentResult.rows[0]?.id;
  if (commentId === undefined) return undefined;
  return { threadId, commentId };
};

/** Adds one comment; the derived state reopens a resolved thread with no write to the thread. */
export const createThreadComment = async (
  transaction: ClientTransaction,
  input: {
    readonly clientId: string;
    readonly threadId: string;
    readonly actorUserId: string;
    readonly side: ThreadSide;
    readonly body: string;
  }
): Promise<string | undefined> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
    values (?::uuid, ?::uuid, ?::uuid, ?, ?)
    returning id
  `, [input.threadId, input.clientId, input.actorUserId, input.side, input.body]);
  return result.rows[0]?.id;
};

/**
 * Resolves an open thread. False means it was already resolved (or reopened by a comment the
 * update condition did not see), so the caller returns the current thread unchanged -- idempotent.
 */
export const resolveThread = async (
  transaction: ClientTransaction,
  input: { readonly clientId: string; readonly threadId: string; readonly actorUserId: string }
): Promise<boolean> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.client_threads thread
    set resolved_at = now(), resolved_by = ?::uuid
    where thread.id = ?::uuid and thread.client_id = ?::uuid
      and ${openThreadSql('thread')}
    returning thread.id
  `, [input.actorUserId, input.threadId, input.clientId]);
  return result.rows[0] !== undefined;
};

/** A persona used as a thread subject; scoped to the client so another client's persona is not found. */
export const loadPersonaSubject = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly personaId: string }
): Promise<{ readonly status: 'active' | 'archived' } | undefined> => {
  const result = await raw<RawRows<{ status: 'active' | 'archived' }>>(transaction, `
    select persona.status
    from public.client_personas persona
    join public.clients client on client.id = persona.client_id
    where persona.id = ?::uuid and persona.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.personaId, input.clientId, input.agencyId]);
  return result.rows[0];
};

export const threadSubjectFromRow = (row: ThreadRow): ThreadSubject =>
  row.section_key !== null
    ? { sectionKey: row.section_key as ConversationSectionKey }
    : { personaId: row.persona_id as string };

export const threadListItemFromRow = (row: ThreadRow): ThreadListItem => ({
  id: row.id,
  subject: threadSubjectFromRow(row),
  state: row.is_open ? 'open' : 'resolved',
  openedBy: { name: row.opened_by_name, side: row.opened_side },
  lastComment: row.last_comment_side === null || row.last_comment_at === null
    ? null
    : {
        side: row.last_comment_side,
        at: new Date(row.last_comment_at).toISOString(),
        excerpt: row.last_comment_excerpt ?? ''
      },
  commentCount: Number(row.comment_count),
  resolvedBy: row.resolved_at === null ? null : { name: row.resolved_by_name },
  resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString()
});

/** `photoUrl` is already signed (or null) by the caller from `CommentRow.author_image`. */
export const threadCommentFromRow = (row: CommentRow, photoUrl: string | null): ThreadComment => ({
  id: row.id,
  body: row.body,
  side: row.author_side,
  author: row.author_name === null ? null : { name: row.author_name, photoUrl },
  createdAt: new Date(row.created_at).toISOString()
});
