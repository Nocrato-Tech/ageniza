// Issue #876; structural decision: 2026-11-07-comentarios-da-agencia-durante-producao.
export async function up(knex) {
  await knex.raw(`
    create or replace function app_private.content_open_to_agency_writer(p_content_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1 from public.contents content
        where content.id = p_content_id
          and content.status in ('in_production', 'awaiting_approval', 'adjusting', 'approved', 'published')
          and app_private.has_agency_permission(app_private.client_agency_id(content.client_id), 'conteudo.operar')
          and app_private.has_agency_permission(app_private.client_agency_id(content.client_id), 'conteudo.visualizar')
      )
    $function$;
  `);
}

export async function down() {
  throw new Error('Forward-only migration');
}
