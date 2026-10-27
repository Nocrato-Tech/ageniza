// What a person of the portal writes, and who the notification goes to, can be an access with no account (issue #711).
// Structural: docs/business/decisions/2026-10-26-estrutural-o-acesso-ao-portal-e-por-e-mail-e-a-conta-e-opcional.md, Consequência.
//
// - contents.approved_by_portal_access_id: at most one approver, and an approved content has one.
// - client_thread_comments.author_portal_access_id: exactly one author, an access only on the client's side.
// - notification_queue.recipient_portal_access_id: the portal recipient is ALWAYS the access, with or without an account; the
//   account (when there is one) comes from the access, so recipient_user_id goes away. The open-item key and the 15-minute
//   window are per access, and what was queued before the link groups with what comes after it.
//
// Nothing here lets a request write an access as an author: ageniza_app has no INSERT or UPDATE grant on the new columns, and the
// insert policy of the comments still compares author_user_id with the bound actor. The function that sets the access as the
// author in the transaction is the approval link's (#712), which also teaches contents_guard to take it.

export async function up(knex) {
  // contents ---------------------------------------------------------------------------------------------------------------
  await knex.raw(`
    alter table public.contents add column approved_by_portal_access_id uuid;
    alter table public.contents
      add constraint contents_approved_by_portal_access_fkey
      foreign key (approved_by_portal_access_id, client_id) references public.client_portal_accesses (id, client_id);

    alter table public.contents drop constraint contents_state_shape;
    alter table public.contents add constraint contents_state_shape check (
      ((status = any (array['approved', 'published'])) = (approved_by is not null or approved_by_portal_access_id is not null))
      and (approved_by is null or approved_by_portal_access_id is null)
      and ((approved_by is null and approved_by_portal_access_id is null) = (approved_at is null))
      and (approved_by_agency_reason is null or approved_by is not null)
      and ((status = 'published') = (published_on is not null))
      and ((published_on is null) = (published_at is null))
      and ((status = 'cancelled') = (cancelled_at is not null))
    );

    grant select (approved_by_portal_access_id) on public.contents to ageniza_app;
  `);

  await knex.raw(`
    create or replace function app_private.contents_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
      v_category text;
      v_status text;
      v_removed_at timestamptz;
    begin
      if new.cover_asset_id is not null and (tg_op = 'INSERT' or new.cover_asset_id is distinct from old.cover_asset_id) then
        select asset.category, asset.status, asset.removed_at into v_category, v_status, v_removed_at
        from public.media_assets asset
        where asset.id = new.cover_asset_id;
        -- A cover that is not found is left to the policy and the foreign key.
        if found and (v_category <> 'image' or v_status <> 'confirmed' or v_removed_at is not null) then
          raise exception using
            errcode = 'A0069',
            message = 'The cover of a content is a confirmed image that was not removed.';
        end if;
      end if;

      if tg_op = 'INSERT' then
        return new;
      end if;

      if (new.id, new.client_id, new.platform, new.created_at) is distinct from (old.id, old.client_id, old.platform, old.created_at) then
        raise exception using
          errcode = '42501',
          message = 'The identity of a content never changes.';
      end if;

      if new.status is distinct from old.status then
        if (old.status, new.status) not in (
          ('in_production', 'awaiting_approval'), ('adjusting', 'awaiting_approval'), ('approved', 'awaiting_approval'),
          ('awaiting_approval', 'approved'), ('awaiting_approval', 'adjusting'),
          ('approved', 'published'), ('published', 'approved'),
          ('in_production', 'cancelled'), ('awaiting_approval', 'cancelled'), ('adjusting', 'cancelled'), ('approved', 'cancelled'),
          ('cancelled', 'in_production')
        ) then
          raise exception using
            errcode = '42501',
            message = 'A content only moves along the transitions of its life cycle.';
        end if;

        if (new.title, new.format, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id)
          is distinct from (old.title, old.format, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id)
          or (new.publish_on is distinct from old.publish_on and not (old.status = 'cancelled' and new.status = 'in_production'))
        then
          raise exception using
            errcode = '42501',
            message = 'A change of state carries no other change.';
        end if;

        if new.status = 'awaiting_approval' then
          new.approved_by := null;
          new.approved_by_portal_access_id := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'approved' and old.status = 'awaiting_approval' then
          -- Fixed here, from the actor bound in this transaction: no caller chooses who approved or when.
          new.approved_by := app_private.current_user_id();
          new.approved_by_portal_access_id := null;
          new.approved_at := pg_catalog.now();
          if new.approved_by is null then
            raise exception using
              errcode = '42501',
              message = 'A content is approved by a person.';
          end if;
        elsif new.status = 'approved' then
          if old.published_at is null or app_private.sao_paulo_date(old.published_at) <> v_today then
            raise exception using
              errcode = 'A0064',
              message = 'A publication is undone only on the day it was made.';
          end if;
          new.approved_by := old.approved_by;
          new.approved_by_portal_access_id := old.approved_by_portal_access_id;
          new.approved_at := old.approved_at;
          new.approved_by_agency_reason := old.approved_by_agency_reason;
          new.published_on := null;
          new.published_at := null;
        elsif new.status = 'published' then
          if new.published_on is null or new.published_on > v_today then
            raise exception using
              errcode = 'A0067',
              message = 'The real date of a publication is today or before, in America/Sao_Paulo.';
          end if;
          new.published_at := pg_catalog.now();
        elsif new.status = 'cancelled' then
          new.cancelled_at := pg_catalog.now();
          new.approved_by := null;
          new.approved_by_portal_access_id := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'in_production' then
          new.cancelled_at := null;
        end if;
      else
        if (new.approved_by, new.approved_by_portal_access_id, new.approved_at, new.approved_by_agency_reason, new.published_on, new.published_at, new.cancelled_at)
          is distinct from (old.approved_by, old.approved_by_portal_access_id, old.approved_at, old.approved_by_agency_reason, old.published_on, old.published_at, old.cancelled_at)
        then
          raise exception using
            errcode = '42501',
            message = 'Who approved, who published and who cancelled a content, and when, is written with the state.';
        end if;

        if old.status in ('published', 'cancelled') and (
          new.title, new.format, new.publish_on, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id
        ) is distinct from (
          old.title, old.format, old.publish_on, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id
        ) then
          raise exception using
            errcode = 'A0062',
            message = 'A published or cancelled content is no longer edited.';
        end if;

        if new.caption is distinct from old.caption
          or new.cover_asset_id is distinct from old.cover_asset_id
          or new.format is distinct from old.format
        then
          new.revision := old.revision + 1;
          if old.status = 'approved' then
            new.status := 'awaiting_approval';
            new.approved_by := null;
            new.approved_by_portal_access_id := null;
            new.approved_at := null;
            new.approved_by_agency_reason := null;
          end if;
        end if;
      end if;

      return new;
    end;
    $function$;
  `);

  // The name that shows who approved or wrote when it was an access: the account's once it is linked, the address before. A function,
  // because the table of accesses is read by who has `cliente.convidar_usuario` and the reader of a content is not always that person.
  await knex.raw(`
    create function app_private.portal_access_label(p_access_id uuid, p_client_id uuid)
    returns text
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select coalesce(member.name, access.email)
      from public.client_portal_accesses access
      left join auth."user" member on member.id = access.user_id
      where access.id = p_access_id
        and access.client_id = p_client_id
        and (
          app_private.has_agency_permission(app_private.client_agency_id(p_client_id), 'conteudo.visualizar')
          or app_private.is_client_member(p_client_id)
        )
    $function$;

    revoke all on function app_private.portal_access_label(uuid, uuid) from public;
    grant execute on function app_private.portal_access_label(uuid, uuid) to ageniza_app;
  `);

  // client_thread_comments -------------------------------------------------------------------------------------------------
  await knex.raw(`
    alter table public.client_thread_comments add column author_portal_access_id uuid;
    alter table public.client_thread_comments alter column author_user_id drop not null;
    alter table public.client_thread_comments
      add constraint client_thread_comments_author_portal_access_fkey
      foreign key (author_portal_access_id, client_id) references public.client_portal_accesses (id, client_id);
    -- Exactly one author, and an access writes only on the client's side.
    alter table public.client_thread_comments add constraint client_thread_comments_one_author_check
      check ((author_user_id is not null) <> (author_portal_access_id is not null));
    alter table public.client_thread_comments add constraint client_thread_comments_access_is_client_side_check
      check (author_portal_access_id is null or author_side = 'client');

    grant select (author_portal_access_id) on public.client_thread_comments to ageniza_app;
  `);

  await knex.raw(`
    drop function app_private.thread_comment_authors(uuid);

    -- The author of a comment is a person with an account (the name and photo of the link) or an access with none (its address).
    create function app_private.thread_comment_authors(p_thread_id uuid)
    returns table(author_user_id uuid, author_portal_access_id uuid, author_side text, name text, photo_key text)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      with readable_thread as (
        select thread.id, thread.client_id, thread.resolved_by
        from public.client_threads thread
        where thread.id = p_thread_id
          and (
            (thread.content_id is null and app_private.is_agency_member(app_private.client_agency_id(thread.client_id)))
            or (
              thread.content_id is not null
              and app_private.has_agency_permission(app_private.client_agency_id(thread.client_id), 'conteudo.visualizar')
            )
            or (
              app_private.is_client_member(thread.client_id)
              and (
                (
                  thread.content_id is null
                  and (
                    thread.persona_id is null
                    or exists (
                      select 1 from public.client_personas persona
                      where persona.id = thread.persona_id and persona.status = 'active'
                    )
                  )
                )
                or (thread.content_id is not null and app_private.content_open_to_client(thread.content_id))
              )
            )
          )
      ),
      authors as (
        select comment.author_user_id, comment.author_portal_access_id, comment.author_side, readable_thread.client_id
        from readable_thread
        join public.client_thread_comments comment on comment.thread_id = readable_thread.id
        union
        -- Only the agency resolves (rule 9), so the resolver is read through the agency link.
        select readable_thread.resolved_by, null::uuid, 'agency'::text, readable_thread.client_id
        from readable_thread
        where readable_thread.resolved_by is not null
      )
      select authors.author_user_id, null::uuid, authors.author_side, member.name, member.image
      from authors
      join public.agency_memberships link
        on authors.author_side = 'agency'
       and link.user_id = authors.author_user_id
       and link.agency_id = app_private.client_agency_id(authors.client_id)
      join auth."user" member on member.id = link.user_id
      union all
      select authors.author_user_id, null::uuid, authors.author_side, member.name, member.image
      from authors
      join public.client_memberships link
        on authors.author_side = 'client'
       and link.user_id = authors.author_user_id
       and link.client_id = authors.client_id
      join auth."user" member on member.id = link.user_id
      union all
      -- An access author shows the name of the account linked to it, or its address when nobody has entered yet.
      select null::uuid, authors.author_portal_access_id, authors.author_side, coalesce(member.name, access.email), member.image
      from authors
      join public.client_portal_accesses access
        on authors.author_portal_access_id = access.id
       and access.client_id = authors.client_id
      left join auth."user" member on member.id = access.user_id
    $function$;

    revoke all on function app_private.thread_comment_authors(uuid) from public;
    grant execute on function app_private.thread_comment_authors(uuid) to ageniza_app;
  `);

  // notification_queue -----------------------------------------------------------------------------------------------------
  await knex.raw(`
    alter table public.notification_queue add column recipient_portal_access_id uuid;

    update public.notification_queue item
    set recipient_portal_access_id = access.id
    from public.client_portal_accesses access
    where access.client_id = item.client_id and access.user_id = item.recipient_user_id;

    alter table public.notification_queue alter column recipient_portal_access_id set not null;
    alter table public.notification_queue
      add constraint notification_queue_recipient_portal_access_fkey
      foreign key (recipient_portal_access_id, client_id) references public.client_portal_accesses (id, client_id);

    drop index public.notification_queue_open_item_key;
    create unique index notification_queue_open_item_key
      on public.notification_queue (type, content_id, recipient_portal_access_id)
      where sent_at is null and discarded_at is null;

    -- The functions below are rewritten for the access; drop the ones whose signature names the user.
    drop function app_private.claim_notification_batch(integer);
    drop function app_private.recheck_notifications(uuid[], uuid);
    drop function app_private.notification_group_ready(uuid, uuid, text);
    drop function app_private.notification_item_still_holds(text, uuid, uuid, uuid);

    alter table public.notification_queue drop column recipient_user_id;
  `);

  await knex.raw(`
    create function app_private.notification_item_still_holds(p_type text, p_client_id uuid, p_recipient_portal_access_id uuid, p_content_id uuid)
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
          and content.status = case p_type
            when 'content_awaiting_approval' then 'awaiting_approval'
            when 'content_published' then 'published'
          end
      )
    $function$;

    create function app_private.notification_group_ready(p_recipient_portal_access_id uuid, p_client_id uuid, p_type text)
    returns boolean
    language sql
    stable
    set search_path = ''
    as $function$
      select (
          app_private.notification_max_wait(p_type) is null
          or not exists (
            select 1 from public.notification_queue other
            where other.recipient_portal_access_id = p_recipient_portal_access_id and other.client_id = p_client_id and other.type = p_type
              and other.discarded_at is null
              and other.attempts < 5
              and other.send_after > pg_catalog.now()
          )
          or exists (
            select 1 from public.notification_queue other
            where other.recipient_portal_access_id = p_recipient_portal_access_id and other.client_id = p_client_id and other.type = p_type
              and other.sent_at is null and other.discarded_at is null
              and other.attempts < 5
              and other.created_at <= pg_catalog.now() - app_private.notification_max_wait(p_type)
          )
        )
        and not exists (
          select 1 from public.notification_queue other
          where other.recipient_portal_access_id = p_recipient_portal_access_id and other.client_id = p_client_id and other.type = p_type
            and other.sent_at is null and other.discarded_at is null
            and other.claimed_at >= pg_catalog.now() - interval '10 minutes'
        )
    $function$;

    create or replace function app_private.contents_enqueue_notification()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_type text;
    begin
      -- A client that is already archived, or an agency that is already suspended, leaves nothing to send (rule 8). A client being
      -- archived right now is the business of the AFTER INSERT lock of the queue, below.
      perform 1
      from public.clients client
      join public.agencies agency on agency.id = client.agency_id
      where client.id = new.client_id and client.status = 'active' and agency.status = 'active';
      if not found then
        return null;
      end if;

      v_type := case new.status when 'awaiting_approval' then 'content_awaiting_approval' else 'content_published' end;

      -- Every active access of the client, with an account or without one: the person is the access, once.
      insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after)
      select v_type, new.client_id, access.id, new.id, app_private.notification_send_after(v_type, pg_catalog.now())
      from public.client_portal_accesses access
      where access.client_id = new.client_id and access.status = 'active'
      -- Sent again before the e-mail left: the same line of the e-mail, and a new send inside the window postpones it (debounce).
      -- The resend zeroes the attempts and the last error of any open, unclaimed item (including one that ran out): otherwise the new send would never leave.
      on conflict (type, content_id, recipient_portal_access_id) where sent_at is null and discarded_at is null
      do update set send_after = excluded.send_after, attempts = 0, last_error = null
      where public.notification_queue.claimed_at is null;

      return null;
    end;
    $function$;

    create function app_private.claim_notification_batch(p_limit integer)
    returns table(item_id uuid, claim_token uuid, notification_type text, client_id uuid, client_name text, agency_name text,
                  recipient_portal_access_id uuid, recipient_email text, content_id uuid, content_title text, content_publish_on date)
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
          and (candidate.claimed_at is null or candidate.claimed_at < pg_catalog.now() - interval '10 minutes')
          and not app_private.notification_item_still_holds(candidate.type, candidate.client_id, candidate.recipient_portal_access_id, candidate.content_id)
        for update skip locked
      );

      -- One group at a time, and only the groups nobody else is claiming: the lock of the group is held to the end of the transaction,
      -- so a second worker cannot claim part of a group whose first claim it cannot see yet. Whether the group is ready is asked in the
      -- statement that claims, after the lock, so it sees what the previous holder of the lock committed.
      for v_group in
        select item.recipient_portal_access_id, item.client_id, item.type
        from public.notification_queue item
        where item.sent_at is null
          and item.discarded_at is null
          and item.send_after <= pg_catalog.now()
          and (item.claimed_at is null or item.claimed_at < pg_catalog.now() - interval '10 minutes')
          and item.attempts < 5
        group by item.recipient_portal_access_id, item.client_id, item.type
        order by min(item.send_after), item.recipient_portal_access_id, item.client_id, item.type
      loop
        exit when v_claimed >= p_limit;
        continue when not pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended('notification_queue:' || v_group.recipient_portal_access_id::text || ':' || v_group.client_id::text || ':' || v_group.type, 0)
        );

        update public.notification_queue item
        set claimed_at = pg_catalog.now(), claim_token = v_token, attempts = item.attempts + 1
        where item.id in (
          select due.id
          from public.notification_queue due
          where due.recipient_portal_access_id = v_group.recipient_portal_access_id and due.client_id = v_group.client_id and due.type = v_group.type
            and due.sent_at is null
            and due.discarded_at is null
            and due.send_after <= pg_catalog.now()
            and (due.claimed_at is null or due.claimed_at < pg_catalog.now() - interval '10 minutes')
            and due.attempts < 5
          for update skip locked
        )
        and app_private.notification_group_ready(v_group.recipient_portal_access_id, v_group.client_id, v_group.type);
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
             coalesce(person.email, access.email), item.content_id, content.title, content.publish_on
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join public.client_portal_accesses access on access.id = item.recipient_portal_access_id
      left join auth."user" person on person.id = access.user_id
      where item.claim_token = v_token
      order by item.recipient_portal_access_id, item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;

    create function app_private.recheck_notifications(p_item_ids uuid[], p_claim_token uuid)
    returns table(item_id uuid, claim_token uuid, notification_type text, client_id uuid, client_name text, agency_name text,
                  recipient_portal_access_id uuid, recipient_email text, content_id uuid, content_title text, content_publish_on date)
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
          and candidate.claimed_at >= v_now - interval '10 minutes'
          and not app_private.notification_item_still_holds(candidate.type, candidate.client_id, candidate.recipient_portal_access_id, candidate.content_id)
        for update
      );

      return query
      select item.id, item.claim_token, item.type, item.client_id, client.name, agency.name, item.recipient_portal_access_id,
             coalesce(person.email, access.email), item.content_id, content.title, content.publish_on
      from public.notification_queue item
      join public.contents content on content.id = item.content_id and content.client_id = item.client_id
      join public.clients client on client.id = item.client_id
      join public.agencies agency on agency.id = client.agency_id
      join public.client_portal_accesses access on access.id = item.recipient_portal_access_id
      left join auth."user" person on person.id = access.user_id
      where item.id = any(v_item_ids)
        and item.claim_token = p_claim_token
        and item.sent_at is null
        and item.discarded_at is null
        and item.claimed_at >= v_now - interval '10 minutes'
        -- Not redundant with the discard above: each statement has a snapshot of its own, and the lock holds only the clients, so a suspension of
        -- the agency, a removal from the portal or a change of the content that commits between the two statements is seen only here.
        and app_private.notification_item_still_holds(item.type, item.client_id, item.recipient_portal_access_id, item.content_id)
      order by item.recipient_portal_access_id, item.client_id, item.type, item.send_after, item.id;
    end;
    $function$;

    revoke all on function app_private.notification_item_still_holds(text, uuid, uuid, uuid) from public;
    revoke all on function app_private.notification_group_ready(uuid, uuid, text) from public;
    revoke all on function app_private.claim_notification_batch(integer) from public;
    revoke all on function app_private.recheck_notifications(uuid[], uuid) from public;
    grant execute on function app_private.claim_notification_batch(integer) to ageniza_app;
    grant execute on function app_private.recheck_notifications(uuid[], uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
