// Quoting, requesting, confirming, canceling and renewing a subscription, and the overview the screen reads (issue #775, epic
// #770). Forward-only. Needs 20261029000100.
//
// Structural: docs/business/decisions/2026-10-29-estrutural-planos-pagos-assinatura-e-gateway-simulado.md and
// 2026-10-29-estrutural-regras-derivadas-dos-planos-pagos.md.
//
//  - A plan or a limit changes only through `confirm_subscription_charge` and `renew_subscription`, which the server calls
//    after the provider answered, with nobody bound to the transaction, against a charge the Owner was quoted
//    (`request_subscription_change`) or against the price of the next period. The application role has no INSERT, UPDATE or
//    DELETE on the subscription tables.
//  - Raising a plan or buying an extra applies at once and is charged for the days left of the period; lowering waits for the
//    next period and never goes below the clients and the storage in use. Canceling keeps everything until the period ends.
//  - Every writer of the subscription tables (request, confirm, cancel, renew, advance, and the courtesy of the first migration)
//    takes the advisory lock of the agency first and reads after it; there are no row locks, so the lock is the only order.
//    Every operation that counts takes it first, and counts after it. An operation that compares the
//    storage in use with a new ceiling (subscribe, raise, a decrease on request and on renewal) takes the upload confirmation's
//    lock ('media-quota:<agency>', taken by the media service) before the agency's, always in that order, so a confirmation in
//    flight is in the count or waits for the new quota.
//  - An agency whose period ended without a confirmed renewal keeps writing for `payment_grace_period()` (3 days); a renewal, or a
//    new subscription, confirmed in that window starts the new period where the old one ended, so the window is paid for. A
//    canceled subscription has no window. The part of this that decides whether the agency writes (`agency_accepts_writes`) and
//    the undoing of a cancellation (`reactivate_subscription`) are in 20261029000300.
//
// Error codes: A0110 the agency cannot take the operation in its state, A0111 the new limit is below the clients in use,
// A0112 an increase and a decrease together, A0113 nothing changes, A0114 the confirmation does not match the charge,
// A0115 not due for renewal yet, A0116 an invalid plan or quantity, A0117 the new limit is below the storage in use.

const MAX_EXTRA = 10000;

