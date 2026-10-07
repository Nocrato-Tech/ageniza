// Acceptance of one legal document at a time (issue #81). Forward-only, like every migration here.
//
// docs/business/decisions.md, 2026-10-07 ("Termos e Privacidade mudam de versão sem forçar o
// reaceite, e o aceite passa a ser por documento"). `public.legal_acceptances` already stores the
// two documents separately and `ageniza_app` has no INSERT policy on it, which the tenancy suite
// pins on purpose: the table is evidence of consent, so the only write paths are the signup
// function and this one. No table, column, grant or policy changes here.
//
// `security definer` runs as the schema owner and ignores RLS, so the user comes from the actor
// bound for the transaction (`app_private.current_user_id()`), never from an argument: a caller
// can only ever record an acceptance for the account the session belongs to. The version is an
// argument because the API owns the configuration, but it must be a plain `YYYY-MM-DD`, the format
// `AUTH_TERMS_VERSION` and `AUTH_PRIVACY_VERSION` already enforce.
//
// Stable error codes, so the API can translate them without parsing messages:
//   A0030 -> no actor is bound to the transaction
//   A0031 -> the document or the version is not one the table accepts: an unknown document, a
//            version that is not a real `YYYY-MM-DD` date, or one later than today

export async function up(knex) {
  await knex.raw(`
    create function app_private.accept_legal_document(p_document text, p_version text)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_user_id uuid := app_private.current_user_id();
      v_recorded integer;
      v_version_date date;
    begin
      if v_user_id is null then
        raise exception using errcode = 'A0030', message = 'An authenticated user is required.';
      end if;

      if p_document is null or p_document not in ('terms', 'privacy')
         or p_version is null or p_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then
        raise exception using errcode = 'A0031', message = 'Unknown legal document or malformed version.';
      end if;

      -- The shape is not enough: 2026-02-30 and 2026-99-99 match it, and a version in the future
      -- would make the never-regresses rule below suppress every real version for good. The date
      -- is checked for real, and it cannot be later than today in the product's time zone.
      begin
        v_version_date := p_version::date;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception using errcode = 'A0031', message = 'The version is not a real date.';
      end;
      if v_version_date > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date then
        raise exception using errcode = 'A0031', message = 'The version is in the future.';
      end if;

      -- Never regresses: a version older than, or equal to, one the account already accepted for
      -- this document records nothing. "C" collation, because the comparison is byte order on a
      -- fixed-width date and must not depend on the database locale.
      if exists (
        select 1
        from public.legal_acceptances accepted
        where accepted.user_id = v_user_id
          and accepted.document = p_document
          and accepted.version collate "C" >= p_version collate "C"
      ) then
        return false;
      end if;

      insert into public.legal_acceptances (user_id, document, version)
      values (v_user_id, p_document, p_version)
      on conflict (user_id, document, version) do nothing;
      get diagnostics v_recorded = row_count;

      return v_recorded = 1;
    end;
    $function$;
    revoke all on function app_private.accept_legal_document(text, text) from public;
    grant execute on function app_private.accept_legal_document(text, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
