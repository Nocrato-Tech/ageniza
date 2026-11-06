export async function up(knex) {
  await knex.raw(`
    create function app_private.withdraw_content_approval(p_content_id uuid, p_revision integer)
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
      perform app_private.require_read_committed();
      select content.client_id into v_client_id from public.contents content where content.id = p_content_id;
      if not found or not app_private.is_client_member(v_client_id) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;
      perform 1 from public.client_memberships membership
      where membership.client_id = v_client_id and membership.user_id = app_private.current_user_id()
        and membership.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content where content.id = p_content_id for update;
      if not app_private.is_client_member(v_client_id) or v_status in ('in_production', 'cancelled') then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;
      if v_status = 'awaiting_approval' then return; end if;
      if v_status <> 'approved' then
        raise exception using errcode = 'A0062', message = 'Only approved content can have its approval withdrawn.';
      end if;

      update public.contents set status = 'awaiting_approval' where id = p_content_id;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('content.approval_withdrawn', app_private.current_user_id(), app_private.client_agency_id(v_client_id), 'content', p_content_id);
    end;
    $function$;
    revoke all on function app_private.withdraw_content_approval(uuid, integer) from public;
    grant execute on function app_private.withdraw_content_approval(uuid, integer) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
