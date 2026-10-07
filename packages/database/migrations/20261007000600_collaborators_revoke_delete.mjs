// Issue #356. Removing a collaborator or cancelling an invitation never deletes the row: SPEC
// colaboradores rule 11 for `agency_memberships`, and the forward-only trigger of
// `20261006000200` for `invitations` (a revoked invitation is evidence). The grant of
// `20260919000000_tenancy_and_invitations.mjs` still handed `ageniza_app` DELETE on both tables,
// and only the absence of a DELETE policy under forced RLS kept it from working: one `create
// policy ... for delete` by mistake would have erased memberships and invitations.
//
// Revoking DELETE makes the privilege layer say what the SPEC and the RLS already say. The
// legitimate paths do not delete: removing and reactivating are UPDATEs of `status`
// (`20260928000000`), cancelling is an UPDATE of `revoked_at` (`20260925000000`), and the
// SECURITY DEFINER functions run as the schema owner, which this does not touch.
export async function up(knex) {
  await knex.raw(`
    revoke delete on public.agency_memberships from ageniza_app;
    revoke delete on public.invitations from ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
