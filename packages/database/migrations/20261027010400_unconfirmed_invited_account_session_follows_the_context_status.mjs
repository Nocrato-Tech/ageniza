// The unconfirmed account's session follows the same status rules as its context (issue #706, review
// of PR #722, finding B1). Forward-only.
//
// 20261027010300 let an unconfirmed account keep its session while the invitation's link stood, and
// checked the membership and the owner but never `agencies.status` or `clients.status`. An account of
// a suspended agency, or of an archived client, listed no context (`contexts/service.ts` asks for
// `agency.status = 'active'`, and for `client.status = 'active'` on a client) and still held a
// session. The conditions below are the ones of those two queries, so the exception lasts exactly as
// long as the account would still list the context its invitation gave it.
//
// `create or replace` keeps the grants of the function.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.unconfirmed_account_may_hold_session(p_user_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1
        from auth."user" account
        join public.invitations invitation on invitation.accepted_by_user_id = account.id
        where account.id = p_user_id
          and account."emailVerified" = false
          and invitation.used_at is not null
          and (
            (invitation.purpose = 'agency_activation' and exists (
              select 1 from public.agencies agency
              where agency.id = invitation.agency_id and agency.owner_user_id = account.id
                and agency.status = 'active'
            ))
            or (invitation.purpose = 'collaborator_invite' and exists (
              select 1
              from public.agency_memberships membership
              join public.agencies agency on agency.id = membership.agency_id
              where membership.agency_id = invitation.agency_id and membership.user_id = account.id
                and membership.status = 'active'
                and agency.status = 'active'
            ))
            or (invitation.purpose = 'client_invite' and exists (
              select 1
              from public.client_memberships membership
              join public.clients client on client.id = membership.client_id
              join public.agencies agency on agency.id = client.agency_id
              where membership.client_id = invitation.client_id and membership.user_id = account.id
                and membership.status = 'active'
                and client.status = 'active'
                and agency.status = 'active'
            ))
          )
      );
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
