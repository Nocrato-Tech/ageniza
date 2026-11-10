// The last entry of a person into the portal of a client (scope telas-melhorias, subtask S2).
// Structural: docs/business/decisions/2026-11-10-estrutural-ultimo-acesso-ao-portal-por-cliente.md. No backfill: null is "never
// recorded", and "nunca entrou" keeps coming from `first_entered_at`.
//
// `last_entered_at` is stamped by the database and nothing else writes it: `ageniza_app` has no INSERT or UPDATE on the table (the
// column is born read-only under the table-level SELECT of 20261027080100) and reads it through the one policy of the table
// (`cliente.convidar_usuario` or `cliente.remover_usuario`). The portal has no policy there and no function returns the column.
//
// `record_portal_access_entry` is the one rule of recording an entry, internal and run as its owner. It records only an active
// access, only while the agency accepts writes (a read-only agency is left alone instead of failing the portal), and never moves the
// value back: `now()` is the start of a transaction, so one that began before another that already recorded would write an earlier
// instant. Two entrances call it: `mark_client_portal_entered` (the account entered the context of the client) records the access that
// account holds and also the first entry; `exchange_portal_approval_token` (the person opened the approval link) records the last
// entry only, because the first entry is the one of an account and a link needs no account.
//
// The exchange took the access FOR SHARE and now writes it, so two exchanges of one access would hold it together and each wait to
// write it, a deadlock. It takes it FOR NO KEY UPDATE instead, which serializes them and still waits for a removal in flight.
//
// When the account of an access leaves it (the address changed hands) the last entry leaves with it: it was that account's. An access
// with no account keeps what the link recorded, because the link is an entry of the address.

export async function up(knex) {
  await knex.raw(`
    alter table public.client_portal_accesses add column last_entered_at timestamptz;

    create function app_private.record_portal_access_entry(p_access_id uuid, p_account_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      update public.client_portal_accesses access
      set first_entered_at = case when p_account_id is null then access.first_entered_at else coalesce(access.first_entered_at, pg_catalog.now()) end,
          last_entered_at = greatest(access.last_entered_at, pg_catalog.now())
      where access.id = p_access_id
        and access.status = 'active'
        and (p_account_id is null or access.user_id = p_account_id)
        and app_private.agency_accepts_writes(app_private.client_agency_id(access.client_id));
    end;
    $function$;
    revoke all on function app_private.record_portal_access_entry(uuid, uuid) from public;

    -- security invoker, like the guard of the table: it only reads OLD and NEW.
    create function app_private.client_portal_access_last_entry_follows_account()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      new.last_entered_at := null;
      return new;
    end;
    $function$;
    revoke all on function app_private.client_portal_access_last_entry_follows_account() from public;

    create trigger client_portal_accesses_last_entry_follows_account
      before update of user_id on public.client_portal_accesses
      for each row
      when (old.user_id is not null and new.user_id is distinct from old.user_id)
      execute function app_private.client_portal_access_last_entry_follows_account();

    create or replace function app_private.mark_client_portal_entered(p_client_id uuid)
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
      perform app_private.record_portal_access_entry(access.id, v_actor)
      from public.client_portal_accesses access
      where access.client_id = p_client_id and access.user_id = v_actor;
    end;
    $function$;
  `);

  // The body of 20261027090200 with two changes: the lock of the access and the entry recorded after the session is written.
  await knex.raw(`
    create or replace function app_private.exchange_portal_approval_token(p_token_hash text, p_session_hash text)
    returns table(session_expires_at timestamptz, link_expires_at timestamptz)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_link_id uuid;
      v_access_id uuid;
      v_client_id uuid;
      v_link_expires_at timestamptz;
      v_now timestamptz;
      v_expires_at timestamptz;
    begin
      perform app_private.require_read_committed();
      if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      select link.id, link.portal_access_id, link.client_id into v_link_id, v_access_id, v_client_id
      from public.client_portal_approval_links link where link.token_hash = p_token_hash;
      if not found then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      -- Opening the link decides nothing and writes the session and the entry of the access, so it waits for a removal or an archive in
      -- flight and judges after them. The access is taken FOR NO KEY UPDATE, not FOR SHARE: this transaction writes the access below,
      -- and two that held it FOR SHARE would wait on each other to do it.
      perform 1 from public.client_portal_accesses access where access.id = v_access_id for no key update;
      perform 1 from public.clients client where client.id = v_client_id for share;
      select link.expires_at into v_link_expires_at
      from public.client_portal_approval_links link
      where link.id = v_link_id and app_private.portal_approval_link_is_live(link.id, true);
      if not found then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      v_now := pg_catalog.clock_timestamp();
      v_expires_at := least(v_now + interval '2 hours', v_link_expires_at);
      insert into public.client_portal_approval_sessions (link_id, session_hash, created_at, expires_at)
      values (v_link_id, p_session_hash, v_now, v_expires_at);

      perform app_private.record_portal_access_entry(v_access_id, null);

      return query select v_expires_at, v_link_expires_at;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
