// Paid plans, the subscription of an agency, its ceiling of clients and the courtesy plan (issue #771, epic #770). Forward-only.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-planos-pagos-assinatura-e-gateway-simulado.md (the owner's
// decision) and 2026-10-29-estrutural-regras-derivadas-dos-planos-pagos.md (what the implementation had to settle).
// The charge, renewal and cancellation functions come in the next migration (issue #775).
//
//  - `subscription_plans` and `subscription_extra_prices`: the three plans and the price of one extra client and one extra GiB.
//    Prices are provisional and live here, never in code; only the schema owner writes them.
//  - `agency_subscriptions`: one row per agency that ever subscribed (or got a courtesy plan): the plan, the extras, the
//    period, the cancellation at the end of the period and the change scheduled for the next one.
//  - `subscription_charges`: the ledger of what the payment provider confirmed. The application role has no INSERT, UPDATE
//    or DELETE on any of these tables: a plan or a limit never changes by a write from the front.
//  - Only the Owner manages a subscription: the key `assinatura.gerenciar` has no preset and no role may carry it (a CHECK
//    on `role_permissions`), exactly like `colaborador.atribuir_admin`, so `has_agency_permission` is true for the Owner by
//    possession and for nobody else.
//  - The limit of active clients is the plan's plus the extras (3 in trial), counted under the advisory lock of the agency, in
//    the same transaction as the insert. The storage limit is `agency_storage_quotas.quota_bytes`, written with the plan. An
//    agency whose subscription period ended without renewal is read-only, as the trial is.
//  - `grant_courtesy_subscription`: the operation puts an agency in a paid plan without charging it.
//
// Error codes: A0091 the client ceiling (the trial's code), A0110 the agency cannot take the operation in its state, A0116 an
// invalid plan.

const GIB = 1073741824;
const MAX_EXTRA = 10000;

