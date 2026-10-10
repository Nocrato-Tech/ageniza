// CLIENTS module brand study colors (issue #476). Forward-only, and a new migration:
// 20260928000100_clients_module.mjs is not edited.
//
// Recorded in docs/business/decisions/2026-10-10-cores-do-estudo-de-marca-tem-o-formato-do-contrato-no-banco.md.
//
// `client_brand_sections.colors` only had `jsonb_typeof(colors) = 'array'`, so `ageniza_app` could
// store elements the read contract refuses, and one bad color answered 500 for the whole study.
// `app_private.brand_colors_valid` mirrors `BrandColorSchema` and the 24-item limit of
// `BrandStudySectionUpdateRequestSchema` (packages/contracts/src/clients.ts), and the CHECK below
// makes the writer fail on the INSERT instead of the reader failing later. The constraint is added
// validated, with no NOT VALID: a row outside the format has to be repaired before this migrates.

export async function up(knex) {
  await knex.raw(String.raw`
    -- A CHECK cannot hold a subquery, so the per-element rule lives in a function. It tests the
    -- positive shape and flags an element when that test is not true, so a missing key or a JSON null
    -- (both NULL in SQL) is refused rather than slipping through. Every branch is a CASE because
    -- jsonb_array_elements and jsonb_object_keys raise on a value of another type.
    create function app_private.brand_colors_valid(p_colors jsonb)
    returns boolean
    language sql
    immutable
    parallel safe
    set search_path = ''
    as $function$
      select case
        when p_colors is null then true
        when pg_catalog.jsonb_typeof(p_colors) <> 'array' then false
        when pg_catalog.jsonb_array_length(p_colors) > 24 then false
        else not exists (
          select 1
          from pg_catalog.jsonb_array_elements(p_colors) as color(element)
          where (
            case
              when pg_catalog.jsonb_typeof(color.element) <> 'object' then false
              else (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(color.element)) = 2
                and pg_catalog.jsonb_typeof(color.element -> 'name') = 'string'
                and pg_catalog.jsonb_typeof(color.element -> 'hex') = 'string'
                and pg_catalog.octet_length(color.element ->> 'name') <= 60
                and (color.element ->> 'name') !~ '[\x01-\x1f\x7f]'
                and (color.element ->> 'hex') ~ '^#[0-9A-Fa-f]{6}$'
            end
          ) is not true
        )
      end
    $function$;
    revoke all on function app_private.brand_colors_valid(jsonb) from public;
    grant execute on function app_private.brand_colors_valid(jsonb) to ageniza_app;
  `);

  await knex.raw(`
    alter table public.client_brand_sections
      add constraint client_brand_sections_colors_format check (app_private.brand_colors_valid(colors));
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
