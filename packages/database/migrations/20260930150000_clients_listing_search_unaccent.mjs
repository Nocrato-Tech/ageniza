// The client listing (#125) searches by name, razão social and Instagram handle ignoring case AND
// accent (specs/clientes.md §6). PostgreSQL's built-in `unaccent` is what folds accents without a
// generated column or an application-side normalization pass; without it, a search for "padaria"
// would miss "Padária". The extension is schema-qualified (`public.unaccent`) by the query, so it
// is installed in `public` explicitly rather than wherever the search_path happens to point.
//
// Not structural: it creates no table, policy or grant, and the CI migration policy accepts it as a
// new versioned migration. `if not exists` keeps it idempotent against a database where a previous
// attempt already installed it.
export async function up(knex) {
  await knex.raw('create extension if not exists unaccent with schema public');
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
