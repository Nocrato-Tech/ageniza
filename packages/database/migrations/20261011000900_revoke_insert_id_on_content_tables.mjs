// `ageniza_app` no longer chooses the `id` of a row of Conteúdo (issue #580). Forward-only, and a new migration: the ones that
// granted `INSERT (id, ...)` are not edited.
//
// Recorded in docs/business/decisions/2026-10-11-id-nao-e-gravavel-no-insert-das-tabelas-do-conteudo.md (structural: it revokes).
//
// The lesson of the grants is that `id` is never writable: a caller that picks the key of its own row can collide with, or
// squat, a key another part of the system derives things from. Five tables of the module carried `id` in their column-level
// INSERT grant although no route, job or seed passes one (every insert reads the id back with `returning id`), so the privilege
// goes away and the default (`gen_random_uuid()`) stays: an INSERT with no `id` is untouched, an INSERT that names one is 42501.
//
// Left as they are, and listed by name in the catalog test with the reason and the issue that retires each (#601): `media_assets`
// (the API makes the id first, because the object keys are built with it and cannot be updated), `client_threads` and
// `client_thread_comments` (the conversation service and the demo seed name the id), `clients` and `client_personas` (the demo
// seed names the id). `content_media` has no `id` column and `notification_queue` already has no INSERT for the role.
//
// Nothing else changes: the catalog test keeps a before-and-after snapshot of every privilege of the five tables and compares it.

const TABLES = ['contents', 'content_tasks', 'story_scripts', 'story_script_scenes', 'media_folders'];

export async function up(knex) {
  for (const table of TABLES) {
    await knex.raw(`revoke insert (id) on public.${table} from ageniza_app`);
  }
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
