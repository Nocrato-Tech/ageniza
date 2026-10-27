// The confirmation link of a public sign-up (issue #706). Forward-only, and a new migration.
//
// Better Auth's own e-mail verification is a stateless JWT carrying the address: it is not single
// use, a resend does not void the previous one, and `verifyEmail` consumes it without the password
// (security review of PR #721). The link is ours instead, with state:
//
//   - only the SHA-256 of the random token is stored, with the account, the expiry (24 hours) and
//     `consumed_at`; the token carries nothing, the e-mail included;
//   - issuing a new link voids every unconsumed one of the account;
//   - consuming it needs the credential the caller verified the password against (finding A1 of the
//     review of PR #720), and only then is the e-mail confirmed;
//   - the reset that takes over an unconfirmed account voids every unconsumed one.
//
// The table is read and written only by the functions below: the default privileges of schema
// `public` would hand `ageniza_app` full DML on it, so they are revoked outright, and RLS is enabled
// and forced with no policy. `security definer` ignores RLS, so every check is written inside each
// function under `set search_path = ''`. Every path locks the account first, then its links.
//
//   app_private.issue_email_confirmation(user_id, token_hash)     the sign-up, the resend, the invite
//   app_private.email_confirmation_by_token_hash(token_hash)       reads a live link, without consuming
//   app_private.consume_email_confirmation(token_hash, verified)   the link plus the password
//   app_private.confirm_email_by_password_reset(user_id)           replaced: voids the links here

export async function up(knex) {
  await knex.raw(`
    create table public.email_confirmations (
      id uuid not null default gen_random_uuid() primary key,
      user_id uuid not null references auth."user"(id) on delete cascade,
      token_hash text not null,
      expires_at timestamptz not null,
      consumed_at timestamptz null,
      created_at timestamptz not null default now(),
      constraint email_confirmations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint email_confirmations_token_hash_key unique (token_hash)
    );
    create index email_confirmations_user_id_idx on public.email_confirmations (user_id);

    alter table public.email_confirmations enable row level security;
    alter table public.email_confirmations force row level security;
    revoke all on public.email_confirmations from ageniza_app;
  `);

  await knex.raw(`
    -- Returns false, issuing nothing, for an account that does not exist or is already confirmed.
    create function app_private.issue_email_confirmation(p_user_id uuid, p_token_hash text)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform 1 from auth."user" account
      where account.id = p_user_id and account."emailVerified" = false
      for update;
      if not found then
        return false;
      end if;

      delete from public.email_confirmations link
      where link.user_id = p_user_id and link.consumed_at is null;

      insert into public.email_confirmations (user_id, token_hash, expires_at)
      values (p_user_id, p_token_hash, pg_catalog.now() + interval '24 hours');
      return true;
    end;
    $function$;
    revoke all on function app_private.issue_email_confirmation(uuid, text) from public;
    grant execute on function app_private.issue_email_confirmation(uuid, text) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.email_confirmation_by_token_hash(p_token_hash text)
    returns table (user_id uuid, email text)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select account.id, account.email
      from public.email_confirmations link
      join auth."user" account on account.id = link.user_id
      where link.token_hash = p_token_hash
        and link.consumed_at is null
        and link.expires_at > pg_catalog.now()
        and account."emailVerified" = false;
    $function$;
    revoke all on function app_private.email_confirmation_by_token_hash(text) from public;
    grant execute on function app_private.email_confirmation_by_token_hash(text) to ageniza_app;
  `);

  await knex.raw(`
    -- p_verified_hash is the credential hash the caller checked the password against: a reset that
    -- landed between that check and this call makes it differ from the account's, and nothing happens.
    -- Returns the confirmed account, or null for any refusal, one answer for all.
    create function app_private.consume_email_confirmation(p_token_hash text, p_verified_hash text)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_user_id uuid;
    begin
      if p_token_hash is null or p_verified_hash is null or p_verified_hash = '' then
        return null;
      end if;

      select link.user_id into v_user_id from public.email_confirmations link where link.token_hash = p_token_hash;
      if not found then
        return null;
      end if;

      perform 1 from auth."user" account
      where account.id = v_user_id and account."emailVerified" = false
      for update;
      if not found then
        return null;
      end if;

      -- The row lock, under the account's, is what makes the link single use.
      perform 1 from public.email_confirmations link
      where link.token_hash = p_token_hash and link.user_id = v_user_id
        and link.consumed_at is null and link.expires_at > pg_catalog.now()
      for update;
      if not found then
        return null;
      end if;

      if not exists (
        select 1 from auth."account" credential
        where credential."userId" = v_user_id and credential."providerId" = 'credential'
          and credential.password = p_verified_hash
      ) then
        return null;
      end if;

      update public.email_confirmations link set consumed_at = pg_catalog.now()
      where link.token_hash = p_token_hash;
      delete from public.email_confirmations link
      where link.user_id = v_user_id and link.consumed_at is null;
      update auth."user" account set "emailVerified" = true, "updatedAt" = pg_catalog.now()
      where account.id = v_user_id;
      return v_user_id;
    end;
    $function$;
    revoke all on function app_private.consume_email_confirmation(text, text) from public;
    grant execute on function app_private.consume_email_confirmation(text, text) to ageniza_app;
  `);

  await knex.raw(`
    -- The links are voided whether or not the account was still unconfirmed: a reset always means
    -- the mailbox is the one in charge now.
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
      set "emailVerified" = true, "updatedAt" = pg_catalog.now()
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
