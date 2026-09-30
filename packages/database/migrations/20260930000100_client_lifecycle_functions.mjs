// CLIENTS module lifecycle functions (issue #123). Forward-only, like every migration in this repo.
//
// Structural per docs/business/structural-changes.md, and the shape Conteúdo must copy for its
// scheduled publication: docs/business/decisions.md, 2026-09-26 ("ESTRUTURAL: arquivar cliente é
// uma função `security definer` de escopo único, usada pelo job e pela rota") and 2026-09-18 ("O
// processamento de vídeo não contorna o RLS"). This migration opens the documented exception to
// that 18/09 rule: a single-purpose, audited, `security definer` function, callable only for the
// effect it names -- never a service identity with broad access.
//
// It also replaces the `invitations_insert` policy so a portal invite for an archived client is
// refused (specs/clientes.md §5 rule 6), building on the version PR #159 left, which carries the
// admin-grant rule for collaborator invites. Both changes coexist below.
//
// `security definer` runs as the schema owner and ignores RLS, so every agency and permission check
// is written inside each function, and every object is schema-qualified under `set search_path = ''`
// so the function cannot be hijacked through a caller-controlled search_path.
//
// Stable error codes, so the API (#131) can translate them without parsing messages:
//   A0020 -> 404  client/membership not found, of another agency, or the caller lacks the permission
//                 (one error for all, so the response is never an existence oracle)
//   A0021 -> 409  reactivating would collide with another active client's name
//   A0022 -> 400  a non-null closing date is before today in America/Sao_Paulo
//   A0023 -> 400  set_client_membership_status got a status other than 'active' or 'removed'

