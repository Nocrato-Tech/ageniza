// The functions of the approval link (issue #712, epic #718). Single-purpose `security definer`, every object schema-qualified under
// `set search_path = ''`, `revoke all ... from public` and a grant to `ageniza_app` only for the ones a request or the worker calls.
//
//   issue_portal_approval_link              the worker, after it recheck the claimed items: a link per access and per e-mail (7 days)
//   exchange_portal_approval_token          the token (by its hash) for a session (by its hash): the cookie
//   portal_approval_batch / _contents / _media   what the session reads: the batch, its contents and the media of the preview
//   approve_content_by_portal_approval      Aprovar, as the access of the link
//   request_changes_by_portal_approval      Pedir ajuste, as the access of the link, with the comment
// and the internal ones: portal_approval_link_is_live (the revocation, checked at every use) and portal_approval_resolve (the session
// to the link, with the locks of a write).
//
// Stable error codes:
//   A0100 -> 404  the link is not valid: unknown, expired, the access removed or of an earlier generation, the client archived, the
//                 agency suspended or read-only. One error for all of them, so the link is no oracle of which one it was.
//   A0101 -> (worker) the items and the claim do not describe one e-mail of one access
//   A0090          the agency is read-only, for a write with no actor in the transaction (issue #712, requirement of the review of #725)
// and from the portal: A0060 (content not in the batch), A0062 (not awaiting approval), A0063 (revision changed), A0068 (comment).
//
// The writes happen with no actor in the transaction, so the trigger that refuses a read-only agency lets them pass (it looks at
// the actor): every function that writes asks `agency_accepts_writes` itself.

