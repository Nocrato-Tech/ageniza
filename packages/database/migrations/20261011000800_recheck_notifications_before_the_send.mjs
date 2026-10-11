// Issue #260 (the worker that sends the e-mail of Conteúdo). Forward-only, like every migration here.
//
// Structural, in the small: docs/business/decisions/2026-10-11-a-fila-reconfere-o-item-logo-antes-do-envio.md. The queue of
// 20261011000100 (#252/#407) discards what stopped being true only when a worker CLAIMS, and a claim is a lease of 10 minutes that nothing
// touches. A client archived, an agency suspended or a person removed from the portal AFTER the claim and BEFORE the e-mail leaves
// was therefore still sent, and the worker, which is `ageniza_app` with no actor and so sees no row of `clients`,
// `client_memberships` or `agencies`, has no other way to ask. This migration gives it one, and adds nothing else:
//
//  - `app_private.notification_item_still_holds(type, client, recipient, content)` is the ONE rule of "this item is still true" (the client
//    is active, the agency is active, the person has an active link to the client and the content is in the state of the type). The
//    discard of the claim carried a copy of it inline; it now calls this, and so does the recheck, so the two can never disagree. It is
//    internal: closed to PUBLIC and to the application role, like `notification_group_ready`.
//  - `claim_notification_batch` is replaced by the same function with the discard swapped for that call, and nothing else changed (same
//    signature, same columns, same grants, which `create or replace` keeps).
//  - `recheck_notifications(items, token)` is for the worker, right before it sends. For the items that still carry the token of its claim,
//    inside the lease, it takes their clients FOR SHARE (in key order), which waits for an archive in flight and then reads the committed
//    state; discards the ones that stopped being true; and returns the ones that hold, with what the e-mail needs, so the worker sends
//    only what comes back. Like its three sisters it refuses a caller with an actor bound (42501) and any isolation other than READ
//    COMMITTED (40001): it locks and reads again. An item whose lease ran out, or that another claim holds under another token, is
//    neither returned nor discarded: that worker must not send it, and the next claim judges it. The lock lasts until the
//    transaction of the recheck ends, so the worker rechecks in a transaction of its own, never around the send. What stays is the
//    time of the send itself, which is the inherent window of an asynchronous e-mail.
//
// Error codes: none new.

const MAX_ATTEMPTS = 5;
const LEASE = '10 minutes';

