// Issues #251 and #284. Forward-only, and a new migration: the ones that created these objects are not edited.
//
// Recorded in docs/business/decisions/2026-10-07-arquivar-o-cliente-cancela-o-conteudo-e-trava-as-filhas.md; the
// shape of the lock is the one of docs/business/decisions/2026-10-06-estrutural-convite-de-portal-e-arquivamento-do-mesmo.md
// and 20261006000400_client_invitation_archive_serialization.mjs, which explains why it is an AFTER trigger, FOR SHARE
// and a security definer function.
//
// #251: archive_client and archive_due_clients cancel, in their own transaction, every content planned after the day the
// contract ends that is not published. The job cuts at the client's closing date; the route archives "now", which is a
// closing today (decision of 2026-09-26), so it cuts at today, or at an overdue closing date the job has not reached yet.
// The helper is not granted to anyone: it is called by the two archive functions and by nothing else, and cancel_content
// (which checks conteudo.cancelar) is the only other writer of "cancelled".
//
// #284: a row written into a child of the client while the archive is still uncommitted would survive it. Every table whose
// INSERT policy asks for an active client gets the AFTER INSERT trigger of the invitations; so does the only UPDATE that
// moves a content into the range the archive cancels (a new publish_on), which the archive's own scan could not see. The
// functions that move a child take the client FOR SHARE BEFORE the child's own lock, the order the archive takes (client,
// then contents), and read the status after the wait:
//   lock_content_for_agency (every agency function of a content), approve_content, lock_content_task.
// The refusal keeps the precedence each function already had; only the lock moves ahead.
//
// Error codes: A0020 from the trigger (the API translates it to 409 CLIENT_ARCHIVED), and the codes the functions
// already answered (A0060 for the portal, A0061 for the agency).

const CHILD_TABLES = [
  'client_brand_sections',
  'client_personas',
  'client_threads',
  'client_thread_comments',
  'media_folders',
  'media_assets',
  'story_scripts',
  'story_script_scenes',
  'contents',
  'content_tasks'
];

