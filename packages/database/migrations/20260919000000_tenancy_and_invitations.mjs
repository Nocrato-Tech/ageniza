// AUTH-20B database domain. This migration is intentionally forward-only: schema and policy
// corrections must be made by a subsequent migration, never by changing an applied file.

export async function up(knex) {
  await knex.raw(`
    create table public.agencies (
      id uuid not null default gen_random_uuid() primary key,
      name text not null check (btrim(name) <> ''),
      status text not null default 'active' check (status in ('active', 'suspended')),
      owner_user_id uuid null references auth."user"(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table public.clients (
      id uuid not null default gen_random_uuid() primary key,
      agency_id uuid not null references public.agencies(id),
      name text not null,
      status text not null default 'active' check (status in ('active', 'archived')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table public.permissions (
      key text primary key,
      description text not null
    );

    create table public.roles (
      id uuid not null default gen_random_uuid() primary key,
      agency_id uuid null references public.agencies(id),
      key text not null,
      name text not null,
      is_system boolean not null,
      created_at timestamptz not null default now(),
      constraint roles_system_agency_check check (
        (is_system and agency_id is null) or (not is_system and agency_id is not null)
      )
    );
    create unique index roles_system_key_unique on public.roles(key) where agency_id is null;
    create unique index roles_agency_key_unique on public.roles(agency_id, key);

    create table public.role_permissions (
      role_id uuid not null references public.roles(id) on delete cascade,
      permission_key text not null references public.permissions(key),
      primary key (role_id, permission_key)
    );

    create table public.agency_memberships (
      id uuid not null default gen_random_uuid() primary key,
      agency_id uuid not null references public.agencies(id),
      user_id uuid not null references auth."user"(id),
      role_id uuid not null references public.roles(id),
      job_title text null,
      status text not null default 'active' check (status in ('active', 'removed')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (agency_id, user_id)
    );

    create table public.client_memberships (
      id uuid not null default gen_random_uuid() primary key,
      client_id uuid not null references public.clients(id),
      user_id uuid not null references auth."user"(id),
      status text not null default 'active' check (status in ('active', 'removed')),
      onboarding_seen_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (client_id, user_id)
    );

    create table public.invitations (
      id uuid not null default gen_random_uuid() primary key,
      agency_id uuid not null references public.agencies(id),
      purpose text not null check (purpose in ('agency_activation', 'collaborator_invite', 'client_invite')),
      email text not null check (email = lower(btrim(email))),
      role_id uuid null references public.roles(id),
      client_id uuid null references public.clients(id),
      token_hash text not null unique,
      expires_at timestamptz not null,
      used_at timestamptz null,
      revoked_at timestamptz null,
      invited_by_user_id uuid null references auth."user"(id),
      accepted_by_user_id uuid null references auth."user"(id),
      created_at timestamptz not null default now(),
      constraint invitations_purpose_fields_check check (
        (purpose = 'collaborator_invite' and role_id is not null and client_id is null)
        or (purpose = 'client_invite' and client_id is not null and role_id is null)
        or (purpose = 'agency_activation' and role_id is null and client_id is null)
      )
    );
    create unique index invitations_pending_equivalent_unique on public.invitations (
      agency_id,
      purpose,
      email,
      coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) where used_at is null and revoked_at is null;

    create table public.legal_acceptances (
      id uuid not null default gen_random_uuid() primary key,
      user_id uuid not null references auth."user"(id),
      document text not null check (document in ('terms', 'privacy')),
      version text not null,
      accepted_at timestamptz not null default now(),
      unique (user_id, document, version)
    );

    -- Every table in public is tenant data or authorization data and must be protected, including
    -- tables whose rows are only written through a SECURITY DEFINER function.
    alter table public.agencies enable row level security;
    alter table public.agencies force row level security;
    alter table public.clients enable row level security;
    alter table public.clients force row level security;
    alter table public.permissions enable row level security;
    alter table public.permissions force row level security;
    alter table public.roles enable row level security;
    alter table public.roles force row level security;
    alter table public.role_permissions enable row level security;
    alter table public.role_permissions force row level security;
    alter table public.agency_memberships enable row level security;
    alter table public.agency_memberships force row level security;
    alter table public.client_memberships enable row level security;
    alter table public.client_memberships force row level security;
    alter table public.invitations enable row level security;
    alter table public.invitations force row level security;
    alter table public.legal_acceptances enable row level security;
    alter table public.legal_acceptances force row level security;

    grant select, insert, update, delete on public.agencies to ageniza_app;
    grant select, insert, update, delete on public.clients to ageniza_app;
    grant select, insert, update, delete on public.permissions to ageniza_app;
    grant select, insert, update, delete on public.roles to ageniza_app;
    grant select, insert, update, delete on public.role_permissions to ageniza_app;
    grant select, insert, update, delete on public.agency_memberships to ageniza_app;
    grant select, insert, update, delete on public.client_memberships to ageniza_app;
    grant select, insert, update, delete on public.invitations to ageniza_app;
    grant select, insert, update, delete on public.legal_acceptances to ageniza_app;

    insert into public.permissions (key, description) values
      ('colaborador.convidar', 'Convidar colaboradores para a agência.'),
      ('cliente.convidar_usuario', 'Convidar usuários para um cliente.'),
      ('convite.reenviar', 'Reenviar convites pendentes.'),
      ('convite.cancelar', 'Cancelar convites pendentes.');

    insert into public.roles (agency_id, key, name, is_system) values
      (null, 'admin', 'Admin', true),
      (null, 'account_manager', 'Gestor de conta', true),
      (null, 'production', 'Produção', true),
      (null, 'sales', 'Vendas', true),
      (null, 'finance', 'Financeiro', true);

    insert into public.role_permissions (role_id, permission_key)
    select role.id, permission.key
    from public.roles role
    cross join public.permissions permission
    where role.agency_id is null
      and role.key = 'admin'
      and permission.key in (
        'colaborador.convidar',
        'cliente.convidar_usuario',
        'convite.reenviar',
        'convite.cancelar'
      );
  `);

  await knex.raw(`
    create function app_private.is_agency_member(p_agency_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select exists (
        select 1
        from public.agencies agency
        left join public.agency_memberships membership
          on membership.agency_id = agency.id
         and membership.user_id = app_private.current_user_id()
         and membership.status = 'active'
        where agency.id = p_agency_id
          and agency.status = 'active'
          and (membership.id is not null or agency.owner_user_id = app_private.current_user_id())
      )
    $$;
    revoke all on function app_private.is_agency_member(uuid) from public;
    grant execute on function app_private.is_agency_member(uuid) to ageniza_app;

    create function app_private.has_agency_permission(p_agency_id uuid, p_permission text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select exists (
        select 1
        from public.agencies agency
        where agency.id = p_agency_id
          and agency.status = 'active'
          and agency.owner_user_id = app_private.current_user_id()
      )
      or exists (
        select 1
        from public.agencies agency
        join public.agency_memberships membership on membership.agency_id = agency.id
        join public.roles role on role.id = membership.role_id
        join public.role_permissions role_permission on role_permission.role_id = role.id
        where agency.id = p_agency_id
          and agency.status = 'active'
          and membership.user_id = app_private.current_user_id()
          and membership.status = 'active'
          and (role.agency_id is null or role.agency_id = agency.id)
          and role_permission.permission_key = p_permission
      )
    $$;
    revoke all on function app_private.has_agency_permission(uuid, text) from public;
    grant execute on function app_private.has_agency_permission(uuid, text) to ageniza_app;

    create function app_private.is_client_member(p_client_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select exists (
        select 1
        from public.client_memberships membership
        join public.clients client on client.id = membership.client_id
        join public.agencies agency on agency.id = client.agency_id
        where membership.client_id = p_client_id
          and membership.user_id = app_private.current_user_id()
          and membership.status = 'active'
          and client.status = 'active'
          and agency.status = 'active'
      )
    $$;
    revoke all on function app_private.is_client_member(uuid) from public;
    grant execute on function app_private.is_client_member(uuid) to ageniza_app;
  `);

  await knex.raw(`
    create policy agencies_select on public.agencies
      for select to ageniza_app
      using (
        app_private.is_agency_member(id)
        or exists (
          select 1
          from public.clients client
          join public.client_memberships membership on membership.client_id = client.id
          where client.agency_id = agencies.id
            and client.status = 'active'
            and membership.user_id = app_private.current_user_id()
            and membership.status = 'active'
        )
      );

    create policy clients_select on public.clients
      for select to ageniza_app
      using (app_private.is_agency_member(agency_id) or app_private.is_client_member(id));

    create policy permissions_select on public.permissions
      for select to ageniza_app
      using (app_private.current_user_id() is not null);

    create policy roles_select on public.roles
      for select to ageniza_app
      using (agency_id is null or app_private.is_agency_member(agency_id));

    create policy role_permissions_select on public.role_permissions
      for select to ageniza_app
      using (app_private.current_user_id() is not null);

    create policy agency_memberships_select on public.agency_memberships
      for select to ageniza_app
      using (user_id = app_private.current_user_id() or app_private.is_agency_member(agency_id));

    create policy client_memberships_select on public.client_memberships
      for select to ageniza_app
      using (
        user_id = app_private.current_user_id()
        or exists (
          select 1
          from public.clients client
          where client.id = client_memberships.client_id
            and app_private.is_agency_member(client.agency_id)
        )
      );

    create policy invitations_select on public.invitations
      for select to ageniza_app
      using (
        app_private.has_agency_permission(agency_id, 'colaborador.convidar')
        or app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
      );

    create policy invitations_insert on public.invitations
      for insert to ageniza_app
      with check (
        (purpose = 'collaborator_invite' and app_private.has_agency_permission(agency_id, 'colaborador.convidar'))
        or (purpose = 'client_invite' and app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario'))
      );

    create policy invitations_update on public.invitations
      for update to ageniza_app
      using (
        (purpose = 'collaborator_invite' and app_private.has_agency_permission(agency_id, 'colaborador.convidar'))
        or (purpose = 'client_invite' and app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario'))
      )
      with check (
        (purpose = 'collaborator_invite' and app_private.has_agency_permission(agency_id, 'colaborador.convidar'))
        or (purpose = 'client_invite' and app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario'))
      );

    create policy legal_acceptances_select on public.legal_acceptances
      for select to ageniza_app
      using (user_id = app_private.current_user_id());
  `);

  await knex.raw(`
    create function app_private.invitation_by_token_hash(p_token_hash text)
    returns table (
      id uuid,
      purpose text,
      email text,
      agency_id uuid,
      agency_name text,
      client_id uuid,
      client_name text,
      role_id uuid,
      valid boolean
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select
        invitation.id,
        invitation.purpose,
        invitation.email,
        invitation.agency_id,
        agency.name,
        invitation.client_id,
        client.name,
        invitation.role_id,
        (
          invitation.used_at is null
          and invitation.revoked_at is null
          and invitation.expires_at > pg_catalog.now()
          and agency.status = 'active'
          and (invitation.client_id is null or (client.id is not null and client.agency_id = invitation.agency_id and client.status = 'active'))
        ) as valid
      from public.invitations invitation
      join public.agencies agency on agency.id = invitation.agency_id
      left join public.clients client on client.id = invitation.client_id
      where invitation.token_hash = p_token_hash
    $$;
    revoke all on function app_private.invitation_by_token_hash(text) from public;
    grant execute on function app_private.invitation_by_token_hash(text) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.accept_invitation(
      p_token_hash text,
      p_user_id uuid,
      p_terms_version text,
      p_privacy_version text,
      p_record_acceptance boolean
    )
    returns table (status text, agency_id uuid, client_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      invitation public.invitations%rowtype;
      agency public.agencies%rowtype;
      invited_user_email text;
      admin_role_id uuid;
      already_member boolean := false;
    begin
      select *
      into invitation
      from public.invitations
      where token_hash = p_token_hash
      for update;

      if not found then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      select agency_row.*
      into agency
      from public.agencies agency_row
      where agency_row.id = invitation.agency_id
      for update;

      if not found
         or invitation.used_at is not null
         or invitation.revoked_at is not null
         or invitation.expires_at <= pg_catalog.now()
         or agency.status <> 'active'
      then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      if invitation.client_id is not null then
        if not exists (
          select 1
          from public.clients invited_client
          where invited_client.id = invitation.client_id
            and invited_client.agency_id = invitation.agency_id
            and invited_client.status = 'active'
        ) then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;
      end if;

      if invitation.role_id is not null and not exists (
        select 1
        from public.roles invited_role
        where invited_role.id = invitation.role_id
          and (invited_role.agency_id is null or invited_role.agency_id = invitation.agency_id)
      ) then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      select "email"
      into invited_user_email
      from auth."user"
      where id = p_user_id;

      if not found or invited_user_email <> invitation.email then
        raise exception using
          errcode = 'A0002',
          message = 'The authenticated account does not match this invitation.';
      end if;

      if invitation.purpose = 'agency_activation' then
        already_member := agency.owner_user_id = p_user_id;
      elsif invitation.purpose = 'collaborator_invite' then
        select exists (
          select 1
          from public.agency_memberships existing_membership
          where existing_membership.agency_id = invitation.agency_id
            and existing_membership.user_id = p_user_id
            and existing_membership.status = 'active'
        ) into already_member;
      else
        select exists (
          select 1
          from public.client_memberships existing_membership
          where existing_membership.client_id = invitation.client_id
            and existing_membership.user_id = p_user_id
            and existing_membership.status = 'active'
        ) into already_member;
      end if;

      if already_member then
        return query select 'already_member'::text, invitation.agency_id, invitation.client_id;
        return;
      end if;

      if p_record_acceptance
         and (
           p_terms_version is null or pg_catalog.btrim(p_terms_version) = ''
           or p_privacy_version is null or pg_catalog.btrim(p_privacy_version) = ''
         )
      then
        raise exception using
          errcode = 'A0003',
          message = 'Terms and privacy versions are required.';
      end if;

      if invitation.purpose = 'agency_activation' then
        if agency.owner_user_id is not null then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;

        select system_role.id
        into admin_role_id
        from public.roles system_role
        where system_role.agency_id is null and system_role.key = 'admin';

        if not found then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;

        update public.agencies
        set owner_user_id = p_user_id, updated_at = pg_catalog.now()
        where id = invitation.agency_id;

        insert into public.agency_memberships (agency_id, user_id, role_id)
        values (invitation.agency_id, p_user_id, admin_role_id)
        on conflict on constraint agency_memberships_agency_id_user_id_key do update
          set role_id = excluded.role_id, status = 'active', updated_at = pg_catalog.now();
      elsif invitation.purpose = 'collaborator_invite' then
        insert into public.agency_memberships (agency_id, user_id, role_id)
        values (invitation.agency_id, p_user_id, invitation.role_id)
        on conflict on constraint agency_memberships_agency_id_user_id_key do update
          set role_id = excluded.role_id, status = 'active', updated_at = pg_catalog.now();
      else
        insert into public.client_memberships (client_id, user_id)
        values (invitation.client_id, p_user_id)
        on conflict on constraint client_memberships_client_id_user_id_key do update
          set status = 'active', updated_at = pg_catalog.now();
      end if;

      update public.invitations
      set used_at = pg_catalog.now(), accepted_by_user_id = p_user_id
      where id = invitation.id;

      if p_record_acceptance then
        insert into public.legal_acceptances (user_id, document, version)
        values
          (p_user_id, 'terms', p_terms_version),
          (p_user_id, 'privacy', p_privacy_version)
        on conflict (user_id, document, version) do nothing;
      end if;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('invitation.accepted', p_user_id, invitation.agency_id, 'invitation', invitation.id);

      if invitation.purpose = 'agency_activation' then
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('agency.activated', p_user_id, invitation.agency_id, 'agency', invitation.agency_id);
      end if;

      return query select 'accepted'::text, invitation.agency_id, invitation.client_id;
    end;
    $function$;
    revoke all on function app_private.accept_invitation(text, uuid, text, text, boolean) from public;
    grant execute on function app_private.accept_invitation(text, uuid, text, text, boolean) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
