import { randomUUID } from 'node:crypto';

import type { BrandSectionKey, ConversationSide, Thread, ThreadState, ThreadSubject } from '@ageniza/contracts';
import { raw, type SqlBinding } from '@ageniza/database';

import { THREAD_EXCERPT_LENGTH } from './policy.js';
import { loadClient, sectionFilledSql, type ClientTransaction } from './service.js';
import { latestCommentSideSql, openThreadSql } from './thread-state.js';

/**
 * The conversation between an agency and a client (specs/clientes.md sections 3, 4 and 6), written
 * once for both sides. The agency routes (#128) and the portal routes (#130) call these same
 * functions and differ only in the `ConversationScope`: who is writing and which side that stamps.
 * Two implementations of "open", "resolved" and "who wrote this" would drift within weeks, so a rule
 * lives here or it does not live in a route.
 *
 * The side of a thread or comment is never an input: it comes from the scope, which a route builds
 * from its own guard. Row-level security is the second barrier on every statement, and a refusal of
 * it that reaches a route is read back by `diagnoseConversationRefusal`.
 */
export type ConversationScope =
  | { readonly side: 'agency'; readonly agencyId: string; readonly clientId: string; readonly userId: string }
  | { readonly side: 'client'; readonly clientId: string; readonly userId: string };

/** Why a conversation write or read finds nothing to act on; the route maps each to one HTTP error. */
export type ConversationRefusal =
  | 'client-not-found'
  | 'client-archived'
  | 'subject-not-found'
  | 'persona-archived'
  | 'section-not-filled'
  | 'thread-not-found';

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** The policy refused a write the checks before it let through: the row changed under the request. */
export class ConversationWriteRefused extends Error {
  constructor() {
    super('The conversation write was refused by row-level security.');
    this.name = 'ConversationWriteRefused';
  }
}

export interface ThreadRow {
  readonly id: string;
  readonly section_key: BrandSectionKey | null;
  readonly persona_id: string | null;
  readonly opened_by: string;
  readonly opened_side: ConversationSide;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly comment_count: string | number;
  readonly last_comment_at: Date;
  readonly last_side: ConversationSide;
  readonly excerpt: string;
  readonly is_open: boolean;
}

export interface CommentRow {
  readonly id: string;
  readonly body: string;
  readonly author_user_id: string;
  readonly author_side: ConversationSide;
  readonly created_at: Date;
}

interface AuthorRow {
  readonly thread_id: string;
  readonly author_user_id: string;
  readonly author_side: ConversationSide;
  readonly name: string;
  readonly photo_key: string | null;
}

export interface ConversationAuthor {
  readonly name: string;
  readonly photoKey: string | null;
}

/** Authors of a set of threads, keyed by thread, side and user: the side is part of who someone signed as. */
export type ConversationAuthors = ReadonlyMap<string, ConversationAuthor>;

const authorKey = (threadId: string, side: ConversationSide, userId: string): string => `${threadId}:${side}:${userId}`;

export const authorOf = (authors: ConversationAuthors, threadId: string, side: ConversationSide, userId: string): ConversationAuthor | undefined =>
  authors.get(authorKey(threadId, side, userId));

/**
 * Names and photo keys come from `app_private.thread_comment_authors`, which reads the link of each
 * comment's own side and answers only for a caller who can read the thread. `auth."user"` is never
 * read from here.
 */
export const loadAuthors = async (transaction: ClientTransaction, threadIds: readonly string[]): Promise<ConversationAuthors> => {
  if (threadIds.length === 0) return new Map();
  const result = await raw<RawRows<AuthorRow>>(transaction, `
    select thread.id as thread_id, author.author_user_id, author.author_side, author.name, author.photo_key
    from public.client_threads thread
    cross join lateral app_private.thread_comment_authors(thread.id) author
    where thread.id in (${threadIds.map(() => '?::uuid').join(', ')})
  `, [...threadIds]);
  return new Map(result.rows.map((row) => [
    authorKey(row.thread_id, row.author_side, row.author_user_id),
    { name: row.name, photoKey: row.photo_key }
  ]));
};