export async function up(knex) {
  await knex.raw(`
    -- How long an agency keeps writing after its period ended with no renewal confirmed (decision of 2026-10-29). One copy: the
    -- write check, the start of the renewal and the date the screen shows all read it.
    create function app_private.payment_grace_period()
    returns interval
    language sql
    immutable
    set search_path = ''
    as $function$
      select interval '3 days'
    $function$;
    revoke all on function app_private.payment_grace_period() from public;

    -- The part of a monthly difference that falls on the days left of the period, whole days rounded up.
    create function app_private.prorated_cents(p_difference_cents integer, p_period_start timestamptz, p_period_end timestamptz, p_at timestamptz)
    returns integer
    language sql
    immutable
    set search_path = ''
    as $function$
      select pg_catalog.round(
        p_difference_cents::numeric
        * least(greatest(pg_catalog.ceil(pg_catalog.date_part('epoch', p_period_end - p_at) / 86400), 0), total.days)
        / total.days
      )::integer
      from (select greatest(pg_catalog.round(pg_catalog.date_part('epoch', p_period_end - p_period_start) / 86400), 1) as days) total
    $function$;
    revoke all on function app_private.prorated_cents(integer, timestamptz, timestamptz, timestamptz) from public;
  `);

  await knex.raw(`
    -- The two locks a change of ceiling needs, always in this order: the upload confirmation's (which writes the storage in use)
    -- and the agency's (which serializes the clients, the collaborators and the other changes of the subscription). The media
    -- service takes only the first and the client triggers only the second, so no path takes them the other way round.
    create function app_private.lock_subscription_change(p_agency_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('media-quota:' || p_agency_id::text, 0));
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
    end;
    $function$;
    revoke all on function app_private.lock_subscription_change(uuid) from public;
  `);

  await knex.raw(`
    -- The pure core: what a change to (plan, extras) is, what it costs now and why it is refused. 'subscribe' starts a
    -- period, 'upgrade' takes effect now and is charged for the days left, 'downgrade' waits for the next period.
    create function app_private.assess_subscription_change(
      p_current_plan_key text, p_current_extra_clients integer, p_current_extra_storage_gib integer,
      p_period_start timestamptz, p_period_end timestamptz,
      p_target_plan_key text, p_target_extra_clients integer, p_target_extra_storage_gib integer,
      p_used_clients bigint, p_used_bytes bigint, p_at timestamptz
    )
    returns table (effect text, monthly_cents integer, amount_cents integer)
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    declare
      v_target_monthly integer := app_private.subscription_monthly_cents(p_target_plan_key, p_target_extra_clients, p_target_extra_storage_gib);
      v_target_clients integer := app_private.subscription_client_limit(p_target_plan_key, p_target_extra_clients);
      v_target_bytes bigint := app_private.subscription_storage_bytes(p_target_plan_key, p_target_extra_storage_gib);
      v_current_monthly integer;
      v_current_clients integer;
      v_current_bytes bigint;
    begin
      if v_target_monthly is null
         or p_target_extra_clients is null or p_target_extra_clients not between 0 and ${MAX_EXTRA}
         or p_target_extra_storage_gib is null or p_target_extra_storage_gib not between 0 and ${MAX_EXTRA} then
        raise exception using errcode = 'A0116', message = 'The plan or the quantity of an extra is not valid.';
      end if;
      if p_used_clients > v_target_clients then
        raise exception using errcode = 'A0111', message = pg_catalog.format('The new limit of %s clients is below the %s active clients.', v_target_clients, p_used_clients);
      end if;
      if p_used_bytes > v_target_bytes then
        raise exception using errcode = 'A0117', message = pg_catalog.format('The new storage limit of %s bytes is below the %s bytes in use.', v_target_bytes, p_used_bytes);
      end if;

      if p_current_plan_key is null then
        return query select 'subscribe'::text, v_target_monthly, v_target_monthly;
        return;
      end if;

      v_current_monthly := app_private.subscription_monthly_cents(p_current_plan_key, p_current_extra_clients, p_current_extra_storage_gib);
      v_current_clients := app_private.subscription_client_limit(p_current_plan_key, p_current_extra_clients);
      v_current_bytes := app_private.subscription_storage_bytes(p_current_plan_key, p_current_extra_storage_gib);

      if v_target_clients = v_current_clients and v_target_bytes = v_current_bytes then
        if v_target_monthly = v_current_monthly then
          raise exception using errcode = 'A0113', message = 'The subscription already has these terms.';
        end if;
        if v_target_monthly < v_current_monthly then
          return query select 'downgrade'::text, v_target_monthly, 0;
        else
          return query select 'upgrade'::text, v_target_monthly,
            app_private.prorated_cents(v_target_monthly - v_current_monthly, p_period_start, p_period_end, p_at);
        end if;
        return;
      end if;
      if v_target_clients >= v_current_clients and v_target_bytes >= v_current_bytes then
        return query select 'upgrade'::text, v_target_monthly,
          greatest(app_private.prorated_cents(v_target_monthly - v_current_monthly, p_period_start, p_period_end, p_at), 0);
        return;
      end if;
      if v_target_clients <= v_current_clients and v_target_bytes <= v_current_bytes then
        return query select 'downgrade'::text, v_target_monthly, 0;
        return;
      end if;
      raise exception using errcode = 'A0112', message = 'An increase and a decrease of the limits cannot go together.';
    end;
    $function$;
    revoke all on function app_private.assess_subscription_change(
      text, integer, integer, timestamptz, timestamptz, text, integer, integer, bigint, bigint, timestamptz
    ) from public;

    -- Assesses a change against the stored subscription and the live usage. The caller holds the lock of the agency.
    create function app_private.assess_agency_subscription_change(
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
        period_end := case when v_live then v_subscription.current_period_end end;
        return next;
      end loop;
    end;
    $function$;
    revoke all on function app_private.assess_agency_subscription_change(uuid, text, integer, integer) from public;

    -- The Owner is the only caller of the functions below that start from a person. A quote only reads, so it takes no lock:
    -- the request that follows counts again under the lock.
    -- A charge is confirmed and a period renewed by the server, from the provider's word, never inside a person's transaction.
    create function app_private.require_no_person()
    returns void
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'A confirmation comes from the payment provider, not from a person.';
      end if;
    end;
    $function$;
    revoke all on function app_private.require_no_person() from public;

    create function app_private.require_subscription_owner(p_agency_id uuid)
    returns void
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    begin
      if not app_private.has_agency_permission(p_agency_id, 'assinatura.gerenciar') then
        raise exception using errcode = '42501', message = 'Only the Owner manages the subscription.';
      end if;
    end;
    $function$;
    revoke all on function app_private.require_subscription_owner(uuid) from public;

    create function app_private.quote_subscription_change(
      p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer
    )
    returns table (effect text, monthly_cents integer, amount_cents integer, effective_at timestamptz)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      return query
        select assessment.effect, assessment.monthly_cents, assessment.amount_cents,
               case assessment.effect when 'downgrade' then assessment.period_end else pg_catalog.now() end
        from app_private.assess_agency_subscription_change(p_agency_id, p_plan_key, p_extra_clients, p_extra_storage_gib) assessment;
    end;
    $function$;
    revoke all on function app_private.quote_subscription_change(uuid, text, integer, integer) from public;
    grant execute on function app_private.quote_subscription_change(uuid, text, integer, integer) to ageniza_app;

    -- A change that is charged now opens a pending charge for the provider to confirm; a decrease is scheduled for the next
    -- period and charges nothing.
    create function app_private.request_subscription_change(
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
      insert into public.subscription_charges (agency_id, kind, plan_key, extra_clients, extra_storage_gib, amount_cents, requested_by_user_id, expires_at)
      values (p_agency_id, v_assessment.effect, p_plan_key, p_extra_clients, p_extra_storage_gib, v_assessment.amount_cents,
              app_private.current_user_id(), pg_catalog.now() + interval '30 minutes')
      returning id into v_charge_id;
      return query select v_charge_id, v_assessment.effect, v_assessment.monthly_cents, v_assessment.amount_cents, pg_catalog.now();
    end;
    $function$;
    revoke all on function app_private.request_subscription_change(uuid, text, integer, integer) from public;
    grant execute on function app_private.request_subscription_change(uuid, text, integer, integer) to ageniza_app;

    -- The provider confirmed the charge: this is the only path by which a plan or a limit grows. The amount charged must be
    -- the amount the Owner was quoted, and a reference the provider already used for this charge answers false and writes nothing.
    create function app_private.confirm_subscription_charge(
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
      if p_provider is null or p_provider not in ('simulado', 'asaas') or p_provider_ref is null or pg_catalog.btrim(p_provider_ref) = '' then
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
      if v_charge.status <> 'pending' or v_charge.expires_at <= pg_catalog.now() then
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
    revoke all on function app_private.confirm_subscription_charge(uuid, text, text, integer) from public;
    grant execute on function app_private.confirm_subscription_charge(uuid, text, text, integer) to ageniza_app;

    create function app_private.cancel_subscription(p_agency_id uuid)
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
    revoke all on function app_private.cancel_subscription(uuid) from public;
    grant execute on function app_private.cancel_subscription(uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- What the next period costs: the scheduled terms when they still fit the usage, the current ones otherwise. Null when
    -- the subscription does not renew now. A courtesy plan has no end (agency_subscriptions_period_check), so the comparison with
    -- the end is never true for it and it never renews.
    create function app_private.next_renewal_terms(p_agency_id uuid)
    returns table (plan_key text, extra_clients integer, extra_storage_gib integer, scheduled_applies boolean)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        case when fits.ok then coalesce(subscription.pending_plan_key, subscription.plan_key) else subscription.plan_key end,
        case when fits.ok then coalesce(subscription.pending_extra_clients, subscription.extra_clients) else subscription.extra_clients end,
        case when fits.ok then coalesce(subscription.pending_extra_storage_gib, subscription.extra_storage_gib) else subscription.extra_storage_gib end,
        fits.ok and subscription.pending_plan_key is not null
      from public.agency_subscriptions subscription
      join public.agencies agency on agency.id = subscription.agency_id and agency.plan = 'ativo' and agency.status = 'active'
      cross join lateral (
        select subscription.pending_plan_key is null
          or ((select pg_catalog.count(*) from public.clients client where client.agency_id = subscription.agency_id and client.status = 'active')
                <= app_private.subscription_client_limit(subscription.pending_plan_key, subscription.pending_extra_clients)
              and app_private.agency_storage_used_bytes(subscription.agency_id)
                <= app_private.subscription_storage_bytes(subscription.pending_plan_key, subscription.pending_extra_storage_gib)) as ok
      ) fits
      where subscription.agency_id = p_agency_id
        and not subscription.cancel_at_period_end
        and subscription.current_period_end <= pg_catalog.now() + interval '1 day'
    $function$;
    revoke all on function app_private.next_renewal_terms(uuid) from public;

    create function app_private.next_renewal_cents(p_agency_id uuid)
    returns integer
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select app_private.subscription_monthly_cents(terms.plan_key, terms.extra_clients, terms.extra_storage_gib)
      from app_private.next_renewal_terms(p_agency_id) terms
      where app_private.current_user_id() is null or app_private.is_agency_member(p_agency_id)
    $function$;
    revoke all on function app_private.next_renewal_cents(uuid) from public;
    grant execute on function app_private.next_renewal_cents(uuid) to ageniza_app;

    -- The agencies the worker has to renew: the period ends within a day, and nothing cancels it (a courtesy plan has no end).
    create function app_private.agencies_due_for_renewal(p_limit integer)
    returns setof uuid
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select subscription.agency_id
      from public.agency_subscriptions subscription
      join public.agencies agency on agency.id = subscription.agency_id and agency.plan = 'ativo' and agency.status = 'active'
      where app_private.current_user_id() is null
        and not subscription.cancel_at_period_end
        and subscription.current_period_end <= pg_catalog.now() + interval '1 day'
      order by subscription.current_period_end
      limit least(greatest(p_limit, 0), 500)
    $function$;
    revoke all on function app_private.agencies_due_for_renewal(integer) from public;
    grant execute on function app_private.agencies_due_for_renewal(integer) to ageniza_app;

    -- The provider charged the next period. The new period starts where the old one ended, or now when the renewal comes after the
    -- window the agency keeps writing in (the days before it are paid, the days after it were read-only).
    create function app_private.renew_subscription(p_agency_id uuid, p_provider text, p_provider_ref text, p_charged_cents integer)
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
      if p_provider is null or p_provider not in ('simulado', 'asaas') or p_provider_ref is null or pg_catalog.btrim(p_provider_ref) = '' then
        raise exception using errcode = 'A0114', message = 'The confirmation names no provider or no reference.';
      end if;
      perform app_private.lock_subscription_change(p_agency_id);
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
    revoke all on function app_private.renew_subscription(uuid, text, text, integer) from public;
    grant execute on function app_private.renew_subscription(uuid, text, text, integer) to ageniza_app;

    -- Development only, and only for a subscription of the simulated provider: moves the period back so it ends now; once it ended
    -- (and the subscription was not canceled), moves it back again so the window the agency keeps writing in ends now.
    create function app_private.advance_simulated_period(p_agency_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_subscription public.agency_subscriptions;
      v_shift interval;
    begin
      perform app_private.require_subscription_owner(p_agency_id);
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
      select * into v_subscription from public.agency_subscriptions subscription where subscription.agency_id = p_agency_id;
      if not found or v_subscription.provider <> 'simulado' then
        raise exception using errcode = 'A0110', message = 'Only a simulated subscription moves its period.';
      end if;
      v_shift := v_subscription.current_period_end - pg_catalog.now();
      if v_shift <= interval '0' then
        if v_subscription.cancel_at_period_end or v_subscription.current_period_end + app_private.payment_grace_period() <= pg_catalog.now() then
          return;
        end if;
        v_shift := v_subscription.current_period_end + app_private.payment_grace_period() - pg_catalog.now();
      end if;
      update public.agency_subscriptions
      set current_period_start = current_period_start - v_shift, current_period_end = current_period_end - v_shift, updated_at = pg_catalog.now()
      where agency_id = p_agency_id;
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('subscription.simulated_period_ended', app_private.current_user_id(), p_agency_id, 'agency', p_agency_id);
    end;
    $function$;
    revoke all on function app_private.advance_simulated_period(uuid) from public;
    grant execute on function app_private.advance_simulated_period(uuid) to ageniza_app;

    -- What the screen shows, priced by the one place that prices: the cost of the period and of the next, the ceilings and the
    -- usage. Every member of the agency reads it.
    create function app_private.subscription_overview(p_agency_id uuid)
    returns table (
      monthly_cents integer, next_monthly_cents integer, client_limit integer, storage_bytes bigint, used_clients bigint, used_bytes bigint,
      grace_ends_on date
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        case when subscription.provider = 'cortesia' then 0
             else app_private.subscription_monthly_cents(subscription.plan_key, subscription.extra_clients, subscription.extra_storage_gib) end,
        case when subscription.provider = 'cortesia' or subscription.cancel_at_period_end then null
             else app_private.subscription_monthly_cents(
               coalesce(subscription.pending_plan_key, subscription.plan_key),
               coalesce(subscription.pending_extra_clients, subscription.extra_clients),
               coalesce(subscription.pending_extra_storage_gib, subscription.extra_storage_gib)) end,
        app_private.subscription_client_limit(subscription.plan_key, subscription.extra_clients),
        app_private.subscription_storage_bytes(subscription.plan_key, subscription.extra_storage_gib),
        (select pg_catalog.count(*) from public.clients client where client.agency_id = subscription.agency_id and client.status = 'active'),
        app_private.agency_storage_used_bytes(subscription.agency_id),
        -- The last day to pay, in the day of São Paulo; null unless the period ended and the agency still writes in the window (a
        -- courtesy has no end, so it never has one).
        case when not subscription.cancel_at_period_end
                  and subscription.current_period_end <= pg_catalog.now()
                  and subscription.current_period_end + app_private.payment_grace_period() > pg_catalog.now()
             then app_private.sao_paulo_date(subscription.current_period_end + app_private.payment_grace_period()) end
      from public.agency_subscriptions subscription
      where subscription.agency_id = p_agency_id and app_private.is_agency_member(p_agency_id)
    $function$;
    revoke all on function app_private.subscription_overview(uuid) from public;
    grant execute on function app_private.subscription_overview(uuid) to ageniza_app;

  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
