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

// The columns of one collaborator, shared by the listing and the detail so both always return the
// same shape. `auth."user"` is reached only through the membership's `user_id`.
const COLLABORATOR_COLUMNS = `
      membership.id as membership_id,
      member.name as name,
      member.email as email,
      member.image as photo_key,
      membership.job_title as job_title,
      role.key as role_key,
      role.name as role_name,
      app_private.is_agency_owner(membership.agency_id, membership.user_id) as is_owner,
      membership.status as status,
      membership.created_at as created_at`;

// `auth."user"` has no RLS, so every query starts from `agency_memberships` and joins the user by
// the link's `user_id`. The role join repeats the scope `app_private.has_agency_permission`
// applies (`role.agency_id is null or role.agency_id = membership.agency_id`).
const COLLABORATOR_FROM = `
    from public.agency_memberships as membership
    join auth."user" as member on member.id = membership.user_id
    join public.roles as role
      on role.id = membership.role_id
     and (role.agency_id is null or role.agency_id = membership.agency_id)`;

/**
 * Lists the team of one agency, starting from `public.agency_memberships` filtered by the route's
 * agency and reaching `auth."user"` only through the link's `user_id` (`specs/colaboradores.md`
 * §3/§5, rule 2). `auth."user"` has no RLS, so a query that starts there -- or resolves users by
 * name before filtering the agency -- would leak other agencies' people, and the response would
 * still look correct.
 *
 * Ordering is always by name ascending with a membership-id tie-break, so a page boundary is
 * stable across calls.
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

  const countResult = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total${COLLABORATOR_FROM}
    where ${where}
  `, bindings);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);

  const itemsResult = await raw<RawRows<CollaboratorRow>>(transaction, `
    select${COLLABORATOR_COLUMNS}${COLLABORATOR_FROM}
    where ${where}
    order by member.name asc, membership.id asc
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);

  return { items: itemsResult.rows, totalItems };
};

/**
 * Reads one collaborator of one agency by membership id (issue #96). Scoped to the route's agency
 * exactly like the listing, so a membership that belongs to another agency is not a row here: the
 * caller gets the same 404 as for a nonexistent id, never a 403 that would reveal it exists.
 *
 * Only `active` links are returned. `specs/colaboradores.md` §4 keeps `removed` links in the
 * database, and §5 rule 9 keeps them out of the listing by default; until the removal task (#98)
 * adds the administrative view of removed links, the detail treats them as not found too.
 */
export const getCollaborator = async (
  transaction: CollaboratorTransaction,
  agencyId: string,
  membershipId: string
): Promise<CollaboratorRow | undefined> => {
  const result = await raw<RawRows<CollaboratorRow>>(transaction, `
    select${COLLABORATOR_COLUMNS}${COLLABORATOR_FROM}
    where membership.agency_id = ?::uuid
      and membership.id = ?::uuid
      and membership.status = 'active'
  `, [agencyId, membershipId]);
  return result.rows[0];
};
