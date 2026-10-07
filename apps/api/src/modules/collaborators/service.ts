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

// The job-title filter of the badge grid (#102) needs the values that exist in the agency, not one
// page of them. The cap keeps a pathological agency from returning an unbounded array.
const JOB_TITLE_LIMIT = 200;

/**
 * Distinct job titles of one agency's **active** links (issue #218), for the grid's filter. The
 * listing (#95) cannot serve it: it returns a single page, and the SPEC forbids changing its shape.
 *
 * The query starts from `agency_memberships` scoped to the route's agency: the RLS only guarantees
 * the caller sees agencies they belong to, never that the query landed on one, so a person linked
 * to two agencies would otherwise see both (issue #186 lesson). Values are trimmed, blanks and
 * nulls dropped, de-duplicated and ordered alphabetically; `removed` links do not contribute.
 */
export const listAgencyJobTitles = async (
  transaction: CollaboratorTransaction,
  agencyId: string
): Promise<string[]> => {
  const result = await raw<RawRows<{ job_title: string }>>(transaction, `
    select distinct btrim(membership.job_title) as job_title
    from public.agency_memberships as membership
    where membership.agency_id = ?::uuid
      and membership.status = 'active'
      and membership.job_title is not null
      and btrim(membership.job_title) <> ''
    order by job_title asc
    limit ?
  `, [agencyId, JOB_TITLE_LIMIT]);
  return result.rows.map((row) => row.job_title);
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

export interface AgencyRoleRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/**
 * Roles the caller may assign in one agency (issue #287): the system presets plus the agency's own
 * custom roles -- the exact scope the invitation insert, the membership-update trigger and the
 * reactivation all accept (`role.agency_id is null or role.agency_id = <agency>`), so the list can
 * never suggest a role the database would refuse.
 *
 * The `admin` preset is only assigned by the Owner (`specs/colaboradores.md` §2 and §7); adapting
 * the query to the caller's ownership keeps the hiding server-side, where the invite/PATCH
 * barriers also live, instead of trusting the screen to filter. Ordering is by `key` so the same
 * agency always answers the same sequence.
 *
 * The RLS `roles_select` already limits this read to system roles plus roles of agencies the
 * caller belongs to; the agency filter is the second barrier that pins the query to the route's
 * agency, exactly like the listing's (issue #186 lesson).
 */
export const listAgencyRoles = async (
  transaction: CollaboratorTransaction,
  agencyId: string,
  includeAdmin: boolean
): Promise<readonly AgencyRoleRow[]> => {
  const conditions = ['(role.agency_id is null or role.agency_id = ?::uuid)'];
  const bindings: SqlBinding[] = [agencyId];
  if (!includeAdmin) {
    conditions.push('not (role.key = \'admin\' and (role.agency_id is null or role.agency_id = ?::uuid))');
    bindings.push(agencyId);
  }
  // `collate "C"` pins the order to the byte value of `key` whatever the database collation is,
  // and `role.id` breaks any tie so the same agency always answers the same sequence.
  const result = await raw<RawRows<AgencyRoleRow>>(transaction, `
    select role.id, role.key, role.name
    from public.roles as role
    where ${conditions.join('\n  and ')}
    order by role.key collate "C" asc, role.id asc
  `, bindings);
  return result.rows;
};

export interface MembershipTarget {
  readonly user_id: string;
  readonly is_owner: boolean;
}

/**
 * Reads and locks the active membership a change is about, scoped to the route's agency: another
 * agency's link, a nonexistent one and a removed one are all "no row". The lock serializes two
 * changes of the same person, so the checks that follow judge the row the update will actually see.
 */
export const lockActiveMembership = async (
  transaction: CollaboratorTransaction,
  agencyId: string,
  membershipId: string
): Promise<MembershipTarget | undefined> => {
  const result = await raw<RawRows<MembershipTarget>>(transaction, `
    select
      membership.user_id as user_id,
      app_private.is_agency_owner(membership.agency_id, membership.user_id) as is_owner
    from public.agency_memberships as membership
    where membership.agency_id = ?::uuid
      and membership.id = ?::uuid
      and membership.status = 'active'
    for update of membership
  `, [agencyId, membershipId]);
  return result.rows[0];
};

/**
 * Resolves a role the caller wants to hand out. Undefined when the role is neither a system role
 * nor one of this agency's; otherwise whether it is the `admin` role, by the same
 * `app_private.is_admin_role` the UPDATE trigger and the invitation policy use.
 */
export const findAssignableRole = async (
  transaction: CollaboratorTransaction,
  agencyId: string,
  roleId: string
): Promise<{ readonly isAdmin: boolean } | undefined> => {
  const result = await raw<RawRows<{ is_admin: boolean }>>(transaction, `
    select app_private.is_admin_role(role.id, ?::uuid) as is_admin
    from public.roles as role
    where role.id = ?::uuid
      and (role.agency_id is null or role.agency_id = ?::uuid)
  `, [agencyId, roleId, agencyId]);
  const row = result.rows[0];
  return row === undefined ? undefined : { isAdmin: row.is_admin === true };
};

export interface MembershipChange {
  readonly jobTitle?: string | null;
  readonly roleId?: string;
}

/**
 * Writes only the fields present in the change, so two concurrent changes of different fields
 * never overwrite each other with a stale copy. Returns whether a row was updated: the caller must
 * never answer success for zero rows (a policy that filters the row is silent, not an error).
 */
export const updateMembership = async (
  transaction: CollaboratorTransaction,
  agencyId: string,
  membershipId: string,
  change: MembershipChange
): Promise<boolean> => {
  const assignments = ['updated_at = now()'];
  const bindings: SqlBinding[] = [];
  if (change.jobTitle !== undefined) {
    assignments.push('job_title = ?');
    bindings.push(change.jobTitle);
  }
  if (change.roleId !== undefined) {
    assignments.push('role_id = ?::uuid');
    bindings.push(change.roleId);
  }
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.agency_memberships
       set ${assignments.join(', ')}
     where agency_id = ?::uuid
       and id = ?::uuid
       and status = 'active'
    returning id
  `, [...bindings, agencyId, membershipId]);
  return result.rows.length === 1;
};
