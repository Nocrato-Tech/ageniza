// Issue #250. Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-10-01-conteudo-impacto-estrutural.md (point 2) and
// docs/business/decisions/2026-10-07-conteudo-conversa-do-conteudo-no-banco.md, which records what the SPEC leaves
// open. It alters `client_threads` and replaces its three policies and the two of `client_thread_comments`.
//
// specs/conteudo.md §3 (`client_threads.content_id`), §5 rules 1, 2 and 13, §6.
//
//  - `content_id` is one more subject of a thread (exactly one of section, persona or content), tied to the client
//    of the content by a composite foreign key, and unique: one conversation per content.
//  - The conversation of a content is client-facing, so it exists only while the content is open to the client
//    ("awaiting approval", "adjusting", "approved", "published"), for BOTH sides: the agency writes with
//    `conteudo.operar` and `conteudo.visualizar` (not `cliente.operar`), the portal with an active link. A comment
//    written in production would otherwise surface to the client the day the content is sent.
//  - Reading: the agency reads a content thread with `conteudo.visualizar` (every collaborator reads the other
//    threads, so Sales and Finance would read the conversation of a content they may not see); the portal only
//    through `app_private.content_open_to_client`. The comments are read through the thread, which is the only
//    place the rule lives, and `app_private.thread_comment_authors` follows the same predicate, so the names of the
//    authors of a conversation the portal may not read never leak.
//  - The reopening by a client comment (#212) is untouched: the constraint trigger fires for any thread.
//  - `app_private.request_content_changes` is the transition "awaiting approval" -> "adjusting": a person of the
//    portal, with the revision they saw and a comment that enters the conversation of the content in the same
//    transaction, so a request for changes without a comment cannot exist.
//
// Error codes added to the ones of 20261007001200_contents.mjs: none; the function answers A0060, A0062, A0063
// and A0068 as the other portal function (`approve_content`) does.

// Spaces, the characters that draw nothing (zero-width, joiners, direction marks, the byte order mark) and control characters.
const isBlank = (column) =>
  `regexp_replace(${column}, '[[:space:]\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2060\\u3000\\ufeff]+', '', 'g') = ''`;

const OPEN_TO_CLIENT = "('awaiting_approval', 'adjusting', 'approved', 'published')";

