// The profile of a persona: age, occupation, place, traits, "onde está" and "tom que funciona" (scope telas-melhorias, redesign subtask A3).
// Structural: docs/business/decisions/2026-11-11-estrutural-a-persona-ganha-idade-ocupacao-local-tracos-onde-esta-e-tom.md. No backfill:
// the six columns are nullable and a persona without them is as valid as before. The policies of `client_personas` are not changed: the
// agency writes with `cliente.operar` on an active client and the portal reads the active personas of its own client.
//
//  - `age` 1..120; `occupation` and `location` one line of up to 80 characters; `where_they_are` and `tone_that_works` up to 280 characters
//    and may break lines; `traits` is a JSON array of up to 5 strings, each one line of up to 24 characters. The checks are the database's
//    copy of what the contract says (`display_text_valid` and `multiline_text_valid` are from 20261111000301).
//  - The application role gets INSERT and UPDATE of the six columns. `updated_by` and `updated_at` stay what they were, so a save of one
//    line is the same write as the save of the name.
//  - The edit lock of the persona (20261011000700) lists exactly the columns the application role may UPDATE, and a test of the catalog
//    holds the two together, so the trigger is dropped and created again with the six new columns: a write of a new column to a persona
//    of a client that an archive is closing waits for the archive and finds the client no longer active, like every other write.

export async function up(knex) {
  await knex.raw(String.raw`
    -- A CHECK cannot hold a subquery, so the rule of each element lives in a function, as for the colors of the brand study (20261010000100).
    -- Every branch is a CASE because jsonb_array_elements raises on a value of another type, and an element is flagged when the test is
    -- not true, so a JSON null (NULL in SQL) is refused rather than slipping through.
    create function app_private.persona_traits_valid(p_traits jsonb)
    returns boolean
    language sql
    immutable
    parallel safe
    set search_path = ''
    as $function$
      select case
        when p_traits is null then true
        when pg_catalog.jsonb_typeof(p_traits) <> 'array' then false
        when pg_catalog.jsonb_array_length(p_traits) > 5 then false
        else not exists (
          select 1
          from pg_catalog.jsonb_array_elements(p_traits) as trait(element)
          where (
            case
              when pg_catalog.jsonb_typeof(trait.element) <> 'string' then false
              else app_private.display_text_valid(trait.element #>> '{}', 24)
            end
          ) is not true
        )
      end
    $function$;
    revoke all on function app_private.persona_traits_valid(jsonb) from public;
    grant execute on function app_private.persona_traits_valid(jsonb) to ageniza_app;
  `);

  await knex.raw(`
    alter table public.client_personas
      add column age smallint null,
      add column occupation text null,
      add column location text null,
      add column traits jsonb null,
      add column where_they_are text null,
      add column tone_that_works text null,
      add constraint client_personas_age_check check (age is null or age between 1 and 120),
      add constraint client_personas_occupation_check check (app_private.display_text_valid(occupation, 80)),
      add constraint client_personas_location_check check (app_private.display_text_valid(location, 80)),
      add constraint client_personas_traits_check check (app_private.persona_traits_valid(traits)),
      add constraint client_personas_where_they_are_check check (app_private.multiline_text_valid(where_they_are, 280)),
      add constraint client_personas_tone_that_works_check check (app_private.multiline_text_valid(tone_that_works, 280));

    grant insert (age, occupation, location, traits, where_they_are, tone_that_works) on public.client_personas to ageniza_app;
    grant update (age, occupation, location, traits, where_they_are, tone_that_works) on public.client_personas to ageniza_app;

    drop trigger "0_client_personas_edit_lock_active_client" on public.client_personas;
    create trigger "0_client_personas_edit_lock_active_client"
      after update of name, description, pains, desires, objections, age, occupation, location, traits, where_they_are, tone_that_works,
        status, updated_by, updated_at on public.client_personas
      for each row
      when (
        (old.name, old.description, old.pains, old.desires, old.objections, old.age, old.occupation, old.location, old.traits,
         old.where_they_are, old.tone_that_works, old.status, old.updated_by, old.updated_at)
        is distinct from
        (new.name, new.description, new.pains, new.desires, new.objections, new.age, new.occupation, new.location, new.traits,
         new.where_they_are, new.tone_that_works, new.status, new.updated_by, new.updated_at)
      )
      execute function app_private.lock_active_client_of_child();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