// `openThreadSql` and `latestCommentSideSql` are the single definition of the derived state; the
// statistics below only add what a thread item shows.
const THREAD_COLUMNS = `
  thread.id, thread.section_key, thread.persona_id, thread.opened_by, thread.opened_side,
  thread.resolved_at, thread.resolved_by,
  stats.comment_count, stats.last_comment_at,
  ${latestCommentSideSql('thread')} as last_side,
  last_comment.excerpt,
  ${openThreadSql('thread')} as is_open
`;

const THREAD_FROM = `
  from public.client_threads thread
  cross join lateral (
    select count(*) as comment_count, max(comment.created_at) as last_comment_at
    from public.client_thread_comments comment
    where comment.thread_id = thread.id
  ) stats
  cross join lateral (
    select left(regexp_replace(comment.body, '\\s+', ' ', 'g'), ${THREAD_EXCERPT_LENGTH}) as excerpt
    from public.client_thread_comments comment
    where comment.thread_id = thread.id
    order by comment.created_at desc, comment.id desc
    limit 1
  ) last_comment
`;

export const threadFromRow = (row: ThreadRow, authors: ConversationAuthors): Thread => {
  const state: ThreadState = row.is_open ? 'open' : 'resolved';
  const resolved = state === 'resolved' && row.resolved_at !== null && row.resolved_by !== null;
  return {
    id: row.id,
    subject: row.section_key !== null ? { sectionKey: row.section_key } : { personaId: row.persona_id ?? '' },
    state,
    openedBy: { name: authorOf(authors, row.id, row.opened_side, row.opened_by)?.name ?? null, side: row.opened_side },
    lastComment: { side: row.last_side, at: new Date(row.last_comment_at).toISOString(), excerpt: row.excerpt },
    commentCount: Number(row.comment_count),
    // A thread that a later comment reopened keeps its old stamps in the row, but it is not resolved
    // anymore: showing who resolved it and when would describe a state the thread is no longer in.
    resolvedBy: resolved ? { name: authorOf(authors, row.id, 'agency', row.resolved_by ?? '')?.name ?? null } : null,
    resolvedAt: resolved ? new Date(row.resolved_at ?? 0).toISOString() : null
  };
};

export const loadThreadRow = async (
  transaction: ClientTransaction,
  input: { readonly clientId: string; readonly threadId: string }
): Promise<ThreadRow | undefined> => {
  const result = await raw<RawRows<ThreadRow>>(transaction, `
    select ${THREAD_COLUMNS}
    ${THREAD_FROM}
    where thread.id = ?::uuid and thread.client_id = ?::uuid
  `, [input.threadId, input.clientId]);
  return result.rows[0];
};

interface SubjectPersonaRow {
  readonly id: string;
  readonly status: 'active' | 'archived';
}

/**
 * The persona of a subject, inside the client. Row-level security hides an archived persona from the
 * portal, so there it is "not found" exactly like a persona of another client; the agency sees it and
 * tells the two apart by `status`.
 */
const loadSubjectPersona = async (
  transaction: ClientTransaction,
  input: { readonly clientId: string; readonly personaId: string }
): Promise<SubjectPersonaRow | undefined> => {
  const result = await raw<RawRows<SubjectPersonaRow>>(transaction, `
    select id, status from public.client_personas where id = ?::uuid and client_id = ?::uuid
  `, [input.personaId, input.clientId]);
  return result.rows[0];
};

/** `personas` is filled by an active persona; every other section by its own row, per `sectionFilledSql`. */
const isSectionFilled = async (transaction: ClientTransaction, clientId: string, sectionKey: BrandSectionKey): Promise<boolean> => {
  if (sectionKey === 'personas') {
    const result = await raw<RawRows<{ filled: boolean }>>(transaction, `
      select exists (select 1 from public.client_personas persona where persona.client_id = ?::uuid and persona.status = 'active') as filled
    `, [clientId]);
    return result.rows[0]?.filled === true;
  }
  const result = await raw<RawRows<{ filled: boolean }>>(transaction, `
    select exists (
      select 1 from public.client_brand_sections section
      where section.client_id = ?::uuid and section.section_key = ? and ${sectionFilledSql('section')}
    ) as filled
  `, [clientId, sectionKey]);
  return result.rows[0]?.filled === true;
};

