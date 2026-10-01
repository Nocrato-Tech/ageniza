/**
 * Issue #225. `agency_memberships.job_title` is `text` with no format bound, while the response
 * schemas of the listing (#95), the detail (#96) and the job-titles route (#218) require a trimmed,
 * non-empty value of at most 256 characters. One malformed row -- only a tab, only a NBSP, or over
 * 256 characters -- makes `parseResponse` fail and turns every read of the agency into a 500. Today
 * only `seed:demo` writes the column; #97 will start writing it, so the bound belongs in the bank.
 *
 * Structural, small backfill (recorded in decisions.md, 2026-10-01): the existing rows are
 * normalized first, with the same whitespace expression the client-name index uses (NBSP becomes a
 * space, every run of whitespace collapses to one space, then `btrim`; an empty result becomes
 * `null`), and only then the CHECK is added. New rows are constrained; the write path of #97 must
 * normalize with the same expression.
 */
export async function up(knex) {
  await knex.raw(`
    create function app_private.normalize_job_title(p_value text)
    returns text
    language sql
    immutable
    set search_path = ''
    as $$
      select nullif(
        btrim(regexp_replace(replace(p_value, chr(160), ' '), '[[:space:]]+', ' ', 'g')),
        ''
      )
    $$;
    revoke all on function app_private.normalize_job_title(text) from public;
    grant execute on function app_private.normalize_job_title(text) to ageniza_app;
  `);

  await knex.raw(`
    -- Backfill before the constraint: every existing row is stored in the canonical form, so a row
    -- that was only whitespace becomes null instead of surviving as invalid data.
    update public.agency_memberships
    set job_title = app_private.normalize_job_title(job_title)
    where job_title is not null
      and job_title is distinct from app_private.normalize_job_title(job_title);

    -- Null, or a non-empty canonical value of at most 256 characters. The same expression the
    -- backfill and the response schema use, so a row can no longer be stricter than the contract.
    alter table public.agency_memberships
      add constraint agency_memberships_job_title_format
      check (
        job_title is null
        or (
          app_private.normalize_job_title(job_title) is not null
          and char_length(app_private.normalize_job_title(job_title)) between 1 and 256
        )
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
