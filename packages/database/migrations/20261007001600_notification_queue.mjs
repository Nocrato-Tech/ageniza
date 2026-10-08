// Issue #252. Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-10-01-conteudo-impacto-estrutural.md (point 7, "Fila de notificação") and, for what
// the SPEC leaves open, the four decisions of 2026-10-08 on the queue. specs/conteudo.md §5 rule 8 and §8. It adds one table, one
// trigger on `contents` and the functions below; the worker that sends (#260) and the routes that move a content (#256) are not here.
//
// `notification_queue` is the first notification mechanism, and the next types reuse it. One row is one e-mail owed to ONE person
// about ONE thing: type, client, recipient (a user), reference (the content, for the two types of Conteúdo) and the moment the item
// may go out (`send_after`, the opening of its grouping window). The worker reads rows of the same recipient, client and type as ONE
// message.
//
//  - `ageniza_app` has no privilege at all on the table, and the table has RLS forced with NO policy, two belts that each deny on
//    their own. The state of an item (`claimed_at`, `attempts`, `last_error`, `sent_at`, `discarded_at`) is therefore written only by
//    the functions below, and a person of the portal or of the agency can neither read the list of e-mail addresses nor write a row.
//  - Who enqueues is the database, never a route: `contents_enqueue_notification` is an AFTER UPDATE trigger on `contents`, a
//    `security definer` one (it writes a table the caller cannot), that fires when a content MOVES to "awaiting approval" (also when the
//    database itself returns an approved content there, rule 6: the trigger is not "UPDATE OF status", because a column-list trigger
//    ignores a column a BEFORE trigger changes) or to "published". Nothing else enqueues, and no function that enqueues is granted.
//  - The recipients are the ACTIVE links of the portal of that client (`client_memberships`), never a bare `auth."user"`. A client
//    that is archived or an agency that is suspended enqueues nothing (rule 8). The trigger takes the client FOR SHARE, like every
//    writer of the client, so it waits for an archive in flight; and the queue is a child of the client, so it has the AFTER INSERT
//    lock of 20261007001400 as well, which refuses (A0020) a row for a client that is not active.
//  - The worker reads and marks through three functions, granted to `ageniza_app` (the worker connects as the API does, with no
//    user). They refuse a caller that has an actor bound to the transaction (42501): every request of the API binds one, the worker
//    never does, so the list of addresses is not something a request can ask for. They refuse any isolation other than READ COMMITTED
//    (40001, via `require_read_committed` of 20261007001500), because they lock rows and read again.
//      claim_notification_batch(limit)   discards what stopped being true, then claims the items whose groups are ready and returns
//                                        what an e-mail needs (address, names, content title and date): the worker has no other
//                                        way to read them, RLS gives it no row.
//      mark_notifications_sent(ids)      the e-mail left: stamps `sent_at` on what is claimed.
//      fail_notifications(ids, code)     the e-mail did not leave: releases the claim and pushes the item back. The code is a machine
//                                        token, never the text of the provider, which carries addresses.
//  - When an item goes out. "Contents to approve" are DEBOUNCED: an item is due 15 minutes after its content was sent for approval,
//    and the e-mail of a recipient, client and type leaves only when no other open item of that group is still inside its 15
//    minutes, so a burst of sends is ONE e-mail, 15 minutes after the LAST send, and nothing leaves at once. A burst is not postponed
//    for ever: once the oldest open item of the group is 60 minutes old, what is due leaves (the rest opens the next window). The
//    summary of "published" is not debounced: its items are due when the day ends in Brasília. Never two e-mails of the same group in
//    flight. A claim is a lease of 10 minutes, after which another claim takes the item again; an item is tried 5 times. The numbers
//    live in this file, in `notification_send_after` and in `notification_max_wait` only.
//  - What stopped being true is discarded, not held: the client was archived, the agency suspended, the person was removed from the
//    portal, the content left "awaiting approval" (approved, or taken back) or left "published" (taken back the same day).
//
// Error codes: none new. A refused caller is 42501 and a wrong isolation is 40001; both only the worker meets.

const MAX_ATTEMPTS = 5;
const LEASE = '10 minutes';

