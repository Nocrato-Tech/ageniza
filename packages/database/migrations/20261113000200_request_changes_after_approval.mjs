// The client may ask for changes in a content that is already approved, until the day it is published (scope redesign-igual, subtask W11-S1).
// Not structural: no table, column, policy or grant changes; the decision is docs/business/decisions/2026-11-13-o-cliente-pede-ajuste-depois-de-aprovar-ate-a-vespera-da-publicacao.md.
//
//  - `app_private.content_accepts_changes_request(status, publish_on)` is the one copy of the rule: a content awaiting approval, or an approved
//    one whose planned day (`publish_on`) is after today in America/Sao_Paulo. The day of the publication itself is refused. Nobody calls it
//    but the portal function below, which runs as the owner of the schema, so it is closed to PUBLIC and the application role holds no grant.
//  - `request_content_changes` (the portal, with an account) is the body of 20261112000200 with that one test in the place of
//    `status <> 'awaiting_approval'`. The day is read from the row AFTER the lock on the content, so an agency that moves the date
//    meanwhile is seen, and from the clock after the wait (`clock_timestamp()`, like #304 of the invitation): a request that waited for
//    the lock across midnight is judged by the day it got the lock. A refusal is still `A0062`. After the lock the function also checks
//    again that the person is still of the portal of the client (`A0060`), as `withdraw_content_approval` does: dropping an approval is
//    not for someone removed meanwhile.
//  - `request_changes_by_portal_approval` (the link of the e-mail, no account) keeps the rule it had, `awaiting_approval` only: the link
//    decides only a content that awaits approval (decisions 2026-10-26 item 4, 2026-10-27 item 6, 2026-11-06). Its body is that of
//    20261112000200 again, so the helper has one caller.
//  - `contents_guard` is the body of 20261027090100 with one more transition, `approved -> adjusting`. Entering "adjusting" clears who
//    approved and when, like entering "awaiting approval", because only "approved" and "published" carry an approval (`contents_state_shape`).
//    The conversation keeps every comment, the note of the approval included.

export async function up(knex) {
  await knex.raw(`
    create function app_private.content_accepts_changes_request(p_status text, p_publish_on date)
    returns boolean
    language sql
    volatile
    set search_path = ''
    as $function$
      select p_status = 'awaiting_approval'
        or (p_status = 'approved' and p_publish_on > app_private.sao_paulo_date(pg_catalog.clock_timestamp()))
    $function$;
    revoke all on function app_private.content_accepts_changes_request(text, date) from public;
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
      v_link_access uuid;
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
          ('awaiting_approval', 'approved'), ('awaiting_approval', 'adjusting'), ('approved', 'adjusting'),
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

        if new.status in ('awaiting_approval', 'adjusting') then
          new.approved_by := null;
          new.approved_by_portal_access_id := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'approved' and old.status = 'awaiting_approval' then
          -- Fixed here, from the actor bound in this transaction or the access of the approval link: no caller chooses who approved or when.
          v_link_access := app_private.portal_approval_access_id();
          new.approved_by := app_private.current_user_id();
          new.approved_by_portal_access_id := v_link_access;
          new.approved_at := pg_catalog.now();
          if new.approved_by is null and v_link_access is null then
            raise exception using
              errcode = '42501',
              message = 'A content is approved by a person.';
          end if;
          if new.approved_by is not null and v_link_access is not null then
            raise exception using
              errcode = '42501',
              message = 'A content is approved by an account or by the access of an approval link, never by both.';
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

  await knex.raw(`
    create or replace function app_private.request_content_changes(p_content_id uuid, p_revision integer, p_body text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
      v_publish_on date;
      v_thread_id uuid;
      v_actor uuid := app_private.current_user_id();
    begin
      select content.client_id, content.status into v_client_id, v_status
      from public.contents content
      where content.id = p_content_id;

      -- Same door as approve_content: only an active person of the portal of this client, and a content the portal
      -- cannot open yet is "not found" for it.
      if not found or not app_private.is_client_member(v_client_id) or (
        v_status not in ('awaiting_approval', 'adjusting', 'approved', 'published')
        and not app_private.has_agency_permission(app_private.client_agency_id(v_client_id), 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if p_body is null or regexp_replace(p_body, '[[:space:]\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2060\\u3000\\ufeff]+', '', 'g') = '' or octet_length(p_body) > 5000 then
        raise exception using errcode = 'A0068', message = 'A request for changes carries its comment.';
      end if;

      -- The client is locked before the content, the order archive_client takes: a request that waits for the archiving of the
      -- client finds it archived and answers "not found", instead of moving the content and writing a comment after the archive.
      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      -- The state and the planned day are read from the locked row: an edit or a publication that held it is seen.
      select content.status, content.revision, content.publish_on into v_status, v_revision, v_publish_on
      from public.contents content
      where content.id = p_content_id
      for update;

      -- A person removed from the portal while this request waited for the lock is no longer one: the approval it would drop is not hers to drop.
      if not app_private.is_client_member(v_client_id) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if not app_private.content_accepts_changes_request(v_status, v_publish_on) then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval, or an approved one planned for after today, gets a request for changes.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
      insert into public.client_threads (client_id, content_id, opened_by, opened_side)
      values (v_client_id, p_content_id, v_actor, 'client')
      on conflict (content_id) where content_id is not null do nothing;

      select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

      insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
      values (v_thread_id, v_client_id, v_actor, 'client', p_body);

      update public.contents set status = 'adjusting' where id = p_content_id;

      perform app_private.notify_content_owner('content_changes_requested', p_content_id);
    end;
    $function$;
  `);

  await knex.raw(`
    create or replace function app_private.request_changes_by_portal_approval(p_session_hash text, p_content_id uuid, p_revision integer, p_body text)
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

      perform app_private.notify_content_owner('content_changes_requested', p_content_id);
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
