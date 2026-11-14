// The test card of an agency and the days of a quote (scope redesign-igual, subtask W5-S1: the database layer). Forward-only. Needs
// 20261029000200 (the quote) and 20261029000100 (`assinatura.gerenciar`).
//
// Structural: docs/business/decisions/2026-11-11-estrutural-pagamento-simulado-no-dev-cartao-de-teste-faturas-e-compra-dos-planos.md.
//
//  - `agency_test_cards`: at most one row per agency, with the last four digits, the expiry and the fixed brand `test`, and who saved it and
//    when. No column holds a number, a security code or a name: there is nowhere to put one. The four rules of what a test card is live once,
//    as CHECKs of the table.
//  - `ageniza_app` can only SELECT the four columns of the card and `agency_id`, and only through the policy: whoever holds
//    `assinatura.gerenciar` in the agency (the Owner by ownership; no role can carry it, and a link to a client is never looked at). No
//    INSERT, UPDATE or DELETE, on the table or on a column.
//  - `save_agency_test_card` is the one writer: it checks the permission, upserts the row ("Trocar" replaces the card of the agency), stamps
//    the actor and the instant from the database and audits `subscription.test_card_saved` with the agency as the target. The digits are
//    not in the event. A value that is not a test card is refused with A0124 and nothing is written. Whether the card exists only outside
//    production is the API's rule (it does not register the route there); the database holds a harmless row either way.
//  - The charges of an agency are already readable by whoever holds `assinatura.gerenciar` (policy and columns of 20261029000100), so the
//    list of invoices needs no new object.
//  - The quote also tells the days that fall on the proportional charge. The count of days lived in `prorated_cents`; it is now two helpers
//    that `prorated_cents` and the quote share, with the arithmetic (double precision, rounding of the half to the even) untouched.
//
// Error code (new): A0124 the value is not a test card.

export async function up(knex) {
  await knex.raw(`
    create table public.agency_test_cards (
      agency_id uuid primary key references public.agencies (id) on delete cascade,
      last4 text not null,
      exp_month integer not null,
      exp_year integer not null,
      brand text not null default 'test',
      saved_by_user_id uuid not null references auth."user" (id),
      saved_at timestamptz not null default now(),
      constraint agency_test_cards_last4_check check (last4 ~ '^[0-9]{4}$'),
      constraint agency_test_cards_exp_month_check check (exp_month between 1 and 12),
      constraint agency_test_cards_exp_year_check check (exp_year between 2000 and 2099),
      constraint agency_test_cards_brand_check check (brand = 'test')
    );

    alter table public.agency_test_cards enable row level security;
    alter table public.agency_test_cards force row level security;

    revoke all on public.agency_test_cards from ageniza_app;
    grant select (agency_id, last4, exp_month, exp_year, brand) on public.agency_test_cards to ageniza_app;

    create policy agency_test_cards_select on public.agency_test_cards
      for select to ageniza_app
      using (app_private.has_agency_permission(agency_id, 'assinatura.gerenciar'));
  `);

  await knex.raw(`
    create function app_private.save_agency_test_card(p_agency_id uuid, p_last4 text, p_exp_month integer, p_exp_year integer, p_brand text)
    returns table (last4 text, exp_month integer, exp_year integer, brand text)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      begin
        insert into public.agency_test_cards as card (agency_id, last4, exp_month, exp_year, brand, saved_by_user_id, saved_at)
        values (p_agency_id, p_last4, p_exp_month, p_exp_year, p_brand, app_private.current_user_id(), pg_catalog.now())
        on conflict (agency_id) do update
          set last4 = excluded.last4, exp_month = excluded.exp_month, exp_year = excluded.exp_year, brand = excluded.brand,
              saved_by_user_id = excluded.saved_by_user_id, saved_at = excluded.saved_at
        returning card.last4, card.exp_month, card.exp_year, card.brand into last4, exp_month, exp_year, brand;
      exception
        when check_violation or not_null_violation then
          raise exception using errcode = 'A0124', message = 'Only the last four digits, the expiry and the test brand of a test card are kept.';
      end;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('subscription.test_card_saved', app_private.current_user_id(), p_agency_id, 'agency', p_agency_id);
      return next;
    end;
    $function$;
    revoke all on function app_private.save_agency_test_card(uuid, text, integer, integer, text) from public;
    grant execute on function app_private.save_agency_test_card(uuid, text, integer, integer, text) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.period_length_days(p_period_start timestamptz, p_period_end timestamptz)
    returns double precision
    language sql
    immutable
    set search_path = ''
    as $function$
      select greatest(pg_catalog.round(pg_catalog.date_part('epoch', p_period_end - p_period_start) / 86400), 1)
    $function$;
    revoke all on function app_private.period_length_days(timestamptz, timestamptz) from public;

    -- The whole days of the period that are left at p_at, the day that has begun counted, never more than the days of the period.
    create function app_private.period_days_left(p_period_start timestamptz, p_period_end timestamptz, p_at timestamptz)
    returns double precision
    language sql
    immutable
    set search_path = ''
    as $function$
      select least(
        greatest(pg_catalog.ceil(pg_catalog.date_part('epoch', p_period_end - p_at) / 86400), 0),
        app_private.period_length_days(p_period_start, p_period_end)
      )
    $function$;
    revoke all on function app_private.period_days_left(timestamptz, timestamptz, timestamptz) from public;

    -- Same signature, volatility, security and search_path as before (the grants stay); the body reads the days from the two helpers.
    create or replace function app_private.prorated_cents(p_difference_cents integer, p_period_start timestamptz, p_period_end timestamptz, p_at timestamptz)
    returns integer
    language sql
    immutable
    set search_path = ''
    as $function$
      select pg_catalog.round(
        p_difference_cents::numeric
        * app_private.period_days_left(p_period_start, p_period_end, p_at)
        / app_private.period_length_days(p_period_start, p_period_end)
      )::integer
    $function$;
  `);

  await knex.raw(`
    drop function app_private.quote_subscription_change(uuid, text, integer, integer);
    -- days_left and period_days are the share of the proportional charge, and only a raise has one; they are null for the first
    -- subscription (the whole month is charged) and for a decrease (nothing is charged).
    create function app_private.quote_subscription_change(
      p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer
    )
    returns table (effect text, monthly_cents integer, amount_cents integer, effective_at timestamptz, days_left integer, period_days integer)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      return query
        select assessment.effect, assessment.monthly_cents, assessment.amount_cents,
               case assessment.effect when 'downgrade' then assessment.period_end else pg_catalog.now() end,
               case when assessment.effect = 'upgrade'
                 then app_private.period_days_left(subscription.current_period_start, assessment.period_end, pg_catalog.now())::integer end,
               case when assessment.effect = 'upgrade'
                 then app_private.period_length_days(subscription.current_period_start, assessment.period_end)::integer end
        from app_private.assess_agency_subscription_change(p_agency_id, p_plan_key, p_extra_clients, p_extra_storage_gib) assessment
        left join public.agency_subscriptions subscription on subscription.agency_id = p_agency_id;
    end;
    $function$;
    revoke all on function app_private.quote_subscription_change(uuid, text, integer, integer) from public;
    grant execute on function app_private.quote_subscription_change(uuid, text, integer, integer) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