export async function up(knex) {
  await knex.raw(`
    create function app_private.notification_item_still_holds(
      p_type text, p_client_id uuid, p_recipient_user_id uuid, p_content_id uuid
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
        join public.client_memberships membership on membership.client_id = client.id
        where content.id = p_content_id
          and content.client_id = p_client_id
          and membership.user_id = p_recipient_user_id
          and membership.status = 'active'
          and client.status = 'active'
          and agency.status = 'active'
          and content.status = case p_type
            when 'content_awaiting_approval' then 'awaiting_approval'
            when 'content_published' then 'published'
          end
      )
    $function$;
    revoke all on function app_private.notification_item_still_holds(text, uuid, uuid, uuid) from public;
  `);

  await knex.raw(`
    create or replace function app_private.claim_notification_batch(p_limit integer)
    returns table (
      item_id uuid,
      claim_token uuid,
      notification_type text,
      client_id uuid,
      client_name text,
      agency_name text,
      recipient_user_id uuid,
      recipient_email text,
      content_id uuid,
      content_title text,
      content_publish_on date
    )
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
          and not app_private.notification_item_still_holds(candidate.type, candidate.client_id, candidate.recipient_user_id, candidate.content_id)
        for update skip locked
      );

      -- One group at a time, and only the groups nobody else is claiming: the lock of the group is held to the end of the transaction,
      -- so a second worker cannot claim part of a group whose first claim it cannot see yet. Whether the group is ready is asked in the
      -- statement that claims, after the lock, so it sees what the previous holder of the lock committed.
      for v_group in
        select item.recipient_user_id, item.client_id, item.type
        from public.notification_queue item
        where item.sent_at is null
          and item.discarded_at is null
          and item.send_after <= pg_catalog.now()
          and (item.claimed_at is null or item.claimed_at < pg_catalog.now() - interval '${LEASE}')
          and item.attempts < ${MAX_ATTEMPTS}
        group by item.recipient_user_id, item.client_id, item.type
        order by min(item.send_after), item.recipient_user_id, item.client_id, item.type
      loop
        exit when v_claimed >= p_limit;
        continue when not pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended('notification_queue:' || v_group.recipient_user_id::text || ':' || v_group.client_id::text || ':' || v_group.type, 0)
        );

        update public.notification_queue item
        set claimed_at = pg_catalog.now(), claim_token = v_token, attempts = item.attempts + 1
        where item.id in (
          select due.id
          from public.notification_queue due
          where due.recipient_user_id = v_group.recipient_user_id and due.client_id = v_group.client_id and due.type = v_group.type
            and due.sent_at is null
            and due.discarded_at is null
            and due.send_after <= pg_catalog.now()
            and (due.claimed_at is null or due.claimed_at < pg_catalog.now() - interval '${LEASE}')
            and due.attempts < ${MAX_ATTEMPTS}
          for update skip locked
        )
        and app_private.notification_group_ready(v_group.recipient_user_id, v_group.client_id, v_group.type);
        get diagnostics v_rows = row_count;
        if v_rows > 0 then
          v_claimed := v_claimed + 1;
        end if;
      end loop;

      -- The statuses were checked by the discard above, in this same call: a removal that commits between the two statements is
      -- seen by the next claim, and by no one sooner than the e-mail itself could be stopped.
      return query
      select item.id, item.claim_token, item.type, item.client_id, client.name, agency.name, item.recipient_user_id, person.email,
             item.content_id, content.title, content.publish_on
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join auth."user" person on person.id = item.recipient_user_id
      where item.claim_token = v_token
      order by item.recipient_user_id, item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;
    revoke all on function app_private.claim_notification_batch(integer) from public;
    grant execute on function app_private.claim_notification_batch(integer) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.recheck_notifications(p_item_ids uuid[], p_claim_token uuid)
    returns table (
      item_id uuid,
      claim_token uuid,
      notification_type text,
      client_id uuid,
      client_name text,
      agency_name text,
      recipient_user_id uuid,
      recipient_email text,
      content_id uuid,
      content_title text,
      content_publish_on date
    )
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    #variable_conflict use_column
    declare
      v_item_ids uuid[] := coalesce(p_item_ids, '{}'::uuid[]);
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

      update public.notification_queue item
      set discarded_at = pg_catalog.now()
      where item.id in (
        select candidate.id
        from public.notification_queue candidate
        where candidate.id = any(v_item_ids)
          and candidate.claim_token = p_claim_token
          and candidate.sent_at is null
          and candidate.discarded_at is null
          and candidate.claimed_at >= pg_catalog.now() - interval '${LEASE}'
          and not app_private.notification_item_still_holds(candidate.type, candidate.client_id, candidate.recipient_user_id, candidate.content_id)
        for update
      );

      return query
      select item.id, item.claim_token, item.type, item.client_id, client.name, agency.name, item.recipient_user_id, person.email,
             item.content_id, content.title, content.publish_on
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join auth."user" person on person.id = item.recipient_user_id
      where item.id = any(v_item_ids)
        and item.claim_token = p_claim_token
        and item.sent_at is null
        and item.discarded_at is null
        and item.claimed_at >= pg_catalog.now() - interval '${LEASE}'
        and app_private.notification_item_still_holds(item.type, item.client_id, item.recipient_user_id, item.content_id)
      order by item.recipient_user_id, item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;
    revoke all on function app_private.recheck_notifications(uuid[], uuid) from public;
    grant execute on function app_private.recheck_notifications(uuid[], uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
