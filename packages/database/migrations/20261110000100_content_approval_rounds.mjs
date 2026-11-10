// Approval rounds and the send in a batch (scope telas-melhorias, subtask S1). Forward-only, like every migration here.
//
// Structural: decision 1 of 2026-11-10, docs/business/decisions/2026-11-10-estrutural-*.md. It adds one table and changes how a content is
// sent for approval; the reminders that read the round are the next migration (20261110000200).
//
// `content_approval_rounds`: one row per content sent for approval. A batch is the rows that share `batch_id` (one client, all or none);
// the individual send is a batch of one. A resend after an adjustment opens a NEW round (`sequence` counts them per content); taking the
// approval back (portal) or the database returning an approved content to "awaiting approval" opens none: it stays in the same round.
// A content that was already waiting before this migration has no round (no backfill).
//
//  - Nothing here is writable by `ageniza_app`: the table has no INSERT, UPDATE or DELETE grant, and the rows are written by
//    `send_content_for_approval` (the one rule of sending a content, called by `submit_content` and `submit_contents`) and, for the two
//    `reminded_*_at` stamps, by `enqueue_approval_reminders` (20261110000200). `sent_by` and `sent_at` come from the transaction, never from a
//    caller.
//  - The agency reads the rows the way it reads `contents` (`conteudo.visualizar`). The portal has NO policy, as on `contents`: it reads
//    the current round of a content through `portal_contents` and `portal_approval_contents`, which now return `approval_sent_at`,
//    `approval_due_on` and `approval_note` (null for a content in production or without a round). `sent_by` and `batch_id` never go to the portal.
//  - A child of the client: the AFTER INSERT lock of the active client and the refusal of a write for a read-only agency are the ones of the
//    other children (20261007001400, 20261027020000).
//
// `submit_content(uuid)` becomes `submit_content(uuid, date, text)` (deadline and note default to null, so the call and the `{}` body of the
// route stay valid); `submit_contents(uuid[], date, text)` sends up to 30 contents of ONE client, all or nothing. In the batch a content that
// already waits is refused (A0062) instead of ignored: the deadline and the note would otherwise be dropped silently.
//
// Lock order of the batch: the ids are locked in ascending order, each through `lock_content_for_agency` (client FOR SHARE, then the content
// FOR UPDATE), so two batches over the same contents never wait on each other in a cycle. The functions re-read after a lock, so they refuse
// any isolation level but READ COMMITTED (40001).
//
// Error codes (new): A0120 the deadline is outside "today to 90 days ahead, in America/Sao_Paulo"; A0121 a batch is 1 to 30 distinct contents;
// A0122 the contents of a batch belong to more than one client. Reused: A0060 (not found, or not allowed), A0061 (archived client), A0062 (not in
// production or adjustment), A0065 (media), A0066 (subtask), A0068 (the note is blank or over 500 characters), A0090 (read-only agency).

const MAX_BATCH = 30;
const MAX_DAYS_AHEAD = 90;
const MAX_NOTE_CHARACTERS = 500;

// The same invisible-text rule as the comments of a conversation (20261007001300), kept once here as a function so the CHECK and the
// functions that answer A0068 cannot disagree. A function inside a CHECK is not re-evaluated when it changes: tightening it takes a
// DROP and an ADD of the constraint.
const BLANK = "'[[:space:]\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2060\\u3000\\ufeff]+'";

