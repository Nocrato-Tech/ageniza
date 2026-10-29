// The refund of a renewal is a fact the database knows (issue #772, epic #770; review of #790). Forward-only. Needs 20261029000200 and
// 20261029000600.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-o-worker-renova-a-assinatura.md (items 13 and 14).
//
//  - `subscription_renewal_refunds`: one row per provider reference the worker asked to give back, written BEFORE the provider is asked.
//    The application role has no privilege on it at all; only the functions below touch it. Status `recorded` is a refund asked for and
//    not known to be done (a provider that threw leaves it there), `refunded` and `failed` are what the provider answered. Anything
//    that is not `refunded` is what a person reconciles.
//  - `renew_subscription` refuses (A0118) a reference recorded as refunded. The simulated provider has no memory and answers the same
//    key with the same reference, so without this a renewal that was refunded (canceled and reactivated in the same period, or a
//    scheduled decrease whose usage oscillated) was confirmed later with the reference whose money had gone back.
//  - `renewal_quote` also answers the attempt: how many refunds the period being renewed already has. The worker puts it in the
//    idempotency key, so a charge after a refund asks the provider for a new payment instead of the refunded one. The period is kept
//    and compared to the millisecond, the precision the worker reads it with and builds its key from.
//  - `record_renewal_refund` refuses (A0119) a reference that holds a confirmed charge: a refund never undoes a renewal that took.
//  - Everything else of `renew_subscription` is unchanged.

