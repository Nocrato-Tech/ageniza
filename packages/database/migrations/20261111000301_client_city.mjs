// The city of a client (scope telas-melhorias, redesign subtask A3).
// Structural: docs/business/decisions/2026-11-11-estrutural-o-cliente-ganha-cidade-e-quem-trabalha-nele-e-derivado.md. No backfill: every
// client starts with no city.
//
// `city` is a column of `clients` like the other registration fields: the application role may INSERT and UPDATE it (the policies of the
// table are not changed, so only `cliente.cadastrar` creates and only `cliente.operar` edits an active client), and the portal reads it
// with the rest of its own client.
//
// The two text rules below are the database's copy of the rules the contract states for a short free text of the registration
// (`packages/contracts/src/clients.ts`): `display_text_valid` for one line and `multiline_text_valid` for a text that keeps its line
// breaks. They are the one copy every later column of this scope uses (the persona, the name typed for a portal access, the title of
// a request for material), so a limit is read here and not repeated per table. Both are looser than the contract on purpose (the
// contract also refuses invisible and bidi characters and requires a letter), because a check that mirrored every character class would
// refuse a row the route never produced; what the database holds is the length, a visible character and no control character.

export async function up(knex) {
  await knex.raw(String.raw`
    -- Length in characters, one visible character (a value of nothing but white space is refused: the class lists every White_Space code
    -- point itself, so the rule does not depend on the locale of the database), and none of the C0 and C1 controls (a NUL cannot be stored
    -- anyway). Null is valid: the column is optional.
    create function app_private.display_text_valid(p_value text, p_max_chars integer)
    returns boolean
    language sql
    immutable
    parallel safe
    set search_path = ''
    as $function$
      select case
        when p_value is null then true
        else pg_catalog.char_length(p_value) <= p_max_chars
          and p_value !~ '[\u0001-\u001f\u007f-\u009f]'
          and p_value ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]'
      end
    $function$;
    revoke all on function app_private.display_text_valid(text, integer) from public;
    grant execute on function app_private.display_text_valid(text, integer) to ageniza_app;

    -- The same, keeping tab, line feed and carriage return: the text of a person who writes two lines.
    create function app_private.multiline_text_valid(p_value text, p_max_chars integer)
    returns boolean
    language sql
    immutable
    parallel safe
    set search_path = ''
    as $function$
      select case
        when p_value is null then true
        else pg_catalog.char_length(p_value) <= p_max_chars
          and p_value !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]'
          and p_value ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]'
      end
    $function$;
    revoke all on function app_private.multiline_text_valid(text, integer) from public;
    grant execute on function app_private.multiline_text_valid(text, integer) to ageniza_app;
  `);

  await knex.raw(`
    alter table public.clients
      add column city text null,
      add constraint clients_city_check check (app_private.display_text_valid(city, 80));

    grant insert (city) on public.clients to ageniza_app;
    grant update (city) on public.clients to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
