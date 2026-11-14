// A note on a content that is already approved (scope redesign-igual, subtask A2, security review round 1). Forward-only, like every migration here.
//
// Decision: docs/business/decisions/2026-11-11-recado-em-conteudo-ja-aprovado.md. The approval of 20261111000202 answered a call with a note
// on an approved content with a quiet return: the second person of the portal was told "approved" and the agency never read what they wrote.
// Now a note that would be dropped is refused (A0123), as the send of the agency refuses a repeat with another deadline or note (A0062).
//
// Only the branch of an approved content changes; the door, the locks, the note's rule and the refusals are those of 20261111000202, and so
// are the grants. The check lives here, after the lock of the content, because that is where two people approving at the same moment are
// told apart: a route that read the state first would still drop the note of the one who lost the race. Without a note, the call on an
// approved content stays the quiet, idempotent success it was.
//
// Error code: A0123, the content is already approved and the note was not written.

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

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id
      for update;

      if v_status = 'approved' then
        if p_note is not null then
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
    end;
    $function$;
    revoke all on function app_private.approve_content(uuid, integer, text) from public;
    grant execute on function app_private.approve_content(uuid, integer, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
