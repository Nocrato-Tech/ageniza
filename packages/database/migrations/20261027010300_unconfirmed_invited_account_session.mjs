// The one unconfirmed account that may hold a session (issue #706, after PR #721). Forward-only.
//
// The decision on the copyable invitation link (2026-10-26, item 2) makes the account created by
// accepting an invitation an explicit exception to "sem confirmar, não há sessão": it gets its session
// and its context at once, and confirms the e-mail later. The password login stays closed to every
// unconfirmed account (it answers like invalid credentials, so it never tells an invited account
// apart); the only session such an account has is the one `accept-new-account` creates.
//
// The session guard asks this function whether an unconfirmed account may keep a session: only
// when it accepted an invitation and still has the link that invitation gave it (the agency it owns,
// or an active membership in the agency or client of the invitation). An account that signed up on
// its own never accepted an invitation, and one removed from everything it was invited to loses the
// exception with the link. Read by the guard through the Better Auth pool, which has no actor bound,
// so it is `security definer` and reads only the account given.

export async function up(knex) {
  await knex.raw(`
    create function app_private.unconfirmed_account_may_hold_session(p_user_id uuid)
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
            ))
            or (invitation.purpose = 'collaborator_invite' and exists (
              select 1 from public.agency_memberships membership
              where membership.agency_id = invitation.agency_id and membership.user_id = account.id
                and membership.status = 'active'
            ))
            or (invitation.purpose = 'client_invite' and exists (
              select 1 from public.client_memberships membership
              where membership.client_id = invitation.client_id and membership.user_id = account.id
                and membership.status = 'active'
            ))
          )
      );
    $function$;
    revoke all on function app_private.unconfirmed_account_may_hold_session(uuid) from public;
    grant execute on function app_private.unconfirmed_account_may_hold_session(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
