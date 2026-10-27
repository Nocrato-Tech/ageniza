// "Reenviar" in the pending list of the access tab (decision 2026-10-27, "acessos pendentes ... reenviados e removidos").
//
// Two single-purpose `security definer` functions, every object schema-qualified under `set search_path = ''`:
//   resend_client_portal_access          the welcome e-mail again, for an active access nobody has entered
//   convert_client_portal_invitation     the old portal invitation becomes the access of its address ("Adicionar pessoa"), and is revoked
// and `agency_emails_sent_on_day`, which now counts the audit event of a resend in the same daily budget as the welcome.
//
// Stable error codes (the routes read them; the plan ones are mapped in plugins/infra/errors.ts):
//   A0020 -> 404  client, access or invitation not found, of another agency, archived, or the caller lacks the permission
//   A0090 -> 409  the agency is read-only: a resend widens reach, so it refuses like "Adicionar pessoa"
//   A0095 -> 429  the daily e-mail limit of the agency (nothing written)
//   A0097 -> 409  nothing to resend: the access was removed or its person already entered, or the invitation is no longer pending
//   A0099 -> 429  the same access was mailed less than a minute ago (proposal 2026-10-27, pending the owner)
//
// Lock order matches `remove_client_portal_access` and `add_client_portal_access`: access, then client (share), then the
// advisory lock of the daily limit; the invitation is locked last, after the access has been written.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.agency_emails_sent_on_day(p_agency_id uuid, p_at timestamptz)
    returns bigint
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        (select pg_catalog.count(*)
         from public.invitations invitation
         where invitation.agency_id = p_agency_id
           and invitation.purpose in ('collaborator_invite', 'client_invite')
           and invitation.created_at > p_at - interval '2 days'
           and invitation.created_at < p_at + interval '2 days'
           and app_private.sao_paulo_date(invitation.created_at) = app_private.sao_paulo_date(p_at))
        +
        (select pg_catalog.count(*)
         from audit.events event
         where event.agency_id = p_agency_id
           and event.action in ('client_member.added', 'client_member.readded', 'client_member.resent')
           and event.occurred_at > p_at - interval '2 days'
           and event.occurred_at < p_at + interval '2 days'
           and app_private.sao_paulo_date(event.occurred_at) = app_private.sao_paulo_date(p_at))
    $function$;

    create function app_private.resend_client_portal_access(p_access_id uuid)
    returns table(access_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_access public.client_portal_accesses%rowtype;
      v_client public.clients%rowtype;
    begin
      -- Resolve the access and check the permission WITHOUT a lock: an unauthorized caller never waits on another tenant's row.
      select * into v_access from public.client_portal_accesses where id = p_access_id;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;
      select * into v_client from public.clients where id = v_access.client_id;
      if not found
         or not exists (select 1 from public.agencies agency where agency.id = v_client.agency_id and agency.status = 'active')
         or not app_private.has_agency_permission(v_client.agency_id, 'cliente.convidar_usuario')
      then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      select * into v_access from public.client_portal_accesses where id = p_access_id for update;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;
      select * into v_client from public.clients where id = v_access.client_id for share;
      if not found or v_client.status <> 'active' then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.agency_accepts_writes(v_client.agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;

      -- Decided after the lock: a removal or an entry that was waiting has landed by now.
      if v_access.status <> 'active' or (v_access.first_entered_at is not null and v_access.user_id is not null) then
        raise exception using errcode = 'A0097', message = 'There is nothing to resend.';
      end if;

      -- The clock of the event is the start of its transaction, the one here is the real one, so a transaction that waited counts.
      -- The agency comes first so the count uses events_agency_action_occurred_idx and does not scan audit.events under the lock.
      if exists (
        select 1 from audit.events event
        where event.agency_id = v_client.agency_id
          and event.target_type = 'client_portal_access'
          and event.target_id = v_access.id
          and event.action in ('client_member.added', 'client_member.readded', 'client_member.resent')
          and event.occurred_at > pg_catalog.clock_timestamp() - interval '60 seconds'
      ) then
        raise exception using errcode = 'A0099', message = 'This access was mailed less than a minute ago.';
      end if;

      perform app_private.charge_daily_email(v_client.agency_id);

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('client_member.resent', app_private.current_user_id(), v_client.agency_id, 'client_portal_access', v_access.id);

      return query select v_access.id;
    end;
    $function$;

    create function app_private.convert_client_portal_invitation(p_client_id uuid, p_invitation_id uuid)
    returns table(access_id uuid, outcome text, unlinked_user_id uuid, invitation_revoked boolean)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_invitation public.invitations%rowtype;
      v_client public.clients%rowtype;
      v_added record;
    begin
      -- The permission comes before anything is said about the invitation, so the answer for another agency's is the one of an absent one.
      select * into v_client from public.clients where id = p_client_id;
      if not found
         or not exists (select 1 from public.agencies agency where agency.id = v_client.agency_id and agency.status = 'active')
         or not app_private.has_agency_permission(v_client.agency_id, 'cliente.convidar_usuario')
      then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      select * into v_invitation from public.invitations where id = p_invitation_id;
      if not found
         or v_invitation.purpose <> 'client_invite'
         or v_invitation.client_id is distinct from p_client_id
         or v_invitation.agency_id <> v_client.agency_id
      then
        raise exception using errcode = 'A0020', message = 'Invitation not found.';
      end if;
      if v_invitation.used_at is not null or v_invitation.revoked_at is not null or v_invitation.expires_at <= pg_catalog.clock_timestamp() then
        raise exception using errcode = 'A0097', message = 'The invitation is not pending.';
      end if;

      -- The same function "Adicionar pessoa" calls: the access, the welcome e-mail's place in the day and the read-only check.
      select * into v_added from app_private.add_client_portal_access(p_client_id, v_invitation.email);

      -- The address already had access: nothing was written, and the invitation stays for the agency to cancel.
      if v_added.outcome = 'already_active' then
        return query select v_added.access_id, v_added.outcome, v_added.unlinked_user_id, false;
        return;
      end if;

      -- Locked only now, after the access (the order of a removal). Whoever accepted or cancelled it in the meantime wins,
      -- and the exception takes the access just given along with it.
      select * into v_invitation from public.invitations where id = p_invitation_id for update;
      if not found or v_invitation.used_at is not null or v_invitation.revoked_at is not null or v_invitation.expires_at <= pg_catalog.clock_timestamp() then
        raise exception using errcode = 'A0097', message = 'The invitation is not pending.';
      end if;

      update public.invitations set revoked_at = pg_catalog.now() where id = v_invitation.id;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('invitation.revoked', app_private.current_user_id(), v_client.agency_id, 'invitation', v_invitation.id);

      return query select v_added.access_id, v_added.outcome, v_added.unlinked_user_id, true;
    end;
    $function$;

    revoke all on function app_private.resend_client_portal_access(uuid) from public;
    revoke all on function app_private.convert_client_portal_invitation(uuid, uuid) from public;
    grant execute on function app_private.resend_client_portal_access(uuid) to ageniza_app;
    grant execute on function app_private.convert_client_portal_invitation(uuid, uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
