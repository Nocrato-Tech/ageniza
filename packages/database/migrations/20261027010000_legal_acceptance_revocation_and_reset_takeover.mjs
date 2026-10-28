// Public sign-up (issue #706). Forward-only, and a new migration: none of the earlier ones is edited.
//
// Recorded in docs/business/decisions/2026-10-26-estrutural-cadastro-publico-com-e-mail-e-senha-e-confirmacao.md
// (item 5) and in the decision of the same day on Google (Consequência): resetting the password of an
// unconfirmed account takes it over, and the Terms acceptance whoever signed up recorded is revoked, so
// the owner of the mailbox accepts again. The row stays, with `revoked_at`.
//
// 1. `legal_acceptances.revoked_at`, and the one-row-per-version rule becomes partial: after a
//    revocation, accepting the same version records a new row.
// 2. `accept_legal_document` and `accept_invitation` read the definition from the catalog and replace
//    only the expressions that must ignore revoked rows (like 20261010000200), failing when an
//    expression is not found exactly once.
// 3. `app_private.confirm_email_by_password_reset(user_id)`, the one path the reset takes: it acts only
//    on an unconfirmed account, so it can never revoke a confirmed account's acceptances.

const PATCHES = [
  {
    signature: 'app_private.accept_legal_document(text, text)',
    replacements: [
      ['and accepted.version collate "C" >= p_version collate "C"', 'and accepted.version collate "C" >= p_version collate "C"\n          and accepted.revoked_at is null'],
      ['on conflict (user_id, document, version) do nothing', 'on conflict (user_id, document, version) where revoked_at is null do nothing']
    ]
  },
  {
    signature: 'app_private.accept_invitation(text, uuid, text, text, boolean)',
    replacements: [
      ['on conflict (user_id, document, version) do nothing', 'on conflict (user_id, document, version) where revoked_at is null do nothing']
    ]
  }
];

export async function up(knex) {
  await knex.raw(`
    alter table public.legal_acceptances add column revoked_at timestamptz;
    alter table public.legal_acceptances drop constraint legal_acceptances_user_id_document_version_key;
    create unique index legal_acceptances_active_version_key
      on public.legal_acceptances (user_id, document, version)
      where revoked_at is null;
  `);

  for (const { signature, replacements } of PATCHES) {
    const { rows } = await knex.raw('select pg_catalog.pg_get_functiondef(?::pg_catalog.regprocedure) as definition', [signature]);
    let definition = rows[0].definition;
    for (const [from, to] of replacements) {
      const occurrences = definition.split(from).length - 1;
      if (occurrences !== 1) throw new Error(`${signature} must contain "${from}" exactly once, found ${occurrences}.`);
      definition = definition.replace(from, () => to);
    }
    await knex.raw(definition);
  }

  await knex.raw(`
    create function app_private.confirm_email_by_password_reset(p_user_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $$
    begin
      update auth."user"
      set "emailVerified" = true, "updatedAt" = pg_catalog.now()
      where id = p_user_id and "emailVerified" = false;
      if not found then
        return false;
      end if;

      update public.legal_acceptances
      set revoked_at = pg_catalog.now()
      where user_id = p_user_id and revoked_at is null;

      delete from auth.verification
      where value = p_user_id::text and identifier like 'email-verification:%';

      return true;
    end;
    $$;

    revoke all on function app_private.confirm_email_by_password_reset(uuid) from public;
    grant execute on function app_private.confirm_email_by_password_reset(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
