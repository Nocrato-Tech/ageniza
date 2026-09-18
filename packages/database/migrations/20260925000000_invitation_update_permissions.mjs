/**
 * Issue #39. The UPDATE on `invitations` is always a revocation, reached from three routes:
 * creating an equivalent invitation (`*.convidar`), resending (`convite.reenviar`) and cancelling
 * (`convite.cancelar`). The original policy recognised only the first, so a role holding just
 * `convite.cancelar` would pass the API check and then see no rows. Every permission that governs
 * one of those routes is accepted here; `admin` already holds all four, so nothing changes today.
 */
export async function up(knex) {
  await knex.raw(`
    -- Row scope alone would be far too broad: the table grant covers every column, so a role that
    -- may only cancel could otherwise rewrite role_id, email, expires_at or token_hash of any
    -- pending invitation. Revocation is the only update the application performs.
    revoke update on public.invitations from ageniza_app;
    grant update (revoked_at) on public.invitations to ageniza_app;

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

    -- Resending revokes and then INSERTS a replacement, so the insert policy has to recognise
    -- convite.reenviar too; otherwise that role passes the API check and the insert trips RLS,
    -- turning an authorization decision into a 500.
    drop policy invitations_insert on public.invitations;

    create policy invitations_insert on public.invitations
      for insert to ageniza_app
      with check (
        (purpose = 'collaborator_invite' and (
          app_private.has_agency_permission(agency_id, 'colaborador.convidar')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
        ))
        or (purpose = 'client_invite' and (
          app_private.has_agency_permission(agency_id, 'cliente.convidar_usuario')
          or app_private.has_agency_permission(agency_id, 'convite.reenviar')
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

    -- Issue #38. The e-mail templates reject a display name over 256 characters, so a longer one
    -- leaves every invitation for that tenant permanently undeliverable. The CLI now refuses it,
    -- but agencies and clients are also written by operators over direct SQL, so the bound belongs
    -- here as well.
    alter table public.agencies add constraint agencies_name_length check (length(name) <= 256);
    alter table public.clients add constraint clients_name_length check (length(name) <= 256);
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