export async function up(knex) {
  await knex.raw(`
    -- Archives one client: the route calls this after the API checks cliente.arquivar, and the job
    -- calls archive_due_clients() below, which performs the same steps for every due client. Both
    -- paths therefore have exactly the same effect (specs/clientes.md §4).
    create function app_private.archive_client(p_client_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client public.clients%rowtype;
    begin
      select *
      into v_client
      from public.clients
      where id = p_client_id
      for update;

      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.has_agency_permission(v_client.agency_id, 'cliente.arquivar') then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Idempotent: archiving an archived client is a no-op, not an error and not a second event.
      if v_client.status = 'archived' then
        return;
      end if;

      update public.clients
      set status = 'archived',
          archived_at = pg_catalog.now(),
          closing_date = null,
          updated_at = pg_catalog.now()
      where id = v_client.id;

      -- Archiving revokes every pending portal invitation of that client -- and only that client's
      -- (specs/clientes.md §5 rule 15). Pending means neither used nor already revoked; the issue
      -- calls it accepted_at, but the column this table actually has is used_at.
      update public.invitations
      set revoked_at = pg_catalog.now()
      where client_id = v_client.id
        and purpose = 'client_invite'
        and used_at is null
        and revoked_at is null;

      -- client_memberships is deliberately not touched: reactivating restores whoever had access.
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('client.archived', app_private.current_user_id(), v_client.agency_id, 'client', v_client.id);
    end;
    $function$;
    revoke all on function app_private.archive_client(uuid) from public;
    grant execute on function app_private.archive_client(uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- The scheduled job. Safe by construction: it has no caller identity, and it can only archive
    -- clients whose closing_date already passed, so any caller (including the worker, which uses the
    -- same ageniza_app role as the API) gains no power it did not have. Returns how many it archived.
    create function app_private.archive_due_clients()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
      v_client record;
      v_archived integer := 0;
    begin
      -- closing_date < today, never <=: the contract "encerra em 30/10" runs through the end of
      -- the 30th in Brasília, so the job only archives a date that is strictly past (specs §4).
      for v_client in
        select id, agency_id
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

        -- actor_user_id is null on purpose (no user acted) and the origin names the job, following
        -- the agency-cli convention of recording the caller in request_id when it is not a request.
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
        values ('client.archived', null, v_client.agency_id, 'client', v_client.id, 'job:clients.archive-due');

        v_archived := v_archived + 1;
      end loop;

      return v_archived;
    end;
    $function$;
    revoke all on function app_private.archive_due_clients() from public;
    grant execute on function app_private.archive_due_clients() to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.reactivate_client(p_client_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client public.clients%rowtype;
    begin
      select *
      into v_client
      from public.clients
      where id = p_client_id
      for update;

      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.has_agency_permission(v_client.agency_id, 'cliente.arquivar') then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Idempotent. Returning early also matters for the conflict check below: an active client
      -- would otherwise collide with its own name.
      if v_client.status = 'active' then
        return;
      end if;

      -- Same normalization as clients_active_name_unique (#122): lower(btrim(name)) would miss a
      -- duplicate that differs only by internal whitespace and leak a raw 23505 instead of A0021.
      if exists (
        select 1
        from public.clients other
        where other.agency_id = v_client.agency_id
          and other.id <> v_client.id
          and other.status = 'active'
          and lower(btrim(regexp_replace(replace(other.name, chr(160), ' '), '[[:space:]]+', ' ', 'g')))
              = lower(btrim(regexp_replace(replace(v_client.name, chr(160), ' '), '[[:space:]]+', ' ', 'g')))
      ) then
        raise exception using errcode = 'A0021', message = 'An active client already uses this name.';
      end if;

      update public.clients
      set status = 'active',
          archived_at = null,
          updated_at = pg_catalog.now()
      where id = v_client.id;

      -- Revoked invitations are not restored: the SPEC says reactivating does not restore them (rule 15).
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('client.reactivated', app_private.current_user_id(), v_client.agency_id, 'client', v_client.id);
    end;
    $function$;
    revoke all on function app_private.reactivate_client(uuid) from public;
    grant execute on function app_private.reactivate_client(uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- Schedules or clears the closing date. A null date clears; a non-null date must be today or
    -- later in America/Sao_Paulo, so the contract "encerra em 30/10" is inclusive of the 30th.
    create function app_private.set_client_closing_date(p_client_id uuid, p_date date)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client public.clients%rowtype;
      v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
    begin
      select *
      into v_client
      from public.clients
      where id = p_client_id
      for update;

      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.has_agency_permission(v_client.agency_id, 'cliente.arquivar') then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- An archived client is read-only; the only action is reactivate (specs/clientes.md §4).
      if v_client.status <> 'active' then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if p_date is not null and p_date < v_today then
        raise exception using errcode = 'A0022', message = 'Closing date must be today or later.';
      end if;

      update public.clients
      set closing_date = p_date, updated_at = pg_catalog.now()
      where id = v_client.id;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values (
        case when p_date is null then 'client.closing_cleared' else 'client.closing_scheduled' end,
        app_private.current_user_id(), v_client.agency_id, 'client', v_client.id
      );
    end;
    $function$;
    revoke all on function app_private.set_client_closing_date(uuid, date) from public;
    grant execute on function app_private.set_client_closing_date(uuid, date) to ageniza_app;
  `);

  await knex.raw(`
    -- Removes or reactivates a portal member. client_memberships.status stays out of the column
    -- UPDATE grant on purpose (20260920000000_context_preferences.mjs): the existing
    -- client_memberships_update policy only checks user_id = current_user_id(), so putting status in
    -- the grant would let a removed person reactivate themselves. This function is the only writer,
    -- and it checks cliente.remover_usuario against the membership's own client.
    create function app_private.set_client_membership_status(p_membership_id uuid, p_status text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_membership public.client_memberships%rowtype;
      v_client public.clients%rowtype;
    begin
      if p_status is null or p_status not in ('active', 'removed') then
        raise exception using errcode = 'A0023', message = 'Membership status must be active or removed.';
      end if;

      select *
      into v_membership
      from public.client_memberships
      where id = p_membership_id
      for update;

      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Locking the client too keeps a concurrent archive from slipping between the active check and
      -- the write. Lock order (membership, then client) matches everywhere; archive locks only the
      -- client, so there is no cycle.
      select *
      into v_client
      from public.clients
      where id = v_membership.client_id
      for update;

      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.has_agency_permission(v_client.agency_id, 'cliente.remover_usuario') then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if v_client.status <> 'active' then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Idempotent: no transition, no write, no event.
      if v_membership.status = p_status then
        return;
      end if;

      update public.client_memberships
      set status = p_status, updated_at = pg_catalog.now()
      where id = v_membership.id;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values (
        case when p_status = 'removed' then 'client_member.removed' else 'client_member.reactivated' end,
        app_private.current_user_id(), v_client.agency_id, 'client_membership', v_membership.id
      );
    end;
    $function$;
    revoke all on function app_private.set_client_membership_status(uuid, text) from public;
    grant execute on function app_private.set_client_membership_status(uuid, text) to ageniza_app;
  `);

  await knex.raw(`
    -- Replaces the policy PR #159 left (20260928000000_collaborator_permissions_and_admin_grant.mjs),
    -- keeping its admin-grant rule for collaborator invites intact and adding the missing rule from
    -- specs/clientes.md §5 rule 6: a portal invite cannot be created for an archived client.
    drop policy invitations_insert on public.invitations;

    create policy invitations_insert on public.invitations
      for insert to ageniza_app
      with check (
        (purpose = 'collaborator_invite' and (
          app_private.has_agency_permission(agency_id, 'colaborador.convidar')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
        ) and exists (
          select 1
          from public.roles role
          where role.id = invitations.role_id
            and (role.agency_id is null or role.agency_id = invitations.agency_id)
        ) and (
          not app_private.is_admin_role(role_id, agency_id)
          or app_private.has_agency_permission(agency_id, 'colaborador.atribuir_admin')
        ))
        or (purpose = 'client_invite' and (
          app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
        ) and app_private.client_is_active(client_id))
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
