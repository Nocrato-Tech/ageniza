// The same note sent again on an approved content is a success (decision 2026-11-12, "reenviar o mesmo recado ao aprovar conta como sucesso").
// Forward-only, like every migration here.
//
// `approve_content(uuid, integer, text)` is the one of 20261112000200 (which has the notification). Only the branch of an approved content that
// carries a note changes: it still answers A0123, unless the call is the one that approved it again: the same person who approved
// (`approved_by`), the same revision the content is at, and a note identical to the comment that approval wrote. Then it returns, writing
// nothing and notifying nobody. The link between the note and the approval is `created_at = approved_at`: the comment takes its `created_at`
// from the column default `now()` and the state change takes `approved_at` from `pg_catalog.now()` in `contents_guard`, both the start of the
// transaction of the call, and no trigger on the comments rewrites `created_at`. A comment written later, by the same person or by another,
// never has the instant of the approval. Everything else (door, locks, the note's rule, the other branches) and the grants are unchanged.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.approve_content(p_content_id uuid, p_revision integer, p_note text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
      v_approved_by uuid;
      v_approved_at timestamptz;
      v_thread_id uuid;
      v_actor uuid := app_private.current_user_id();
    begin
      select content.client_id, content.status into v_client_id, v_status
      from public.contents content
      where content.id = p_content_id;

      if not found or not app_private.is_client_member(v_client_id) or (
        v_status not in ('awaiting_approval', 'adjusting', 'approved', 'published')
        and not app_private.has_agency_permission(app_private.client_agency_id(v_client_id), 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if not app_private.approval_note_is_valid(p_note) then
        raise exception using errcode = 'A0068', message = 'The note to the agency is up to 500 characters and not blank.';
      end if;

      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision, content.approved_by, content.approved_at
      into v_status, v_revision, v_approved_by, v_approved_at
      from public.contents content
      where content.id = p_content_id
      for update;

      if v_status = 'approved' then
        if p_note is not null and not (
          p_revision is not distinct from v_revision
          and v_approved_by is not distinct from v_actor
          and exists (
            select 1
            from public.client_threads thread
            join public.client_thread_comments comment on comment.thread_id = thread.id
            where thread.content_id = p_content_id
              and comment.author_user_id = v_actor
              and comment.author_side = 'client'
              and comment.body = p_note
              and comment.created_at = v_approved_at
          )
        ) then
          raise exception using errcode = 'A0123', message = 'The content is already approved and the note was not written.';
        end if;
        return;
      end if;
      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval is approved.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      update public.contents set status = 'approved' where id = p_content_id;

      if p_note is not null then
        -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
        insert into public.client_threads (client_id, content_id, opened_by, opened_side)
        values (v_client_id, p_content_id, v_actor, 'client')
        on conflict (content_id) where content_id is not null do nothing;

        select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        values (v_thread_id, v_client_id, v_actor, 'client', p_note);
      end if;

      perform app_private.notify_content_owner('content_approved', p_content_id);
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
