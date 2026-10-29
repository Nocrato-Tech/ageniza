// A raise of a limit that costs nothing is applied at once (issue #772, epic #770; review of #782). Forward-only. Needs 20261029000200.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-api-da-assinatura-e-gateway-simulado.md (item 9).
//
//  - `request_subscription_change` opened a pending charge for every raise of a limit, including one whose amount is zero: an Owner with
//    a plan of 30 clients, 100 GiB and R$ 249,00 who asks for a plan of 30 clients, 101 GiB and R$ 197,40 is quoted an `upgrade` of
//    zero (`greatest(prorated, 0)`). A provider does not charge zero, so the charge could never be paid and the Owner kept paying for the
//    worse plan. The owner decision (rule derived 3) says "zero charge and no refund": the raise is applied in the same transaction,
//    under the same locks, with no charge row and no provider, and no charge is left pending (the pending ones are expired first, as for
//    any request). The audit event is the one of a confirmed raise.
//  - Everything else of the function is unchanged.

export async function up(knex) {
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

      -- A raise of a limit that costs nothing is applied at once, under the same lock, with no charge and no provider: the Owner already
      -- pays more than the new terms cost (the cheaper plan with a bigger ceiling). A provider
      -- cannot charge zero, so a charge opened for it could never be paid, and the Owner would keep paying for the worse plan.
      if v_assessment.effect = 'upgrade' and v_assessment.amount_cents = 0 then
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
