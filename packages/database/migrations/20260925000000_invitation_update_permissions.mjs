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
    -- turning an authorization decision into a 500. The trade-off is real: RLS no longer enforces
    -- on its own that only an inviter creates an invitation, since a resend is indistinguishable
    -- from a fresh insert at this level. The API keeps that boundary (the resend copies e-mail and
    -- role from the locked row), and narrowing it further would need a security-definer function
    -- for the resend itself.
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

    -- Issue #38. The e-mail templates reject a blank display name or one over 256 UTF-16 units,
    -- and a name that violates either leaves every invitation for that tenant permanently
    -- undeliverable. Operators write both tables over direct SQL, so the bound belongs here too.
    -- octet_length is the check that actually holds: UTF-8 bytes are never fewer than UTF-16 units,
    -- so <= 256 bytes guarantees the template's limit, which length() in characters would not.
    -- NOT VALID applies to new and updated rows without validating existing ones, so a deployment
    -- carrying a too-long name migrates instead of aborting; validate it once the data is clean.
    alter table public.agencies
      add constraint agencies_name_length check (octet_length(name) <= 256) not valid;
    alter table public.clients
      add constraint clients_name_length check (btrim(name) <> '' and octet_length(name) <= 256) not valid;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
