// Canceling inside the three days of payment grace (issue #772, epic #770). Forward-only. Needs 20261029000200 and 20261029000300.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-cobranca-renovacao-cancelamento-e-tolerancia.md ("cancelar na
// tolerancia: permitido, somente leitura imediato", owner, 2026-10-29).
//
//  - `cancel_subscription` (20261029000200) refused a period that had ended. It now also accepts one that ended inside the window.
//    The cancellation is then the end: `agency_accepts_writes` (20261029000300) lets a canceled subscription write only while its
//    period runs, so the agency is read-only at once; `agencies_due_for_renewal` and `next_renewal_terms` skip a canceled one, so no
//    renewal is tried or accepted; and the pending charges are invalidated, as in any cancellation.
//  - `reactivate_subscription` is unchanged: it still stops at the end of the period, so inside the window it answers A0110.
//
// Past the window the agency is read-only already and there is nothing to cancel: A0110, as before.
//
//  - `agency_is_read_only`: what `GET /agencies/:agencyId/me` shows. The rule is `agency_accepts_writes`, which only the triggers call; this
//    answers the same for a member of the agency and null for anyone else, so the API repeats no clock comparison and a stranger learns nothing.

export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.cancel_subscription(p_agency_id uuid)
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
      if not found or v_subscription.provider = 'cortesia'
         or v_subscription.current_period_end + app_private.payment_grace_period() <= pg_catalog.now() then
        raise exception using errcode = 'A0110', message = 'There is no running subscription to cancel.';
      end if;
      if v_subscription.cancel_at_period_end then
        return;
      end if;
      update public.agency_subscriptions
      set cancel_at_period_end = true, pending_plan_key = null, pending_extra_clients = null, pending_extra_storage_gib = null,
          updated_at = pg_catalog.now()
      where agency_id = p_agency_id;
      update public.subscription_charges set status = 'expired' where agency_id = p_agency_id and status = 'pending';
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('subscription.canceled', app_private.current_user_id(), p_agency_id, 'agency', p_agency_id);
    end;
    $function$;

    create function app_private.agency_is_read_only(p_agency_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select not app_private.agency_accepts_writes(p_agency_id) where app_private.is_agency_member(p_agency_id)
    $function$;
    revoke all on function app_private.agency_is_read_only(uuid) from public;
    grant execute on function app_private.agency_is_read_only(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
