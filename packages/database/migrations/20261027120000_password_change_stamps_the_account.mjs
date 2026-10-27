// Issue #719. Forward-only, and a new migration: none of the earlier ones is edited.
//
// Recorded in docs/business/decisions/2026-10-27-estrutural-toda-troca-de-senha-grava-a-data-e-o-login-confere-a-credencial-de-novo.md.
//
// 1. Every replacement of a credential's password stamps `auth."user"."passwordChangedAt"`, in the very statement that
//    replaced it: a trigger on `auth.account`, so the reset ("Esqueci a senha"), a future change of password and any other
//    writer are covered without each remembering to. Security definer because the application role only reads that
//    column (the date is not something a route may write). It is a BEFORE trigger on purpose: it takes the lock of the
//    user row before the update takes the one of the account row, the order `consume_email_confirmation` already uses
//    (user, then credential); an AFTER trigger would reverse it and the two could deadlock.
// 2. `app_private.confirm_email_by_password_reset` (the takeover by the reset) stamps the date itself as well: it is the
//    moment the earlier holder of an unconfirmed account loses it, whatever wrote the password before it.

export async function up(knex) {
  await knex.raw(`
    create function app_private.stamp_password_changed_at()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      update auth."user" set "passwordChangedAt" = pg_catalog.clock_timestamp() where id = new."userId";
      return new;
    end;
    $function$;
    revoke all on function app_private.stamp_password_changed_at() from public;
    revoke all on function app_private.stamp_password_changed_at() from ageniza_app;

    create trigger account_password_stamps_the_user
    before update of password on auth."account"
    for each row
    when (new."providerId" = 'credential' and new.password is distinct from old.password)
    execute function app_private.stamp_password_changed_at();

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
      set "emailVerified" = true, name = pg_catalog.left(pg_catalog.split_part(email, '@', 1), 256),
          "passwordChangedAt" = pg_catalog.clock_timestamp(), "updatedAt" = pg_catalog.now()
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