export async function up(knex) {
  await knex.raw(`
    create table public.subscription_plans (
      key text primary key check (key ~ '^[a-z]{3,20}$'),
      name text not null check (btrim(name) <> '' and octet_length(name) <= 64),
      client_limit integer not null check (client_limit > 0),
      storage_bytes bigint not null check (storage_bytes > 0),
      monthly_price_cents integer not null check (monthly_price_cents > 0),
      position smallint not null unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table public.subscription_extra_prices (
      kind text primary key check (kind in ('client', 'storage_gib')),
      unit_price_cents integer not null check (unit_price_cents > 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    insert into public.subscription_plans (key, name, client_limit, storage_bytes, monthly_price_cents, position) values
      ('essencial', 'Essencial', 10, 20::bigint * ${GIB}, 9700, 1),
      ('profissional', 'Profissional', 30, 100::bigint * ${GIB}, 19700, 2),
      ('agencia', 'Agência', 60, 300::bigint * ${GIB}, 39700, 3);
    insert into public.subscription_extra_prices (kind, unit_price_cents) values ('client', 600), ('storage_gib', 40);

    create table public.agency_subscriptions (
      agency_id uuid primary key references public.agencies(id),
      plan_key text not null references public.subscription_plans(key),
      extra_clients integer not null default 0 check (extra_clients between 0 and ${MAX_EXTRA}),
      extra_storage_gib integer not null default 0 check (extra_storage_gib between 0 and ${MAX_EXTRA}),
      provider text not null check (provider in ('simulado', 'asaas', 'cortesia')),
      current_period_start timestamptz not null,
      current_period_end timestamptz null,
      cancel_at_period_end boolean not null default false,
      pending_plan_key text null references public.subscription_plans(key),
      pending_extra_clients integer null check (pending_extra_clients between 0 and ${MAX_EXTRA}),
      pending_extra_storage_gib integer null check (pending_extra_storage_gib between 0 and ${MAX_EXTRA}),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint agency_subscriptions_period_check check (
        (provider = 'cortesia') = (current_period_end is null)
        and (current_period_end is null or current_period_end > current_period_start)
      ),
      constraint agency_subscriptions_pending_check check (
        (pending_plan_key is null) = (pending_extra_clients is null)
        and (pending_plan_key is null) = (pending_extra_storage_gib is null)
      ),
      constraint agency_subscriptions_courtesy_check check (provider <> 'cortesia' or (not cancel_at_period_end and pending_plan_key is null))
    );

    create table public.subscription_charges (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references public.agencies(id),
      kind text not null check (kind in ('subscribe', 'upgrade', 'renewal')),
      status text not null default 'pending' check (status in ('pending', 'confirmed', 'expired')),
      plan_key text not null references public.subscription_plans(key),
      extra_clients integer not null check (extra_clients between 0 and ${MAX_EXTRA}),
      extra_storage_gib integer not null check (extra_storage_gib between 0 and ${MAX_EXTRA}),
      amount_cents integer not null check (amount_cents >= 0),
      requested_by_user_id uuid null references auth."user"(id),
      provider text null check (provider in ('simulado', 'asaas')),
      provider_ref text null check (provider_ref is null or (btrim(provider_ref) <> '' and octet_length(provider_ref) <= 200)),
      expires_at timestamptz not null,
      period_start timestamptz null,
      period_end timestamptz null,
      created_at timestamptz not null default now(),
      confirmed_at timestamptz null,
      constraint subscription_charges_confirmation_check check (
        (status = 'confirmed') = (confirmed_at is not null)
        and (status = 'confirmed') = (provider is not null and provider_ref is not null)
        and (status = 'confirmed') = (period_start is not null and period_end is not null)
      )
    );
    create unique index subscription_charges_one_pending on public.subscription_charges (agency_id) where status = 'pending';
    create unique index subscription_charges_provider_ref on public.subscription_charges (provider, provider_ref) where provider_ref is not null;
    create index subscription_charges_agency_created on public.subscription_charges (agency_id, created_at desc);

    alter table public.subscription_plans enable row level security;
    alter table public.subscription_plans force row level security;
    alter table public.subscription_extra_prices enable row level security;
    alter table public.subscription_extra_prices force row level security;
    alter table public.agency_subscriptions enable row level security;
    alter table public.agency_subscriptions force row level security;
    alter table public.subscription_charges enable row level security;
    alter table public.subscription_charges force row level security;

    grant select on public.subscription_plans to ageniza_app;
    grant select on public.subscription_extra_prices to ageniza_app;
    grant select (
      agency_id, plan_key, extra_clients, extra_storage_gib, provider, current_period_start, current_period_end,
      cancel_at_period_end, pending_plan_key, pending_extra_clients, pending_extra_storage_gib
    ) on public.agency_subscriptions to ageniza_app;
    grant select (
      id, agency_id, kind, status, plan_key, extra_clients, extra_storage_gib, amount_cents, expires_at, period_start,
      period_end, created_at, confirmed_at
    ) on public.subscription_charges to ageniza_app;

    create policy subscription_plans_select on public.subscription_plans
      for select to ageniza_app using (app_private.current_user_id() is not null);
    create policy subscription_extra_prices_select on public.subscription_extra_prices
      for select to ageniza_app using (app_private.current_user_id() is not null);
    create policy agency_subscriptions_select on public.agency_subscriptions
      for select to ageniza_app using (app_private.is_agency_member(agency_id));
    create policy subscription_charges_select on public.subscription_charges
      for select to ageniza_app using (app_private.has_agency_permission(agency_id, 'assinatura.gerenciar'));

    insert into public.permissions (key, description) values
      ('assinatura.gerenciar', 'Assinar, trocar de plano, comprar extra e cancelar a assinatura da agência. Só o Owner.');
    alter table public.role_permissions
      add constraint role_permissions_not_subscription check (permission_key <> 'assinatura.gerenciar');
  `);

  await knex.raw(`
    create function app_private.agency_storage_used_bytes(p_agency_id uuid)
    returns bigint
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select coalesce(pg_catalog.sum(asset.confirmed_size_bytes), 0)::bigint
      from public.media_assets asset
      where asset.agency_id = p_agency_id and asset.status = 'confirmed' and asset.purged_at is null
    $function$;
    revoke all on function app_private.agency_storage_used_bytes(uuid) from public;

    -- Null for a plan that does not exist, so a typo fails closed in the callers.
    create function app_private.subscription_monthly_cents(p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer)
    returns integer
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select plan.monthly_price_cents
        + p_extra_clients * (select price.unit_price_cents from public.subscription_extra_prices price where price.kind = 'client')
        + p_extra_storage_gib * (select price.unit_price_cents from public.subscription_extra_prices price where price.kind = 'storage_gib')
      from public.subscription_plans plan
      where plan.key = p_plan_key
    $function$;
    revoke all on function app_private.subscription_monthly_cents(text, integer, integer) from public;

    create function app_private.subscription_client_limit(p_plan_key text, p_extra_clients integer)
    returns integer
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select plan.client_limit + p_extra_clients from public.subscription_plans plan where plan.key = p_plan_key
    $function$;
    revoke all on function app_private.subscription_client_limit(text, integer) from public;

    create function app_private.subscription_storage_bytes(p_plan_key text, p_extra_storage_gib integer)
    returns bigint
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select plan.storage_bytes + p_extra_storage_gib::bigint * ${GIB} from public.subscription_plans plan where plan.key = p_plan_key
    $function$;
    revoke all on function app_private.subscription_storage_bytes(text, integer) from public;

    -- The ceiling of active clients that counts under the lock, or null when the agency has none.
    create function app_private.agency_client_limit(p_agency_id uuid)
    returns integer
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select case
        when agency.plan = 'trial' then 3
        when agency.plan = 'ativo' then (
          select app_private.subscription_client_limit(subscription.plan_key, subscription.extra_clients)
          from public.agency_subscriptions subscription
          where subscription.agency_id = agency.id
        )
      end
      from public.agencies agency
      where agency.id = p_agency_id
    $function$;
    revoke all on function app_private.agency_client_limit(uuid) from public;

    -- Serializes the counts of an agency that has a ceiling. The key is the trial's, so a collaborator count and a client
    -- count of one agency still wait on each other.
    create function app_private.lock_plan_limits(p_agency_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if not exists (
        select 1 from public.agencies agency
        where agency.id = p_agency_id
          and (agency.plan = 'trial'
               or (agency.plan = 'ativo' and exists (select 1 from public.agency_subscriptions subscription where subscription.agency_id = agency.id)))
      ) then
        return false;
      end if;
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
      return true;
    end;
    $function$;
    revoke all on function app_private.lock_plan_limits(uuid) from public;

    create or replace function app_private.agency_accepts_writes(p_agency_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select coalesce(
        (select case agency.plan
           when 'trial' then agency.trial_ends_at > pg_catalog.now()
           when 'ativo' then coalesce(
             (select subscription.current_period_end > pg_catalog.now() from public.agency_subscriptions subscription where subscription.agency_id = agency.id),
             true
           )
           else true
         end
         from public.agencies agency where agency.id = p_agency_id),
        false
      )
    $function$;
  `);

  await knex.raw(`
    create function app_private.enforce_client_limit()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_limit integer;
      v_count bigint;
      v_plan text;
    begin
      if app_private.role_bypasses_rls(session_user) then
        return new;
      end if;
      if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
        return new;
      end if;
      -- The count is a statement of its own, after the lock: under READ COMMITTED it sees what the holder committed.
      if not app_private.lock_plan_limits(new.agency_id) then
        return new;
      end if;
      v_limit := app_private.agency_client_limit(new.agency_id);
      if v_limit is null then
        return new;
      end if;
      select pg_catalog.count(*) into v_count from public.clients client
      where client.agency_id = new.agency_id and client.status = 'active' and client.id <> new.id;
      if v_count >= v_limit then
        select agency.plan into v_plan from public.agencies agency where agency.id = new.agency_id;
        raise exception using errcode = 'A0091', message = case v_plan
          when 'trial' then 'The trial allows at most 3 active clients.'
          else pg_catalog.format('The plan allows at most %s active clients.', v_limit)
        end;
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.enforce_client_limit() from public;

    drop trigger "01_clients_trial_limits" on public.clients;
    create trigger "01_clients_client_limit"
      before insert or update of status on public.clients
      for each row execute function app_private.enforce_client_limit();

    -- The collaborator limits stay the trial's: paid plans have no collaborator ceiling.
    create or replace function app_private.enforce_trial_limits()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_email text;
      v_count bigint;
    begin
      if app_private.role_bypasses_rls(session_user) then
        return new;
      end if;

      if tg_table_name = 'agency_memberships' then
        if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
          return new;
        end if;
        select person.email into v_email from auth."user" person where person.id = new.user_id;
        if not app_private.lock_trial_limits(new.agency_id) then
          return new;
        end if;
        v_count := app_private.trial_collaborator_seats(new.agency_id, new.user_id, v_email);
        if v_count >= 3 then
          raise exception using errcode = 'A0092', message = 'The trial allows at most 3 collaborators.';
        end if;
      elsif tg_table_name = 'invitations' then
        if new.purpose <> 'collaborator_invite' then
          return new;
        end if;
        if not app_private.lock_trial_limits(new.agency_id) then
          return new;
        end if;
        v_count := app_private.trial_collaborator_seats(new.agency_id, null, new.email);
        if v_count >= 3 then
          raise exception using errcode = 'A0092', message = 'The trial allows at most 3 collaborators.';
        end if;
      end if;
      return new;
    end;
    $function$;
  `);

  await knex.raw(`
    -- Writes the terms of a subscription and the quota that follows them. A caller holds the lock of the agency
    -- ('agency_trial_limits:<agency>') and, when it compares the storage in use with the new ceiling, also the upload
    -- confirmation's lock ('media-quota:<agency>', taken by the media service) first, always in that order: the two keys do not
    -- serialize with each other, so the lock of the agency alone leaves a confirmation in flight out of the count.
    create function app_private.apply_subscription_terms(
      p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer
    )
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      insert into public.agency_storage_quotas (agency_id, quota_bytes)
      values (p_agency_id, app_private.subscription_storage_bytes(p_plan_key, p_extra_storage_gib))
      on conflict (agency_id) do update set quota_bytes = excluded.quota_bytes, updated_at = pg_catalog.now();
      update public.agencies set plan = 'ativo', trial_ends_at = null, updated_at = pg_catalog.now() where id = p_agency_id;
    end;
    $function$;
    revoke all on function app_private.apply_subscription_terms(uuid, text, integer, integer) from public;

    -- The operation gives an agency a plan without charging it. Only a role that bypasses RLS (the schema owner) calls it.
    create function app_private.grant_courtesy_subscription(p_agency_id uuid, p_plan_key text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if not app_private.role_bypasses_rls(session_user) then
        raise exception using errcode = '42501', message = 'Only the operation grants a courtesy plan.';
      end if;
      if app_private.subscription_monthly_cents(p_plan_key, 0, 0) is null then
        raise exception using errcode = 'A0116', message = 'The plan is not valid.';
      end if;
      if not exists (select 1 from public.agencies agency where agency.id = p_agency_id) then
        raise exception using errcode = 'A0110', message = 'The agency does not exist.';
      end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
      insert into public.agency_subscriptions (agency_id, plan_key, provider, current_period_start)
      values (p_agency_id, p_plan_key, 'cortesia', pg_catalog.now())
      on conflict (agency_id) do update set
        plan_key = excluded.plan_key, extra_clients = 0, extra_storage_gib = 0, provider = 'cortesia',
        current_period_start = excluded.current_period_start, current_period_end = null, cancel_at_period_end = false,
        pending_plan_key = null, pending_extra_clients = null, pending_extra_storage_gib = null, updated_at = pg_catalog.now();
      perform app_private.apply_subscription_terms(p_agency_id, p_plan_key, 0, 0);
      update public.subscription_charges set status = 'expired' where agency_id = p_agency_id and status = 'pending';
      insert into audit.events (action, agency_id, target_type, target_id)
      values ('subscription.courtesy_granted', p_agency_id, 'agency', p_agency_id);
    end;
    $function$;
    revoke all on function app_private.grant_courtesy_subscription(uuid, text) from public;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
