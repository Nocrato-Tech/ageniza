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
 * A thread of the brand study: not the conversation of a content (Conteúdo's) and not a request for material (the agency's ask,
 * not a suggestion of the client). The badges of the agency and the Início of the portal count these alone.
 */
export const brandStudyThreadSql = (threadAlias: string): string =>
  `(${threadAlias}.content_id is null and not ${threadAlias}.is_material_request)`;

/**
 * The open requests for material of one client, aliased `thread`, each with the first comment (`asked`, what the agency wrote). One
 * placeholder: the client id. The list of the portal and the count of its navigation are both built on this, so the two cannot differ.
 */
export const OPEN_MATERIAL_REQUESTS_FROM = `
  from public.client_threads thread
  cross join lateral (
    select comment.body
    from public.client_thread_comments comment
    where comment.thread_id = thread.id
    order by comment.created_at asc, comment.id asc
    limit 1
  ) asked
  where thread.client_id = ?::uuid
    and thread.is_material_request
    and ${openThreadSql('thread')}
`;
