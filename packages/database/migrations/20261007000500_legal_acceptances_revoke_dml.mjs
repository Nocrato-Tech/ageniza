// Issue #343. `public.legal_acceptances` is evidence of consent: the application role only reads
// it. The grant of `20260919000000_tenancy_and_invitations.mjs` handed `ageniza_app` insert, update
// and delete on the whole table, and only the forced RLS (no INSERT, UPDATE or DELETE policy) kept
// them from working. Revoking them makes the privilege layer say the same as the SPEC (section 6,
// issue #81, item 3) and as the RLS, so removing a barrier by mistake no longer opens the table.
//
// Every legitimate write is a SECURITY DEFINER function and runs as the schema owner, which this
// does not touch: app_private.accept_invitation (account creation) and
// app_private.accept_legal_document (re-acceptance by document). SELECT stays, behind the
// `legal_acceptances_select` policy that limits it to the signed-in person's own rows.
export async function up(knex) {
  await knex.raw(`
    revoke insert, update, delete on public.legal_acceptances from ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