/** The agency's client must be in the agency of the route; the portal's client was proven by its guard. */
const checkClient = async (transaction: ClientTransaction, scope: ConversationScope): Promise<ConversationRefusal | undefined> => {
  if (scope.side === 'client') return undefined;
  const client = await loadClient(transaction, { agencyId: scope.agencyId, clientId: scope.clientId });
  if (client === undefined) return 'client-not-found';
  return client.status === 'archived' ? 'client-archived' : undefined;
};

/** Who may start a thread on this subject, and whether the subject exists for them. */
const checkSubject = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  subject: ThreadSubject,
  options: { readonly forWrite: boolean }
): Promise<ConversationRefusal | undefined> => {
  if ('personaId' in subject) {
    const persona = await loadSubjectPersona(transaction, { clientId: scope.clientId, personaId: subject.personaId });
    if (persona === undefined) return 'subject-not-found';
    return options.forWrite && persona.status === 'archived' ? 'persona-archived' : undefined;
  }
  // The portal never offers "Sugerir" on a section the agency has not filled; the route guarantees it.
  if (options.forWrite && scope.side === 'client' && !(await isSectionFilled(transaction, scope.clientId, subject.sectionKey))) {
    return 'section-not-filled';
  }
  return undefined;
};

export type OpenThreadResult =
  | { readonly kind: 'ok'; readonly threadId: string; readonly commentId: string }
  | { readonly kind: ConversationRefusal };

