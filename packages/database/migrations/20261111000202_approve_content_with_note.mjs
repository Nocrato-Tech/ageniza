// Approving with a note (scope redesign-igual, subtask A2). Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md
// (item 2). The decision changes the function the portal approves with, so that it writes in the conversation of the content.
//
// `approve_content(uuid, integer, text)` is the approval of 20261007001400 with an optional note of the client. The note is a comment of
// the client in the conversation of the content, written in the same transaction as the state: a refused comment leaves the content
// awaiting approval, and an approval that is refused leaves no comment. The note follows the rule of the note of the agency (up to 500
// characters, not blank: `approval_note_is_valid`, one copy), and a content that is already approved gets neither a second approval nor
// a second comment (the first person to approve stays, and a repeated click is not a second note).
//
// The door, the locks (the client FOR SHARE, then the content FOR UPDATE) and the refusals are the ones of the function it replaces; they
// live in one place: `approve_content(uuid, integer)` stays, with the same signature and grants, as the call with no note.
//
// Error codes: the ones of the approval (A0060 not found or not allowed, A0062 not awaiting approval, A0063 the content changed since it
// was read) and A0068 for a note over the limit or blank. The agency in read-only mode is refused (A0090) by the trigger of the
// conversation, as it already was by the one of the content.

export async function up(knex) {
  await knex.raw(`
    create function app_private.approve_content(p_content_id uuid, p_revision integer, p_note text)
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

    create or replace function app_private.approve_content(p_content_id uuid, p_revision integer)
    returns void
    language sql
    security definer
    set search_path = ''
    as $function$
      select app_private.approve_content(p_content_id, p_revision, null::text)
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
