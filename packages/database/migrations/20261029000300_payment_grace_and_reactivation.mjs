// The three days an agency keeps writing after its period ended without a confirmed renewal, and the undoing of a cancellation
// (issue #775, epic #770). Forward-only. Needs 20261029000100 and 20261029000200.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-regras-derivadas-dos-planos-pagos.md (items 2, 8, 9 and 11, as the
// owner rewrote them on 2026-10-29) and 2026-10-29-estrutural-cobranca-renovacao-cancelamento-e-tolerancia.md.
//
//  - `agency_accepts_writes` (20261029000100) kept an agency writing only while the period ran. Now, for a subscription that was
//    not canceled, the agency keeps writing for `payment_grace_period()` after the period ends; a canceled one stops writing when
//    the period ends. The window is not a privilege of the ceilings: the plan, the extras and the limits stay what they were.
//  - `reactivate_subscription` undoes a cancellation until the period ends, with no charge, under the same lock `cancel_subscription`
//    takes and for the Owner only. After the end, the agency subscribes again.
//
// Error codes as in 20261029000200.

export async function up(knex) {
  await knex.raw(`
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
             (select case when subscription.cancel_at_period_end
                          then subscription.current_period_end > pg_catalog.now()
                          else subscription.current_period_end + app_private.payment_grace_period() > pg_catalog.now() end
              from public.agency_subscriptions subscription where subscription.agency_id = agency.id),
             true
           )
           else true
         end
         from public.agencies agency where agency.id = p_agency_id),
        false
      )
    $function$;

    -- Takes the cancellation back: the subscription renews as before, with the terms it has now (the cancellation had dropped the
    -- decrease that was scheduled, and that stays dropped). Nothing is charged, and a period that ended cannot be reactivated.
    create function app_private.reactivate_subscription(p_agency_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_subscription public.agency_subscriptions;
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
      select * into v_subscription from public.agency_subscriptions subscription where subscription.agency_id = p_agency_id;
      if not found or v_subscription.provider = 'cortesia' or v_subscription.current_period_end <= pg_catalog.now() then
        raise exception using errcode = 'A0110', message = 'There is no running subscription to reactivate.';
      end if;
      if not v_subscription.cancel_at_period_end then
        return;
      end if;
      update public.agency_subscriptions
      set cancel_at_period_end = false, updated_at = pg_catalog.now()
      where agency_id = p_agency_id;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('subscription.reactivated', app_private.current_user_id(), p_agency_id, 'agency', p_agency_id);
    end;
    $function$;
    revoke all on function app_private.reactivate_subscription(uuid) from public;
    grant execute on function app_private.reactivate_subscription(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
