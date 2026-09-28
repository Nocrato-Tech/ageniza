/**
 * Issue #94. Structural change registered in decisions.md (2026-09-24, "ESTRUTURAL: só o Owner
 * concede o papel de Admin, e a autorização passa a depender do valor"): agency_memberships gains
 * the UPDATE policy it has never had, and invitations_insert is replaced to recognise the same
 * admin-grant gate.
 *
 * agency_memberships_update checks each column against its own current value, not just "does the
 * actor hold one of the module's permissions": a plain sub-select against the same row (no FOR
 * UPDATE) reads the snapshot taken at the start of the statement, i.e. the value before this
 * UPDATE — see https://www.postgresql.org/docs/current/ddl-rowsecurity.html on sub-selects in
 * policies. Without that, colaborador.alterar_funcao alone (job_title) would also let role_id
 * through on any statement that touches both columns.
 */
export async function up(knex) {
  await knex.raw(`
    insert into public.permissions (key, description) values
      ('colaborador.visualizar',     'Ver a equipe da agência.'),
      ('colaborador.remover',        'Remover um colaborador do quadro.'),
      ('colaborador.alterar_papel',  'Trocar o papel de acesso de um colaborador.'),
      ('colaborador.alterar_funcao', 'Editar o cargo de um colaborador.'),
      ('colaborador.atribuir_admin', 'Conceder o papel de Admin.');

    insert into public.role_permissions (role_id, permission_key)
    select role.id, permission.key
    from public.roles role
    cross join public.permissions permission
    where role.agency_id is null
      and permission.key = 'colaborador.visualizar';

    insert into public.role_permissions (role_id, permission_key)
    select role.id, permission.key
    from public.roles role
    cross join public.permissions permission
    where role.agency_id is null
      and role.key = 'admin'
      and permission.key in ('colaborador.remover', 'colaborador.alterar_papel', 'colaborador.alterar_funcao');

    insert into public.role_permissions (role_id, permission_key)
    select role.id, permission.key
    from public.roles role
    cross join public.permissions permission
    where role.agency_id is null
      and role.key = 'account_manager'
      and permission.key = 'colaborador.alterar_funcao';

    -- colaborador.atribuir_admin has no preset row anywhere above, on purpose: only the Owner
    -- passes it, by ownership. A test must fail if any role_permissions row ever grants it.
  `);

  await knex.raw(`
    create function app_private.is_admin_role(p_role_id uuid, p_agency_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select exists (
        select 1
        from public.roles role
        where role.id = p_role_id
          and role.key = 'admin'
          and (role.agency_id is null or role.agency_id = p_agency_id)
      )
    $$;
    revoke all on function app_private.is_admin_role(uuid, uuid) from public;
    grant execute on function app_private.is_admin_role(uuid, uuid) to ageniza_app;

    create function app_private.is_agency_owner(p_agency_id uuid, p_user_id uuid)
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
          and agency.owner_user_id = p_user_id
      )
    $$;
    revoke all on function app_private.is_agency_owner(uuid, uuid) from public;
    grant execute on function app_private.is_agency_owner(uuid, uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- No UPDATE policy existed on this table before: every collaborator-role or job_title change,
    -- and every remove/reactivate, has found zero rows in both layers since AUTH-20B.
    --
    -- The Owner exclusion lives in USING, not WITH CHECK: USING only sees the row as it stood
    -- before the statement, so it cannot depend on a proposed new value, but it can silently drop
    -- an ineligible row from the update (0 rows affected). WITH CHECK runs only after USING has
    -- already admitted the row, so once it fails there Postgres raises a row-security error instead
    -- of returning 0 -- that is unavoidable for any rule that depends on the new value, such as the
    -- admin-grant gate below or a role/status change outside the permission that governs it.
    create policy agency_memberships_update on public.agency_memberships
      for update to ageniza_app
      using (
        not app_private.is_agency_owner(agency_memberships.agency_id, agency_memberships.user_id)
        and (
          app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_papel')
          or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_funcao')
          or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.remover')
        )
      )
      with check (
        (
          agency_memberships.role_id = (
            select membership.role_id from public.agency_memberships membership where membership.id = agency_memberships.id
          )
          or (
            app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_papel')
            and (
              not app_private.is_admin_role(agency_memberships.role_id, agency_memberships.agency_id)
              or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.atribuir_admin')
            )
          )
        )
        and (
          agency_memberships.job_title is not distinct from (
            select membership.job_title from public.agency_memberships membership where membership.id = agency_memberships.id
          )
          or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_funcao')
        )
        and (
          agency_memberships.status = (
            select membership.status from public.agency_memberships membership where membership.id = agency_memberships.id
          )
          or (agency_memberships.status = 'removed' and app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.remover'))
          or (agency_memberships.status = 'active' and app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_papel'))
        )
      );
  `);

  await knex.raw(`
    -- Same admin-grant gate as the UPDATE policy above, at the other place a role is handed out.
    -- The resend path (convite.reenviar) also re-inserts a row, so it is covered by the same check.
    drop policy invitations_insert on public.invitations;

    create policy invitations_insert on public.invitations
      for insert to ageniza_app
      with check (
        (purpose = 'collaborator_invite' and (
          app_private.has_agency_permission(agency_id, 'colaborador.convidar')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
        ) and (
          not app_private.is_admin_role(role_id, agency_id)
          or app_private.has_agency_permission(agency_id, 'colaborador.atribuir_admin')
        ))
        or (purpose = 'client_invite' and (
          app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
        ))
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