export async function up(knex) {
  await knex.raw(`
    -- Whether the link may be used now. The revocation is not an event, it is this: the link did not expire, its access is active and
    -- still in the generation the link carries, the client is not archived and the agency is not suspended nor (for p_check_writes)
    -- read-only. The trial that ends is a date that passes, so it is read here and not fired by anything.
    create function app_private.portal_approval_link_is_live(p_link_id uuid, p_check_writes boolean)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1
        from public.client_portal_approval_links link
        join public.client_portal_accesses access on access.id = link.portal_access_id and access.client_id = link.client_id
        join public.clients client on client.id = link.client_id
        join public.agencies agency on agency.id = client.agency_id
        where link.id = p_link_id
          and link.expires_at > pg_catalog.clock_timestamp()
          and access.status = 'active'
          and access.generation = link.generation
          and client.status = 'active'
          and agency.status = 'active'
          and (not p_check_writes or app_private.agency_accepts_writes(agency.id))
      )
    $function$;
    revoke all on function app_private.portal_approval_link_is_live(uuid, boolean) from public;

    -- The session to its link, judged at this moment. p_for_write takes the locks of a write (the access, then the client, the order
    -- the removal and the archive use) and judges AFTER them, in a statement of its own, so a removal or an archive that committed
    -- while this waited is seen. A write is refused with A0090 when the agency is read-only; a read treats that as a dead link.
    create function app_private.portal_approval_resolve(p_session_hash text, p_for_write boolean)
    returns table(resolved_link_id uuid, resolved_access_id uuid, resolved_client_id uuid, resolved_agency_id uuid,
                  resolved_link_expires_at timestamptz, resolved_session_expires_at timestamptz)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_link_id uuid;
      v_access_id uuid;
      v_client_id uuid;
      v_agency_id uuid;
      v_link_expires_at timestamptz;
      v_session_expires_at timestamptz;
    begin
      if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      select link.id, link.portal_access_id, link.client_id
      into v_link_id, v_access_id, v_client_id
      from public.client_portal_approval_sessions session
      join public.client_portal_approval_links link on link.id = session.link_id
      where session.session_hash = p_session_hash;
      if not found then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      if p_for_write then
        perform 1 from public.client_portal_accesses access where access.id = v_access_id for share;
        perform 1 from public.clients client where client.id = v_client_id for share;
      end if;

      select link.expires_at, session.expires_at, client.agency_id
      into v_link_expires_at, v_session_expires_at, v_agency_id
      from public.client_portal_approval_sessions session
      join public.client_portal_approval_links link on link.id = session.link_id
      join public.clients client on client.id = link.client_id
      where session.session_hash = p_session_hash
        and session.expires_at > pg_catalog.clock_timestamp()
        and app_private.portal_approval_link_is_live(link.id, not p_for_write);
      if not found then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      if p_for_write and not app_private.agency_accepts_writes(v_agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
      end if;

      return query select v_link_id, v_access_id, v_client_id, v_agency_id, v_link_expires_at, v_session_expires_at;
    end;
    $function$;
    revoke all on function app_private.portal_approval_resolve(text, boolean) from public;
  `);

  await knex.raw(`
    -- The worker issues the link of an e-mail from the items it claimed: the items prove the e-mail exists (a claim token is a secret
    -- of the claim), and the link is tied to the contents of those items. A request has an actor and is refused; so is any call that
    -- cannot name a live claim. One e-mail, one mailbox: when two accesses of the client resolve to the same address, the e-mail
    -- carries one link, issued to the first of them by id.
    create function app_private.issue_portal_approval_link(p_item_ids uuid[], p_claim_token uuid, p_token_hash text)
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
        and item.type = 'content_awaiting_approval'
        and item.sent_at is null
        and item.discarded_at is null
        and item.claimed_at >= pg_catalog.clock_timestamp() - interval '10 minutes';
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

    -- The token for a session. Both arrive hashed, the raw values never reach the database. The session ends with the cookie's
    -- life, which is short, and never after the link.
    create function app_private.exchange_portal_approval_token(p_token_hash text, p_session_hash text)
    returns table(session_expires_at timestamptz, link_expires_at timestamptz)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_link_id uuid;
      v_access_id uuid;
      v_client_id uuid;
      v_link_expires_at timestamptz;
      v_now timestamptz;
      v_expires_at timestamptz;
    begin
      if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      select link.id, link.portal_access_id, link.client_id into v_link_id, v_access_id, v_client_id
      from public.client_portal_approval_links link where link.token_hash = p_token_hash;
      if not found then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      -- Opening the link decides nothing and writes only the session, but the session is a write all the same: it waits for a
      -- removal or an archive in flight and judges after them.
      perform 1 from public.client_portal_accesses access where access.id = v_access_id for share;
      perform 1 from public.clients client where client.id = v_client_id for share;
      select link.expires_at into v_link_expires_at
      from public.client_portal_approval_links link
      where link.id = v_link_id and app_private.portal_approval_link_is_live(link.id, true);
      if not found then
        raise exception using errcode = 'A0100', message = 'The approval link is not valid.';
      end if;

      v_now := pg_catalog.clock_timestamp();
      v_expires_at := least(v_now + interval '2 hours', v_link_expires_at);
      insert into public.client_portal_approval_sessions (link_id, session_hash, created_at, expires_at)
      values (v_link_id, p_session_hash, v_now, v_expires_at);

      return query select v_expires_at, v_link_expires_at;
    end;
    $function$;
  `);

  await knex.raw(`
    -- What the page of the link says about itself: the names, the address the access was given to and the two expiries. The brand,
    -- the colors and the photo of the client are not here: the link opens the batch and nothing of the portal.
    create function app_private.portal_approval_batch(p_session_hash text)
    returns table(client_name text, agency_name text, agency_id uuid, person_email text, link_expires_at timestamptz, session_expires_at timestamptz)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    #variable_conflict use_column
    declare
      v_session record;
    begin
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, false);
      return query
      select client.name, agency.name, agency.id, access.email, v_session.resolved_link_expires_at, v_session.resolved_session_expires_at
      from public.client_portal_accesses access
      join public.clients client on client.id = access.client_id
      join public.agencies agency on agency.id = client.agency_id
      where access.id = v_session.resolved_access_id;
    end;
    $function$;

    -- The contents of the batch with the cut of the portal (a cancelled one is gone, one in production is its title, day and format),
    -- in their current state: the one already decided shows up without buttons, the one that came back to awaiting approval stays.
    create function app_private.portal_approval_contents(p_session_hash text)
    returns table(id uuid, title text, platform text, format text, publish_on date, status text,
                  revision integer, publish_at_time time, caption text, cover_asset_id uuid, published_on date)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    #variable_conflict use_column
    declare
      v_session record;
    begin
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, false);
      return query
      select
        content.id, content.title, content.platform, content.format, content.publish_on, content.status,
        case when content.status = 'in_production' then null else content.revision end,
        case when content.status = 'in_production' then null else content.publish_at_time end,
        case when content.status = 'in_production' then null else content.caption end,
        case when content.status = 'in_production' then null else content.cover_asset_id end,
        case when content.status = 'in_production' then null else content.published_on end
      from public.client_portal_approval_link_contents lot
      join public.contents content on content.id = lot.content_id and content.client_id = lot.client_id
      where lot.link_id = v_session.resolved_link_id
        and content.status <> 'cancelled'
      order by content.publish_on, content.publish_at_time, content.id;
    end;
    $function$;

    -- The files of the preview of the batch. The original's key is agency_id/asset_id/original.extension by constraint and is not
    -- returned: the route builds it from the agency of the batch.
    create function app_private.portal_approval_media(p_session_hash text)
    returns table(content_id uuid, asset_id uuid, role text, item_position integer, category text, extension text,
                  video_processing_status text, thumbnail_object_key text)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    #variable_conflict use_column
    declare
      v_session record;
    begin
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, false);
      return query
      select content.id, asset.id, entry.role, entry.item_position, asset.category, asset.extension,
             asset.video_processing_status, asset.thumbnail_object_key
      from public.client_portal_approval_link_contents lot
      join public.contents content on content.id = lot.content_id and content.client_id = lot.client_id
      cross join lateral (
        select content.cover_asset_id as asset_id, 'cover'::text as role, 0 as item_position
        where content.cover_asset_id is not null
        union all
        select item.asset_id, 'media'::text, item.position
        from public.content_media item
        where item.content_id = content.id
      ) entry
      join public.media_assets asset on asset.id = entry.asset_id
      where lot.link_id = v_session.resolved_link_id
        and content.status in ('awaiting_approval', 'adjusting', 'approved', 'published')
        and asset.status = 'confirmed'
        and asset.removed_at is null
      order by content.id, entry.role, entry.item_position;
    end;
    $function$;
  `);

  await knex.raw(`
    -- Aprovar, as the access of the link: the same effect and the same refusals as approve_content of the portal. Idempotent, the first
    -- approval stays. The access goes into the context of the transaction for the guard of contents to write it, and leaves it.
    create function app_private.approve_content_by_portal_approval(p_session_hash text, p_content_id uuid, p_revision integer)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_session record;
      v_status text;
      v_revision integer;
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval link is used with no account bound to the transaction.';
      end if;
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, true);

      if not exists (
        select 1 from public.client_portal_approval_link_contents lot
        where lot.link_id = v_session.resolved_link_id and lot.content_id = p_content_id
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id and content.client_id = v_session.resolved_client_id
      for update;
      if not found or v_status = 'cancelled' then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if v_status = 'approved' then
        return;
      end if;
      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval is approved.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      insert into app_private.portal_approval_context (xact_id, access_id, link_id)
      values (pg_catalog.pg_current_xact_id(), v_session.resolved_access_id, v_session.resolved_link_id);
      update public.contents set status = 'approved' where id = p_content_id;
      delete from app_private.portal_approval_context where xact_id = pg_catalog.pg_current_xact_id();
    end;
    $function$;

    -- Pedir ajuste, as the access of the link: opens (or finds) the conversation of the content, writes the comment as the client's side
    -- and moves the content to "in adjustment", in one transaction, as request_content_changes of the portal.
    create function app_private.request_changes_by_portal_approval(p_session_hash text, p_content_id uuid, p_revision integer, p_body text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_session record;
      v_status text;
      v_revision integer;
      v_thread_id uuid;
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval link is used with no account bound to the transaction.';
      end if;
      -- Spaces, the characters that draw nothing (zero-width, joiners, direction marks, the byte order mark) and control characters.
      if p_body is null
         or pg_catalog.regexp_replace(p_body, '[[:space:]\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2060\\u3000\\ufeff]+', '', 'g') = ''
         or pg_catalog.octet_length(p_body) > 5000 then
        raise exception using errcode = 'A0068', message = 'A request for changes carries its comment.';
      end if;
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, true);

      if not exists (
        select 1 from public.client_portal_approval_link_contents lot
        where lot.link_id = v_session.resolved_link_id and lot.content_id = p_content_id
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id and content.client_id = v_session.resolved_client_id
      for update;
      if not found or v_status = 'cancelled' then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval gets a request for changes.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      insert into app_private.portal_approval_context (xact_id, access_id, link_id)
      values (pg_catalog.pg_current_xact_id(), v_session.resolved_access_id, v_session.resolved_link_id);

      -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
      insert into public.client_threads (client_id, content_id, opened_by_portal_access_id, opened_side)
      values (v_session.resolved_client_id, p_content_id, v_session.resolved_access_id, 'client')
      on conflict (content_id) where content_id is not null do nothing;
      select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

      insert into public.client_thread_comments (thread_id, client_id, author_portal_access_id, author_side, body)
      values (v_thread_id, v_session.resolved_client_id, v_session.resolved_access_id, 'client', p_body);

      update public.contents set status = 'adjusting' where id = p_content_id;
      delete from app_private.portal_approval_context where xact_id = pg_catalog.pg_current_xact_id();
    end;
    $function$;

    revoke all on function app_private.issue_portal_approval_link(uuid[], uuid, text) from public;
    revoke all on function app_private.exchange_portal_approval_token(text, text) from public;
    revoke all on function app_private.portal_approval_batch(text) from public;
    revoke all on function app_private.portal_approval_contents(text) from public;
    revoke all on function app_private.portal_approval_media(text) from public;
    revoke all on function app_private.approve_content_by_portal_approval(text, uuid, integer) from public;
    revoke all on function app_private.request_changes_by_portal_approval(text, uuid, integer, text) from public;
    grant execute on function app_private.issue_portal_approval_link(uuid[], uuid, text) to ageniza_app;
    grant execute on function app_private.exchange_portal_approval_token(text, text) to ageniza_app;
    grant execute on function app_private.portal_approval_batch(text) to ageniza_app;
    grant execute on function app_private.portal_approval_contents(text) to ageniza_app;
    grant execute on function app_private.portal_approval_media(text) to ageniza_app;
    grant execute on function app_private.approve_content_by_portal_approval(text, uuid, integer) to ageniza_app;
    grant execute on function app_private.request_changes_by_portal_approval(text, uuid, integer, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