export async function up(knex) {
  await knex.raw(`
    create table public.subscription_renewal_refunds (
      id uuid primary key default gen_random_uuid(),
      agency_id uuid not null references public.agencies(id),
      provider text not null check (provider in ('simulado', 'asaas')),
      provider_ref text not null check (btrim(provider_ref) <> '' and octet_length(provider_ref) <= 200),
      period_end timestamptz not null,
      amount_cents integer not null check (amount_cents > 0),
      reason text not null check (reason in ('A0114', 'A0115')),
      status text not null default 'recorded' check (status in ('recorded', 'refunded', 'failed')),
      failure text null check (failure is null or (btrim(failure) <> '' and char_length(failure) <= 200)),
      created_at timestamptz not null default now(),
      settled_at timestamptz null,
      constraint subscription_renewal_refunds_settlement_check check (
        (status = 'recorded') = (settled_at is null) and (status = 'failed') = (failure is not null)
      )
    );
    create unique index subscription_renewal_refunds_provider_ref on public.subscription_renewal_refunds (provider, provider_ref);
    create index subscription_renewal_refunds_period on public.subscription_renewal_refunds (agency_id, period_end);
    alter table public.subscription_renewal_refunds enable row level security;
    alter table public.subscription_renewal_refunds force row level security;
  `);

  await knex.raw(`
    create function app_private.record_renewal_refund(
      p_agency_id uuid, p_provider text, p_provider_ref text, p_period_end timestamptz, p_amount_cents integer, p_reason text
    )
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.require_read_committed();
      perform app_private.require_no_person();
      if p_provider is null or p_provider not in ('simulado', 'asaas') or p_provider_ref is null or pg_catalog.btrim(p_provider_ref) = ''
         or pg_catalog.octet_length(p_provider_ref) > 200 or p_period_end is null or p_amount_cents is null or p_amount_cents <= 0
         or p_reason is null or p_reason not in ('A0114', 'A0115') then
        raise exception using errcode = 'A0114', message = 'The refund names no provider, reference, period, amount or reason.';
      end if;
      perform app_private.lock_subscription_change(p_agency_id);
      if exists (
        select 1 from public.subscription_charges charge
        where charge.provider = p_provider and charge.provider_ref = p_provider_ref and charge.status = 'confirmed'
      ) then
        raise exception using errcode = 'A0119', message = 'The reference holds a confirmed charge; it is not refunded.';
      end if;
      insert into public.subscription_renewal_refunds (agency_id, provider, provider_ref, period_end, amount_cents, reason)
      values (p_agency_id, p_provider, p_provider_ref, pg_catalog.date_trunc('milliseconds', p_period_end), p_amount_cents, p_reason)
      on conflict (provider, provider_ref) do nothing;
    end;
    $function$;
    revoke all on function app_private.record_renewal_refund(uuid, text, text, timestamptz, integer, text) from public;
    grant execute on function app_private.record_renewal_refund(uuid, text, text, timestamptz, integer, text) to ageniza_app;

    create function app_private.settle_renewal_refund(p_provider text, p_provider_ref text, p_status text, p_failure text)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.require_read_committed();
      perform app_private.require_no_person();
      if p_status is null or p_status not in ('refunded', 'failed') or (p_status = 'refunded') <> (p_failure is null)
         or (p_status = 'failed' and pg_catalog.btrim(p_failure) = '') then
        raise exception using errcode = 'A0114', message = 'A refund is settled as refunded, or as failed with a reason.';
      end if;
      update public.subscription_renewal_refunds refund
      set status = p_status, failure = pg_catalog.left(pg_catalog.btrim(p_failure), 200), settled_at = pg_catalog.now()
      where refund.provider = p_provider and refund.provider_ref = p_provider_ref and refund.status = 'recorded';
      return found;
    end;
    $function$;
    revoke all on function app_private.settle_renewal_refund(text, text, text, text) from public;
    grant execute on function app_private.settle_renewal_refund(text, text, text, text) to ageniza_app;

    drop function app_private.renewal_quote(uuid);
    create function app_private.renewal_quote(p_agency_id uuid)
    returns table (period_end timestamptz, amount_cents integer, provider text, attempt integer)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select subscription.current_period_end,
             app_private.subscription_monthly_cents(terms.plan_key, terms.extra_clients, terms.extra_storage_gib),
             subscription.provider,
             (select pg_catalog.count(*)::integer from public.subscription_renewal_refunds refund
              where refund.agency_id = p_agency_id and refund.provider = subscription.provider and refund.period_end = pg_catalog.date_trunc('milliseconds', subscription.current_period_end))
      from public.agency_subscriptions subscription
      cross join lateral app_private.next_renewal_terms(p_agency_id) terms
      where subscription.agency_id = p_agency_id
        and app_private.current_user_id() is null
    $function$;
    revoke all on function app_private.renewal_quote(uuid) from public;
    grant execute on function app_private.renewal_quote(uuid) to ageniza_app;
  `);

  await knex.raw(`
    create or replace function app_private.renew_subscription(p_agency_id uuid, p_provider text, p_provider_ref text, p_charged_cents integer)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_subscription public.agency_subscriptions;
      v_terms record;
      v_expected integer;
      v_start timestamptz;
      v_end timestamptz;
    begin
      perform app_private.require_read_committed();
      perform app_private.require_no_person();
      if p_provider is null or p_provider not in ('simulado', 'asaas') or p_provider_ref is null or pg_catalog.btrim(p_provider_ref) = ''
         or pg_catalog.octet_length(p_provider_ref) > 200 then
        raise exception using errcode = 'A0114', message = 'The confirmation names no provider or no reference.';
      end if;
      perform app_private.lock_subscription_change(p_agency_id);
      -- A reference the database recorded as refunded never renews anything: the money was given back (or is being), and the provider
      -- answers the same key with the same reference. The key of the next charge carries the attempt, so this only fires on a provider
      -- that ignored it.
      if exists (
        select 1 from public.subscription_renewal_refunds refund
        where refund.provider = p_provider and refund.provider_ref = p_provider_ref
      ) then
        raise exception using errcode = 'A0118', message = 'The provider reference was refunded and cannot renew a subscription.';
      end if;
      if exists (
        select 1 from public.subscription_charges charge
        where charge.agency_id = p_agency_id and charge.provider = p_provider and charge.provider_ref = p_provider_ref and charge.kind = 'renewal'
      ) then
        return false;
      end if;
      select * into v_subscription from public.agency_subscriptions subscription where subscription.agency_id = p_agency_id;
      if not found or v_subscription.provider is distinct from p_provider then
        raise exception using errcode = 'A0114', message = 'The subscription is not of this provider.';
      end if;
      select * into v_terms from app_private.next_renewal_terms(p_agency_id);
      if v_terms.plan_key is null then
        raise exception using errcode = 'A0115', message = 'The subscription is not due for renewal.';
      end if;
      v_expected := app_private.subscription_monthly_cents(v_terms.plan_key, v_terms.extra_clients, v_terms.extra_storage_gib);
      if p_charged_cents is distinct from v_expected then
        raise exception using errcode = 'A0114', message = 'The amount charged is not the amount of the next period.';
      end if;

      v_start := case when v_subscription.current_period_end + app_private.payment_grace_period() > pg_catalog.now()
                      then v_subscription.current_period_end else pg_catalog.now() end;
      v_end := v_start + interval '1 month';
      update public.agency_subscriptions
      set plan_key = v_terms.plan_key, extra_clients = v_terms.extra_clients, extra_storage_gib = v_terms.extra_storage_gib,
          current_period_start = v_start, current_period_end = v_end,
          pending_plan_key = null, pending_extra_clients = null, pending_extra_storage_gib = null, updated_at = pg_catalog.now()
      where agency_id = p_agency_id;
      perform app_private.apply_subscription_terms(p_agency_id, v_terms.plan_key, v_terms.extra_clients, v_terms.extra_storage_gib);
      update public.subscription_charges set status = 'expired' where agency_id = p_agency_id and status = 'pending';
      insert into public.subscription_charges (
        agency_id, kind, status, plan_key, extra_clients, extra_storage_gib, amount_cents, provider, provider_ref, expires_at,
        period_start, period_end, confirmed_at
      ) values (
        p_agency_id, 'renewal', 'confirmed', v_terms.plan_key, v_terms.extra_clients, v_terms.extra_storage_gib, v_expected,
        p_provider, p_provider_ref, pg_catalog.now(), v_start, v_end, pg_catalog.now()
      );
      insert into audit.events (action, agency_id, target_type, target_id)
      values (case when v_subscription.pending_plan_key is not null and v_terms.scheduled_applies then 'subscription.downgrade_applied'
                   when v_subscription.pending_plan_key is not null then 'subscription.downgrade_skipped'
                   else 'subscription.renewed' end,
              p_agency_id, 'agency', p_agency_id);
      return true;
    exception
      when unique_violation then
        raise exception using errcode = 'A0114', message = 'The provider reference belongs to another charge.';
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
