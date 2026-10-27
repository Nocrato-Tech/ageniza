// The only writers of `client_portal_accesses` and of the state of `client_memberships` (issue #711, epic #718).
// Structural: docs/business/decisions/2026-10-26-estrutural-o-acesso-ao-portal-e-por-e-mail-e-a-conta-e-opcional.md, Consequência.
//
// Single-purpose `security definer` functions, every object schema-qualified under `set search_path = ''`:
//   add_client_portal_access          "Adicionar pessoa": inserts the access, or reactivates the removed row of the same address
//   remove_client_portal_access       Remover, and the person who removes their own access: advances the generation, takes the membership along
//   reactivate_client_portal_access   Reativar: the same row, the generation as it is
//   link_client_portal_accesses       the link, for the account in the transaction, when its address is verified
//   grant_client_portal_access_from_invitation   the old portal invitation, accepted: creates or links the access (internal)
// and `accept_invitation` / `set_client_membership_status`, rewritten so they go through the access.
//
// Stable error codes, in the style of 20261006000300:
//   A0020 -> 404  client or access not found, of another agency, archived, or the caller lacks the permission (one error for all)
//   A0023 -> 400  set_client_membership_status got a status other than 'active' or 'removed'
//   A0098 -> 400  the address is not an e-mail address
// and, from 20261027020000 and 20261027020100 (the trial), A0090 (the agency is read-only) and A0095 (its daily e-mail limit).
//
// The plan of the agency (issue #711 on top of #725):
//   - add and reactivate widen access, so they refuse a read-only agency (A0090); remove narrows it and stays open, and the
//     trigger of the table recognises that exact change of the row, like the ones of 20261027020000.
//   - the welcome e-mail of "Adicionar pessoa" counts in the daily limit of the agency, in the same budget and under the same
//     lock as the invitations (A0095, nothing written). The count reads the invitations and the audit events of the welcome.
//   - a function that writes with no actor in the transaction checks by itself that the agency is not suspended and accepts
//     writes: the accepted invitation (A0090) and the link, which skips what it must not touch.

