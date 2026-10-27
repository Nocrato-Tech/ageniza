// Issue #719. Forward-only, and a new migration: none of the earlier ones is edited.
//
// Recorded in docs/business/decisions/2026-10-27-estrutural-toda-troca-de-senha-grava-a-data-e-o-login-confere-a-credencial-de-novo.md.
//
// 1. Every replacement of a credential's password stamps the date, in the very statement that replaced it. The date lives on
//    the credential's own row (`auth."account"."passwordChangedAt"`) and a BEFORE UPDATE trigger sets it on NEW: the trigger
//    writes no other row and takes no other lock. That is deliberate. A trigger that updated `auth."user"` would take the
//    lock of the account row first (the update already holds it) and then ask for the user row, the reverse of the order
//    `consume_email_confirmation`, `google_takes_over_account` and the purge use (user, then credential): the two would
//    deadlock (40P01) and a reset would answer 500 with its link consumed and the old password still valid.
//    The session guard refuses a session created at or before the greater of this date and `auth."user"."passwordChangedAt"`.
// 2. `app_private.confirm_email_by_password_reset` (the takeover by the reset) stamps the user's date itself as well: it is
//    the moment the earlier holder of an unconfirmed account loses it. It already holds the user lock, so it takes no new one.
// 3. The application role can no longer write either date: UPDATE on `auth."user"` and `auth."account"`, and INSERT on
//    `auth."account"`, become grants by column, without `passwordChangedAt`. Only the triggers and the definer functions
//    move it, so a compromised or buggy route cannot set it back, nor delete a credential and insert it again, to revive
//    an old session (the BEFORE INSERT trigger stamps the new row).

export async function up(knex) {
  await knex.raw(`
    alter table auth."account" add column "passwordChangedAt" timestamptz;

    create function app_private.stamp_password_changed_at()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      new."passwordChangedAt" := pg_catalog.clock_timestamp();
      return new;
    end;
    $function$;

    create trigger account_password_stamps_the_date
    before update of password on auth."account"
    for each row
    when (new."providerId" = 'credential' and new.password is distinct from old.password)
    execute function app_private.stamp_password_changed_at();

    -- A credential that is created with a password is a password set: the account with only Google that asks for
    -- "Esqueci a senha", and the row put back after the credential was deleted. The date comes from here, never from the insert.
    create trigger account_new_password_stamps_the_date
    before insert on auth."account"
    for each row
    when (new."providerId" = 'credential' and new.password is not null)
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

  // UPDATE by column on the two tables, every column that exists except the date. The application role keeps SELECT of it.
  for (const table of ['user', 'account']) {
    const { rows } = await knex.raw(
      `select column_name from information_schema.columns
       where table_schema = 'auth' and table_name = ? and column_name <> 'passwordChangedAt' order by ordinal_position`,
      [table]
    );
    const columns = rows.map((row) => `"${row.column_name}"`).join(', ');
    await knex.raw(`
      revoke update on auth."${table}" from ageniza_app;
      grant update (${columns}) on auth."${table}" to ageniza_app;
    `);
    if (table === 'account') {
      await knex.raw(`
        revoke insert on auth."account" from ageniza_app;
        grant insert (${columns}) on auth."account" to ageniza_app;
      `);
    }
  }
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
