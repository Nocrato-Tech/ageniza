// What the worker charges for a renewal (issue #772, epic #770). Forward-only. Needs 20261029000200.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-o-worker-renova-a-assinatura.md.
//
//  - `renewal_quote`: the end of the period being renewed, what the next period costs and the provider that charges it, read in one
//    statement so all three belong to the same state of the subscription. The worker builds the idempotency key of the charge from them
//    (agency, end of the period, amount): the same period and amount make the same key, so a retry never charges twice, and a period renewed makes a new key, so the next
//    month is never mistaken for this one. Without a person in the transaction only (the worker binds none): a member of the agency
//    reads the same through `subscription_overview`. Empty when the subscription does not renew now, like `next_renewal_terms`.

export async function up(knex) {
  await knex.raw(`
    create function app_private.renewal_quote(p_agency_id uuid)
    returns table (period_end timestamptz, amount_cents integer, provider text)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select subscription.current_period_end,
             app_private.subscription_monthly_cents(terms.plan_key, terms.extra_clients, terms.extra_storage_gib),
             subscription.provider
      from public.agency_subscriptions subscription
      cross join lateral app_private.next_renewal_terms(p_agency_id) terms
      where subscription.agency_id = p_agency_id
        and app_private.current_user_id() is null
    $function$;
    revoke all on function app_private.renewal_quote(uuid) from public;
    grant execute on function app_private.renewal_quote(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
