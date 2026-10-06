/**
 * The one definition of a thread's derived state (specs/clientes.md section 4). A thread is open
 * when it has no resolution or its resolution is not later than its latest comment, and its side is the
 * side of that latest comment. The clients listing (#125), the portal (#129) and the conversation
 * routes must import these instead of restating the rule, so "aguardando a agência" and "com
 * resposta da agência" can never diverge between screens.
 *
 * The alias is interpolated by the caller and is always a fixed literal chosen in this repository,
 * never a request value.
 */

/** The side of a thread's latest comment, or NULL when it has none. */
export const latestCommentSideSql = (threadAlias: string): string =>
  `(select comment.author_side from public.client_thread_comments comment where comment.thread_id = ${threadAlias}.id order by comment.created_at desc, comment.id desc limit 1)`;

/**
 * True while the thread is open: no resolution, or a resolution that is not strictly later than its
 * latest comment (the SPEC calls a thread resolved only when the resolution is posterior to it, so a
 * tie keeps the thread open and never swallows a comment).
 */
export const openThreadSql = (threadAlias: string): string =>
  `(${threadAlias}.resolved_at is null or ${threadAlias}.resolved_at <= (select max(comment.created_at) from public.client_thread_comments comment where comment.thread_id = ${threadAlias}.id))`;

/** Open and last commented by the client: the thread is waiting for the agency to answer. */
export const awaitingAgencySql = (threadAlias: string): string =>
  `(${openThreadSql(threadAlias)} and ${latestCommentSideSql(threadAlias)} = 'client')`;

/** Open and last commented by the agency: the thread already has the agency's answer. */
export const answeredByAgencySql = (threadAlias: string): string =>
  `(${openThreadSql(threadAlias)} and ${latestCommentSideSql(threadAlias)} = 'agency')`;