export async function up(knex) {
  await knex.raw(`
    create function app_private.approval_note_is_valid(p_note text)
    returns boolean
    language sql
    immutable
    set search_path = ''
    as $function$
      select p_note is null
        or (pg_catalog.char_length(p_note) <= ${MAX_NOTE_CHARACTERS} and pg_catalog.regexp_replace(p_note, ${BLANK}, '', 'g') <> '')
    $function$;
    revoke all on function app_private.approval_note_is_valid(text) from public;

    create table public.content_approval_rounds (
      id uuid not null default gen_random_uuid() primary key,
      batch_id uuid not null,
      client_id uuid not null,
      content_id uuid not null,
      sequence integer not null check (sequence >= 1),
      due_on date null,
      note text null,
      sent_by uuid not null references auth."user"(id),
      sent_at timestamptz not null default now(),
      reminded_due_soon_at timestamptz null,
      reminded_overdue_at timestamptz null,
      constraint content_approval_rounds_note_check check (app_private.approval_note_is_valid(note)),
      constraint content_approval_rounds_content_fk foreign key (content_id, client_id)
        references public.contents (id, client_id) on delete cascade,
      constraint content_approval_rounds_content_sequence_key unique (content_id, sequence),
      constraint content_approval_rounds_id_content_client_key unique (id, content_id, client_id)
    );
    create index content_approval_rounds_batch_idx on public.content_approval_rounds (batch_id);
    create index content_approval_rounds_client_idx on public.content_approval_rounds (client_id);
    create index content_approval_rounds_reminder_idx on public.content_approval_rounds (due_on)
      where due_on is not null and (reminded_due_soon_at is null or reminded_overdue_at is null);

    alter table public.content_approval_rounds enable row level security;
    alter table public.content_approval_rounds force row level security;

    revoke all on public.content_approval_rounds from ageniza_app;
    grant select on public.content_approval_rounds to ageniza_app;

    create policy content_approval_rounds_select on public.content_approval_rounds
      for select to ageniza_app
      using (app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar'));

    create trigger "0_content_approval_rounds_lock_active_client"
      after insert on public.content_approval_rounds
      for each row
      execute function app_private.lock_active_client_of_child();

    create trigger "00_content_approval_rounds_agency_accepts_writes"
      before insert or update or delete on public.content_approval_rounds
      for each row execute function app_private.refuse_write_to_read_only_agency('client_id');
  `);

  await knex.raw(`
    create function app_private.check_approval_round_input(p_due_on date, p_note text)
    returns void
    language plpgsql
    stable
    set search_path = ''
    as $function$
    declare
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
    begin
      if p_due_on is not null and (p_due_on < v_today or p_due_on > v_today + ${MAX_DAYS_AHEAD}) then
        raise exception using errcode = 'A0120', message = 'The deadline is from today to ${MAX_DAYS_AHEAD} days ahead, in America/Sao_Paulo.';
      end if;
      if not app_private.approval_note_is_valid(p_note) then
        raise exception using errcode = 'A0068', message = 'The note to the client is up to ${MAX_NOTE_CHARACTERS} characters and not blank.';
      end if;
    end;
    $function$;
    revoke all on function app_private.check_approval_round_input(date, text) from public;

    -- The one rule of sending a content for approval, for a content the caller already locked with lock_content_for_agency. The round is
    -- written before the state moves, so a refusal of the state leaves no round (and the transaction would undo it anyway).
    create function app_private.send_content_for_approval(p_content public.contents, p_batch_id uuid, p_due_on date, p_note text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if p_content.status not in ('in_production', 'adjusting') then
        raise exception using errcode = 'A0062', message = 'Only a content in production or in adjustment is sent for approval.';
      end if;
      if not app_private.content_media_is_complete(p_content.id, p_content.format) then
        raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
      end if;
      if exists (
        select 1 from public.media_assets asset where asset.id = p_content.cover_asset_id and asset.removed_at is not null
      ) then
        raise exception using errcode = 'A0065', message = 'The cover of a content was removed.';
      end if;
      if exists (select 1 from public.content_tasks task where task.content_id = p_content.id and task.status <> 'approved') then
        raise exception using errcode = 'A0066', message = 'Every subtask is approved before the content is sent.';
      end if;

      insert into public.content_approval_rounds (batch_id, client_id, content_id, sequence, due_on, note, sent_by)
      select p_batch_id, p_content.client_id, p_content.id, coalesce(pg_catalog.max(round.sequence), 0) + 1, p_due_on, p_note,
             app_private.current_user_id()
      from public.content_approval_rounds round
      where round.content_id = p_content.id;

      update public.contents set status = 'awaiting_approval' where id = p_content.id;
    end;
    $function$;
    revoke all on function app_private.send_content_for_approval(public.contents, uuid, date, text) from public;

    drop function app_private.submit_content(uuid);

    create function app_private.submit_content(p_content_id uuid, p_due_on date default null, p_note text default null)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      perform app_private.require_read_committed();
      perform app_private.check_approval_round_input(p_due_on, p_note);
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status = 'awaiting_approval' then
        return;
      end if;
      perform app_private.send_content_for_approval(v_content, pg_catalog.gen_random_uuid(), p_due_on, p_note);
    end;
    $function$;
    revoke all on function app_private.submit_content(uuid, date, text) from public;
    grant execute on function app_private.submit_content(uuid, date, text) to ageniza_app;

    create function app_private.submit_contents(p_content_ids uuid[], p_due_on date default null, p_note text default null)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_batch_id uuid := pg_catalog.gen_random_uuid();
      v_ids uuid[];
      v_id uuid;
      v_content public.contents;
      v_client_id uuid;
    begin
      perform app_private.require_read_committed();
      if p_content_ids is null
        or pg_catalog.cardinality(p_content_ids) not between 1 and ${MAX_BATCH}
        or pg_catalog.array_position(p_content_ids, null) is not null
        or pg_catalog.cardinality(p_content_ids) <> (select pg_catalog.count(distinct item) from pg_catalog.unnest(p_content_ids) as item)
      then
        raise exception using errcode = 'A0121', message = 'A batch is from 1 to ${MAX_BATCH} contents, each one once.';
      end if;
      perform app_private.check_approval_round_input(p_due_on, p_note);

      select pg_catalog.array_agg(item order by item) into v_ids from pg_catalog.unnest(p_content_ids) as item;
      foreach v_id in array v_ids loop
        v_content := app_private.lock_content_for_agency(v_id, 'conteudo.operar');
        if v_client_id is null then
          v_client_id := v_content.client_id;
        elsif v_content.client_id <> v_client_id then
          raise exception using errcode = 'A0122', message = 'The contents of a batch belong to one client.';
        end if;
        perform app_private.send_content_for_approval(v_content, v_batch_id, p_due_on, p_note);
      end loop;

      return v_batch_id;
    end;
    $function$;
    revoke all on function app_private.submit_contents(uuid[], date, text) from public;
    grant execute on function app_private.submit_contents(uuid[], date, text) to ageniza_app;
  `);

  await knex.raw(`
    drop function app_private.portal_contents(uuid, date, date, text[], uuid);

    create function app_private.portal_contents(
      p_client_id uuid,
      p_from date default null,
      p_to date default null,
      p_statuses text[] default null,
      p_content_id uuid default null
    )
    returns table (
      id uuid, title text, platform text, format text, publish_on date, status text,
      revision integer, publish_at_time time, caption text, cover_asset_id uuid, published_on date,
      approval_sent_at timestamptz, approval_due_on date, approval_note text
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        content.id, content.title, content.platform, content.format, content.publish_on, content.status,
        case when content.status = 'in_production' then null else content.revision end,
        case when content.status = 'in_production' then null else content.publish_at_time end,
        case when content.status = 'in_production' then null else content.caption end,
        case when content.status = 'in_production' then null else content.cover_asset_id end,
        case when content.status = 'in_production' then null else content.published_on end,
        approval.sent_at, approval.due_on, approval.note
      from public.contents content
      left join lateral (
        select round.sent_at, round.due_on, round.note
        from public.content_approval_rounds round
        where round.content_id = content.id and content.status <> 'in_production'
        order by round.sequence desc
        limit 1
      ) approval on true
      where content.client_id = p_client_id
        and app_private.is_client_member(p_client_id)
        and content.status <> 'cancelled'
        and (p_from is null or content.publish_on >= p_from)
        and (p_to is null or content.publish_on <= p_to)
        and (p_statuses is null or content.status = any (p_statuses))
        and (p_content_id is null or content.id = p_content_id)
      order by content.publish_on, content.id
    $function$;
    revoke all on function app_private.portal_contents(uuid, date, date, text[], uuid) from public;
    grant execute on function app_private.portal_contents(uuid, date, date, text[], uuid) to ageniza_app;

    drop function app_private.portal_approval_contents(text);

    create function app_private.portal_approval_contents(p_session_hash text)
    returns table(id uuid, title text, platform text, format text, publish_on date, status text,
                  revision integer, publish_at_time time, caption text, cover_asset_id uuid, published_on date,
                  approval_sent_at timestamptz, approval_due_on date, approval_note text)
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
        case when content.status = 'in_production' then null else content.published_on end,
        approval.sent_at, approval.due_on, approval.note
      from public.client_portal_approval_link_contents lot
      join public.contents content on content.id = lot.content_id and content.client_id = lot.client_id
      left join lateral (
        select round.sent_at, round.due_on, round.note
        from public.content_approval_rounds round
        where round.content_id = content.id and content.status <> 'in_production'
        order by round.sequence desc
        limit 1
      ) approval on true
      where lot.link_id = v_session.resolved_link_id
        and content.status <> 'cancelled'
      order by content.publish_on, content.publish_at_time, content.id;
    end;
    $function$;
    revoke all on function app_private.portal_approval_contents(text) from public;
    grant execute on function app_private.portal_approval_contents(text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
