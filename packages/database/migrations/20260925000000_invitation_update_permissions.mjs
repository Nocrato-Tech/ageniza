/**
 * Issue #39. The UPDATE on `invitations` is always a revocation, reached from three routes:
 * creating an equivalent invitation (`*.convidar`), resending (`convite.reenviar`) and cancelling
 * (`convite.cancelar`). The original policy recognised only the first, so a role holding just
 * `convite.cancelar` would pass the API check and then see no rows. Every permission that governs
 * one of those routes is accepted here; `admin` already holds all four, so nothing changes today.
 */
export async function up(knex) {
  await knex.raw(`
    drop policy invitations_update on public.invitations;

    create policy invitations_update on public.invitations
      for update to ageniza_app
      using (
        (purpose = 'collaborator_invite' and (
          app_private.has_agency_permission(agency_id, 'colaborador.convidar')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
          or app_private.has_agency_permission(agency_id, 'convite.cancelar')
        ))
        or (purpose = 'client_invite' and (
          app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
          or app_private.has_agency_permission(agency_id, 'convite.cancelar')
        ))
      )
      with check (
        (purpose = 'collaborator_invite' and (
          app_private.has_agency_permission(agency_id, 'colaborador.convidar')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
          or app_private.has_agency_permission(agency_id, 'convite.cancelar')
        ))
        or (purpose = 'client_invite' and (
          app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
          or app_private.has_agency_permission(agency_id, 'convite.cancelar')
        ))
      );

    drop policy invitations_select on public.invitations;

    create policy invitations_select on public.invitations
      for select to ageniza_app
      using (
        app_private.has_agency_permission(agency_id, 'colaborador.convidar')
        or app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
        or app_private.has_agency_permission(agency_id, 'convite.reenviar')
        or app_private.has_agency_permission(agency_id, 'convite.cancelar')
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
