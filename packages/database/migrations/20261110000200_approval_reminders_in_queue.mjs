// Approval reminders in the notification queue (scope telas-melhorias, subtask S1). Forward-only, like every migration here.
//
// Structural: decision 2 of 2026-11-10, docs/business/decisions/2026-11-10-estrutural-*.md. It extends the queue of 20261011000100 and
// reads the rounds of 20261110000100. The e-mail and the job that calls the function are the worker's (S5), not here.
//
//  - Two new types, `content_approval_due_soon` (the eve of the deadline) and `content_approval_overdue` (the day after it). An item of
//    these types carries `approval_round_id`: the round it reminds of, which is also what "still true" is judged against.
//  - `enqueue_approval_reminders(p_at)` is the second writer of the queue (the first is the trigger of `contents`). It is for the worker
//    alone (an actor bound to the transaction is refused, 42501) and returns how many items it enqueued. Each reminder is owed once per
//    round: the UPDATE that stamps `reminded_due_soon_at` / `reminded_overdue_at` is the statement that feeds the INSERT, and its WHERE asks
//    for the stamp to be null, so a second run on the same day (or a second worker waiting on the same rows) enqueues nothing. The day is
//    the one of America/Sao_Paulo at `p_at`, and a reminder is for that exact day: a day the worker never ran is not made up for the next
//    one. The worker passes now(); the instant is a parameter for the tests to fix the day, as in `purge_unconfirmed_accounts`, and one
//    past now() plus a minute is refused (22023): it would look ahead and enqueue the reminder of a day that has not come.
//    "Due soon" is not enqueued for a round that was sent on the eve itself: the e-mail of the send already said so.
//  - Who is told and what stopped being true is the rule the queue already has, kept in ONE place: `notification_item_still_holds` (the
//    active accesses of the client, the client active, the agency active and not read-only, the content in the state of the type) now also
//    asks, for a reminder, that the round is the LATEST round of the content. The enqueue, the discard of the claim and the recheck all call
//    it. A resend after an adjustment opens a round that supersedes the previous one, so a reminder of the old one is dropped.
//  - The clients are taken FOR SHARE in key order before the statements, like the recheck: an archive in flight is waited for and the
//    statements then read what it committed.
//  - The claim and the recheck return, per item, `approval_due_on`, `approval_note` and `approval_batch_id` (null when there is none): the
//    round of the item for a reminder, the latest round of the content for "contents to approve", nothing for "published".
//  - `issue_portal_approval_link` accepts the reminder types, since their e-mail carries the link of approval too. `mark_notifications_sent`
//    and `fail_notifications` never looked at the type.
//
// Error codes: none new (42501 for a caller with an actor, 40001 for an isolation other than READ COMMITTED, 22023 for a missing instant or
// one in the future).

const DUE_SOON = 'content_approval_due_soon';
const OVERDUE = 'content_approval_overdue';
const REMINDERS = `('${DUE_SOON}', '${OVERDUE}')`;
const WITH_ROUND = `('content_awaiting_approval', '${DUE_SOON}', '${OVERDUE}')`;
const LEASE = '10 minutes';
const MAX_ATTEMPTS = 5;

