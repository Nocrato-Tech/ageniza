// Agency authorization: one reading for the API, and a closed owner (issue #189). Forward-only, and a new
// migration: 20260919000000_tenancy_and_invitations.mjs is not edited.
//
// Recorded in docs/business/decisions/2026-10-10-a-api-le-a-autorizacao-de-agencia-de-uma-funcao-e-a-rls-nao.md.
//
// The permissions a person holds in an agency were resolved in three places that had to agree:
// `app_private.has_agency_permission` (what RLS reads), the API guard and `GET /agencies/:id/me`.
// `app_private.agency_permission_keys` is the one reading the API moves to (in a following change), and
// a database test holds it to `has_agency_permission` key by key across every scenario.
//
// `has_agency_permission` is deliberately NOT defined from it. RLS calls it once per row, and a
// `security definer` function that calls another `security definer` function cannot be inlined: on 20,000
// rows the listing of media and of invitations ran 4.5x to 12.6x slower (605 ms -> 7,598 ms for the owner
// on media). The decision file has the table. Do not derive the policy function from the keys function.
//
// The function takes no user: it answers for the person bound to the transaction, so nobody can ask
// what another person holds. A person who is neither the owner nor an active member of an active
// agency gets an empty set, the same answer as for an agency that does not exist.
//
// One behavior changes on purpose: the owner holds every key of `public.permissions`, no longer "any
// text". `has_agency_permission(agency, 'a.key.that.does.not.exist')` answered true for the owner and
// answers false now, through one primary-key lookup in the owner branch. No policy asks for a key
// outside the catalog (the database test proves it), so only a typo in a future policy changes: it
// fails closed instead of silently opening for the owner.

export async function up(knex) {
  await knex.raw(String.raw`
    create function app_private.agency_permission_keys(p_agency_id uuid)
    returns setof text
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      -- Ownership is a property of the agency, independent of any membership row: the owner holds the
      -- whole catalog, including keys no preset carries (colaborador.atribuir_admin).
      select permission.key
      from public.agencies as agency
      cross join public.permissions as permission
      where agency.id = p_agency_id
        and agency.status = 'active'
        and agency.owner_user_id = app_private.current_user_id()
      union
      -- Everyone else holds what the role of their active membership carries. A role is a system role
      -- (no agency) or a role of this very agency: a membership pointing at another agency's role grants
      -- nothing.
      select role_permission.permission_key
      from public.agencies as agency
      join public.agency_memberships as membership on membership.agency_id = agency.id
      join public.roles as role on role.id = membership.role_id
      join public.role_permissions as role_permission on role_permission.role_id = role.id
      where agency.id = p_agency_id
        and agency.status = 'active'
        and membership.user_id = app_private.current_user_id()
        and membership.status = 'active'
        and (role.agency_id is null or role.agency_id = agency.id)
    $function$;
    revoke all on function app_private.agency_permission_keys(uuid) from public;
    grant execute on function app_private.agency_permission_keys(uuid) to ageniza_app;

    -- Same signature, volatility, security and search_path as before, so every policy that calls it, and
    -- the grant it already has, stay as they are. The body is the old one with a single addition: the
    -- owner holds a key only if the key exists in the catalog.
    create or replace function app_private.has_agency_permission(p_agency_id uuid, p_permission text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1
        from public.agencies agency
        where agency.id = p_agency_id
          and agency.status = 'active'
          and agency.owner_user_id = app_private.current_user_id()
          and exists (select 1 from public.permissions permission where permission.key = p_permission)
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
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
