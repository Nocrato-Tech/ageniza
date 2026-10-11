/**
 * The one definition of a thread's derived state (specs/clientes.md section 4). A thread is open
 * when it has no resolution or its resolution predates its latest comment, and its side is the
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

/** True while the thread is open: no resolution, or a resolution older than its latest comment. */
export const openThreadSql = (threadAlias: string): string =>
  `(${threadAlias}.resolved_at is null or ${threadAlias}.resolved_at < (select max(comment.created_at) from public.client_thread_comments comment where comment.thread_id = ${threadAlias}.id))`;

/**
 * True for a thread about the brand study (a section or a persona). A content's conversation is the
 * third subject of `client_threads` and is read from the Conteúdos screens, so the brand-study
 * counters (the card's "aguardando a agência", the detail summary and the portal's "com resposta da
 * agência") leave it out: a comment on a post never lights the brand study's badge.
 */
export const brandStudyThreadSql = (threadAlias: string): string => `${threadAlias}.content_id is null`;
