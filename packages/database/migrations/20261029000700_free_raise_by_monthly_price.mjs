// A raise is free when the monthly price does not go up, not when the prorated amount rounds to zero (issue #772, epic #770; review of
// #782). Forward-only. Needs 20261029000200 and 20261029000500.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-o-worker-renova-a-assinatura.md (item 12).
//
//  - Migration 500 applied at once every raise whose prorated amount was zero. That held because the prices of today make a raise
//    that costs more at least one cent, but the amount rounds: a table with a GiB under 16 cents would have given a paid raise for free.
//    `request_subscription_change` now compares the monthly price of the new terms with the one of the current terms (the locked
//    subscription) and applies the raise at once only when it is not higher.
//  - The assessment charges a raise that costs more at least one cent, so a charge is never opened for zero (which no provider collects),
//    and the quote and the charge agree.
//  - Everything else of both functions is unchanged.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.assess_agency_subscription_change(
      p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer
    )
    returns table (effect text, monthly_cents integer, amount_cents integer, period_end timestamptz)
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    declare
      v_plan text;
      v_subscription public.agency_subscriptions;
      v_live boolean;
      v_row record;
      v_current_monthly integer;
    begin
      select agency.plan into v_plan from public.agencies agency where agency.id = p_agency_id and agency.status = 'active';
      if v_plan is null then
        raise exception using errcode = '42501', message = 'The agency does not take this operation.';
      end if;
      if v_plan = 'isenta' then
        raise exception using errcode = 'A0110', message = 'The agency is exempt from payment.';
      end if;
      select * into v_subscription from public.agency_subscriptions subscription where subscription.agency_id = p_agency_id;
      v_live := v_plan = 'ativo' and found and v_subscription.current_period_end is not null and v_subscription.current_period_end > pg_catalog.now();

      if v_plan = 'ativo' and not found then
        raise exception using errcode = 'A0110', message = 'The plan of this agency is managed by the operation.';
      end if;
      if v_plan = 'ativo' and v_subscription.provider = 'cortesia' then
        raise exception using errcode = 'A0110', message = 'A courtesy plan is changed by the operation.';
      end if;
      if v_live and v_subscription.cancel_at_period_end then
        raise exception using errcode = 'A0110', message = 'The subscription is canceled; it can be taken again when the period ends.';
      end if;

      if v_live then
        v_current_monthly := app_private.subscription_monthly_cents(v_subscription.plan_key, v_subscription.extra_clients, v_subscription.extra_storage_gib);
      end if;

      for v_row in
        select * from app_private.assess_subscription_change(
          case when v_live then v_subscription.plan_key end,
          case when v_live then v_subscription.extra_clients end,
          case when v_live then v_subscription.extra_storage_gib end,
          case when v_live then v_subscription.current_period_start end,
          case when v_live then v_subscription.current_period_end end,
          p_plan_key, p_extra_clients, p_extra_storage_gib,
          (select pg_catalog.count(*) from public.clients client where client.agency_id = p_agency_id and client.status = 'active'),
          app_private.agency_storage_used_bytes(p_agency_id),
          pg_catalog.now()
        )
      loop
        effect := v_row.effect;
        monthly_cents := v_row.monthly_cents;
        amount_cents := v_row.amount_cents;
        -- A raise that makes the subscription cost more is charged at least one cent, whatever the proration rounds to: a charge of zero
        -- could never be paid. A raise that does not cost more stays at zero, and request_subscription_change applies it at once.
        if v_live and v_row.effect = 'upgrade' and v_row.monthly_cents > v_current_monthly and amount_cents < 1 then
          amount_cents := 1;
        end if;
        period_end := case when v_live then v_subscription.current_period_end end;
        return next;
      end loop;
    end;
    $function$;
  `);
  await knex.raw(`
    create or replace function app_private.request_subscription_change(
      p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer
    )
    returns table (charge_id uuid, effect text, monthly_cents integer, amount_cents integer, effective_at timestamptz)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_assessment record;
      v_charge_id uuid;
      v_current_monthly integer;
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      perform app_private.require_read_committed();
      perform app_private.lock_subscription_change(p_agency_id);
      select * into v_assessment from app_private.assess_agency_subscription_change(p_agency_id, p_plan_key, p_extra_clients, p_extra_storage_gib);

      if v_assessment.effect = 'downgrade' then
        update public.agency_subscriptions
        set pending_plan_key = p_plan_key, pending_extra_clients = p_extra_clients, pending_extra_storage_gib = p_extra_storage_gib,
            updated_at = pg_catalog.now()
        where agency_id = p_agency_id;
        update public.subscription_charges set status = 'expired' where agency_id = p_agency_id and status = 'pending';
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('subscription.downgrade_scheduled', app_private.current_user_id(), p_agency_id, 'agency', p_agency_id);
        return query select null::uuid, v_assessment.effect, v_assessment.monthly_cents, 0, v_assessment.period_end;
        return;
      end if;

      update public.subscription_charges set status = 'expired' where agency_id = p_agency_id and status = 'pending';

      -- A raise of a limit that does not make the subscription cost more is applied at once, under the same lock, with no charge and no
      -- provider: the Owner already pays at least what the new terms cost (the cheaper plan with a bigger ceiling). A provider cannot
      -- charge zero, so a charge opened for it could never be paid, and the Owner would keep paying for the worse plan. What decides is the
      -- difference of the monthly prices, not the prorated amount, which also rounds to zero for a small rise.
      select app_private.subscription_monthly_cents(subscription.plan_key, subscription.extra_clients, subscription.extra_storage_gib)
      into v_current_monthly
      from public.agency_subscriptions subscription where subscription.agency_id = p_agency_id;
      if v_assessment.effect = 'upgrade' and v_assessment.monthly_cents <= v_current_monthly then
        update public.agency_subscriptions
        set plan_key = p_plan_key, extra_clients = p_extra_clients, extra_storage_gib = p_extra_storage_gib,
            pending_plan_key = null, pending_extra_clients = null, pending_extra_storage_gib = null, updated_at = pg_catalog.now()
        where agency_id = p_agency_id;
        perform app_private.apply_subscription_terms(p_agency_id, p_plan_key, p_extra_clients, p_extra_storage_gib);
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('subscription.upgraded', app_private.current_user_id(), p_agency_id, 'agency', p_agency_id);
        return query select null::uuid, v_assessment.effect, v_assessment.monthly_cents, 0, pg_catalog.now();
        return;
      end if;

      insert into public.subscription_charges (agency_id, kind, plan_key, extra_clients, extra_storage_gib, amount_cents, requested_by_user_id, expires_at)
      values (p_agency_id, v_assessment.effect, p_plan_key, p_extra_clients, p_extra_storage_gib, v_assessment.amount_cents,
              app_private.current_user_id(), pg_catalog.now() + interval '30 minutes')
      returning id into v_charge_id;
      return query select v_charge_id, v_assessment.effect, v_assessment.monthly_cents, v_assessment.amount_cents, pg_catalog.now();
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
