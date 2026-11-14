// Issue #893, specs/auth.md section 14. Forward-only, and a new migration: none of the earlier ones is edited.
//
// Recorded in docs/business/decisions/2026-11-11-estrutural-sessoes-ativas-na-conta-com-cidade-do-cabecalho-do-cloudflare.md.
//
// `auth."session"` gains the approximate city the session was created from, shown to the person on the list of their own
// sessions. It is informational: no decision of security reads it. Nullable, with no default and no backfill (a session
// that exists today keeps no city), and the API never reads it from anything but the creation of the session.
//
// 1. The CHECK keeps what reaches the row small and printable: 1 to 80 characters (not bytes) and no control character
//    (C0, DEL and C1). The API cleans the header harder than this (bidi and invisible characters, white space at the ends)
//    and never sends a value this CHECK would refuse: a login must not fail because of a city.
// 2. The application role writes the city when the session is created and never changes it: UPDATE on `auth."session"`
//    becomes a grant by column, every column that exists except `city`. It keeps SELECT and INSERT of the whole table, and
//    the row lock (`for update`) still works, because the column-level UPDATE that is left is enough for it.

export async function up(knex) {
  await knex.raw(String.raw`
    alter table auth."session"
      add column "city" text,
      add constraint session_city_clean
        check ("city" is null or (char_length("city") between 1 and 80 and "city" !~ '[\x01-\x1f\x7f-\x9f]'));
  `);

  const { rows } = await knex.raw(
    `select column_name from information_schema.columns
     where table_schema = 'auth' and table_name = 'session' and column_name <> 'city' order by ordinal_position`
  );
  const columns = rows.map((row) => `"${row.column_name}"`).join(', ');
  await knex.raw(`
    revoke update on auth."session" from ageniza_app;
    grant update (${columns}) on auth."session" to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