const insertComment = async (
  transaction: ClientTransaction,
  input: { readonly threadId: string; readonly clientId: string; readonly userId: string; readonly side: ConversationSide; readonly body: string }
): Promise<string> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
    values (?::uuid, ?::uuid, ?::uuid, ?, ?)
    returning id
  `, [input.threadId, input.clientId, input.userId, input.side, input.body]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Comment insert did not return a row.');
  return id;
};

/** Opens a thread and writes its first comment in the same transaction, on the side of the scope. */
export const openThread = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  input: { readonly subject: ThreadSubject; readonly body: string }
): Promise<OpenThreadResult> => {
  const clientRefusal = await checkClient(transaction, scope);
  if (clientRefusal !== undefined) return { kind: clientRefusal };
  const subjectRefusal = await checkSubject(transaction, scope, input.subject, { forWrite: true });
  if (subjectRefusal !== undefined) return { kind: subjectRefusal };

  const threadId = randomUUID();
  await raw(transaction, `
    insert into public.client_threads (id, client_id, section_key, persona_id, opened_by, opened_side)
    values (?::uuid, ?::uuid, ?, ?::uuid, ?::uuid, ?)
  `, [
    threadId,
    scope.clientId,
    'sectionKey' in input.subject ? input.subject.sectionKey : null,
    'personaId' in input.subject ? input.subject.personaId : null,
    scope.userId,
    scope.side
  ]);
  const commentId = await insertComment(transaction, { threadId, clientId: scope.clientId, userId: scope.userId, side: scope.side, body: input.body });
  return { kind: 'ok', threadId, commentId };
};

interface ThreadContextRow {
  readonly persona_status: 'active' | 'archived' | null;
  readonly client_status: 'active' | 'archived';
}

/**
 * The thread as the caller can reach it: inside the client, and for the agency inside the agency of
 * the route. Nothing is returned for a thread the caller cannot read, which covers another client's
 * thread, another agency's, a missing one and, for the portal, one about an archived persona.
 */
const loadThreadContext = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  threadId: string
): Promise<ThreadContextRow | undefined> => {
  const conditions = ['thread.id = ?::uuid', 'thread.client_id = ?::uuid'];
  const bindings: SqlBinding[] = [threadId, scope.clientId];
  if (scope.side === 'agency') {
    conditions.push('client.agency_id = ?::uuid');
    bindings.push(scope.agencyId);
  }
  const result = await raw<RawRows<ThreadContextRow>>(transaction, `
    select persona.status as persona_status, client.status as client_status
    from public.client_threads thread
    join public.clients client on client.id = thread.client_id
    left join public.client_personas persona on persona.id = thread.persona_id
    where ${conditions.join(' and ')}
  `, bindings);
  return result.rows[0];
};

const refusalOfContext = (context: ThreadContextRow | undefined): ConversationRefusal | undefined => {
  if (context === undefined) return 'thread-not-found';
  if (context.client_status === 'archived') return 'client-archived';
  return context.persona_status === 'archived' ? 'persona-archived' : undefined;
};

export type AddCommentResult =
  | { readonly kind: 'ok'; readonly commentId: string }
  | { readonly kind: ConversationRefusal };

/** Comments on a thread on the side of the scope; a comment on a resolved thread reopens it by its date. */
export const addComment = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  input: { readonly threadId: string; readonly body: string }
): Promise<AddCommentResult> => {
  const refusal = refusalOfContext(await loadThreadContext(transaction, scope, input.threadId));
  if (refusal !== undefined) return { kind: refusal };
  const commentId = await insertComment(transaction, {
    threadId: input.threadId,
    clientId: scope.clientId,
    userId: scope.userId,
    side: scope.side,
    body: input.body
  });
  return { kind: 'ok', commentId };
};

export type ResolveThreadResult =
  | { readonly kind: 'ok' }
  | { readonly kind: ConversationRefusal };

/**
 * Stamps the resolution. Only the agency resolves; a portal scope never reaches this function.
 * Resolving a thread that is already resolved writes nothing, so the first resolver and moment stay.
 */
export const resolveThread = async (
  transaction: ClientTransaction,
  scope: Extract<ConversationScope, { readonly side: 'agency' }>,
  threadId: string
): Promise<ResolveThreadResult> => {
  const refusal = refusalOfContext(await loadThreadContext(transaction, scope, threadId));
  if (refusal !== undefined) return { kind: refusal };

  const current = await loadThreadRow(transaction, { clientId: scope.clientId, threadId });
  if (current === undefined) return { kind: 'thread-not-found' };
  if (!current.is_open) return { kind: 'ok' };

  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.client_threads
    set resolved_at = now(), resolved_by = ?::uuid
    where id = ?::uuid and client_id = ?::uuid
    returning id
  `, [scope.userId, threadId, scope.clientId]);
  if (result.rows.length !== 1) throw new ConversationWriteRefused();
  return { kind: 'ok' };
};

export interface ThreadPage {
  readonly items: readonly ThreadRow[];
  readonly totalItems: number;
}

export type ListThreadsResult =
  | { readonly kind: 'ok'; readonly page: ThreadPage }
  | { readonly kind: ConversationRefusal };

/**
 * One subject's threads, the most recently active first. The subject is required by the contract and
 * is checked here against the client, so a persona of another client is "not found" for both sides.
 * `count(*) over ()` rides the page's own snapshot, so the total and the page cannot describe two
 * states of the table.
 */
export const listThreads = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  input: { readonly subject: ThreadSubject; readonly state?: ThreadState },
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<ListThreadsResult> => {
  const clientRefusal = await checkClient(transaction, scope);
  // An archived client is read-only, not unreadable: only a missing client stops a read.
  if (clientRefusal === 'client-not-found') return { kind: clientRefusal };
  const subjectRefusal = await checkSubject(transaction, scope, input.subject, { forWrite: false });
  if (subjectRefusal !== undefined) return { kind: subjectRefusal };

  const conditions = ['thread.client_id = ?::uuid'];
  const bindings: SqlBinding[] = [scope.clientId];
  if ('sectionKey' in input.subject) {
    conditions.push('thread.section_key = ?');
    bindings.push(input.subject.sectionKey);
  } else {
    conditions.push('thread.persona_id = ?::uuid');
    bindings.push(input.subject.personaId);
  }
  if (input.state === 'open') conditions.push(openThreadSql('thread'));
  if (input.state === 'resolved') conditions.push(`not ${openThreadSql('thread')}`);
  const where = conditions.join(' and ');

  const result = await raw<RawRows<ThreadRow & { readonly total: string | number }>>(transaction, `
    select ${THREAD_COLUMNS}, count(*) over () as total
    ${THREAD_FROM}
    where ${where}
    order by stats.last_comment_at desc, thread.id desc
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) {
    return { kind: 'ok', page: { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) } };
  }
  // An empty first page is the whole truth; a second count could only answer from another snapshot.
  if (pagination.offset === 0) return { kind: 'ok', page: { items: [], totalItems: 0 } };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total ${THREAD_FROM} where ${where}
  `, bindings);
  return { kind: 'ok', page: { items: [], totalItems: Number(count.rows[0]?.total ?? 0) } };
};

