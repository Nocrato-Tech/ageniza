// An account whose e-mail is not confirmed opens no context (decision 2026-10-27, "a conta de convite só entra depois de
// confirmar"). Forward-only.
//
// The session of the account born through a copied invitation token still exists (the click on the confirmation link
// needs it), so the agency and client guards and the list of contexts ask the database, in the transaction that already
// runs for them, whether the account is confirmed. The function answers "not confirmed" for an id with no account too,
// so a mistake in the caller fails closed. It is `security definer` because the application role reads no column of
// `auth."user"` that says it, and it reads only the account given.

export async function up(knex) {
  await knex.raw(`
    create function app_private.email_not_confirmed(p_user_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select not exists (
        select 1 from auth."user" account
        where account.id = p_user_id and account."emailVerified" = true
      );
    $function$;
    revoke all on function app_private.email_not_confirmed(uuid) from public;
    grant execute on function app_private.email_not_confirmed(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
