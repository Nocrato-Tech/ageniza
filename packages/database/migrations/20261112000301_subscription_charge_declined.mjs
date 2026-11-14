// A charge records that its payment was declined (scope redesign-igual, subtask W5-S1c1). Forward-only. Needs 20261029000200 (the charges
// and `confirm_subscription_charge`) and 20261029000100 (`assinatura.gerenciar`).
//
// Structural: docs/business/decisions/2026-11-12-estrutural-a-cobranca-registra-a-recusa-do-pagamento.md.
//
//  - `subscription_charges.declined_at`: the instant the provider refused the payment, null until then. The state of the charge does not
//    change (a declined charge keeps `pending` until a newer request replaces it, and then `expired`): the invoice reads the instant first.
//    A CHECK keeps a confirmed charge from carrying it. The application role can only SELECT it, like the other columns of an invoice.
//  - `decline_subscription_charge` is the one writer: it checks the permission, takes the lock of the agency that every writer of the
//    charges takes, reads the charge after it, refuses one that is not open (confirmed, expired, past its time or already declined, all
//    A0125, and the same answer for a charge that is not the agency's), stamps the instant from the database and audits
//    `subscription.charge_declined` with the charge as the target. There is no row lock on purpose: the lock of the agency is the order.
//  - `confirm_subscription_charge` keeps its body and refuses a declined charge with A0114 (the answer for a charge that is not open).
//
// Error code (new): A0125 the charge is not open to be declined.

export async function up(knex) {
  await knex.raw(`
    alter table public.subscription_charges
      add column declined_at timestamptz null,
      add constraint subscription_charges_declined_check check (declined_at is null or status <> 'confirmed');
    grant select (declined_at) on public.subscription_charges to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.decline_subscription_charge(p_agency_id uuid, p_charge_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_charge public.subscription_charges;
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
      select * into v_charge from public.subscription_charges charge where charge.id = p_charge_id and charge.agency_id = p_agency_id;
      if not found or v_charge.status <> 'pending' or v_charge.declined_at is not null or v_charge.expires_at <= pg_catalog.now() then
        raise exception using errcode = 'A0125', message = 'The charge is not open to be declined.';
      end if;
      update public.subscription_charges set declined_at = pg_catalog.now() where id = v_charge.id;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('subscription.charge_declined', app_private.current_user_id(), p_agency_id, 'subscription_charge', v_charge.id);
    end;
    $function$;
    revoke all on function app_private.decline_subscription_charge(uuid, uuid) from public;
    grant execute on function app_private.decline_subscription_charge(uuid, uuid) to ageniza_app;
  `);

  // Same signature, result, security and search_path as in 20261029000200 (the grants stay); the body of that migration plus the declined check.
  await knex.raw(`
    create or replace function app_private.confirm_subscription_charge(
      p_charge_id uuid, p_provider text, p_provider_ref text, p_charged_cents integer
    )
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_charge public.subscription_charges;
      v_assessment record;
      v_subscription public.agency_subscriptions;
      v_start timestamptz;
      v_end timestamptz;
    begin
      perform app_private.require_read_committed();
      perform app_private.require_no_person();
      if p_provider is null or p_provider not in ('simulado', 'asaas') or p_provider_ref is null or pg_catalog.btrim(p_provider_ref) = ''
         or pg_catalog.octet_length(p_provider_ref) > 200 then
        raise exception using errcode = 'A0114', message = 'The confirmation names no provider or no reference.';
      end if;
      select * into v_charge from public.subscription_charges charge where charge.id = p_charge_id;
      if not found then
        raise exception using errcode = 'A0114', message = 'The charge does not exist.';
      end if;
      perform app_private.lock_subscription_change(v_charge.agency_id);
      -- Read again after the wait: every writer of the charges holds the lock of the agency, so no row lock is needed.
      select * into v_charge from public.subscription_charges charge where charge.id = p_charge_id;

      if v_charge.status = 'confirmed' then
        if v_charge.provider = p_provider and v_charge.provider_ref = p_provider_ref then
          return false;
        end if;
        raise exception using errcode = 'A0114', message = 'The charge was confirmed with another reference.';
      end if;
      if v_charge.status <> 'pending' or v_charge.declined_at is not null or v_charge.expires_at <= pg_catalog.now() then
        raise exception using errcode = 'A0114', message = 'The charge is not open for confirmation.';
      end if;
      if p_charged_cents is distinct from v_charge.amount_cents then
        raise exception using errcode = 'A0114', message = 'The amount charged is not the amount of the charge.';
      end if;

      -- The state may have moved since the request: the same change has to be the same kind of change now.
      select * into v_assessment from app_private.assess_agency_subscription_change(
        v_charge.agency_id, v_charge.plan_key, v_charge.extra_clients, v_charge.extra_storage_gib);
      if v_assessment.effect is distinct from v_charge.kind then
        raise exception using errcode = 'A0114', message = 'The subscription changed after the charge was requested.';
      end if;

      if v_charge.kind = 'subscribe' then
        select * into v_subscription from public.agency_subscriptions subscription where subscription.agency_id = v_charge.agency_id;
        -- Inside the window after an unpaid period the new one starts where the old one ended: the days of the window are paid.
        -- No subscription and a courtesy have no end, so the comparison is null and the period starts now.
        v_start := case when not v_subscription.cancel_at_period_end
                         and v_subscription.current_period_end + app_private.payment_grace_period() > pg_catalog.now()
                        then v_subscription.current_period_end else pg_catalog.now() end;
        v_end := v_start + interval '1 month';
        insert into public.agency_subscriptions (agency_id, plan_key, extra_clients, extra_storage_gib, provider, current_period_start, current_period_end)
        values (v_charge.agency_id, v_charge.plan_key, v_charge.extra_clients, v_charge.extra_storage_gib, p_provider, v_start, v_end)
        on conflict (agency_id) do update set
          plan_key = excluded.plan_key, extra_clients = excluded.extra_clients, extra_storage_gib = excluded.extra_storage_gib,
          provider = excluded.provider, current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
          cancel_at_period_end = false, pending_plan_key = null, pending_extra_clients = null, pending_extra_storage_gib = null,
          updated_at = pg_catalog.now();
      else
        select * into v_subscription from public.agency_subscriptions subscription where subscription.agency_id = v_charge.agency_id;
        if v_subscription.provider is distinct from p_provider then
          raise exception using errcode = 'A0114', message = 'The subscription is not of this provider.';
        end if;
        v_start := v_subscription.current_period_start;
        v_end := v_subscription.current_period_end;
        update public.agency_subscriptions
        set plan_key = v_charge.plan_key, extra_clients = v_charge.extra_clients, extra_storage_gib = v_charge.extra_storage_gib,
            pending_plan_key = null, pending_extra_clients = null, pending_extra_storage_gib = null, updated_at = pg_catalog.now()
        where agency_id = v_charge.agency_id;
      end if;
      perform app_private.apply_subscription_terms(v_charge.agency_id, v_charge.plan_key, v_charge.extra_clients, v_charge.extra_storage_gib);

      update public.subscription_charges
      set status = 'confirmed', provider = p_provider, provider_ref = p_provider_ref, period_start = v_start, period_end = v_end,
          confirmed_at = pg_catalog.now()
      where id = v_charge.id;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values (case v_charge.kind when 'subscribe' then 'subscription.subscribed' else 'subscription.upgraded' end, v_charge.requested_by_user_id, v_charge.agency_id, 'agency', v_charge.agency_id);
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
