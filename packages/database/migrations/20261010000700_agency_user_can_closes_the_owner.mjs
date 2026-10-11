// `agency_user_can` closes the owner like `has_agency_permission` (issue #508). Forward-only, and a new migration:
// 20261007001200_contents.mjs is not edited.
//
// Recorded in docs/business/decisions/2026-10-10-agency-user-can-tambem-nega-chave-fora-do-catalogo.md, which applies
// to this function what 2026-10-10-a-api-le-a-autorizacao-de-agencia-de-uma-funcao-e-a-rls-nao.md decided for
// `has_agency_permission`.
//
// `app_private.agency_user_can(agency, person, key)` is the third SQL copy of "what does this person hold in this
// agency": the Conteúdo triggers (`contents_check_references`, `content_tasks_check_people`) call it to check that the
// owner or the assignee of a content is a collaborator who can see it. For the owner it answered true for ANY text.
// It now answers true only for a key that exists in `public.permissions`, through one primary-key lookup in the owner
// branch, which is what `has_agency_permission` and `agency_permission_keys` already do.
//
// Nothing that is open closes: the only caller passes the literal `conteudo.visualizar`, which is in the catalog (the
// database test proves every literal asked of these functions is). The body is the old one with that single addition;
// `create or replace` keeps the signature, volatility, security, search_path, owner and ACL (no EXECUTE for PUBLIC or
// for `ageniza_app`: only the schema owner, through the triggers).

export async function up(knex) {
  await knex.raw(String.raw`
    create or replace function app_private.agency_user_can(p_agency_id uuid, p_user_id uuid, p_permission text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1 from public.agencies agency
        where agency.id = p_agency_id
          and agency.status = 'active'
          and agency.owner_user_id = p_user_id
          and exists (select 1 from public.permissions permission where permission.key = p_permission)
      ) or exists (
        select 1
        from public.agencies agency
        join public.agency_memberships membership on membership.agency_id = agency.id
        join public.roles role on role.id = membership.role_id
        join public.role_permissions role_permission on role_permission.role_id = role.id
        where agency.id = p_agency_id
          and agency.status = 'active'
          and membership.user_id = p_user_id
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
