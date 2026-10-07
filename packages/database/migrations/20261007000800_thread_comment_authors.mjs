// Issues #128 and #130. Forward-only, like every migration in this repo.
//
// Structural per docs/business/structural-changes.md (a new `security definer` read function over
// RLS-protected tables); recorded in docs/business/decisions/2026-10-07-autor-do-comentario-pelo-vinculo.md.
//
// A comment shows who wrote it, and that name is the one on the person's link (`agency_memberships`
// for the agency side, `client_memberships` for the client side), never a bare `auth."user"` read
// (`auth."user"` has no RLS). Under RLS the portal cannot read those links: `agency_memberships`
// shows an agency's links only to its members, and `client_memberships` shows a client's links only
// to their owner or to the agency. So the agency and the portal could not share one author query.
//
// This function is the single read path both sides use. It is `security definer` and single
// purpose: for one thread, the people who commented on it and the one who resolved it (always on
// the agency side), as {user, side, name, photo key} and nothing else. The access check repeats the `client_threads_select` predicate, built from the
// same functions the policy calls (`is_agency_member`, `is_client_member`, `client_agency_id`) and
// the same persona-active rule for the portal. A caller who cannot read the thread gets zero rows,
// exactly like a thread that does not exist, so the function is not an existence oracle.
//
// A removed link still answers: the comment is history, and the name that signed it stays.
// `search_path` is empty and every object is schema-qualified, like the other definer functions.

export async function up(knex) {
  await knex.raw(`
    create function app_private.thread_comment_authors(p_thread_id uuid)
    returns table (author_user_id uuid, author_side text, name text, photo_key text)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      with readable_thread as (
        select thread.id, thread.client_id, thread.resolved_by
        from public.client_threads thread
        where thread.id = p_thread_id
          and (
            app_private.is_agency_member(app_private.client_agency_id(thread.client_id))
            or (
              app_private.is_client_member(thread.client_id)
              and (
                thread.persona_id is null
                or exists (
                  select 1 from public.client_personas persona
                  where persona.id = thread.persona_id and persona.status = 'active'
                )
              )
            )
          )
      ),
      authors as (
        select comment.author_user_id, comment.author_side, readable_thread.client_id
        from readable_thread
        join public.client_thread_comments comment on comment.thread_id = readable_thread.id
        union
        -- Only the agency resolves (rule 9), so the resolver is read through the agency link.
        select readable_thread.resolved_by, 'agency'::text, readable_thread.client_id
        from readable_thread
        where readable_thread.resolved_by is not null
      )
      select authors.author_user_id, authors.author_side, member.name, member.image
      from authors
      join public.agency_memberships link
        on authors.author_side = 'agency'
       and link.user_id = authors.author_user_id
       and link.agency_id = app_private.client_agency_id(authors.client_id)
      join auth."user" member on member.id = link.user_id
      union all
      select authors.author_user_id, authors.author_side, member.name, member.image
      from authors
      join public.client_memberships link
        on authors.author_side = 'client'
       and link.user_id = authors.author_user_id
       and link.client_id = authors.client_id
      join auth."user" member on member.id = link.user_id
    $function$;

    revoke all on function app_private.thread_comment_authors(uuid) from public;
    grant execute on function app_private.thread_comment_authors(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
