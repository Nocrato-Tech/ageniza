// Issue #724 (security review of PR #722, finding 4, LGPD). Forward-only, and a new migration.
//
// Recorded in docs/business/decisions/2026-10-27-estrutural-contas-nao-confirmadas-somem-em-7-dias.md.
//
// A sign-up that is never confirmed keeps a name and an e-mail that a third party may have typed. Two changes:
//
// 1. `app_private.purge_unconfirmed_accounts(p_at, p_limit)` deletes the accounts that were never confirmed, are older than
//    `unconfirmed_account_retention()` (7 days) at `p_at`, and have no tie at all: no agency of their own, no agency or client
//    membership, no invitation they sent or accepted, and no live session. An account an invitation created has a tie, so it is
//    never touched. The confirmations, the acceptances and the other rows of the account go with it. The instant is a parameter
//    (the job passes now()) so that the tests do not depend on the clock (lesson of #730).
//    - `security definer`, closed to PUBLIC, open to `ageniza_app` (the role the worker connects as) and refused when a user is
//      bound to the transaction, as every request binds one and the worker never does (as `media_due_for_purge`).
//    - One run at a time: a transaction-level advisory lock, taken with `try`, so a second run answers 0 instead of waiting.
//    - Each account is locked (`for update`) and its ties are read again under that lock: a tie is created through a foreign key
//      to the account, which waits for that lock. An account that still cannot be deleted for a key not listed here is left.
//    - The audit records the id of the account, never the e-mail or the name.
// 2. `confirm_email_by_password_reset` also replaces the name: the account is taken over by the owner of the mailbox, and the name
//    the third party typed does not survive. The name is not empty because the response of sign-in and of the session requires one
//    (`AuthUserSchema`, `min(1)`): an empty name made the taken-over account unable to sign in. It becomes the part of the address
//    before the `@`, which is the owner's own data, until the owner edits the profile.

export async function up(knex) {
  await knex.raw(`
    create function app_private.unconfirmed_account_retention()
    returns interval
    language sql
    immutable
    set search_path = ''
    as $function$
      select interval '7 days'
    $function$;
    revoke all on function app_private.unconfirmed_account_retention() from public;

    create function app_private.unconfirmed_account_has_ties(p_user_id uuid, p_at timestamptz)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (select 1 from public.agencies agency where agency.owner_user_id = p_user_id)
        or exists (select 1 from public.agency_memberships membership where membership.user_id = p_user_id)
        or exists (select 1 from public.client_memberships membership where membership.user_id = p_user_id)
        or exists (
          select 1 from public.invitations invitation
          where invitation.accepted_by_user_id = p_user_id or invitation.invited_by_user_id = p_user_id
        )
        or exists (select 1 from auth.session session where session."userId" = p_user_id and session."expiresAt" > p_at)
    $function$;
    revoke all on function app_private.unconfirmed_account_has_ties(uuid, timestamptz) from public;

    create function app_private.purge_unconfirmed_accounts(p_at timestamptz, p_limit integer)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_candidate uuid;
      v_deleted integer := 0;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The unconfirmed accounts are purged by the worker, not by a request.';
      end if;
      if p_at is null then
        raise exception using errcode = '22023', message = 'The purge needs the instant it is run at.';
      end if;
      if p_limit is null or p_limit < 1 or p_limit > 500 then
        raise exception using errcode = '22023', message = 'The batch is between 1 and 500 accounts.';
      end if;

      if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('app_private.purge_unconfirmed_accounts', 0)) then
        return 0;
      end if;

      for v_candidate in
        select account.id
        from auth."user" account
        where account."emailVerified" = false
          and account."createdAt" < p_at - app_private.unconfirmed_account_retention()
          and not app_private.unconfirmed_account_has_ties(account.id, p_at)
        order by account."createdAt", account.id
        limit p_limit
      loop
        perform 1
        from auth."user" account
        where account.id = v_candidate
          and account."emailVerified" = false
          and account."createdAt" < p_at - app_private.unconfirmed_account_retention()
        for update;
        if not found or app_private.unconfirmed_account_has_ties(v_candidate, p_at) then
          continue;
        end if;

        begin
          delete from public.legal_acceptances where user_id = v_candidate;
          delete from public.user_context_preferences where user_id = v_candidate;
          delete from auth.verification where value = v_candidate::text;
          delete from auth."user" where id = v_candidate;

          insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
          values ('account.unconfirmed_purged', null, null, 'user', v_candidate, 'job:accounts.purge-unconfirmed');
          v_deleted := v_deleted + 1;
        exception when foreign_key_violation then
          null;
        end;
      end loop;

      return v_deleted;
    end;
    $function$;
    revoke all on function app_private.purge_unconfirmed_accounts(timestamptz, integer) from public;
    grant execute on function app_private.purge_unconfirmed_accounts(timestamptz, integer) to ageniza_app;

    create or replace function app_private.confirm_email_by_password_reset(p_user_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform 1 from auth."user" account where account.id = p_user_id for update;

      delete from public.email_confirmations link
      where link.user_id = p_user_id and link.consumed_at is null;

      update auth."user"
      set "emailVerified" = true, name = pg_catalog.left(pg_catalog.split_part(email, '@', 1), 256), "updatedAt" = pg_catalog.now()
      where id = p_user_id and "emailVerified" = false;
      if not found then
        return false;
      end if;

      update public.legal_acceptances
      set revoked_at = pg_catalog.now()
      where user_id = p_user_id and revoked_at is null;

      return true;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