export async function up(knex) {
  await knex.raw(`
    alter table public.client_threads
      add column content_id uuid null,
      add constraint client_threads_content_fk foreign key (content_id, client_id)
        references public.contents (id, client_id),
      drop constraint client_threads_subject_check,
      add constraint client_threads_subject_check check (num_nonnulls(section_key, persona_id, content_id) = 1);
    create unique index client_threads_content_key on public.client_threads (content_id) where content_id is not null;

    grant insert (content_id) on public.client_threads to ageniza_app;

    -- The agency writes in the conversation of a content when the content is open to the client and the caller may operate and
    -- read it. It is one function so that no rule depends on what a sub-select reads under the policies of another table.
    create function app_private.content_open_to_agency_writer(p_content_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1 from public.contents content
        where content.id = p_content_id
          and content.status in ${OPEN_TO_CLIENT}
          and app_private.has_agency_permission(app_private.client_agency_id(content.client_id), 'conteudo.operar')
          and app_private.has_agency_permission(app_private.client_agency_id(content.client_id), 'conteudo.visualizar')
      )
    $function$;
    revoke all on function app_private.content_open_to_agency_writer(uuid) from public;
    grant execute on function app_private.content_open_to_agency_writer(uuid) to ageniza_app;

    drop policy client_threads_select on public.client_threads;
    drop policy client_threads_insert on public.client_threads;
    drop policy client_threads_resolve on public.client_threads;
    drop policy client_thread_comments_select on public.client_thread_comments;
    drop policy client_thread_comments_insert on public.client_thread_comments;

    create policy client_threads_select on public.client_threads
      for select to ageniza_app
      using (
        (content_id is null and app_private.is_agency_member(app_private.client_agency_id(client_id)))
        or (
          content_id is not null
          and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
        )
        or (
          app_private.is_client_member(client_id)
          and (
            (
              content_id is null
              and (
                persona_id is null
                or exists (select 1 from public.client_personas persona where persona.id = persona_id and persona.status = 'active')
              )
            )
            or (content_id is not null and app_private.content_open_to_client(content_id))
          )
        )
      );

    create policy client_threads_insert on public.client_threads
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and opened_by = app_private.current_user_id()
        and (
          (
            content_id is null
            and (
              (opened_side = 'agency' and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar'))
              or (opened_side = 'client' and app_private.is_client_member(client_id))
            )
          )
          or (
            content_id is not null
            and (
              (opened_side = 'agency' and app_private.content_open_to_agency_writer(content_id))
              or (opened_side = 'client' and app_private.content_open_to_client(content_id))
            )
          )
        )
        and (
          persona_id is null
          or exists (select 1 from public.client_personas persona where persona.id = persona_id and persona.status = 'active')
        )
      );

    create policy client_threads_resolve on public.client_threads
      for update to ageniza_app
      using (
        app_private.client_is_active(client_id)
        and (
          (content_id is null and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar'))
          or (
            content_id is not null
            and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
            and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
          )
        )
        and (
          persona_id is null
          or exists (select 1 from public.client_personas persona where persona.id = persona_id and persona.status = 'active')
        )
      )
      with check (
        app_private.client_is_active(client_id)
        and (
          (content_id is null and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar'))
          or (
            content_id is not null
            and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
            and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
          )
        )
        and resolved_by = app_private.current_user_id()
      );

    create policy client_thread_comments_select on public.client_thread_comments
      for select to ageniza_app
      using (exists (select 1 from public.client_threads thread where thread.id = thread_id));

    create policy client_thread_comments_insert on public.client_thread_comments
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and author_user_id = app_private.current_user_id()
        and exists (
          select 1
          from public.client_threads thread
          left join public.client_personas persona on persona.id = thread.persona_id
          where thread.id = thread_id
            and thread.client_id = client_thread_comments.client_id
            and (thread.persona_id is null or persona.status = 'active')
            and (
              (
                client_thread_comments.author_side = 'agency'
                and (
                  (
                    thread.content_id is null
                    and app_private.has_agency_permission(app_private.client_agency_id(client_thread_comments.client_id), 'cliente.operar')
                  )
                  or (thread.content_id is not null and app_private.content_open_to_agency_writer(thread.content_id))
                )
              )
              or (
                client_thread_comments.author_side = 'client'
                and (
                  (thread.content_id is null and app_private.is_client_member(client_thread_comments.client_id))
                  or (thread.content_id is not null and app_private.content_open_to_client(thread.content_id))
                )
              )
            )
        )
      );
  `);

  await knex.raw(`
    create or replace function app_private.thread_comment_authors(p_thread_id uuid)
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
            (thread.content_id is null and app_private.is_agency_member(app_private.client_agency_id(thread.client_id)))
            or (
              thread.content_id is not null
              and app_private.has_agency_permission(app_private.client_agency_id(thread.client_id), 'conteudo.visualizar')
            )
            or (
              app_private.is_client_member(thread.client_id)
              and (
                (
                  thread.content_id is null
                  and (
                    thread.persona_id is null
                    or exists (
                      select 1 from public.client_personas persona
                      where persona.id = thread.persona_id and persona.status = 'active'
                    )
                  )
                )
                or (thread.content_id is not null and app_private.content_open_to_client(thread.content_id))
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
  `);

  await knex.raw(`
    create function app_private.request_content_changes(p_content_id uuid, p_revision integer, p_body text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
      v_thread_id uuid;
      v_actor uuid := app_private.current_user_id();
    begin
      select content.client_id, content.status into v_client_id, v_status
      from public.contents content
      where content.id = p_content_id;

      -- Same door as approve_content: only an active person of the portal of this client, and a content the portal
      -- cannot open yet is "not found" for it.
      if not found or not app_private.is_client_member(v_client_id) or (
        v_status not in ${OPEN_TO_CLIENT}
        and not app_private.has_agency_permission(app_private.client_agency_id(v_client_id), 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if p_body is null or ${isBlank('p_body')} or octet_length(p_body) > 5000 then
        raise exception using errcode = 'A0068', message = 'A request for changes carries its comment.';
      end if;

      -- The client is locked before the content, the order archive_client takes: a request that waits for the archiving of the
      -- client finds it archived and answers "not found", instead of moving the content and writing a comment after the archive.
      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id
      for update;

      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval gets a request for changes.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
      insert into public.client_threads (client_id, content_id, opened_by, opened_side)
      values (v_client_id, p_content_id, v_actor, 'client')
      on conflict (content_id) where content_id is not null do nothing;

      select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

      insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
      values (v_thread_id, v_client_id, v_actor, 'client', p_body);

      update public.contents set status = 'adjusting' where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.request_content_changes(uuid, integer, text) from public;
    grant execute on function app_private.request_content_changes(uuid, integer, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
