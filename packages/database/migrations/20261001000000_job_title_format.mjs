/**
 * Issue #225. `agency_memberships.job_title` is `text` with no format bound, while the response
 * schemas of the listing (#95), the detail (#96) and the job-titles route (#218) require a trimmed,
 * non-empty value of at most 256 characters. One malformed row makes `parseResponse` fail and turns
 * every read of the agency into a 500. Today only `seed:demo` writes the column; #97 will start
 * writing it, so the bound belongs in the database.
 *
 * The contract is JavaScript's, not PostgreSQL's, and the two disagree on purpose:
 * - `String.prototype.trim` removes a specific whitespace set that includes NBSP (U+00A0) and
 *   U+FEFF, neither of which PostgreSQL's `[[:space:]]` matches.
 * - `z.string().max(256)` counts UTF-16 code units, while `char_length` counts code points, so 129
 *   astral emoji are 258 units and only 129 points.
 * The migration closes both gaps: `app_private.normalize_job_title` trims exactly the JS whitespace
 * set (and turns an empty result into null), `app_private.utf16_length` counts UTF-16 units, a BEFORE
 * trigger stores the normalized form on every write, and the CHECK validates that stored form.
 *
 * Structural, small backfill (decisions.md, 2026-10-01). The backfill runs before the CHECK: a
 * legacy value that is only whitespace, or that is still longer than 256 UTF-16 units after the
 * trim, becomes null -- explicitly, counted, and logged by this migration's `up()`; the migration
 * never truncates silently. The choice is pending validation by the product owner.
 */
export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.normalize_job_title(p_value text)
    returns text
    language sql
    immutable
    set search_path = ''
    as $$
      -- The exact set of ECMAScript WhiteSpace + LineTerminator, minus nothing: U+0009, U+000A,
      -- U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F,
      -- U+205F, U+3000 and U+FEFF. Internal runs are preserved, exactly like String.prototype.trim.
      select nullif(
        btrim(
          p_value,
          chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
          || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
          || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
          || chr(8287) || chr(12288) || chr(65279)
        ),
        ''
      )
    $$;
    revoke all on function app_private.normalize_job_title(text) from public;

    create or replace function app_private.utf16_length(p_value text)
    returns integer
    language sql
    immutable
    set search_path = ''
    as $$
      -- char_length counts code points; JavaScript counts UTF-16 units. An astral character
      -- (code point above U+FFFF) is one point but two units, so add the astral characters back.
      -- ascii() returns the code point in a UTF-8 database, and this avoids any regex escape.
      select char_length(p_value) + (
        select count(*)
        from generate_series(1, char_length(p_value)) as position(index)
        where ascii(substring(p_value from position.index for 1)) > 65535
      )
    $$;
    revoke all on function app_private.utf16_length(text) from public;

    grant execute on function app_private.normalize_job_title(text) to ageniza_app;
    grant execute on function app_private.utf16_length(text) to ageniza_app;
  `);

  await knex.raw(`
    -- The column stores the normalized form, so a row is never stricter than the contract on read.
    create or replace function app_private.set_job_title()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      new.job_title := app_private.normalize_job_title(new.job_title);
      return new;
    end;
    $function$;
    revoke all on function app_private.set_job_title() from public;

    drop trigger if exists agency_memberships_job_title_normalize on public.agency_memberships;
    create trigger agency_memberships_job_title_normalize
      before insert or update of job_title on public.agency_memberships
      for each row
      execute function app_private.set_job_title();
  `);

  await knex.raw(`
    -- The legacy cleanup, exposed so the upgrade can be tested against real pre-existing data. It
    -- returns the counts so up() can log them; a value is never truncated, only dropped explicitly.
    create or replace function app_private.backfill_job_title()
    returns table (whitespace_nulled integer, over_limit_nulled integer, normalized integer)
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_whitespace integer;
      v_over_limit integer;
      v_normalized integer;
    begin
      update public.agency_memberships
         set job_title = null
       where job_title is not null
         and app_private.normalize_job_title(job_title) is null;
      get diagnostics v_whitespace = row_count;

      update public.agency_memberships
         set job_title = null
       where job_title is not null
         and app_private.utf16_length(app_private.normalize_job_title(job_title)) > 256;
      get diagnostics v_over_limit = row_count;

      update public.agency_memberships
         set job_title = app_private.normalize_job_title(job_title)
       where job_title is not null
         and job_title is distinct from app_private.normalize_job_title(job_title);
      get diagnostics v_normalized = row_count;

      return query select v_whitespace, v_over_limit, v_normalized;
    end;
    $function$;
    revoke all on function app_private.backfill_job_title() from public;
  `);

  // The server's default log_min_messages drops the NOTICE a plpgsql function would raise, so the
  // migration prints the returned counts itself; a deploy that drops legacy rows must leave a record.
  const backfill = await knex.raw('select * from app_private.backfill_job_title()');
  console.log(`job_title backfill: ${JSON.stringify(backfill.rows[0])}`);

  await knex.raw(`
    -- Null, or the canonical stored form of 1 to 256 UTF-16 units. The length is measured in UTF-16
    -- units because that is what the contract's max(256) counts, and the canonical comparison
    -- rejects anything a direct write slipped past the trigger.
    alter table public.agency_memberships
      drop constraint if exists agency_memberships_job_title_format;
    alter table public.agency_memberships
      add constraint agency_memberships_job_title_format
      check (
        job_title is null
        or (
          app_private.normalize_job_title(job_title) is not null
          and app_private.normalize_job_title(job_title) = job_title
          and app_private.utf16_length(job_title) between 1 and 256
        )
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
