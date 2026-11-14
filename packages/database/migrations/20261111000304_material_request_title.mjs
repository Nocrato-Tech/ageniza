// The title of a request for material (scope telas-melhorias, redesign subtask A3).
// Structural: docs/business/decisions/2026-11-11-estrutural-o-pedido-de-material-ganha-titulo.md. No backfill: the requests that exist have
// no title, and the screen uses the start of the description for them.
//
// `title` is nullable in the database and required by the API for a new request, as the decision says, so a request born before this
// migration stays valid. It belongs to a request for material alone (`client_threads_title_request_check`, like `due_on`), is one line of up
// to 80 characters (`display_text_valid`, 20261111000301), and is written once with the thread: the application role gets INSERT and no
// UPDATE, so the title never changes after the thread is born, like the subject and the deadline (20261110000400). The policies are not
// changed, so the portal reads the title through the policy that already lets it read the request, and only the agency opens one
// (`client_threads_material_request_agency_check` holds it whatever a policy says).

export async function up(knex) {
  await knex.raw(`
    alter table public.client_threads
      add column title text null,
      add constraint client_threads_title_check check (app_private.display_text_valid(title, 80)),
      add constraint client_threads_title_request_check check (title is null or is_material_request);

    grant insert (title) on public.client_threads to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
