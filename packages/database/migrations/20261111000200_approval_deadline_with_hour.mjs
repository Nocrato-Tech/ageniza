// The deadline of an approval round gets an hour (scope redesign-igual, subtask A2). Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas.md. It alters
// `content_approval_rounds` (the deadline of a round was one day of São Paulo, `due_on`), changes the signature of the functions that
// send a content, and carries what already exists (backfill).
//
//  - `due_at` (timestamptz, null without a deadline) is the deadline. `due_on` stays, now as the São Paulo day OF `due_at`: the reminders
//    ("vence amanhã", "venceu"), the e-mails and every reader that counts in days keep reading it, and a CHECK keeps the two from
//    ever disagreeing. Nobody but the sending function writes either: `ageniza_app` has no write grant on the table.
//  - Backfill: a deadline that was a day is valid until the END of that day in São Paulo, 23:59, which is what the day meant.
//  - The window of a new deadline is "after now, up to 90 days ahead" (the decision), checked at an instant the check receives, as the
//    other date rules do. The standard of 48 hours is the screen's: the API still accepts a send without a deadline.
//  - `app_private.sao_paulo_end_of_day(date)` is the one place that turns a São Paulo day into an instant. It owns no time zone: the
//    day of an instant is asked of `sao_paulo_date`, as the catalog test of the client dates demands, by looking for the first whole
//    UTC hour at which São Paulo is on the next day (its offset is always a whole number of hours).
//  - `submit_content(uuid, timestamptz, text)` and `submit_contents(uuid[], timestamptz, text)` replace the ones that took a `date`; the
//    default of both parameters is still null, so the calls with no deadline and no note stay valid. The rules of the batch (all or
//    nothing, up to 30 contents of one client, locks in ascending order, READ COMMITTED only) are the ones of 20261110000100.
//  - `check_approval_round_input(date, text, timestamptz)` is kept: the deadline of a material request (20261110000400) is still a day and
//    is checked by it. The deadline of a round is checked by `check_approval_round_deadline`; the note is judged by the same
//    `approval_note_is_valid` in both.
//
// The portal reads return the new deadline, and who sent the round, in the next migration (20261111000201).

const MAX_DAYS_AHEAD = 90;
const MAX_NOTE_CHARACTERS = 500;

