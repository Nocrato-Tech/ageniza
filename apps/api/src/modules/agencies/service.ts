import { raw, type DatabaseClient } from '@ageniza/database';
import type { AgencyContext, AgencyMeResponse } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';

type AgencyTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

interface AgencyMeRow {
  readonly agency_id: string;
  readonly agency_name: string;
  readonly is_owner: boolean;
  readonly membership_id: string | null;
  readonly role_key: string;
  readonly role_name: string;
  readonly permissions: readonly string[] | null;
  readonly plan: 'trial' | 'ativo' | 'isenta';
  readonly trial_ends_at: Date | null;
  readonly read_only: boolean;
}

/**
 * Resolves the effective permissions of one agency context for the authenticated user. The
 * permission list is read from `app_private.agency_permission_keys` (#189), the one function that
 * resolves it -- the owner gets the whole catalog, every other the keys of the active membership's
 * role scoped to `role.agency_id is null or role.agency_id = agency.id` -- and the database test
 * `agency-permission-keys.integration.test.ts` holds it to `app_private.has_agency_permission`
 * key by key, the one RLS reads; `agencies.integration.test.ts` proves the equivalence again here.
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
      membership.id as membership_id,
      -- Owner is not a role, so an owner without an effective membership role is labelled with the
      -- admin preset, exactly like GET /me/contexts. Every other case without a role (a
      -- membership pointing at another agency's role, hidden by the scope above) gets a neutral
      -- label instead of borrowing "Admin": permissions below stay the authoritative field.
      case
        when role.id is not null then role.key
        when agency.owner_user_id = app_private.current_user_id() then 'admin'
        else 'sem-papel'
      end as role_key,
      case
        when role.id is not null then role.name
        when agency.owner_user_id = app_private.current_user_id() then 'Admin'
        else 'Sem papel'
      end as role_name,
      (
        select coalesce(array_agg(held.key order by held.key), array[]::text[])
        from app_private.agency_permission_keys(agency.id) as held(key)
      ) as permissions,
      agency.plan,
      agency.trial_ends_at,
      -- The database clock decides, with the comparison the write trigger makes.
      (agency.plan = 'trial' and agency.trial_ends_at <= now()) as read_only
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
    membershipId: row.membership_id,
    role: { key: row.role_key, name: row.role_name },
    permissions: [...(row.permissions ?? [])],
    plan: {
      kind: row.plan,
      trialEndsAt: row.trial_ends_at === null ? null : new Date(row.trial_ends_at).toISOString(),
      readOnly: row.read_only === true
    }
  };
};

const databaseErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

const emailNotVerified = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'EMAIL_NOT_VERIFIED',
  message: 'Confirme o seu e-mail antes de criar uma agência.'
});

const trialAlreadyExists = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'TRIAL_ALREADY_EXISTS',
  message: 'Sua conta já tem uma agência em período de teste.'
});

/**
 * Creates the agency in trial through `app_private.create_trial_agency` (issue #709), which takes the actor from the
 * transaction, and answers the new context as `GET /me/contexts` lists it. The unique index on one trial per owner is
 * the last word under a race, so its violation is the same refusal as the function's.
 */
export const createTrialAgency = async (transaction: AgencyTransaction, name: string): Promise<AgencyContext> => {
  try {
    const created = await raw<RawRows<{ id: string }>>(transaction, 'select app_private.create_trial_agency(?) as id', [name]);
    // A statement of its own: the rows the function inserted are not in the snapshot of the statement that called it.
    const result = await raw<RawRows<{ agency_id: string; agency_name: string; role_key: string; role_name: string }>>(transaction, `
      select agency.id as agency_id, agency.name as agency_name, role.key as role_key, role.name as role_name
      from public.agencies agency
      join public.agency_memberships membership on membership.agency_id = agency.id and membership.user_id = app_private.current_user_id()
      join public.roles role on role.id = membership.role_id
      where agency.id = ?::uuid
    `, [created.rows[0]?.id ?? null]);
    const row = result.rows[0];
    if (row === undefined) throw new Error('The created agency is not visible to its owner.');
    return { type: 'agency', agencyId: row.agency_id, agencyName: row.agency_name, roleKey: row.role_key, roleName: row.role_name, isOwner: true };
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === 'A0093') throw emailNotVerified();
    if (code === 'A0094') throw trialAlreadyExists();
    throw error;
  }
};