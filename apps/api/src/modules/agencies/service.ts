import { raw, type DatabaseClient } from '@ageniza/database';
import type { AgencyMeResponse } from '@ageniza/contracts';

type AgencyTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

interface AgencyMeRow {
  readonly agency_id: string;
  readonly agency_name: string;
  readonly is_owner: boolean;
  readonly role_key: string;
  readonly role_name: string;
  readonly permissions: readonly string[] | null;
}

/**
 * Resolves the effective permissions of one agency context for the authenticated user. The
 * permission list is derived from the same source `app_private.has_agency_permission` reads --
 * the owner by ownership, every other by the active membership's role scoped to
 * `role.agency_id is null or role.agency_id = agency.id` -- so the screen and the database never
 * diverge; `agencies.integration.test.ts` proves the equivalence key by key.
 *
 * Runs inside `withAuthenticatedUserTransaction`: the row is invisible without the caller's
 * transaction-local identity, and the access condition repeats the guard so a suspension between
 * the guard and this query (or a caller that skipped the guard) still yields no row.
 */
export const loadAgencyMe = async (transaction: AgencyTransaction, agencyId: string): Promise<AgencyMeResponse | undefined> => {
  const result = await raw<RawRows<AgencyMeRow>>(transaction, `
    select
      agency.id as agency_id,
      agency.name as agency_name,
      (agency.owner_user_id = app_private.current_user_id()) as is_owner,
      -- Owner is not a role; the fallback label mirrors GET /me/contexts exactly. Permissions
      -- below stay the authoritative field: a membership pointing at another agency's role is
      -- labelled but grants nothing.
      coalesce(role.key, 'admin') as role_key,
      coalesce(role.name, 'Admin') as role_name,
      case
        when agency.owner_user_id = app_private.current_user_id() then (
          select coalesce(array_agg(permission.key order by permission.key), array[]::text[])
          from public.permissions as permission
        )
        else (
          select coalesce(array_agg(distinct role_permission.permission_key order by role_permission.permission_key), array[]::text[])
          from public.role_permissions as role_permission
          where role_permission.role_id = role.id
        )
      end as permissions
    from public.agencies as agency
    left join public.agency_memberships as membership
      on membership.agency_id = agency.id
     and membership.user_id = app_private.current_user_id()
     and membership.status = 'active'
    left join public.roles as role
      on role.id = membership.role_id
     and (role.agency_id is null or role.agency_id = agency.id)
    where agency.id = ?::uuid
      and agency.status = 'active'
      and (membership.id is not null or agency.owner_user_id = app_private.current_user_id())
  `, [agencyId]);

  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    agencyId: row.agency_id,
    agencyName: row.agency_name,
    isOwner: row.is_owner === true,
    role: { key: row.role_key, name: row.role_name },
    permissions: [...(row.permissions ?? [])]
  };
};
