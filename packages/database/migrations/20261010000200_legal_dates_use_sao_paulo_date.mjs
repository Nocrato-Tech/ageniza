// Legal dates (issue #373). Forward-only, and a new migration: none of the earlier ones is edited.
//
// Recorded in docs/business/decisions/2026-10-10-a-data-legal-usa-a-funcao-pura-do-fuso-de-sao-paulo.md.
//
// `accept_legal_document` and `accept_invitation` still computed "today" inline, as
// `now() at time zone 'America/Sao_Paulo'`, so no test could tell Brasília from UTC (they differ
// between 21:00 and 24:00 there). Both now ask `app_private.sao_paulo_date`, the pure function of an
// instant that 20261007001000_client_dates_in_brasilia.mjs introduced and a test calls at a fixed
// instant.
//
// `accept_invitation` is 200 lines of authentication code, so the definition is read from the
// catalog and only the one expression is replaced, instead of copying the whole body again: the
// result differs from what is deployed in that expression and in nothing else, and `create or
// replace` keeps owner and grants. The migration fails when the expression is not found exactly once.

const INLINE_TODAY = "(pg_catalog.now() at time zone 'America/Sao_Paulo')::date";
const PURE_TODAY = 'app_private.sao_paulo_date(pg_catalog.now())';

const FUNCTIONS = [
  'app_private.accept_legal_document(text, text)',
  'app_private.accept_invitation(text, uuid, text, text, boolean)'
];

export async function up(knex) {
  for (const signature of FUNCTIONS) {
    const { rows } = await knex.raw('select pg_catalog.pg_get_functiondef(?::pg_catalog.regprocedure) as definition', [signature]);
    const definition = rows[0].definition;
    const occurrences = definition.split(INLINE_TODAY).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${signature} must compute today inline exactly once, found ${occurrences}.`);
    }
    await knex.raw(definition.replace(INLINE_TODAY, () => PURE_TODAY));
  }
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