export async function up(knex) {
  await knex.raw(`
    -- The last minute (23:59) of a São Paulo day, as an instant. The epoch is read as UTC midnight of the day; São Paulo midnight of the
    -- next day is between 12 and 48 hours after it in any offset it ever had, and the first whole hour past it is the first hour of the
    -- next day. A day with a different length (the old daylight saving time) is handled by the same search.
    create function app_private.sao_paulo_end_of_day(p_day date)
    returns timestamptz
    language sql
    stable
    set search_path = ''
    as $function$
      select pg_catalog.min(hour) - interval '1 minute'
      from pg_catalog.generate_series(
        pg_catalog.to_timestamp(((p_day - date '1970-01-01')::bigint * 86400)::double precision) + interval '12 hours',
        pg_catalog.to_timestamp(((p_day - date '1970-01-01')::bigint * 86400)::double precision) + interval '48 hours',
        interval '1 hour'
      ) as hour
      where app_private.sao_paulo_date(hour) > p_day
    $function$;
    revoke all on function app_private.sao_paulo_end_of_day(date) from public;
    grant execute on function app_private.sao_paulo_end_of_day(date) to ageniza_app;

    alter table public.content_approval_rounds add column due_at timestamptz null;
    update public.content_approval_rounds set due_at = app_private.sao_paulo_end_of_day(due_on) where due_on is not null;
    alter table public.content_approval_rounds
      add constraint content_approval_rounds_due_check check (due_on is not distinct from app_private.sao_paulo_date(due_at));

    create function app_private.check_approval_round_deadline(p_due_at timestamptz, p_note text, p_at timestamptz)
    returns void
    language plpgsql
    stable
    set search_path = ''
    as $function$
    begin
      -- A null instant would make every comparison below null, and a comparison with null refuses nothing.
      if p_at is null then
        raise exception using errcode = '22023', message = 'The deadline is checked at an instant.';
      end if;
      -- In hours, not days: an interval of days moves with the time zone of the session, an interval of hours does not.
      if p_due_at is not null and (p_due_at <= p_at or p_due_at > p_at + interval '${MAX_DAYS_AHEAD * 24} hours') then
        raise exception using errcode = 'A0120', message = 'The deadline is after now and up to ${MAX_DAYS_AHEAD} days ahead.';
      end if;
      if not app_private.approval_note_is_valid(p_note) then
        raise exception using errcode = 'A0068', message = 'The note to the client is up to ${MAX_NOTE_CHARACTERS} characters and not blank.';
      end if;
    end;
    $function$;
    revoke all on function app_private.check_approval_round_deadline(timestamptz, text, timestamptz) from public;
  `);

  await knex.raw(`
    drop function app_private.submit_content(uuid, date, text);
    drop function app_private.submit_contents(uuid[], date, text);
    drop function app_private.send_content_for_approval(public.contents, uuid, date, text);

    -- The one rule of sending a content for approval, for a content the caller already locked with lock_content_for_agency. The round is
    -- written before the state moves, so a refusal of the state leaves no round (and the transaction would undo it anyway).
    create function app_private.send_content_for_approval(p_content public.contents, p_batch_id uuid, p_due_at timestamptz, p_note text)
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

      insert into public.content_approval_rounds (batch_id, client_id, content_id, sequence, due_at, due_on, note, sent_by)
      select p_batch_id, p_content.client_id, p_content.id, coalesce(pg_catalog.max(round.sequence), 0) + 1, p_due_at,
             app_private.sao_paulo_date(p_due_at), p_note, app_private.current_user_id()
      from public.content_approval_rounds round
      where round.content_id = p_content.id;

      update public.contents set status = 'awaiting_approval' where id = p_content.id;
    end;
    $function$;
    revoke all on function app_private.send_content_for_approval(public.contents, uuid, timestamptz, text) from public;

    create function app_private.submit_content(p_content_id uuid, p_due_at timestamptz default null, p_note text default null)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
      v_due_at timestamptz;
      v_note text;
    begin
      perform app_private.require_read_committed();
      perform app_private.check_approval_round_deadline(p_due_at, p_note, pg_catalog.now());
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status = 'awaiting_approval' then
        -- The same call again (a double click, a retry) changes nothing. One that asks for another deadline or note would be dropped
        -- silently, so it is refused, as the batch refuses a content that already waits. A content that waited before the rounds existed
        -- has none and counts as sent with neither.
        select round.due_at, round.note into v_due_at, v_note
        from public.content_approval_rounds round
        where round.content_id = v_content.id
        order by round.sequence desc
        limit 1;
        if p_due_at is not distinct from v_due_at and p_note is not distinct from v_note then
          return;
        end if;
        raise exception using errcode = 'A0062', message = 'The content already waits for approval, with another deadline or note.';
      end if;
      perform app_private.send_content_for_approval(v_content, pg_catalog.gen_random_uuid(), p_due_at, p_note);
    end;
    $function$;
    revoke all on function app_private.submit_content(uuid, timestamptz, text) from public;
    grant execute on function app_private.submit_content(uuid, timestamptz, text) to ageniza_app;

    create function app_private.submit_contents(p_content_ids uuid[], p_due_at timestamptz default null, p_note text default null)
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
      -- A list of one dimension and not empty: the dimension of a missing or an empty array is null. A null item is not counted by
      -- count(distinct), so the last line refuses it as well as a repeated one.
      if pg_catalog.array_ndims(p_content_ids) is distinct from 1
        or pg_catalog.cardinality(p_content_ids) > 30
        or pg_catalog.cardinality(p_content_ids) <> (select pg_catalog.count(distinct item) from pg_catalog.unnest(p_content_ids) as item)
      then
        raise exception using errcode = 'A0121', message = 'A batch is from 1 to 30 contents, each one once.';
      end if;
      perform app_private.check_approval_round_deadline(p_due_at, p_note, pg_catalog.now());

      select pg_catalog.array_agg(item order by item) into v_ids from pg_catalog.unnest(p_content_ids) as item;
      foreach v_id in array v_ids loop
        v_content := app_private.lock_content_for_agency(v_id, 'conteudo.operar');
        if v_client_id is null then
          v_client_id := v_content.client_id;
        elsif v_content.client_id <> v_client_id then
          raise exception using errcode = 'A0122', message = 'The contents of a batch belong to one client.';
        end if;
        perform app_private.send_content_for_approval(v_content, v_batch_id, p_due_at, p_note);
      end loop;

      return v_batch_id;
    end;
    $function$;
    revoke all on function app_private.submit_contents(uuid[], timestamptz, text) from public;
    grant execute on function app_private.submit_contents(uuid[], timestamptz, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
