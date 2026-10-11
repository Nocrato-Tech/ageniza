// Issues #408 and #534. Forward-only. Decision: docs/business/decisions/2026-10-11-toda-edicao-de-conteudo-trava-o-cliente-ativo.md.
//
// Rule 14 of specs/conteudo.md was serialized with the archive only for the INSERT of a content and for the move of
// `publish_on` (20261007001400). Any other edit read the client as active under its own snapshot and could commit after an
// archive that was still uncommitted. The trigger of the move becomes the trigger of every edit of a column the application
// role may write, with the function the ten children use: A0020 in READ COMMITTED, 40001 from an older snapshot, and 42501
// from `contents_update` when the archive was already committed.
//
// Status and revision stay out: the functions that write them already take the client first, and the archive writes the
// status itself, holding the client. A row trigger runs after the content row is locked, so an UPDATE takes "content, then
// client", the reverse of the archive; the cycle is the accepted one of 2026-10-10 (40P01, TRY_AGAIN).
//
// The story scripts (#534) get the same: the day of a script and the scenes are edited by plain UPDATEs, and
// `send_story_script` and `record_story_script` locked the script without taking the client. The two functions take it FOR
// SHARE before the script, as archive_client does; they keep the codes they had (A0051 for the agency, A0050 for the portal).
// The archive never writes a script, so there is no cycle with it.

export async function up(knex) {
  await knex.raw(`
    drop trigger "0_contents_move_lock_active_client" on public.contents;

    create trigger "0_contents_edit_lock_active_client"
      after update of title, format, publish_on, publish_at_time, caption, folder_id, cover_asset_id, owner_user_id
      on public.contents
      for each row
      when (
        (old.title, old.format, old.publish_on, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id)
        is distinct from
        (new.title, new.format, new.publish_on, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id)
      )
      execute function app_private.lock_active_client_of_child();

    create trigger "0_story_scripts_edit_lock_active_client"
      after update of script_on on public.story_scripts
      for each row
      when (old.script_on is distinct from new.script_on)
      execute function app_private.lock_active_client_of_child();

    create trigger "0_story_script_scenes_edit_lock_active_client"
      after update of position, text, guidance on public.story_script_scenes
      for each row
      when ((old.position, old.text, old.guidance) is distinct from (new.position, new.text, new.guidance))
      execute function app_private.lock_active_client_of_child();
  `);

  await knex.raw(`
    create or replace function app_private.send_story_script(p_script_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_agency_id uuid;
      v_status text;
    begin
      -- The permission is checked BEFORE the lock, and an unknown script answers like a forbidden one.
      select script.client_id into v_client_id from public.story_scripts script where script.id = p_script_id;
      if not found then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      v_agency_id := app_private.client_agency_id(v_client_id);
      if not (
        app_private.has_agency_permission(v_agency_id, 'conteudo.operar')
        and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      -- Shared with the other writers of the client and in conflict with archiving it; the client first, as archive_client does.
      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;

      select script.status into v_status from public.story_scripts script where script.id = p_script_id for update;

      if not app_private.client_is_active(v_client_id) then
        raise exception using errcode = 'A0051', message = 'The client is archived.';
      end if;

      -- Idempotent: sending a script that was already sent changes nothing.
      if v_status = 'sent' then
        return;
      end if;

      if v_status <> 'draft' then
        raise exception using errcode = 'A0052', message = 'Only a draft is sent.';
      end if;

      update public.story_scripts set status = 'sent' where id = p_script_id;
    end;
    $function$;

    create or replace function app_private.record_story_script(p_script_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_client_active boolean;
    begin
      select script.client_id, script.status into v_client_id, v_status
      from public.story_scripts script
      where script.id = p_script_id;

      -- Only an active person of the portal of this client records. An agency permission, the Owner's
      -- ownership and a removed link all fail the same way: the script is "not found".
      if not found or not app_private.is_client_member(v_client_id) then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      -- The portal never sees a draft, so it must not learn that one exists. A person who is also a
      -- collaborator with conteudo.visualizar already reads it and is told the truth below.
      if v_status = 'draft' and not app_private.has_agency_permission(
        app_private.client_agency_id(v_client_id), 'conteudo.visualizar'
      ) then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      v_client_active := found;

      select script.status into v_status from public.story_scripts script where script.id = p_script_id for update;

      if not v_client_active then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      -- Idempotent, and the first person to record stays the one recorded.
      if v_status = 'recorded' then
        return;
      end if;

      if v_status <> 'sent' then
        raise exception using errcode = 'A0052', message = 'Only a sent script is recorded.';
      end if;

      update public.story_scripts set status = 'recorded' where id = p_script_id;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