export async function up(knex) {
  await knex.raw(`
    create table public.notification_queue (
      id uuid not null default gen_random_uuid() primary key,
      type text not null check (type in ('content_awaiting_approval', 'content_published')),
      client_id uuid not null references public.clients(id),
      recipient_user_id uuid not null references auth."user"(id),
      content_id uuid null,
      send_after timestamptz not null,
      created_at timestamptz not null default now(),
      claimed_at timestamptz null,
      attempts integer not null default 0 check (attempts >= 0),
      last_error text null check (last_error ~ '^[a-z0-9_.:-]{1,64}$'),
      sent_at timestamptz null,
      discarded_at timestamptz null,
      constraint notification_queue_content_fk foreign key (content_id, client_id)
        references public.contents (id, client_id) on delete cascade,
      constraint notification_queue_reference_check check (
        (type in ('content_awaiting_approval', 'content_published')) = (content_id is not null)
      ),
      constraint notification_queue_closed_once check (sent_at is null or discarded_at is null)
    );

    -- One open item per person and content and type: a content sent for approval, taken back and sent again before the e-mail goes
    -- is ONE line of that e-mail. Once the item is sent or discarded, the next cycle opens another.
    create unique index notification_queue_open_item_key
      on public.notification_queue (type, content_id, recipient_user_id)
      where sent_at is null and discarded_at is null;
    create index notification_queue_due_idx on public.notification_queue (send_after) where sent_at is null and discarded_at is null;
    create index notification_queue_content_idx on public.notification_queue (content_id, client_id);

    alter table public.notification_queue enable row level security;
    alter table public.notification_queue force row level security;
    -- The default privileges of this schema hand every new table to ageniza_app; this one is for the functions only.
    revoke all on public.notification_queue from ageniza_app;

    create trigger "0_notification_queue_lock_active_client"
      after insert on public.notification_queue
      for each row
      execute function app_private.lock_active_client_of_child();

    -- When an item opened at p_instant is due. "Contents to approve" are due 15 minutes later, and the claim waits for the group to be
    -- quiet for that long (debounce); the summary of "published" is due when the day of p_instant ends in Brasília, through the one
    -- function that reads that day.
    create function app_private.notification_send_after(p_type text, p_instant timestamptz)
    returns timestamptz
    language sql
    stable
    set search_path = ''
    as $function$
      select case p_type
        when 'content_published' then (app_private.sao_paulo_date(p_instant) + 1)::timestamp at time zone 'America/Sao_Paulo'
        else p_instant + interval '15 minutes'
      end
    $function$;
    revoke all on function app_private.notification_send_after(text, timestamptz) from public;

    -- How long a debounced group can be postponed by new items, counted from its oldest open item. Null: the type is not debounced.
    create function app_private.notification_max_wait(p_type text)
    returns interval
    language sql
    immutable
    set search_path = ''
    as $function$
      select case p_type when 'content_awaiting_approval' then interval '60 minutes' else null::interval end
    $function$;
    revoke all on function app_private.notification_max_wait(text) from public;
  `);

  await knex.raw(`
    create function app_private.contents_enqueue_notification()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_type text;
    begin
      -- The client is taken FOR SHARE, as every writer of it does, and read again after the wait: an archive in flight is waited for,
      -- and one that committed first leaves nothing to send. The agency must be active too (rule 8).
      perform 1
      from public.clients client
      join public.agencies agency on agency.id = client.agency_id
      where client.id = new.client_id and client.status = 'active' and agency.status = 'active'
      for share of client;
      if not found then
        return null;
      end if;

      v_type := case new.status when 'awaiting_approval' then 'content_awaiting_approval' else 'content_published' end;

      insert into public.notification_queue (type, client_id, recipient_user_id, content_id, send_after)
      select v_type, new.client_id, membership.user_id, new.id, app_private.notification_send_after(v_type, pg_catalog.now())
      from public.client_memberships membership
      where membership.client_id = new.client_id and membership.status = 'active'
      on conflict (type, content_id, recipient_user_id) where sent_at is null and discarded_at is null do nothing;

      return null;
    end;
    $function$;
    revoke all on function app_private.contents_enqueue_notification() from public;

    -- Not "UPDATE OF status": a trigger with a column list ignores a column that a BEFORE trigger changed, and the database moves an
    -- approved content back to "awaiting approval" by itself when the caption changes (rule 6).
    create trigger "9_contents_enqueue_notification"
      after update on public.contents
      for each row
      when (old.status is distinct from new.status and new.status in ('awaiting_approval', 'published'))
      execute function app_private.contents_enqueue_notification();
  `);

  await knex.raw(`
    create function app_private.claim_notification_batch(p_limit integer)
    returns table (
      item_id uuid,
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
      v_claimed uuid[];
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
          and not exists (
            select 1
            from public.contents content
            join public.clients client on client.id = content.client_id
            join public.agencies agency on agency.id = client.agency_id
            join public.client_memberships membership on membership.client_id = client.id
            where content.id = candidate.content_id
              and content.client_id = candidate.client_id
              and membership.user_id = candidate.recipient_user_id
              and membership.status = 'active'
              and client.status = 'active'
              and agency.status = 'active'
              and content.status = case candidate.type
                when 'content_awaiting_approval' then 'awaiting_approval'
                when 'content_published' then 'published'
              end
          )
        for update skip locked
      );

      with due as (
        select item.id, item.recipient_user_id, item.client_id, item.type, item.send_after
        from public.notification_queue item
        where item.sent_at is null
          and item.discarded_at is null
          and item.send_after <= pg_catalog.now()
          and (item.claimed_at is null or item.claimed_at < pg_catalog.now() - interval '${LEASE}')
          and item.attempts < ${MAX_ATTEMPTS}
        for update skip locked
      ),
      ready as (
        select due.recipient_user_id, due.client_id, due.type
        from due
        where (
            app_private.notification_max_wait(due.type) is null
            or not exists (
              select 1 from public.notification_queue other
              where other.recipient_user_id = due.recipient_user_id and other.client_id = due.client_id and other.type = due.type
                and other.sent_at is null and other.discarded_at is null
                and other.send_after > pg_catalog.now()
            )
            or exists (
              select 1 from public.notification_queue other
              where other.recipient_user_id = due.recipient_user_id and other.client_id = due.client_id and other.type = due.type
                and other.sent_at is null and other.discarded_at is null
                and other.attempts < ${MAX_ATTEMPTS}
                and other.created_at <= pg_catalog.now() - app_private.notification_max_wait(due.type)
            )
          )
          and not exists (
            select 1 from public.notification_queue other
            where other.recipient_user_id = due.recipient_user_id and other.client_id = due.client_id and other.type = due.type
              and other.sent_at is null and other.discarded_at is null
              and other.claimed_at >= pg_catalog.now() - interval '${LEASE}'
          )
        group by due.recipient_user_id, due.client_id, due.type
        order by min(due.send_after), due.recipient_user_id, due.client_id, due.type
        limit p_limit
      ),
      claimed as (
        update public.notification_queue item
        set claimed_at = pg_catalog.now(), attempts = item.attempts + 1
        from due
        join ready on ready.recipient_user_id = due.recipient_user_id and ready.client_id = due.client_id and ready.type = due.type
        where item.id = due.id
        returning item.id
      )
      select pg_catalog.array_agg(claimed.id) into v_claimed from claimed;

      -- The statuses were checked by the discard above, in this same call: a removal that commits between the two statements is
      -- seen by the next claim, and by no one sooner than the e-mail itself could be stopped.
      return query
      select item.id, item.type, item.client_id, client.name, agency.name, item.recipient_user_id, person.email,
             item.content_id, content.title, content.publish_on
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join public.client_memberships membership on membership.client_id = item.client_id and membership.user_id = item.recipient_user_id
      join auth."user" person on person.id = item.recipient_user_id
      where item.id = any(coalesce(v_claimed, '{}'::uuid[]))
      order by item.recipient_user_id, item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;
    revoke all on function app_private.claim_notification_batch(integer) from public;
    grant execute on function app_private.claim_notification_batch(integer) to ageniza_app;

    create function app_private.mark_notifications_sent(p_item_ids uuid[])
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_marked integer;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The notification queue is written by the worker, not by a request.';
      end if;

      -- Only what a claim holds: an item nobody claimed, or one already closed, is not stamped.
      update public.notification_queue item
      set sent_at = pg_catalog.now()
      where item.id = any(coalesce(p_item_ids, '{}'::uuid[]))
        and item.claimed_at is not null
        and item.sent_at is null
        and item.discarded_at is null;
      get diagnostics v_marked = row_count;
      return v_marked;
    end;
    $function$;
    revoke all on function app_private.mark_notifications_sent(uuid[]) from public;
    grant execute on function app_private.mark_notifications_sent(uuid[]) to ageniza_app;

    create function app_private.fail_notifications(p_item_ids uuid[], p_error_code text)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_failed integer;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The notification queue is written by the worker, not by a request.';
      end if;
      -- A token, never the text of a provider: that text carries the address the e-mail was sent to.
      if p_error_code is null or p_error_code !~ '^[a-z0-9_.:-]{1,64}$' then
        raise exception using errcode = '22023', message = 'The error is a code of up to 64 characters: lowercase letters, digits and _ . : -';
      end if;

      update public.notification_queue item
      set claimed_at = null,
          last_error = p_error_code,
          send_after = pg_catalog.now() + item.attempts * interval '5 minutes'
      where item.id = any(coalesce(p_item_ids, '{}'::uuid[]))
        and item.claimed_at is not null
        and item.sent_at is null
        and item.discarded_at is null;
      get diagnostics v_failed = row_count;
      return v_failed;
    end;
    $function$;
    revoke all on function app_private.fail_notifications(uuid[], text) from public;
    grant execute on function app_private.fail_notifications(uuid[], text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
