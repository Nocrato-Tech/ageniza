// The name the agency types when it adds a person to the portal of a client (scope telas-melhorias, redesign subtask A3).
// Structural: docs/business/decisions/2026-11-11-estrutural-o-nome-do-convidado-digitado-pela-agencia-aparece-antes-da-entrada.md, which
// revises the anti-oracle rule of docs/business/decisions/2026-10-27-a-lista-de-acessos-so-mostra-quem-entrou-no-portal-daquele-cliente.md
// only as far as it says: before the entry the name is the one the agency wrote, never one read from an account. No backfill: the accesses
// that exist have no typed name.
//
// `invited_name` is written by `add_client_portal_access` and by nothing else: the application role still has no INSERT or UPDATE on the
// table, it reads the column through the one policy of the table (`cliente.convidar_usuario` or `cliente.remover_usuario`), and the portal
// has no policy there and no function that returns the row. The function never reads the name of an account: the typed name is a value the
// caller passed, so the list shows the same for an address with an account and for one without, and a name typed in one agency is not in
// the table of another (the table is the access of ONE client).
//
// The signature changes (`p_name`, default null), so the function is dropped and created again; the call of `convert_client_portal_invitation`
// with two arguments keeps resolving to it. The body is the one of 20261027080300 with the name added at the three places it matters:
//  - a new access records the typed name;
//  - a removed address added again takes the new name when one is typed, and keeps the old one when none is ("adicionar de novo um e-mail
//    removido pode atualizar o nome");
//  - an address that already has an active access writes nothing, the name included: the add is idempotent.

export async function up(knex) {
  await knex.raw(`
    alter table public.client_portal_accesses
      add column invited_name text null,
      add constraint client_portal_accesses_invited_name_check check (app_private.display_text_valid(invited_name, 120));

    drop function app_private.add_client_portal_access(uuid, text);

    create function app_private.add_client_portal_access(p_client_id uuid, p_email text, p_name text default null)
    returns table(access_id uuid, outcome text, unlinked_user_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
      v_name text := nullif(pg_catalog.btrim(p_name), '');
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
        insert into public.client_portal_accesses (client_id, email, invited_name)
        values (p_client_id, v_email, v_name)
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
              first_entered_at = case when v_unlinked is null then first_entered_at else null end,
              invited_name = coalesce(v_name, invited_name), updated_at = pg_catalog.now()
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

    revoke all on function app_private.add_client_portal_access(uuid, text, text) from public;
    grant execute on function app_private.add_client_portal_access(uuid, text, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
