// Migrations are forward-only: never edit an applied migration and never roll schema back
// automatically (ADR 0010, ADR 0011). Correct mistakes with a new migration.

export async function up(knex) {
  await knex.raw(`
    create schema if not exists app_private;
    revoke all on schema app_private from public;
    comment on schema app_private is 'Server-only database primitives such as RLS context helpers.';

    -- ageniza_app is created when the data volume is initialised (infra/postgres/initdb).
    grant usage on schema public to ageniza_app;
    grant usage on schema app_private to ageniza_app;
    alter default privileges in schema public grant select, insert, update, delete on tables to ageniza_app;
    alter default privileges in schema public grant usage, select on sequences to ageniza_app;
    alter default privileges in schema app_private revoke all on functions from public;

    -- RLS policies read the verified user set by withAuthenticatedUserTransaction.
    create function app_private.current_user_id() returns uuid
      language sql
      stable
      set search_path = ''
      as $$ select nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid $$;
    revoke all on function app_private.current_user_id() from public;
    grant execute on function app_private.current_user_id() to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
