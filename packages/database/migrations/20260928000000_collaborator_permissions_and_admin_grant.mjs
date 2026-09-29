/**
 * Issue #94. Structural change registered in decisions.md (2026-09-24, "ESTRUTURAL: só o Owner
 * concede o papel de Admin, e a autorização passa a depender do valor"): agency_memberships gains
 * the UPDATE policy it has never had, and invitations_insert is replaced to recognise the same
 * admin-grant gate.
 *
 * Post-review correction (PR #159, issue #94). The first cut compared each column against a
 * plain sub-select of the same row inside WITH CHECK, which has two defects a security review
 * found:
 *
 * 1. The table-wide UPDATE grant (20260919000000) left agency_id/user_id/id writable. When those
 *    are the only columns a statement touches, role_id/job_title/status trivially equal
 *    themselves and every WITH CHECK branch is satisfied — any actor holding a module permission
 *    could move a membership to another agency or hand it to another user_id, which is exactly
 *    how atribuir_admin was bypassed. Fixed by revoking table UPDATE and granting it only on
 *    (role_id, job_title, status, updated_at): the identity columns are no longer part of the
 *    grant, so Postgres refuses any statement that touches them before RLS is even evaluated.
 * 2. A plain sub-select with no FOR UPDATE reads the snapshot taken at the start of the
 *    statement. That is correct against a single writer, but under READ COMMITTED with a second,
 *    concurrent UPDATE the row goes through EvalPlanQual and is reapplied on the newest committed
 *    version — while the sub-select still reads the pre-concurrent-write snapshot. An actor who
 *    started their UPDATE first can have their WITH CHECK re-evaluated against a value someone
 *    else just committed, and a rule keyed on "did this column change" can be reapplied on stale
 *    data. Fixed by moving the OLD/NEW comparison into a BEFORE UPDATE trigger: OLD there is the
 *    row actually being updated (the same one EvalPlanQual reapplies the SET against), not an
 *    independent read.
 *
 * USING keeps only row-level filtering — does the actor hold any of the module's permissions on
 * this agency — and no longer special-cases the Owner: whether a specific column may move on a
 * specific row is entirely the trigger's job now, since only it sees a trustworthy OLD/NEW pair.
 * WITH CHECK repeats the same filter (Postgres defaults it to USING when omitted, but the
 * decisions.md pattern for this table spells it out).
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
    -- No UPDATE policy or grant existed on this table before: every collaborator-role or
    -- job_title change, and every remove/reactivate, has found zero rows in both layers since
    -- AUTH-20B. The table-wide grant is narrowed first: agency_id, user_id and id must never be
    -- part of the application role's UPDATE vocabulary, because no rule below depends on their
    -- own values, and any rule that did would still be racing the same value it is comparing
    -- against (see the top-of-file note on sub-selects vs. triggers). A statement that touches
    -- any of them is refused by the grant itself, before RLS or the trigger below ever run.
    revoke update on public.agency_memberships from ageniza_app;
    grant update (role_id, job_title, status, updated_at) on public.agency_memberships to ageniza_app;

    create policy agency_memberships_update on public.agency_memberships
      for update to ageniza_app
      using (
        app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_papel')
        or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_funcao')
        or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.remover')
      )
      with check (
        app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_papel')
        or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.alterar_funcao')
        or app_private.has_agency_permission(agency_memberships.agency_id, 'colaborador.remover')
      );
  `);

  await knex.raw(`
    -- Enforces the value-dependent half of the rule that RLS cannot express safely (see the
    -- top-of-file note): which column may change, and to what, given OLD as it truly stands at
    -- the moment this row is locked for update -- not a sub-select's stale snapshot. Runs as
    -- security definer so app_private.has_agency_permission and is_agency_owner/is_admin_role see
    -- the same authorization surface RLS policies do, regardless of table grants on this role.
    create function app_private.check_agency_membership_update()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      -- RLS itself is bypassed for the table owner (migrations, this package's tests, any future
      -- ops tooling), which is how those connections write fixtures directly today; a trigger is
      -- not bypassed the same way, so it must bypass explicitly for the one case RLS already
      -- does: no authenticated user context at all. app_private.has_agency_permission always
      -- resolves against current_user_id(), so without app.user_id every permission check below
      -- would read as false and this trigger would block administrative writes RLS never gated.
      -- ageniza_app itself never reaches here without app.user_id set: without it, USING already
      -- sees no permission and the update affects zero rows before this trigger ever runs.
      if pg_catalog.current_setting('app.user_id', true) is null or pg_catalog.current_setting('app.user_id', true) = '' then
        return new;
      end if;

      if app_private.is_agency_owner(old.agency_id, old.user_id) then
        if new.role_id is distinct from old.role_id or new.status is distinct from old.status then
          raise exception using
            errcode = '42501',
            message = 'The agency Owner''s role and status cannot be changed by this module.';
        end if;
      elsif new.role_id is distinct from old.role_id then
        if not app_private.has_agency_permission(old.agency_id, 'colaborador.alterar_papel') then
          raise exception using
            errcode = '42501',
            message = 'colaborador.alterar_papel is required to change role_id.';
        end if;

        if not exists (
          select 1
          from public.roles role
          where role.id = new.role_id
            and (role.agency_id is null or role.agency_id = old.agency_id)
        ) then
          raise exception using
            errcode = '42501',
            message = 'role_id must be a system role or belong to this agency.';
        end if;

        if app_private.is_admin_role(new.role_id, old.agency_id)
           and not app_private.has_agency_permission(old.agency_id, 'colaborador.atribuir_admin')
        then
          raise exception using
            errcode = '42501',
            message = 'colaborador.atribuir_admin is required to grant the admin role.';
        end if;
      end if;

      if new.job_title is distinct from old.job_title
         and not app_private.has_agency_permission(old.agency_id, 'colaborador.alterar_funcao')
      then
        raise exception using
          errcode = '42501',
          message = 'colaborador.alterar_funcao is required to change job_title.';
      end if;

      -- The Owner branch above already rejects any status change on the Owner's row, so reaching
      -- here with new.status distinct from old.status means old.user_id is not the Owner.
      if new.status is distinct from old.status then
        if new.status = 'removed' and not app_private.has_agency_permission(old.agency_id, 'colaborador.remover') then
          raise exception using
            errcode = '42501',
            message = 'colaborador.remover is required to remove a collaborator.';
        elsif new.status = 'active' and not app_private.has_agency_permission(old.agency_id, 'colaborador.alterar_papel') then
          raise exception using
            errcode = '42501',
            message = 'colaborador.alterar_papel is required to reactivate a collaborator.';
        end if;
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.check_agency_membership_update() from public;

    create trigger agency_memberships_check_update
      before update on public.agency_memberships
      for each row
      execute function app_private.check_agency_membership_update();
  `);

  await knex.raw(`
    -- Same admin-grant gate as the UPDATE policy above, at the other place a role is handed out.
    -- The resend path (convite.reenviar) also re-inserts a row, so it is covered by the same
    -- check. The role-scope condition closes the same gap the trigger closes for UPDATE: without
    -- it, an inviter could carry a role_id belonging to another agency's custom role into their
    -- own agency's invitation, which is_admin_role's own agency filter would silently miss.
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
        ))
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
