// Confirming the e-mail and resetting the password, serialized (security review of PR #722, finding 3).
// Forward-only, and a new migration.
//
// `consume_email_confirmation` compared the account's credential with the one the caller verified
// without locking it, so a reset could replace the password between that comparison and the commit:
// the link was consumed under a password that no longer existed, and the reset, finding the account
// already confirmed, did not take it over. Now the credential row is locked (`for update`) under the
// account's lock before it is compared. The reset's password update waits for the confirmation to
// commit, or the confirmation sees the new credential and refuses; either way the two never overlap,
// and `confirm_email_by_password_reset`, which locks the account too, takes over every account that
// is still unconfirmed when the reset lands.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.consume_email_confirmation(p_token_hash text, p_verified_hash text)
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

      -- Locked, so a password reset cannot replace it between this comparison and the commit.
      perform 1 from auth."account" credential
      where credential."userId" = v_user_id and credential."providerId" = 'credential'
        and credential.password = p_verified_hash
      for update;
      if not found then
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
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