export interface CommentPage {
  readonly items: readonly CommentRow[];
  readonly totalItems: number;
}

export type ListCommentsResult =
  | { readonly kind: 'ok'; readonly page: CommentPage }
  | { readonly kind: ConversationRefusal };

/** The comments of one thread, oldest first, with the same single-snapshot total as the thread list. */
export const listComments = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  threadId: string,
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<ListCommentsResult> => {
  if (await loadThreadContext(transaction, scope, threadId) === undefined) return { kind: 'thread-not-found' };

  const result = await raw<RawRows<CommentRow & { readonly total: string | number }>>(transaction, `
    select comment.id, comment.body, comment.author_user_id, comment.author_side, comment.created_at, count(*) over () as total
    from public.client_thread_comments comment
    where comment.thread_id = ?::uuid and comment.client_id = ?::uuid
    order by comment.created_at asc, comment.id asc
    limit ? offset ?
  `, [threadId, scope.clientId, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) {
    return { kind: 'ok', page: { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) } };
  }
  if (pagination.offset === 0) return { kind: 'ok', page: { items: [], totalItems: 0 } };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total from public.client_thread_comments comment
    where comment.thread_id = ?::uuid and comment.client_id = ?::uuid
  `, [threadId, scope.clientId]);
  return { kind: 'ok', page: { items: [], totalItems: Number(count.rows[0]?.total ?? 0) } };
};

export const loadComment = async (
  transaction: ClientTransaction,
  input: { readonly clientId: string; readonly threadId: string; readonly commentId: string }
): Promise<CommentRow | undefined> => {
  const result = await raw<RawRows<CommentRow>>(transaction, `
    select comment.id, comment.body, comment.author_user_id, comment.author_side, comment.created_at
    from public.client_thread_comments comment
    where comment.id = ?::uuid and comment.thread_id = ?::uuid and comment.client_id = ?::uuid
  `, [input.commentId, input.threadId, input.clientId]);
  return result.rows[0];
};

/**
 * Reads back why a write the earlier checks let through was refused by row-level security: the
 * client or the persona changed between the check and the write. The agency learns which (409); the
 * portal only learns that what it was looking at is gone (404). Runs in a fresh transaction, because
 * the one that was refused is aborted. `undefined` means neither changed, so the refusal was not a
 * state conflict and the route answers 403.
 */
export const diagnoseConversationRefusal = async (
  transaction: ClientTransaction,
  scope: ConversationScope,
  target: { readonly personaId?: string; readonly threadId?: string }
): Promise<ConversationRefusal | undefined> => {
  if (scope.side === 'client') return 'client-not-found';
  const clientRefusal = await checkClient(transaction, scope);
  if (clientRefusal !== undefined) return clientRefusal;
  if (target.threadId !== undefined) {
    const context = await loadThreadContext(transaction, scope, target.threadId);
    return context?.persona_status === 'archived' ? 'persona-archived' : undefined;
  }
  if (target.personaId !== undefined) {
    const persona = await loadSubjectPersona(transaction, { clientId: scope.clientId, personaId: target.personaId });
    return persona?.status === 'archived' ? 'persona-archived' : undefined;
  }
  return undefined;
};
