/**
 * Issue #98. Second-barrier gap found while implementing the reactivation route.
 *
 * `app_private.check_agency_membership_update` (20260928000000) asks for `colaborador.atribuir_admin`
 * only when `role_id` changes to an admin role. Reactivating a removed link (`removed` -> `active`)
 * changes `status` and not `role_id`, so a person who was an Admin and comes back as an Admin kept
 * the same `role_id` and passed the trigger without the grant: an Admin could bring back a former
 * Admin, which is exactly what the rule "only the Owner grants admin" exists to prevent. Only the
 * route stopped it.
 *
 * The same trigger, replaced in place, now also asks for the grant when a link comes back to
 * `active` holding an admin role, whether or not the role changed, with a message of its own. It
 * acts only on that transition: an `active` link whose job title is edited, or a removal, is
 * untouched. `create or replace` keeps the function's privileges (no `revoke` is needed, and the
 * trigger itself is not recreated).
 *
 * Structural, registered in decisions.md (2026-10-07, "Remover e reativar"): it changes how an
 * authorization rule is evaluated for one table; no table, column, policy or grant changes.
 */
export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.check_agency_membership_update()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      -- Only the application role is governed here. The schema owner (migrations, this package's
      -- fixtures) and anything running as a security definer function owned by it -- chiefly
      -- accept_invitation -- already bypass RLS on this table and keep bypassing this trigger too.
      if current_user <> 'ageniza_app' then
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

      -- A link coming back to active with an admin role hands that role out again, even when the
      -- role_id is the one it had before the removal and the branch above never saw it change.
      if old.status = 'removed'
         and new.status = 'active'
         and app_private.is_admin_role(new.role_id, old.agency_id)
         and not app_private.has_agency_permission(old.agency_id, 'colaborador.atribuir_admin')
      then
        raise exception using
          errcode = '42501',
          message = 'colaborador.atribuir_admin is required to bring back a link with the admin role.';
      end if;

      return new;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