export async function up(knex) {
  await knex.raw(`
    create function app_private.lock_active_client_of_child()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      -- The owner (migrations, operations) is not constrained by RLS either; session_user cannot be changed by ageniza_app.
      -- A media of the agency's library has no client.
      if session_user <> 'ageniza_app' or new.client_id is null then
        return null;
      end if;

      perform 1 from public.clients where id = new.client_id and status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      return null;
    end;
    $function$;
    revoke all on function app_private.lock_active_client_of_child() from public;

    ${CHILD_TABLES.map((table) => `
    create trigger "0_${table}_lock_active_client"
      after insert on public.${table}
      for each row
      execute function app_private.lock_active_client_of_child();`).join('\n')}

    create trigger "0_contents_move_lock_active_client"
      after update of publish_on on public.contents
      for each row
      when (old.publish_on is distinct from new.publish_on)
      execute function app_private.lock_active_client_of_child();
  `);

  await knex.raw(`
    create function app_private.cancel_contents_after(p_client_id uuid, p_last_day date)
    returns void
    language sql
    security definer
    set search_path = ''
    as $function$
      update public.contents
      set status = 'cancelled'
      where client_id = p_client_id
        and status in ('in_production', 'awaiting_approval', 'adjusting', 'approved')
        and publish_on > p_last_day
    $function$;
    revoke all on function app_private.cancel_contents_after(uuid, date) from public;

    create or replace function app_private.archive_client(p_client_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_agency_id uuid;
      v_client public.clients%rowtype;
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
    begin
      select agency_id into v_agency_id from public.clients where id = p_client_id;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.has_agency_permission(v_agency_id, 'cliente.arquivar') then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      select * into v_client from public.clients where id = p_client_id for update;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if v_client.status = 'archived' then
        return;
      end if;

      update public.clients
      set status = 'archived',
          archived_at = pg_catalog.now(),
          closing_date = null,
          updated_at = pg_catalog.now()
      where id = v_client.id;

      update public.invitations
      set revoked_at = pg_catalog.now()
      where client_id = v_client.id
        and purpose = 'client_invite'
        and used_at is null
        and revoked_at is null;

      perform app_private.cancel_contents_after(v_client.id, least(coalesce(v_client.closing_date, v_today), v_today));

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('client.archived', app_private.current_user_id(), v_client.agency_id, 'client', v_client.id);
    end;
    $function$;

    create or replace function app_private.archive_due_clients()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
      v_client record;
      v_archived integer := 0;
    begin
      for v_client in
        select id, agency_id, closing_date
        from public.clients
        where status = 'active'
          and closing_date is not null
          and closing_date < v_today
        for update
      loop
        update public.clients
        set status = 'archived',
            archived_at = pg_catalog.now(),
            closing_date = null,
            updated_at = pg_catalog.now()
        where id = v_client.id;

        update public.invitations
        set revoked_at = pg_catalog.now()
        where client_id = v_client.id
          and purpose = 'client_invite'
          and used_at is null
          and revoked_at is null;

        perform app_private.cancel_contents_after(v_client.id, v_client.closing_date);

        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
        values ('client.archived', null, v_client.agency_id, 'client', v_client.id, 'job:clients.archive-due');

        v_archived := v_archived + 1;
      end loop;

      return v_archived;
    end;
    $function$;
  `);

  await knex.raw(`
    create or replace function app_private.lock_content_for_agency(p_content_id uuid, p_permission text)
    returns public.contents
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
      v_agency_id uuid;
      v_client_active boolean;
    begin
      select content.* into v_content from public.contents content where content.id = p_content_id;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      v_agency_id := app_private.client_agency_id(v_content.client_id);
      if not (
        app_private.has_agency_permission(v_agency_id, p_permission)
        and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      perform 1 from public.clients client where client.id = v_content.client_id and client.status = 'active' for share;
      v_client_active := found;

      select content.* into v_content from public.contents content where content.id = p_content_id for update;

      if not v_client_active then
        raise exception using errcode = 'A0061', message = 'The client is archived.';
      end if;

      return v_content;
    end;
    $function$;

    create or replace function app_private.approve_content(p_content_id uuid, p_revision integer)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
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
    end;
    $function$;

    create or replace function app_private.lock_content_task(p_task_id uuid, p_actor_must_approve boolean)
    returns public.content_tasks
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_task public.content_tasks;
      v_content public.contents;
      v_agency_id uuid;
      v_client_active boolean;
    begin
      select task.* into v_task from public.content_tasks task where task.id = p_task_id;
      if not found then
        raise exception using errcode = 'A0070', message = 'Content task not found.';
      end if;

      v_agency_id := app_private.client_agency_id(v_task.client_id);
      if not app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar') then
        raise exception using errcode = 'A0070', message = 'Content task not found.';
      end if;

      perform 1 from public.clients client where client.id = v_task.client_id and client.status = 'active' for share;
      v_client_active := found;

      -- The content is locked before the task, always in this order, and only FOR SHARE: submit_content takes it FOR UPDATE.
      select content.* into v_content from public.contents content where content.id = v_task.content_id for share;

      if p_actor_must_approve then
        if v_content.owner_user_id is distinct from app_private.current_user_id()
          and not app_private.has_agency_permission(v_agency_id, 'conteudo.aprovar_pela_agencia')
        then
          raise exception using errcode = 'A0074', message = 'Only the owner of the content, or who approves for the agency, approves a task.';
        end if;
      elsif v_task.assignee_user_id is distinct from app_private.current_user_id() then
        raise exception using errcode = 'A0074', message = 'Only the person in charge of a task delivers it.';
      end if;

      select task.* into v_task from public.content_tasks task where task.id = p_task_id for update;

      if not v_client_active then
        raise exception using errcode = 'A0061', message = 'The client is archived.';
      end if;
      if v_content.status in ('published', 'cancelled') then
        raise exception using errcode = 'A0071', message = 'The tasks of a published or cancelled content are no longer edited.';
      end if;

      return v_task;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
