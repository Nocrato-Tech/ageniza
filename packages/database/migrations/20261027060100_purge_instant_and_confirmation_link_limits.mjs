// Two corrections from the security review of PR #732 (findings B1 and B2). Forward-only, and a new migration.
//
// B1. `purge_unconfirmed_accounts` took any `p_at`, so a connection of `ageniza_app` with no user bound could pass a date years ahead and
//     delete accounts younger than 7 days or with a live session. The instant exists for the tests to fix the clock, never to look ahead:
//     it is refused (22023) past now() plus one minute, the skew tolerated between the caller and the database.
// B2. A confirmation link issued on the 6th day lived until the 7th, past the purge, and the account was deleted with the link still valid.
//     `issue_email_confirmation` now limits `expires_at` to `least(now() + 24 hours, createdAt + retention)` for an account with no tie,
//     the only kind the purge deletes, and issues nothing once that instant has passed. A link is not a tie: counting it would let whoever
//     typed a stranger's address keep the account by asking for a link every day. An account with a tie (an invitation created it) is
//     never purged, so its link keeps the 24 hours.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.purge_unconfirmed_accounts(p_at timestamptz, p_limit integer)
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
      -- The instant is a parameter for the tests, never to look ahead: a minute is the skew tolerated between the caller and the database.
      if p_at > pg_catalog.now() + interval '1 minute' then
        raise exception using errcode = '22023', message = 'The purge cannot be run at an instant in the future.';
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

    create or replace function app_private.issue_email_confirmation(p_user_id uuid, p_token_hash text)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_created_at timestamptz;
      v_expires_at timestamptz := pg_catalog.now() + interval '24 hours';
    begin
      select account."createdAt" into v_created_at
      from auth."user" account
      where account.id = p_user_id and account."emailVerified" = false
      for update;
      if not found then
        return false;
      end if;

      if not app_private.unconfirmed_account_has_ties(p_user_id, pg_catalog.now()) then
        v_expires_at := least(v_expires_at, v_created_at + app_private.unconfirmed_account_retention());
        if v_expires_at <= pg_catalog.now() then
          return false;
        end if;
      end if;

      delete from public.email_confirmations link
      where link.user_id = p_user_id and link.consumed_at is null;

      insert into public.email_confirmations (user_id, token_hash, expires_at)
      values (p_user_id, p_token_hash, v_expires_at);
      return true;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
