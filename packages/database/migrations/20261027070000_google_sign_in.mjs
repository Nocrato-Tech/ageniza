// Sign in with Google (issue #707). Forward-only, and a new migration: none of the earlier ones is edited.
//
// Recorded in docs/business/decisions/2026-10-26-estrutural-entrar-com-google-e-a-conta-que-o-google-assume.md
// and in docs/business/decisions/2026-10-27-estrutural-entrar-com-o-google-o-que-a-implementacao-decidiu.md.
//
// 1. The Google account is identified by its subject (item 5): `auth.account` had no uniqueness on
//    (providerId, accountId), so two accounts could hold the same subject. It now cannot, and one person holds at
//    most one Google identity.
// 2. `auth."user"."passwordChangedAt`: the date the credential of the account was replaced under the person's feet. The
//    session guard refuses a session created before it (the mechanism of issue #719). The application role reads it and
//    never writes it: only the functions below do.
// 3. `app_private.google_sign_in_admission(subject, email)`: the one decision on whether this Google identity may sign in,
//    made in a single transaction with the account locked. It also carries out the takeover of an unconfirmed account.
// 4. `app_private.credential_fingerprint` falls back to the Google subject for an account without a password (item 6).
// 5. `app_private.legal_acceptance_blocks_access`: the Google account that has not accepted the Terms and the Privacy
//    Policy (a new one, or one the Google took over) has no context and cannot create an agency.

const CREATE_TRIAL_AGENCY_GATE = {
  signature: 'app_private.create_trial_agency(text)',
  from: '      select app_private.trial_email_key(person.email) into v_key\n',
  to: `      if app_private.legal_acceptance_blocks_access(v_actor) then
        raise exception using errcode = 'A0096', message = 'The Terms and the Privacy Policy must be accepted first.';
      end if;
      select app_private.trial_email_key(person.email) into v_key\n`
};

const CAN_CREATE_TRIAL_AGENCY_GATE = {
  signature: 'app_private.can_create_trial_agency()',
  from: 'where person.id = app_private.current_user_id() and person."emailVerified" = true)',
  to: 'where person.id = app_private.current_user_id() and person."emailVerified" = true)\n        and not app_private.legal_acceptance_blocks_access(app_private.current_user_id())'
};

const patchFunction = async (knex, { signature, from, to }) => {
  const { rows } = await knex.raw('select pg_catalog.pg_get_functiondef(?::pg_catalog.regprocedure) as definition', [signature]);
  const definition = rows[0].definition;
  const occurrences = definition.split(from).length - 1;
  if (occurrences !== 1) throw new Error(`${signature} must contain ${JSON.stringify(from)} exactly once, found ${occurrences}.`);
  await knex.raw(definition.replace(from, () => to));
};

export async function up(knex) {
  await knex.raw(`
    create unique index account_provider_subject_key on auth."account" ("providerId", "accountId");
    create unique index account_one_google_per_user_key on auth."account" ("userId") where "providerId" = 'google';

    alter table auth."user" add column "passwordChangedAt" timestamptz;
    grant select ("passwordChangedAt") on auth."user" to ageniza_app;
  `);

  await knex.raw(`
    create or replace function app_private.credential_fingerprint(p_user_id uuid)
    returns text
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select coalesce(
        (select pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.string_agg(coalesce(credential.password, ''), '|' order by credential.id), 'UTF8'
           )),
           'hex'
         )
         from auth."account" credential
         where credential."userId" = p_user_id and credential."providerId" = 'credential'
         having pg_catalog.count(*) > 0),
        (select pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.string_agg(google."accountId", '|' order by google.id), 'UTF8'
           )),
           'hex'
         )
         from auth."account" google
         where google."userId" = p_user_id and google."providerId" = 'google'
         having pg_catalog.count(*) > 0)
      );
    $function$;
  `);

  await knex.raw(`
    create function app_private.legal_acceptance_blocks_access(p_user_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (select 1 from auth."account" google where google."userId" = p_user_id and google."providerId" = 'google')
        and not (
          exists (select 1 from public.legal_acceptances accepted
                  where accepted.user_id = p_user_id and accepted.document = 'terms' and accepted.revoked_at is null)
          and exists (select 1 from public.legal_acceptances accepted
                  where accepted.user_id = p_user_id and accepted.document = 'privacy' and accepted.revoked_at is null)
        );
    $function$;
    revoke all on function app_private.legal_acceptance_blocks_access(uuid) from public;
    grant execute on function app_private.legal_acceptance_blocks_access(uuid) to ageniza_app;
  `);

  await patchFunction(knex, CAN_CREATE_TRIAL_AGENCY_GATE);
  await patchFunction(knex, CREATE_TRIAL_AGENCY_GATE);

  await knex.raw(`
    -- The mailbox owner proved the address to Google, so the account that was created with it before them is theirs
    -- (decision 2026-10-26, item 4). Everything the earlier holder could still use dies in the same transaction.
    create function app_private.google_takes_over_account(p_user_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      update auth."user"
      set "emailVerified" = true, "passwordChangedAt" = pg_catalog.clock_timestamp(), "updatedAt" = pg_catalog.now()
      where id = p_user_id;

      delete from auth."account" where "userId" = p_user_id and "providerId" = 'credential';
      delete from auth.session where "userId" = p_user_id;
      delete from auth.verification where value = p_user_id::text;
      delete from public.email_confirmations where user_id = p_user_id and consumed_at is null;

      update public.email_change_requests
      set status = 'superseded', token_hash = null, token_expires_at = null, decided_at = pg_catalog.now()
      where user_id = p_user_id and status in ('pending', 'approved');

      update public.legal_acceptances set revoked_at = pg_catalog.now() where user_id = p_user_id and revoked_at is null;

      insert into audit.events (action, actor_user_id, target_type, target_id)
      values ('auth.google_takeover', p_user_id, 'user', p_user_id);
    end;
    $function$;
    revoke all on function app_private.google_takes_over_account(uuid) from public;
    revoke all on function app_private.google_takes_over_account(uuid) from ageniza_app;

    -- Whether this Google identity (the id token already proved: signed, for this client, with a verified address) may
    -- sign in, and the takeover of the unconfirmed account that holds its address. The subject names the account once it
    -- is linked (item 5); before that the address does, and only an address that nobody holds, or that a confirmed
    -- account or an unconfirmed one holds, goes on. False refuses, and the caller answers it like a wrong credential.
    create function app_private.google_sign_in_admission(p_subject text, p_email text)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
      v_user_id uuid;
      v_owner_email text;
      v_verified boolean;
    begin
      if coalesce(p_subject, '') = '' or v_email = '' then
        return false;
      end if;

      select account.id, account.email into v_user_id, v_owner_email
      from auth."account" linked
      join auth."user" account on account.id = linked."userId"
      where linked."providerId" = 'google' and linked."accountId" = p_subject;
      if found then
        return v_owner_email = v_email;
      end if;

      select account.id, account."emailVerified" into v_user_id, v_verified
      from auth."user" account where account.email = v_email for update;
      if not found then
        return true;
      end if;

      if exists (select 1 from auth."account" linked where linked."userId" = v_user_id and linked."providerId" = 'google') then
        return false;
      end if;

      if not v_verified then
        perform app_private.google_takes_over_account(v_user_id);
      end if;
      return true;
    end;
    $function$;
    revoke all on function app_private.google_sign_in_admission(text, text) from public;
    grant execute on function app_private.google_sign_in_admission(text, text) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