export async function up(knex) {
  await knex.raw(`
    -- The welcome e-mails are counted from the audit events the function writes; this is the index of that count.
    create index events_agency_action_occurred_idx on audit.events (agency_id, action, occurred_at);

    -- The e-mails an agency sent today (the day of São Paulo): its invitations, collaborator and portal, and the welcomes.
    create function app_private.agency_emails_today(p_agency_id uuid)
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
           and invitation.created_at > pg_catalog.now() - interval '2 days'
           and app_private.sao_paulo_date(invitation.created_at) = app_private.sao_paulo_date(pg_catalog.now()))
        +
        (select pg_catalog.count(*)
         from audit.events event
         where event.agency_id = p_agency_id
           and event.action in ('client_member.added', 'client_member.readded')
           and event.occurred_at > pg_catalog.now() - interval '2 days'
           and app_private.sao_paulo_date(event.occurred_at) = app_private.sao_paulo_date(pg_catalog.now()))
    $function$;
    revoke all on function app_private.agency_emails_today(uuid) from public;

    -- The place for one more e-mail, or A0095. The lock is the one of the invitations (20261027020100), so the two kinds of
    -- e-mail share the budget under concurrency, and the count is a statement of its own after the lock.
    create function app_private.charge_daily_email(p_agency_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_limit integer;
    begin
      if app_private.role_bypasses_rls(session_user) then
        return;
      end if;
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_daily_email_limit:' || p_agency_id::text, 0));
      v_limit := app_private.agency_daily_email_limit(p_agency_id);
      if v_limit is not null and app_private.agency_emails_today(p_agency_id) >= v_limit then
        raise exception using errcode = 'A0095', message = 'The agency reached its daily e-mail limit.';
      end if;
    end;
    $function$;
    revoke all on function app_private.charge_daily_email(uuid) from public;

    -- The trigger of the invitations counts the welcomes too, so an invitation cannot go past what the welcomes spent.
    create or replace function app_private.enforce_daily_email_limit()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if app_private.role_bypasses_rls(session_user) or new.purpose not in ('collaborator_invite', 'client_invite') then
        return new;
      end if;
      perform app_private.charge_daily_email(new.agency_id);
      return new;
    end;
    $function$;

    -- Read-only: the writes of the table are refused like the ones of the other tables of the agency (20261027020000), except the
    -- removal of an access, recognised by the exact change of the row.
    create function app_private.refuse_portal_access_write_to_read_only_agency()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_agency_id uuid;
    begin
      if app_private.role_bypasses_rls(session_user) or app_private.current_user_id() is null then
        return new;
      end if;
      if tg_op = 'UPDATE' and old.status = 'active' and new.status = 'removed' and new.generation = old.generation + 1
         and (pg_catalog.to_jsonb(old) - array['status', 'generation', 'updated_at']) = (pg_catalog.to_jsonb(new) - array['status', 'generation', 'updated_at']) then
        return new;
      end if;
      select client.agency_id into v_agency_id from public.clients client where client.id = new.client_id;
      if v_agency_id is not null and not app_private.agency_accepts_writes(v_agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.refuse_portal_access_write_to_read_only_agency() from public;

    create trigger "00_client_portal_accesses_agency_accepts_writes"
      before insert or update on public.client_portal_accesses
      for each row execute function app_private.refuse_portal_access_write_to_read_only_agency();
  `);

  await knex.raw(`
    create function app_private.add_client_portal_access(p_client_id uuid, p_email text)
    returns table(access_id uuid, outcome text, unlinked_user_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
      v_client public.clients%rowtype;
      v_access public.client_portal_accesses%rowtype;
      v_account_email text;
      v_unlinked uuid := null;
      v_outcome text;
    begin
      if v_email is null or v_email not like '%@%' or pg_catalog.char_length(v_email) not between 3 and 320 then
        raise exception using errcode = 'A0098', message = 'The address is not an e-mail address.';
      end if;

      -- Resolve the client and check the permission WITHOUT a lock: an unauthorized caller never waits on another tenant's row.
      select * into v_client from public.clients where id = p_client_id;
      if not found
         or not exists (select 1 from public.agencies agency where agency.id = v_client.agency_id and agency.status = 'active')
         or not app_private.has_agency_permission(v_client.agency_id, 'cliente.convidar_usuario')
      then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- An archive in flight holds its client; this waits for it and then finds the client archived.
      select * into v_client from public.clients where id = p_client_id for share;
      if not found or v_client.status <> 'active' then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Adding widens access: a read-only agency does not.
      if not app_private.agency_accepts_writes(v_client.agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;

      select * into v_access from public.client_portal_accesses where client_id = p_client_id and email = v_email for update;
      if not found then
        -- A new address is a welcome e-mail: it takes a place in the day before anything is written.
        perform app_private.charge_daily_email(v_client.agency_id);
        insert into public.client_portal_accesses (client_id, email)
        values (p_client_id, v_email)
        on conflict on constraint client_portal_accesses_client_id_email_key do nothing
        returning * into v_access;
        if found then
          v_outcome := 'created';
        else
          select * into v_access from public.client_portal_accesses where client_id = p_client_id and email = v_email for update;
        end if;
      end if;

      if v_outcome is null then

        -- The account that held the address may hold another one today (it changed it). The row must not give the access back
        -- to it: it lets go of the account, so whoever has the address now can link at the next login.
        if v_access.user_id is not null then
          select pg_catalog.lower(pg_catalog.btrim(account.email)) into v_account_email from auth."user" account where account.id = v_access.user_id;
          if v_account_email is distinct from v_access.email then
            v_unlinked := v_access.user_id;
          end if;
        end if;

        if v_access.status = 'active' and v_unlinked is null then
          v_outcome := 'already_active';
        else
          v_outcome := 'reactivated';
          -- The welcome goes again: it takes a place in the day too.
          perform app_private.charge_daily_email(v_client.agency_id);
          update public.client_portal_accesses
          set status = 'active', user_id = case when v_unlinked is null then user_id else null end,
              first_entered_at = case when v_unlinked is null then first_entered_at else null end, updated_at = pg_catalog.now()
          where id = v_access.id;

          -- The membership follows the access: back for the same account, or leaving with the account that lost the address.
          if v_unlinked is not null then
            update public.client_memberships
            set status = 'removed', updated_at = pg_catalog.now()
            where portal_access_id = v_access.id and user_id = v_unlinked and status = 'active';
          elsif v_access.user_id is not null then
            update public.client_memberships
            set status = 'active', updated_at = pg_catalog.now()
            where portal_access_id = v_access.id and user_id = v_access.user_id;
          end if;
        end if;
      end if;

      if v_outcome <> 'already_active' then
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values (
          case when v_outcome = 'created' then 'client_member.added' else 'client_member.readded' end,
          v_actor, v_client.agency_id, 'client_portal_access', v_access.id
        );
      end if;

      -- Only an account that was IN loses something: the one a removed row was already waiting without is not told again.
      return query select v_access.id, v_outcome, case when v_access.status = 'active' then v_unlinked end;
    end;
    $function$;

    create function app_private.remove_client_portal_access(p_access_id uuid)
    returns table(account_user_id uuid, changed boolean)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_access public.client_portal_accesses%rowtype;
      v_client public.clients%rowtype;
    begin
      select * into v_access from public.client_portal_accesses where id = p_access_id;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      select * into v_client from public.clients where id = v_access.client_id;
      if not found
         or not exists (select 1 from public.agencies agency where agency.id = v_client.agency_id and agency.status = 'active')
         or not app_private.has_agency_permission(v_client.agency_id, 'cliente.remover_usuario')
      then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Lock order (access, then client) matches the other writers; archive locks only the client, so there is no cycle.
      select * into v_access from public.client_portal_accesses where id = p_access_id for update;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;
      select * into v_client from public.clients where id = v_access.client_id for share;
      if not found or v_client.status <> 'active' then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- Idempotent: no transition, no write, no event.
      if v_access.status = 'removed' then
        return query select v_access.user_id, false;
        return;
      end if;

      update public.client_portal_accesses
      set status = 'removed', generation = generation + 1, updated_at = pg_catalog.now()
      where id = v_access.id;

      update public.client_memberships
      set status = 'removed', updated_at = pg_catalog.now()
      where portal_access_id = v_access.id and status = 'active';

      -- An old portal invitation of the same address must not bring the person back: it dies with the access.
      with revoked as (
        update public.invitations
        set revoked_at = pg_catalog.now()
        where client_id = v_access.client_id and email = v_access.email and purpose = 'client_invite'
          and used_at is null and revoked_at is null
        returning id
      )
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      select 'invitation.revoked', app_private.current_user_id(), v_client.agency_id, 'invitation', revoked.id from revoked;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('client_member.removed', app_private.current_user_id(), v_client.agency_id, 'client_portal_access', v_access.id);

      return query select v_access.user_id, true;
    end;
    $function$;

    create function app_private.reactivate_client_portal_access(p_access_id uuid)
    returns table(account_user_id uuid, changed boolean)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_access public.client_portal_accesses%rowtype;
      v_client public.clients%rowtype;
    begin
      select * into v_access from public.client_portal_accesses where id = p_access_id;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      select * into v_client from public.clients where id = v_access.client_id;
      if not found
         or not exists (select 1 from public.agencies agency where agency.id = v_client.agency_id and agency.status = 'active')
         or not app_private.has_agency_permission(v_client.agency_id, 'cliente.remover_usuario')
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

      if v_access.status = 'active' then
        return query select v_access.user_id, false;
        return;
      end if;

      -- Bringing someone back widens access: a read-only agency does not (removing, which narrows it, stays open).
      if not app_private.agency_accepts_writes(v_client.agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;

      -- The generation stays where the removal left it: a link of the earlier life of the access does not come back.
      update public.client_portal_accesses set status = 'active', updated_at = pg_catalog.now() where id = v_access.id;

      if v_access.user_id is not null then
        update public.client_memberships
        set status = 'active', portal_access_id = v_access.id, updated_at = pg_catalog.now()
        where client_id = v_access.client_id and user_id = v_access.user_id;
        if not found then
          insert into public.client_memberships (client_id, user_id, portal_access_id)
          values (v_access.client_id, v_access.user_id, v_access.id);
        end if;
      end if;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('client_member.reactivated', app_private.current_user_id(), v_client.agency_id, 'client_portal_access', v_access.id);

      return query select v_access.user_id, true;
    end;
    $function$;

    -- The account of the transaction takes the active accesses of its own verified address. It never takes an access that has an
    -- account, never one of an address it has not confirmed, and never one of a client that is archived, of a suspended agency or of
    -- a read-only one: the account is the actor here, so the trigger of the table would refuse the write, and the load of the
    -- contexts must not fail for an agency whose trial ended. The access waits and is taken after the agency renews.
    create function app_private.link_client_portal_accesses()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_email text;
      v_verified boolean;
      v_access record;
      v_other public.client_portal_accesses%rowtype;
      v_linked integer := 0;
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'A portal access is linked by the account that enters.';
      end if;

      select pg_catalog.lower(pg_catalog.btrim(account.email)), account."emailVerified" into v_email, v_verified
      from auth."user" account where account.id = v_actor;
      if not found or v_verified is not true then
        return 0;
      end if;

      for v_access in
        select access.id, access.client_id, client.agency_id
        from public.client_portal_accesses access
        join public.clients client on client.id = access.client_id
        join public.agencies agency on agency.id = client.agency_id
        where access.email = v_email
          and access.user_id is null
          and access.status = 'active'
          and client.status = 'active'
          and agency.status = 'active'
          and app_private.agency_accepts_writes(agency.id)
        order by access.id
        for update of access
        for share of client
      loop
        -- One access per account in a client: another row of this account that is active means the person is in already, and
        -- one that is removed is history that lets go of the account.
        select * into v_other from public.client_portal_accesses where client_id = v_access.client_id and user_id = v_actor for update;
        if found then
          if v_other.status = 'active' then
            continue;
          end if;
          update public.client_portal_accesses set user_id = null, updated_at = pg_catalog.now() where id = v_other.id;
        end if;

        update public.client_portal_accesses set user_id = v_actor, first_entered_at = null, updated_at = pg_catalog.now() where id = v_access.id;

        update public.client_memberships
        set status = 'active', portal_access_id = v_access.id, updated_at = pg_catalog.now()
        where client_id = v_access.client_id and user_id = v_actor;
        if not found then
          insert into public.client_memberships (client_id, user_id, portal_access_id)
          values (v_access.client_id, v_actor, v_access.id);
        end if;

        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('client_member.linked', v_actor, v_access.agency_id, 'client_portal_access', v_access.id);
        v_linked := v_linked + 1;
      end loop;

      return v_linked;
    end;
    $function$;

    -- The accepted portal invitation of before: the access of that address, linked to the account that accepted it, in the same
    -- transaction. Internal: only accept_invitation calls it.
    create function app_private.grant_client_portal_access_from_invitation(p_client_id uuid, p_user_id uuid, p_email text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client public.clients%rowtype;
      v_access public.client_portal_accesses%rowtype;
      v_other public.client_portal_accesses%rowtype;
      v_previous uuid;
    begin
      select * into v_client from public.clients where id = p_client_id for share;
      if not found
         or v_client.status <> 'active'
         or not exists (select 1 from public.agencies agency where agency.id = v_client.agency_id and agency.status = 'active')
      then
        raise exception using errcode = 'A0001', message = 'Invitation link is not valid.';
      end if;
      -- No actor is bound here, so the trigger of the table does not look: the plan of the agency is asked explicitly.
      if not app_private.agency_accepts_writes(v_client.agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;

      select * into v_access from public.client_portal_accesses where client_id = p_client_id and email = p_email for update;
      -- The agency removed this address after it sent the invitation: the invitation does not undo that.
      if v_access.status = 'removed' then
        raise exception using errcode = 'A0001', message = 'Invitation link is not valid.';
      end if;
      select * into v_other from public.client_portal_accesses
      where client_id = p_client_id and user_id = p_user_id and id is distinct from v_access.id for update;
      if found then
        -- The account is already in through another row, and the caller returned 'already_member' before getting here.
        if v_other.status = 'active' then
          raise exception using errcode = 'A0001', message = 'Invitation link is not valid.';
        end if;
        update public.client_portal_accesses set user_id = null, updated_at = pg_catalog.now() where id = v_other.id;
      end if;

      if v_access.id is null then
        insert into public.client_portal_accesses (client_id, email, user_id, first_entered_at)
        values (p_client_id, p_email, p_user_id, pg_catalog.now())
        returning * into v_access;
      else
        -- The address changed hands: the account that held it before is out, and the one that has it now is in.
        if v_access.user_id is not null and v_access.user_id <> p_user_id then
          v_previous := v_access.user_id;
          update public.client_portal_accesses set user_id = null, first_entered_at = null, updated_at = pg_catalog.now() where id = v_access.id;
          update public.client_memberships
          set status = 'removed', updated_at = pg_catalog.now()
          where portal_access_id = v_access.id and user_id = v_previous and status = 'active';
        end if;
        update public.client_portal_accesses
        set user_id = p_user_id, status = 'active', first_entered_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = v_access.id;
      end if;

      update public.client_memberships
      set status = 'active', portal_access_id = v_access.id, updated_at = pg_catalog.now()
      where client_id = p_client_id and user_id = p_user_id;
      if not found then
        insert into public.client_memberships (client_id, user_id, portal_access_id)
        values (p_client_id, p_user_id, v_access.id);
      end if;
    end;
    $function$;

    -- The account of the transaction enters the portal of a client: the first time is recorded, and it is what the agency's list
    -- shows as "entrou" and the name. Resolving or selecting the context of that client is the entry; loading the list of
    -- contexts is not. A read-only agency is left as it is (the write would be refused), and nothing is marked for an access the
    -- account does not hold.
    create function app_private.mark_client_portal_entered(p_client_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'The portal is entered by an account.';
      end if;
      update public.client_portal_accesses access
      set first_entered_at = pg_catalog.now()
      where access.client_id = p_client_id
        and access.user_id = v_actor
        and access.status = 'active'
        and access.first_entered_at is null
        and app_private.agency_accepts_writes(app_private.client_agency_id(access.client_id));
    end;
    $function$;

    -- The old door by membership id stays, and goes through the access: it is not the place where the state is written any more.
    create or replace function app_private.set_client_membership_status(p_membership_id uuid, p_status text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_access_id uuid;
    begin
      if p_status is null or p_status not in ('active', 'removed') then
        raise exception using errcode = 'A0023', message = 'Membership status must be active or removed.';
      end if;

      -- The link of the account that holds the access now; a link left behind by an access that passed on is not a person.
      select membership.portal_access_id into v_access_id
      from public.client_memberships membership
      join public.client_portal_accesses access on access.id = membership.portal_access_id and access.user_id = membership.user_id
      where membership.id = p_membership_id;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if p_status = 'removed' then
        perform app_private.remove_client_portal_access(v_access_id);
      else
        perform app_private.reactivate_client_portal_access(v_access_id);
      end if;
    end;
    $function$;

    revoke all on function app_private.add_client_portal_access(uuid, text) from public;
    revoke all on function app_private.remove_client_portal_access(uuid) from public;
    revoke all on function app_private.reactivate_client_portal_access(uuid) from public;
    revoke all on function app_private.link_client_portal_accesses() from public;
    revoke all on function app_private.mark_client_portal_entered(uuid) from public;
    grant execute on function app_private.mark_client_portal_entered(uuid) to ageniza_app;
    revoke all on function app_private.grant_client_portal_access_from_invitation(uuid, uuid, text) from public;
    grant execute on function app_private.add_client_portal_access(uuid, text) to ageniza_app;
    grant execute on function app_private.remove_client_portal_access(uuid) to ageniza_app;
    grant execute on function app_private.reactivate_client_portal_access(uuid) to ageniza_app;
    grant execute on function app_private.link_client_portal_accesses() to ageniza_app;
  `);

  await knex.raw(`CREATE OR REPLACE FUNCTION app_private.accept_invitation(p_token_hash text, p_user_id uuid, p_terms_version text, p_privacy_version text, p_record_acceptance boolean)
 RETURNS TABLE(status text, agency_id uuid, client_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    declare
      invitation public.invitations%rowtype;
      agency public.agencies%rowtype;
      invited_user_email text;
      admin_role_id uuid;
      already_member boolean := false;
      v_terms_date date;
      v_privacy_date date;
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
    begin
      select *
      into invitation
      from public.invitations
      where token_hash = p_token_hash
      for update;

      if not found then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      select agency_row.*
      into agency
      from public.agencies agency_row
      where agency_row.id = invitation.agency_id
      for update;

      -- After both locks: now() and statement_timestamp() would not see the wait pass (issue #304).
      if not found
         or invitation.used_at is not null
         or invitation.revoked_at is not null
         or invitation.expires_at <= pg_catalog.clock_timestamp()
         or agency.status <> 'active'
         or not app_private.agency_accepts_writes(agency.id)
      then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      if invitation.client_id is not null then
        if not exists (
          select 1
          from public.clients invited_client
          where invited_client.id = invitation.client_id
            and invited_client.agency_id = invitation.agency_id
            and invited_client.status = 'active'
        ) then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;
      end if;

      if invitation.role_id is not null and not exists (
        select 1
        from public.roles invited_role
        where invited_role.id = invitation.role_id
          and (invited_role.agency_id is null or invited_role.agency_id = invitation.agency_id)
      ) then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      select "email"
      into invited_user_email
      from auth."user"
      where id = p_user_id;

      if not found or invited_user_email <> invitation.email then
        raise exception using
          errcode = 'A0002',
          message = 'The authenticated account does not match this invitation.';
      end if;

      if invitation.purpose = 'agency_activation' then
        already_member := agency.owner_user_id = p_user_id;
      elsif invitation.purpose = 'collaborator_invite' then
        select exists (
          select 1
          from public.agency_memberships existing_membership
          where existing_membership.agency_id = invitation.agency_id
            and existing_membership.user_id = p_user_id
            and existing_membership.status = 'active'
        ) into already_member;
      else
        select exists (
          select 1
          from public.client_memberships existing_membership
          where existing_membership.client_id = invitation.client_id
            and existing_membership.user_id = p_user_id
            and existing_membership.status = 'active'
        ) into already_member;
      end if;

      if already_member then
        return query select 'already_member'::text, invitation.agency_id, invitation.client_id;
        return;
      end if;

      if p_record_acceptance
         and (
           p_terms_version is null or pg_catalog.btrim(p_terms_version) = ''
           or p_privacy_version is null or pg_catalog.btrim(p_privacy_version) = ''
         )
      then
        raise exception using
          errcode = 'A0003',
          message = 'Terms and privacy versions are required.';
      end if;

      -- Issue #296: a version that is not a real date, or is in the future, is refused here as
      -- accept_legal_document refuses it; a future one would suppress every real version later.
      if p_record_acceptance then
        if p_terms_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_privacy_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception using
            errcode = 'A0031',
            message = 'Malformed legal document version.';
        end if;

        begin
          v_terms_date := p_terms_version::date;
          v_privacy_date := p_privacy_version::date;
        exception when datetime_field_overflow or invalid_datetime_format then
          raise exception using
            errcode = 'A0031',
            message = 'The version is not a real date.';
        end;

        if v_terms_date > v_today or v_privacy_date > v_today then
          raise exception using
            errcode = 'A0031',
            message = 'The version is in the future.';
        end if;
      end if;

      if invitation.purpose = 'agency_activation' then
        if agency.owner_user_id is not null then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;

        select system_role.id
        into admin_role_id
        from public.roles system_role
        where system_role.agency_id is null and system_role.key = 'admin';

        if not found then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;

        update public.agencies
        set owner_user_id = p_user_id, updated_at = pg_catalog.now()
        where id = invitation.agency_id;

        insert into public.agency_memberships (agency_id, user_id, role_id)
        values (invitation.agency_id, p_user_id, admin_role_id)
        on conflict on constraint agency_memberships_agency_id_user_id_key do update
          set role_id = excluded.role_id, status = 'active', updated_at = pg_catalog.now();
      elsif invitation.purpose = 'collaborator_invite' then
        insert into public.agency_memberships (agency_id, user_id, role_id)
        values (invitation.agency_id, p_user_id, invitation.role_id)
        on conflict on constraint agency_memberships_agency_id_user_id_key do update
          set role_id = excluded.role_id, status = 'active', updated_at = pg_catalog.now();
      else
        -- A portal invitation is no longer created, and one still pending is accepted into the access of its address.
        perform app_private.grant_client_portal_access_from_invitation(invitation.client_id, p_user_id, invitation.email);
      end if;

      update public.invitations
      set used_at = pg_catalog.now(), accepted_by_user_id = p_user_id
      where id = invitation.id;

      if p_record_acceptance then
        insert into public.legal_acceptances (user_id, document, version)
        values
          (p_user_id, 'terms', p_terms_version),
          (p_user_id, 'privacy', p_privacy_version)
        on conflict (user_id, document, version) where revoked_at is null do nothing;
      end if;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('invitation.accepted', p_user_id, invitation.agency_id, 'invitation', invitation.id);

      if invitation.purpose = 'agency_activation' then
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('agency.activated', p_user_id, invitation.agency_id, 'agency', invitation.agency_id);
      end if;

      return query select 'accepted'::text, invitation.agency_id, invitation.client_id;
    end;
    $function$;`);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
