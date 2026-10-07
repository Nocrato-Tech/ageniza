// CLIENTS module closing dates (issues #131 and #133). Forward-only, and a new migration:
// 20261006000300_client_lifecycle_functions.mjs is not edited.
//
// Recorded in docs/business/decisions/2026-10-07-a-data-de-encerramento-do-cliente-vem-de-uma-funcao-pura-do-fuso.md.
//
// "Today" for a contract is the day in America/Sao_Paulo (specs/clientes.md §4), and both
// `set_client_closing_date` (the routes) and `archive_due_clients` (the job) had it written inline as
// `now() at time zone 'America/Sao_Paulo'`. Between 21:00 and 24:00 in Brasília the Brasília date and
// the UTC date differ, and no test can stand in that window, so the mutation Sao_Paulo -> UTC stayed
// green. The expression now lives in one pure function of an instant, which a test calls with a fixed
// instant at 22:00 in Brasília, and both functions call it, so the route and the job cannot keep two
// clocks.
//
// The two functions are replaced with `create or replace`, which keeps their owner and grants, and
// only the line that computes v_today changes. `now()` stays `now()` on purpose: the stale-clock
// question after a lock wait is a separate finding, and the transaction start only ever errs towards
// archiving less.

export async function up(knex) {
  await knex.raw(`
    -- The day, in the product's time zone, that an instant falls on. Pure, so the boundary can be
    -- tested at a fixed instant. It reads no row and holds no data, so the application role may call it
    -- too (Conteúdo's policies and functions need today's date); PUBLIC may not.
    create function app_private.sao_paulo_date(p_instant timestamptz)
    returns date
    language sql
    stable
    set search_path = ''
    as $function$
      select (p_instant at time zone 'America/Sao_Paulo')::date
    $function$;
    revoke all on function app_private.sao_paulo_date(timestamptz) from public;
    grant execute on function app_private.sao_paulo_date(timestamptz) to ageniza_app;
  `);

  await knex.raw(`
    create or replace function app_private.archive_due_clients()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
      v_client record;
      v_archived integer := 0;
    begin
      -- closing_date < today, never <=: the contract "encerra em 30/10" runs through the end of
      -- the 30th in Brasília, so the job only archives a date that is strictly past (specs §4).
      for v_client in
        select id, agency_id
        from public.clients
        where status = 'active'
          and closing_date is not null
          and closing_date < v_today
        for update
      loop
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

        -- actor_user_id is null on purpose (no user acted) and the origin names the job, following
        -- the agency-cli convention of recording the caller in request_id when it is not a request.
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
        values ('client.archived', null, v_client.agency_id, 'client', v_client.id, 'job:clients.archive-due');

        v_archived := v_archived + 1;
      end loop;

      return v_archived;
    end;
    $function$;
  `);

  await knex.raw(`
    create or replace function app_private.set_client_closing_date(p_client_id uuid, p_date date)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_agency_id uuid;
      v_client public.clients%rowtype;
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
    begin
      -- Permission before the lock, same reasoning as archive_client.
      select agency_id into v_agency_id from public.clients where id = p_client_id;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if not app_private.has_agency_permission(v_agency_id, 'cliente.arquivar') then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      select * into v_client from public.clients where id = p_client_id for update;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      -- An archived client is read-only; the only action is reactivate (specs/clientes.md §4).
      if v_client.status <> 'active' then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      if p_date is not null and p_date < v_today then
        raise exception using errcode = 'A0022', message = 'Closing date must be today or later.';
      end if;

      update public.clients
      set closing_date = p_date, updated_at = pg_catalog.now()
      where id = v_client.id;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values (
        case when p_date is null then 'client.closing_cleared' else 'client.closing_scheduled' end,
        app_private.current_user_id(), v_client.agency_id, 'client', v_client.id
      );
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
