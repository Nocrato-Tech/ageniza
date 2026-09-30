import { raw, type DatabaseClient, type SqlBinding } from '@ageniza/database';

import type { ResolvedPagination } from '@ageniza/contracts';

type CollaboratorTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface CollaboratorListFilters {
  /** Free text over name and email; the route defaults `status` to `active`. */
  readonly status: 'active' | 'removed';
  readonly q?: string;
  readonly role?: string;
  readonly jobTitle?: string;
}

export interface CollaboratorRow {
  readonly membership_id: string;
  readonly name: string;
  readonly email: string;
  /** The identity storage key (`auth."user".image`), or null. The route turns it into a signed URL. */
  readonly photo_key: string | null;
  readonly job_title: string | null;
  readonly role_key: string;
  readonly role_name: string;
  readonly is_owner: boolean;
  readonly status: 'active' | 'removed';
  readonly created_at: string | Date;
}

export interface CollaboratorPage {
  readonly items: readonly CollaboratorRow[];
  readonly totalItems: number;
}

/**
 * Escapes the ILIKE metacharacters so a search for `100%` or `a_b` is a literal search, not a
 * wildcard. The backslash escape character is the one declared next to the `ilike` clauses.
 */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Lists the team of one agency, starting from `public.agency_memberships` filtered by the route's
 * agency and reaching `auth."user"` only through the link's `user_id` (`specs/colaboradores.md`
 * §3/§5, rule 2). `auth."user"` has no RLS, so a query that starts there -- or resolves users by
 * name before filtering the agency -- would leak other agencies' people, and the response would
 * still look correct.
 *
 * The role join repeats the scope `app_private.has_agency_permission` applies
 * (`role.agency_id is null or role.agency_id = membership.agency_id`). Ordering is always by name
 * ascending with a membership-id tie-break, so a page boundary is stable across calls.
 *
 * Runs inside the authenticated transaction the route already opened: `agency_memberships_select`
 * only shows the agency's links to a caller who is a member of it.
 */
export const listCollaborators = async (
  transaction: CollaboratorTransaction,
  agencyId: string,
  filters: CollaboratorListFilters,
  pagination: ResolvedPagination
): Promise<CollaboratorPage> => {
  const conditions = ['membership.agency_id = ?::uuid', 'membership.status = ?'];
  const bindings: SqlBinding[] = [agencyId, filters.status];

  if (filters.q !== undefined) {
    const pattern = `%${escapeLikePattern(filters.q)}%`;
    conditions.push("(member.name ilike ? escape '\\' or member.email ilike ? escape '\\')");
    bindings.push(pattern, pattern);
  }
  if (filters.role !== undefined) {
    conditions.push('role.key = ?');
    bindings.push(filters.role);
  }
  if (filters.jobTitle !== undefined) {
    conditions.push('membership.job_title = ?');
    bindings.push(filters.jobTitle);
  }

  const where = conditions.join('\n    and ');
  const from = `
    from public.agency_memberships as membership
    join auth."user" as member on member.id = membership.user_id
    join public.roles as role
      on role.id = membership.role_id
     and (role.agency_id is null or role.agency_id = membership.agency_id)`;

  const countResult = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total${from}
    where ${where}
  `, bindings);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);

  const itemsResult = await raw<RawRows<CollaboratorRow>>(transaction, `
    select
      membership.id as membership_id,
      member.name as name,
      member.email as email,
      member.image as photo_key,
      membership.job_title as job_title,
      role.key as role_key,
      role.name as role_name,
      app_private.is_agency_owner(membership.agency_id, membership.user_id) as is_owner,
      membership.status as status,
      membership.created_at as created_at${from}
    where ${where}
    order by member.name asc, membership.id asc
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);

  return { items: itemsResult.rows, totalItems };
};
