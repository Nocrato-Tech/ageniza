// Two tokens per invitation (issue #706 follow-up, decision 2026-10-27 "o aceite pelo link do e-mail
// confirma o e-mail"). Forward-only, and a new migration: none of the earlier ones is edited.
//
// `token_hash` stays the token that may be copied (it is the only one a pending invitation of before
// this migration has, and those keep creating an unconfirmed account). `email_token_hash` is the one
// that only travels in the e-mail: accepting through it proves the mailbox, and the account is born
// confirmed. Both belong to the same row, so revoking, using or letting expire the row ends both.
//
// 1. The column. `ageniza_app` can write it on insert and never read it: the hash of the token that
//    proves the mailbox has no reason to leave the database, and the lists never select it. The role had
//    SELECT on the whole table, which would have covered the new column, so the table-level SELECT goes
//    and the other columns are granted one by one.
// 2. `invitation_by_token_hash` and `accept_invitation` find the row by either hash, patched from the
//    catalog like 20261027010000 so that nothing else in them is retyped.
// 3. `invitation_token_came_by_email(hash)`, the one way the route learns which token it was given.

const PATCHES = [
  {
    signature: 'app_private.invitation_by_token_hash(text)',
    replacements: [
      ['where invitation.token_hash = p_token_hash', 'where (invitation.token_hash = p_token_hash or invitation.email_token_hash = p_token_hash)']
    ]
  },
  {
    signature: 'app_private.accept_invitation(text, uuid, text, text, boolean)',
    replacements: [
      ['where token_hash = p_token_hash', 'where (token_hash = p_token_hash or email_token_hash = p_token_hash)']
    ]
  }
];

export async function up(knex) {
  await knex.raw(`
    alter table public.invitations add column email_token_hash text unique;
    alter table public.invitations add constraint invitations_email_token_check check (
      email_token_hash is null
      or (email_token_hash <> token_hash and purpose in ('collaborator_invite', 'agency_activation'))
    );
    grant insert (email_token_hash) on public.invitations to ageniza_app;
    revoke select on public.invitations from ageniza_app;
    grant select (
      id, agency_id, purpose, email, role_id, client_id, token_hash, expires_at, used_at, revoked_at,
      invited_by_user_id, accepted_by_user_id, created_at
    ) on public.invitations to ageniza_app;
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
    create function app_private.invitation_token_came_by_email(p_token_hash text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1 from public.invitations invitation where invitation.email_token_hash = p_token_hash
      );
    $function$;

    revoke all on function app_private.invitation_token_came_by_email(text) from public;
    grant execute on function app_private.invitation_token_came_by_email(text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