export async function up(knex) {
  await knex.raw(`
    alter table public.notification_queue drop constraint notification_queue_type_check;
    alter table public.notification_queue add constraint notification_queue_type_check
      check (type in ('content_awaiting_approval', 'content_published', '${DUE_SOON}', '${OVERDUE}'));

    alter table public.notification_queue drop constraint notification_queue_reference_check;
    alter table public.notification_queue add constraint notification_queue_reference_check
      check ((type in ('content_awaiting_approval', 'content_published', '${DUE_SOON}', '${OVERDUE}')) = (content_id is not null));

    alter table public.notification_queue add column approval_round_id uuid null;
    alter table public.notification_queue add constraint notification_queue_round_fk
      foreign key (approval_round_id, content_id, client_id)
      references public.content_approval_rounds (id, content_id, client_id) on delete cascade;
    alter table public.notification_queue add constraint notification_queue_round_check
      check ((type in ${REMINDERS}) = (approval_round_id is not null));
    create index notification_queue_round_idx on public.notification_queue (approval_round_id) where approval_round_id is not null;
  `);

  await knex.raw(`
    -- When an item opened at p_instant is due. "Contents to approve" are due 15 minutes later, and the claim waits for the group to be
    -- quiet for that long (debounce); the summary of "published" is due when the day of p_instant ends in Brasília, through the one
    -- function that reads that day. The reminders are due at once: the day they are for is the job's, not the queue's.
    create or replace function app_private.notification_send_after(p_type text, p_instant timestamptz)
    returns timestamptz
    language sql
    stable
    set search_path = ''
    as $function$
      select case p_type
        -- The first whole UTC hour at which Brasília is on another day: its midnight is always one, and the day is asked of
        -- sao_paulo_date alone, as the catalog test of the client dates demands (no time zone of its own here).
        when 'content_published' then (
          select pg_catalog.min(hour)
          from pg_catalog.generate_series(
            pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from p_instant) / 3600) * 3600) + interval '1 hour',
            pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from p_instant) / 3600) * 3600) + interval '30 hours',
            interval '1 hour'
          ) as hour
          where app_private.sao_paulo_date(hour) > app_private.sao_paulo_date(p_instant)
        )
        when '${DUE_SOON}' then p_instant
        when '${OVERDUE}' then p_instant
        else p_instant + interval '15 minutes'
      end
    $function$;

    -- The one rule of "this item is still true". A reminder also needs its round to be the latest of the content.
    create function app_private.notification_item_still_holds(
      p_type text, p_client_id uuid, p_recipient_portal_access_id uuid, p_content_id uuid, p_approval_round_id uuid
    )
    returns boolean
    language sql
    stable
    set search_path = ''
    as $function$
      select exists (
        select 1
        from public.contents content
        join public.clients client on client.id = content.client_id
        join public.agencies agency on agency.id = client.agency_id
        join public.client_portal_accesses access on access.client_id = client.id
        where content.id = p_content_id
          and content.client_id = p_client_id
          and access.id = p_recipient_portal_access_id
          and access.status = 'active'
          and client.status = 'active'
          and agency.status = 'active'
          and app_private.agency_accepts_writes(agency.id)
          and content.status = case p_type
            when 'content_awaiting_approval' then 'awaiting_approval'
            when 'content_published' then 'published'
            when '${DUE_SOON}' then 'awaiting_approval'
            when '${OVERDUE}' then 'awaiting_approval'
          end
          and (
            p_type not in ${REMINDERS}
            or exists (
              select 1
              from public.content_approval_rounds round
              where round.id = p_approval_round_id
                and round.content_id = content.id
                and not exists (
                  select 1 from public.content_approval_rounds newer
                  where newer.content_id = round.content_id and newer.sequence > round.sequence
                )
            )
          )
      )
    $function$;
    revoke all on function app_private.notification_item_still_holds(text, uuid, uuid, uuid, uuid) from public;

    create or replace function app_private.notification_item_still_holds(
      p_type text, p_client_id uuid, p_recipient_portal_access_id uuid, p_content_id uuid
    )
    returns boolean
    language sql
    stable
    set search_path = ''
    as $function$
      select app_private.notification_item_still_holds(p_type, p_client_id, p_recipient_portal_access_id, p_content_id, null::uuid)
    $function$;

    -- The round an e-mail talks about: the one the item is bound to (a reminder), else the latest of the content ("contents to approve").
    create function app_private.notification_item_round(p_type text, p_content_id uuid, p_approval_round_id uuid)
    returns table (due_on date, note text, batch_id uuid)
    language sql
    stable
    set search_path = ''
    as $function$
      select round.due_on, round.note, round.batch_id
      from public.content_approval_rounds round
      where p_type in ${WITH_ROUND}
        and round.content_id = p_content_id
        and (p_approval_round_id is null or round.id = p_approval_round_id)
      order by round.sequence desc
      limit 1
    $function$;
    revoke all on function app_private.notification_item_round(text, uuid, uuid) from public;
  `);

  await knex.raw(`
    drop function app_private.claim_notification_batch(integer);
    drop function app_private.recheck_notifications(uuid[], uuid);

    create function app_private.claim_notification_batch(p_limit integer)
    returns table(item_id uuid, claim_token uuid, notification_type text, client_id uuid, client_name text, agency_name text,
                  recipient_portal_access_id uuid, recipient_email text, content_id uuid, content_title text, content_publish_on date,
                  approval_due_on date, approval_note text, approval_batch_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    #variable_conflict use_column
    declare
      v_token uuid := gen_random_uuid();
      v_group record;
      v_claimed integer := 0;
      v_rows integer;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The notification queue is read by the worker, not by a request.';
      end if;
      if p_limit is null or p_limit < 1 or p_limit > 100 then
        raise exception using errcode = '22023', message = 'The limit is a number of groups, from 1 to 100.';
      end if;

      -- What stopped being true is discarded, not held. A lease still running is not touched: someone is sending it. A row another
      -- worker holds is skipped, not waited for: that worker is discarding or claiming it.
      update public.notification_queue item
      set discarded_at = pg_catalog.now()
      where item.id in (
        select candidate.id
        from public.notification_queue candidate
        where candidate.sent_at is null
          and candidate.discarded_at is null
          and (candidate.claimed_at is null or candidate.claimed_at < pg_catalog.now() - interval '${LEASE}')
          and not app_private.notification_item_still_holds(
            candidate.type, candidate.client_id, candidate.recipient_portal_access_id, candidate.content_id, candidate.approval_round_id
          )
        for update skip locked
      );

      -- One group at a time, and only the groups nobody else is claiming: the lock of the group is held to the end of the transaction,
      -- so a second worker cannot claim part of a group whose first claim it cannot see yet. Whether the group is ready is asked in the
      -- statement that claims, after the lock, so it sees what the previous holder of the lock committed.
      for v_group in
        select app_private.notification_address(item.recipient_portal_access_id) as address, item.client_id, item.type
        from public.notification_queue item
        where item.sent_at is null
          and item.discarded_at is null
          and item.send_after <= pg_catalog.now()
          and (item.claimed_at is null or item.claimed_at < pg_catalog.now() - interval '${LEASE}')
          and item.attempts < ${MAX_ATTEMPTS}
        group by app_private.notification_address(item.recipient_portal_access_id), item.client_id, item.type
        order by min(item.send_after), app_private.notification_address(item.recipient_portal_access_id), item.client_id, item.type
      loop
        exit when v_claimed >= p_limit;
        continue when not pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended('notification_queue:' || v_group.address || ':' || v_group.client_id::text || ':' || v_group.type, 0)
        );

        update public.notification_queue item
        set claimed_at = pg_catalog.now(), claim_token = v_token, attempts = item.attempts + 1
        where item.id in (
          select due.id
          from public.notification_queue due
          where app_private.notification_address(due.recipient_portal_access_id) = v_group.address and due.client_id = v_group.client_id and due.type = v_group.type
            and due.sent_at is null
            and due.discarded_at is null
            and due.send_after <= pg_catalog.now()
            and (due.claimed_at is null or due.claimed_at < pg_catalog.now() - interval '${LEASE}')
            and due.attempts < ${MAX_ATTEMPTS}
          for update skip locked
        )
        and app_private.notification_group_ready(v_group.address, v_group.client_id, v_group.type);
        get diagnostics v_rows = row_count;
        if v_rows > 0 then
          v_claimed := v_claimed + 1;
        end if;
      end loop;

      -- The statuses were checked by the discard above, in this same call: a removal that commits between the two statements is
      -- seen by the next claim, and by no one sooner than the e-mail itself could be stopped. The address is the account's when
      -- the access has one, and the access's own when it has none.
      return query
      select item.id, item.claim_token, item.type, item.client_id, client.name, agency.name, item.recipient_portal_access_id,
             coalesce(person.email, access.email), item.content_id, content.title, content.publish_on,
             approval.due_on, approval.note, approval.batch_id
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join public.client_portal_accesses access on access.id = item.recipient_portal_access_id
      left join auth."user" person on person.id = access.user_id
      left join lateral app_private.notification_item_round(item.type, item.content_id, item.approval_round_id) approval on true
      where item.claim_token = v_token
      order by coalesce(person.email, access.email), item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;

    create function app_private.recheck_notifications(p_item_ids uuid[], p_claim_token uuid)
    returns table(item_id uuid, claim_token uuid, notification_type text, client_id uuid, client_name text, agency_name text,
                  recipient_portal_access_id uuid, recipient_email text, content_id uuid, content_title text, content_publish_on date,
                  approval_due_on date, approval_note text, approval_batch_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    #variable_conflict use_column
    declare
      v_item_ids uuid[] := coalesce(p_item_ids, '{}'::uuid[]);
      v_now timestamptz;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The notification queue is read by the worker, not by a request.';
      end if;

      -- The clients of the items this claim still holds, taken FOR SHARE in key order: an archive in flight holds its client, so this
      -- waits for it, and the statements below (each with a snapshot of its own, READ COMMITTED) then see what it committed.
      perform 1
      from public.clients client
      where client.id in (
        select held.client_id
        from public.notification_queue held
        where held.id = any(v_item_ids)
          and held.claim_token = p_claim_token
          and held.sent_at is null
          and held.discarded_at is null
      )
      order by client.id
      for share of client;

      -- The lease is measured here, after the wait above: now() is the start of the transaction, and an archive in flight can hold this
      -- call for longer than what is left of a lease, which would then be judged as if it still ran.
      v_now := pg_catalog.clock_timestamp();

      update public.notification_queue item
      set discarded_at = pg_catalog.now()
      where item.id in (
        select candidate.id
        from public.notification_queue candidate
        where candidate.id = any(v_item_ids)
          and candidate.claim_token = p_claim_token
          and candidate.sent_at is null
          and candidate.discarded_at is null
          and candidate.claimed_at >= v_now - interval '${LEASE}'
          and not app_private.notification_item_still_holds(
            candidate.type, candidate.client_id, candidate.recipient_portal_access_id, candidate.content_id, candidate.approval_round_id
          )
        for update
      );

      return query
      select item.id, item.claim_token, item.type, item.client_id, client.name, agency.name, item.recipient_portal_access_id,
             coalesce(person.email, access.email), item.content_id, content.title, content.publish_on,
             approval.due_on, approval.note, approval.batch_id
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join public.client_portal_accesses access on access.id = item.recipient_portal_access_id
      left join auth."user" person on person.id = access.user_id
      left join lateral app_private.notification_item_round(item.type, item.content_id, item.approval_round_id) approval on true
      where item.id = any(v_item_ids)
        and item.claim_token = p_claim_token
        and item.sent_at is null
        and item.discarded_at is null
        and item.claimed_at >= v_now - interval '${LEASE}'
        -- Not redundant with the discard above: each statement has a snapshot of its own, and the lock holds only the clients, so a suspension of
        -- the agency, a removal from the portal or a change of the content that commits between the two statements is seen only here.
        and app_private.notification_item_still_holds(item.type, item.client_id, item.recipient_portal_access_id, item.content_id, item.approval_round_id)
      order by coalesce(person.email, access.email), item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;

    revoke all on function app_private.claim_notification_batch(integer) from public;
    revoke all on function app_private.recheck_notifications(uuid[], uuid) from public;
    grant execute on function app_private.claim_notification_batch(integer) to ageniza_app;
    grant execute on function app_private.recheck_notifications(uuid[], uuid) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.enqueue_approval_reminders(p_at timestamptz)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_today date;
      v_rows integer;
      v_enqueued integer := 0;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval reminders are enqueued by the worker, not by a request.';
      end if;
      if p_at is null then
        raise exception using errcode = '22023', message = 'The reminders need the instant they are enqueued at.';
      end if;
      -- The instant is a parameter for the tests, never to look ahead: a minute is the skew tolerated between the caller and the database.
      if p_at > pg_catalog.now() + interval '1 minute' then
        raise exception using errcode = '22023', message = 'The reminders cannot be enqueued at an instant in the future.';
      end if;
      v_today := app_private.sao_paulo_date(p_at);

      -- The clients of the rounds that are due, taken FOR SHARE in key order before the statements: an archive in flight holds its client,
      -- so this waits for it, and the statements then see what it committed.
      perform 1
      from public.clients client
      where client.status = 'active'
        and client.id in (
          select round.client_id
          from public.content_approval_rounds round
          where (round.reminded_due_soon_at is null and round.due_on = v_today + 1)
             or (round.reminded_overdue_at is null and round.due_on = v_today - 1)
        )
      order by client.id
      for share of client;

      with due as (
        update public.content_approval_rounds round
        set reminded_due_soon_at = pg_catalog.now()
        where round.reminded_due_soon_at is null
          and round.due_on = v_today + 1
          and app_private.sao_paulo_date(round.sent_at) <> round.due_on - 1
        returning round.id, round.client_id, round.content_id
      )
      insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, approval_round_id, send_after)
      select '${DUE_SOON}', due.client_id, access.id, due.content_id, due.id, app_private.notification_send_after('${DUE_SOON}', pg_catalog.now())
      from due
      join public.client_portal_accesses access on access.client_id = due.client_id and access.status = 'active'
      where app_private.notification_item_still_holds('${DUE_SOON}', due.client_id, access.id, due.content_id, due.id)
      on conflict (type, content_id, recipient_portal_access_id) where sent_at is null and discarded_at is null
      do update set approval_round_id = excluded.approval_round_id, send_after = excluded.send_after, attempts = 0, last_error = null
      where public.notification_queue.claimed_at is null;
      get diagnostics v_rows = row_count;
      v_enqueued := v_enqueued + v_rows;

      with due as (
        update public.content_approval_rounds round
        set reminded_overdue_at = pg_catalog.now()
        where round.reminded_overdue_at is null
          and round.due_on = v_today - 1
        returning round.id, round.client_id, round.content_id
      )
      insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, approval_round_id, send_after)
      select '${OVERDUE}', due.client_id, access.id, due.content_id, due.id, app_private.notification_send_after('${OVERDUE}', pg_catalog.now())
      from due
      join public.client_portal_accesses access on access.client_id = due.client_id and access.status = 'active'
      where app_private.notification_item_still_holds('${OVERDUE}', due.client_id, access.id, due.content_id, due.id)
      on conflict (type, content_id, recipient_portal_access_id) where sent_at is null and discarded_at is null
      do update set approval_round_id = excluded.approval_round_id, send_after = excluded.send_after, attempts = 0, last_error = null
      where public.notification_queue.claimed_at is null;
      get diagnostics v_rows = row_count;
      v_enqueued := v_enqueued + v_rows;

      return v_enqueued;
    end;
    $function$;
    revoke all on function app_private.enqueue_approval_reminders(timestamptz) from public;
    grant execute on function app_private.enqueue_approval_reminders(timestamptz) to ageniza_app;
  `);

  await knex.raw(`
    -- The worker issues the link of an e-mail from the items it claimed: the items prove the e-mail exists (a claim token is a secret
    -- of the claim), and the link is tied to the contents of those items. A request has an actor and is refused; so is any call that
    -- cannot name a live claim. One e-mail, one mailbox: when two accesses of the client resolve to the same address, the e-mail
    -- carries one link, issued to the first of them by id.
    create or replace function app_private.issue_portal_approval_link(p_item_ids uuid[], p_claim_token uuid, p_token_hash text)
    returns timestamptz
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_item_ids uuid[] := coalesce(p_item_ids, '{}'::uuid[]);
      v_found integer;
      v_clients integer;
      v_addresses integer;
      v_access_id uuid;
      v_client_id uuid;
      v_agency_id uuid;
      v_generation integer;
      v_link_id uuid;
      v_now timestamptz;
      v_expires_at timestamptz;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval links are issued by the worker, not by a request.';
      end if;
      if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_claim_token is null or cardinality(v_item_ids) = 0 then
        raise exception using errcode = 'A0101', message = 'The items and the claim do not describe one e-mail.';
      end if;

      select pg_catalog.count(*), pg_catalog.count(distinct item.client_id),
             pg_catalog.count(distinct app_private.notification_address(item.recipient_portal_access_id)),
             (pg_catalog.array_agg(item.recipient_portal_access_id order by item.recipient_portal_access_id))[1],
             (pg_catalog.array_agg(item.client_id))[1]
      into v_found, v_clients, v_addresses, v_access_id, v_client_id
      from public.notification_queue item
      where item.id = any(v_item_ids)
        and item.claim_token = p_claim_token
        and item.type in ${WITH_ROUND}
        and item.sent_at is null
        and item.discarded_at is null
        and item.claimed_at >= pg_catalog.clock_timestamp() - interval '${LEASE}';
      if v_found <> (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_item_ids) as id) or v_clients <> 1 or v_addresses <> 1 then
        raise exception using errcode = 'A0101', message = 'The items and the claim do not describe one e-mail.';
      end if;

      -- The locks of the removal and the archive, in their order, and the judgment after them.
      perform 1 from public.client_portal_accesses access where access.id = v_access_id for share;
      perform 1 from public.clients client where client.id = v_client_id for share;
      select client.agency_id, access.generation into v_agency_id, v_generation
      from public.client_portal_accesses access
      join public.clients client on client.id = access.client_id
      join public.agencies agency on agency.id = client.agency_id
      where access.id = v_access_id and access.client_id = v_client_id
        and access.status = 'active' and client.status = 'active' and agency.status = 'active';
      if not found then
        raise exception using errcode = 'A0101', message = 'The items and the claim do not describe one e-mail.';
      end if;
      if not app_private.agency_accepts_writes(v_agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;

      v_now := pg_catalog.clock_timestamp();
      v_expires_at := v_now + interval '7 days';
      insert into public.client_portal_approval_links (portal_access_id, client_id, generation, token_hash, expires_at, created_at)
      values (v_access_id, v_client_id, v_generation, p_token_hash, v_expires_at, v_now)
      returning id into v_link_id;

      insert into public.client_portal_approval_link_contents (link_id, content_id, client_id)
      select distinct v_link_id, item.content_id, item.client_id
      from public.notification_queue item
      where item.id = any(v_item_ids) and item.claim_token = p_claim_token;

      return v_expires_at;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
