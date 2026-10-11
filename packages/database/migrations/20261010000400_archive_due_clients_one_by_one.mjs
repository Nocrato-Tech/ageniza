// The archive job, one client at a time (issue #397). Forward-only, and a new migration: the ones that created
// these functions are not edited.
//
// Recorded in docs/business/decisions/2026-10-10-os-gatilhos-pulam-pelo-atributo-do-papel-e-o-job-de-arquivamento-vai-cliente-a-cliente.md.
//
// `archive_due_clients()` archived every due client in a single call, so a single transaction: when one client lost a
// deadlock (40P01) against a concurrent write, the whole hour rolled back. The rule of one client is now its own function,
// `archive_due_client(client)`, which the worker calls once per client, each call a short transaction of its own, so the
// deadlock of one leaves the others archived and the one that lost is still due at the next run. `due_client_ids()` lists
// who is due. `archive_due_clients()` stays, built from the same two functions, so the batch and the single client cannot
// keep two rules; its answer is still the number archived.
//
// Both new functions are `security definer` with a fixed search_path, closed to PUBLIC and open to the application role,
// which is the role the worker connects as: like `archive_due_clients()`, they are the single-purpose exception of
// docs/business/structural-changes.md and can do nothing but what time would do anyway. `archive_due_client` re-reads the
// row under FOR UPDATE with the due condition in the WHERE, so a client reactivated, rescheduled or already archived by
// the route while the job waited is left alone (false).

export async function up(knex) {
  await knex.raw(`
    create function app_private.due_client_ids()
    returns setof uuid
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select client.id
      from public.clients client
      where client.status = 'active'
        and client.closing_date is not null
        and client.closing_date < app_private.sao_paulo_date(pg_catalog.now())
      order by client.closing_date, client.id
    $function$;
    revoke all on function app_private.due_client_ids() from public;
    grant execute on function app_private.due_client_ids() to ageniza_app;

    create function app_private.archive_due_client(p_client_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client record;
    begin
      -- closing_date < today, never <=: the contract "encerra em 30/10" runs through the end of
      -- the 30th in Brasília, so the job only archives a date that is strictly past (specs §4).
      select client.id, client.agency_id, client.closing_date
      into v_client
      from public.clients client
      where client.id = p_client_id
        and client.status = 'active'
        and client.closing_date is not null
        and client.closing_date < app_private.sao_paulo_date(pg_catalog.now())
      for update;

      if not found then
        return false;
      end if;

      update public.clients
      set status = 'archived',
          archived_at = pg_catalog.now(),
          closing_date = null,
          updated_at = pg_catalog.now()
      where id = v_client.id;

      update public.invitations
      set revoked_at = pg_catalog.now()
      where client_id = v_client.id
        and purpose = 'client_invite'
        and used_at is null
        and revoked_at is null;

      perform app_private.cancel_contents_after(v_client.id, v_client.closing_date);

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
      values ('client.archived', null, v_client.agency_id, 'client', v_client.id, 'job:clients.archive-due');

      return true;
    end;
    $function$;
    revoke all on function app_private.archive_due_client(uuid) from public;
    grant execute on function app_private.archive_due_client(uuid) to ageniza_app;
  `);

  await knex.raw(`
    create or replace function app_private.archive_due_clients()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_archived integer := 0;
    begin
      for v_client_id in select app_private.due_client_ids() loop
        if app_private.archive_due_client(v_client_id) then
          v_archived := v_archived + 1;
        end if;
      end loop;

      return v_archived;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
