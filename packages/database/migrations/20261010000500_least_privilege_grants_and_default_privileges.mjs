// Least privilege for the application role (issue #372). Forward-only, and a new migration: the ones that granted
// these privileges are not edited.
//
// Recorded in docs/business/decisions/2026-10-10-grants-por-coluna-e-tabela-nova-sem-privilegio-automatico.md (structural).
//
// 1. Seven tables carried an INSERT of the whole table for `ageniza_app` with no INSERT policy at all: with forced RLS
//    nothing gets in today, but one permissive policy created by mistake would open every column. Nobody inserts into them
//    as the application role (the schema owner does, through the CLI and the security definer functions), so the privilege
//    goes away.
// 2. `invitations` and `user_context_preferences` do have an INSERT policy, and carried the INSERT, and for the second
//    the UPDATE, of the whole table. They become the columns the routes write.
// 3. The foundation's default privileges handed `ageniza_app` select, insert, update and delete on every new table of
//    `public` and `auth`, so a table created by a later migration was open to the application role until someone remembered
//    to narrow it. They are revoked: from here on a migration that creates a table declares, grant by grant, what the
//    application role may do with it. The sequences' default stays, and so does the `pgboss` schema's, which the queue
//    library creates tables in at run time.
//
// DELETE on `user_context_preferences` stays: it is the person's own preference, not a business entity, and its delete
// policy exists. The UPDATE that is left is by column, which keeps `select ... for update/share` working (a row lock only
// asks for UPDATE on some column); no code takes one on a table whose UPDATE is narrowed here.

export async function up(knex) {
  await knex.raw(`
    revoke insert on
      public.agencies,
      public.agency_memberships,
      public.agency_storage_quotas,
      public.client_memberships,
      public.permissions,
      public.role_permissions,
      public.roles
    from ageniza_app;

    revoke insert on public.invitations from ageniza_app;
    grant insert (agency_id, purpose, email, role_id, client_id, token_hash, expires_at, invited_by_user_id)
      on public.invitations to ageniza_app;

    revoke insert, update on public.user_context_preferences from ageniza_app;
    grant insert (user_id, context_type, agency_id, client_id, updated_at)
      on public.user_context_preferences to ageniza_app;
    grant update (context_type, agency_id, client_id, updated_at)
      on public.user_context_preferences to ageniza_app;

    alter default privileges in schema public revoke select, insert, update, delete on tables from ageniza_app;
    alter default privileges in schema auth revoke select, insert, update, delete on tables from ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
