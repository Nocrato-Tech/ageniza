// Triggers that skip by role attribute, not by login name (issue #397). Forward-only, and a new migration:
// the ones that created these functions are not edited.
//
// Recorded in docs/business/decisions/2026-10-10-os-gatilhos-pulam-pelo-atributo-do-papel-e-o-job-de-arquivamento-vai-cliente-a-cliente.md.
//
// Five trigger functions decided who they govern by comparing a name with 'ageniza_app':
//   check_agency_membership_update, invitation_state_is_forward_only, media_asset_upload_state_is_forward_only and
//   story_script_scenes_guard_write test `current_user`; lock_active_client_of_child tests `session_user`, because inside a
//   security definer function `current_user` is the owner.
// A new login that is not the application role and has no bypass (a pooler, a worker with another login) was skipped by all
// five: the lock of the archive was never taken for a login that does `SET ROLE ageniza_app`, since its `session_user` is
// the new login, and the other four guards did not run for a login that inherits the privileges of `ageniza_app`.
// They now skip only for a role with `rolsuper` or `rolbypassrls`, the roles RLS and grants do not constrain either.
//
// The four invoker functions and the definer one are read from the catalog, and only the one comparison is replaced,
// instead of copying five bodies again: each result differs from what is deployed in that line and in nothing else, and
// `create or replace` keeps owner and grants. The migration fails when a comparison is not found exactly once.

const REPLACEMENTS = [
  ['app_private.check_agency_membership_update()', "if current_user <> 'ageniza_app' then", 'if app_private.role_bypasses_rls(current_user) then'],
  ['app_private.invitation_state_is_forward_only()', "if current_user <> 'ageniza_app' then", 'if app_private.role_bypasses_rls(current_user) then'],
  ['app_private.media_asset_upload_state_is_forward_only()', "if current_user <> 'ageniza_app' then", 'if app_private.role_bypasses_rls(current_user) then'],
  ['app_private.story_script_scenes_guard_write()', "if current_user <> 'ageniza_app' then", 'if app_private.role_bypasses_rls(current_user) then'],
  [
    'app_private.lock_active_client_of_child()',
    "if session_user <> 'ageniza_app' or new.client_id is null then",
    'if app_private.role_bypasses_rls(session_user) or new.client_id is null then'
  ]
];

export async function up(knex) {
  await knex.raw(`
    -- Whether RLS and grants constrain a role at all. It reads one attribute pair from pg_roles, which every role may
    -- read already, and an unknown role is constrained (false), so a typo or a dropped role fails closed.
    create function app_private.role_bypasses_rls(p_role name)
    returns boolean
    language sql
    stable
    set search_path = ''
    as $function$
      select coalesce(
        (select role.rolsuper or role.rolbypassrls from pg_catalog.pg_roles role where role.rolname = p_role),
        false
      )
    $function$;
    revoke all on function app_private.role_bypasses_rls(name) from public;
    grant execute on function app_private.role_bypasses_rls(name) to ageniza_app;
  `);

  for (const [signature, before, after] of REPLACEMENTS) {
    const { rows } = await knex.raw('select pg_catalog.pg_get_functiondef(?::pg_catalog.regprocedure) as definition', [signature]);
    const definition = rows[0].definition;
    const occurrences = definition.split(before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${signature} must contain "${before}" exactly once, found ${occurrences}.`);
    }
    await knex.raw(definition.replace(before, () => after));
  }
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
