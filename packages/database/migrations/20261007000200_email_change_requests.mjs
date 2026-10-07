// Account e-mail change by request (issue #80). Forward-only, like every migration here.
//
// docs/business/decisions.md, 2026-10-07 ("A troca de e-mail da conta é um pedido à operação, não
// uma edição"). `auth."user"` is global, so the request goes to the platform operation and not to
// an agency: the operation approves through the CLI, the approval issues a single-use link to the
// NEW address, and following it swaps the address and ends every session of the account.
//
// The table is written only by the three paths below and read by none of the application role:
// the default privileges of schema `public` would hand `ageniza_app` full DML on it, so they are
// revoked outright. The people never read their own request (the screen has no status to show), and
// the CLI connects as the migration owner.
//
//   app_private.request_email_change  the signed-in person's request (actor-bound)
//   app_private.confirm_email_change  the link in the new mailbox (public, token-bound)
//   the CLI (apps/api/src/cli/email-change.ts) approves, rejects and lists as the owner
//
// `security definer` runs as the schema owner and ignores RLS, so every check is written inside
// each function and every object is schema-qualified under `set search_path = ''`.
//
// Stable error codes, so the API can translate them without parsing messages:
//   A0040 -> no actor is bound to the transaction
//   A0041 -> the new address is malformed
//   A0042 -> the link is not valid (unknown, used, expired, superseded, or the swap is no longer
//            possible); one error for all, so the response is never an oracle
//   A0043 -> the new address is the one the account already has
//
// A request is only as good as the credential that existed when it was made. The notice sent to the
// current address says "if it was not you, change the password", so changing the password must undo
// the request, and two barriers hold that (security review of PR #325, 2026-10-07):
//   1. app_private.supersede_email_change_requests, called by the password reset, closes the open
//      requests of the account whose credential no longer matches the one recorded at request time;
//   2. the request records a fingerprint of the credential, and both the approval (CLI) and
//      confirm_email_change refuse a request whose fingerprint is no longer the account's, whether or
//      not barrier 1 ran (a hook that failed, a password changed by a path that does not call it).

export async function up(knex) {
  await knex.raw(`
    create table public.email_change_requests (
      id uuid not null default gen_random_uuid() primary key,
      user_id uuid not null references auth."user"(id) on delete cascade,
      old_email text not null,
      new_email text not null,
      status text not null default 'pending'
        check (status in ('pending', 'approved', 'rejected', 'completed', 'superseded')),
      token_hash text null,
      token_expires_at timestamptz null,
      ownership_confirmed_at timestamptz null,
      credential_fingerprint text null,
      requested_at timestamptz not null default now(),
      decided_at timestamptz null,
      completed_at timestamptz null,
      constraint email_change_requests_old_email_normalized check (old_email = lower(btrim(old_email))),
      constraint email_change_requests_new_email_normalized check (
        new_email = lower(btrim(new_email)) and char_length(new_email) between 3 and 320
      ),
      constraint email_change_requests_token_pair check ((token_hash is null) = (token_expires_at is null)),
      constraint email_change_requests_token_only_when_approved check ((status = 'approved') = (token_hash is not null))
    );

    -- One open request per account: a new one supersedes the previous before it is inserted.
    create unique index email_change_requests_one_open_per_user
      on public.email_change_requests (user_id) where status in ('pending', 'approved');
    create unique index email_change_requests_token_hash_key
      on public.email_change_requests (token_hash) where token_hash is not null;

    alter table public.email_change_requests enable row level security;
    alter table public.email_change_requests force row level security;
    revoke all on public.email_change_requests from ageniza_app;
  `);

  await knex.raw(`
    -- SHA-256 of the account's credential hash, never the hash itself: the request only needs to know
    -- whether the credential is still the one it was made under. A reset salts a new hash, so even
    -- the same password yields a different fingerprint. Null when the account has no credential.
    -- Internal to the functions below and to the CLI (which runs as the owner): not granted to the
    -- application role.
    create function app_private.credential_fingerprint(p_user_id uuid)
    returns text
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.string_agg(coalesce(credential.password, ''), '|' order by credential.id), 'UTF8'
        )),
        'hex'
      )
      from auth."account" credential
      where credential."userId" = p_user_id and credential."providerId" = 'credential'
      having pg_catalog.count(*) > 0;
    $function$;
    revoke all on function app_private.credential_fingerprint(uuid) from public;
    revoke all on function app_private.credential_fingerprint(uuid) from ageniza_app;
  `);

  await knex.raw(`
    create function app_private.request_email_change(p_new_email text)
    returns table (request_id uuid, previous_email text)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_user_id uuid := app_private.current_user_id();
      v_current text;
      v_new text;
      v_request_id uuid;
    begin
      if v_user_id is null then
        raise exception using errcode = 'A0040', message = 'An authenticated user is required.';
      end if;

      v_new := pg_catalog.lower(pg_catalog.btrim(coalesce(p_new_email, '')));
      if pg_catalog.char_length(v_new) > 320
         or v_new !~ '^[^[:space:]@<>]+@[^[:space:]@<>.]+\\.[^[:space:]@<>]+$'
      then
        raise exception using errcode = 'A0041', message = 'The new e-mail address is malformed.';
      end if;

      -- Serializes concurrent requests of the same account, so superseding the open one and
      -- inserting the new one never races into the one-open-request index. It is also the first of
      -- the two locks every path takes in the same order: the account, then its requests.
      select account.email into v_current from auth."user" account where account.id = v_user_id for update;
      if not found then
        raise exception using errcode = 'A0040', message = 'An authenticated user is required.';
      end if;

      if v_new = v_current then
        raise exception using errcode = 'A0043', message = 'The new e-mail address is the current one.';
      end if;

      update public.email_change_requests open_request
      set status = 'superseded',
          token_hash = null,
          token_expires_at = null,
          decided_at = pg_catalog.now()
      where open_request.user_id = v_user_id and open_request.status in ('pending', 'approved');

      -- The address is recorded whether or not another account already uses it: the answer to the
      -- person is the same either way, and the operation sees the collision when it approves.
      insert into public.email_change_requests (user_id, old_email, new_email, credential_fingerprint)
      values (v_user_id, v_current, v_new, app_private.credential_fingerprint(v_user_id))
      returning id into v_request_id;

      insert into audit.events (action, actor_user_id, target_type, target_id)
      values ('email_change.requested', v_user_id, 'email_change_request', v_request_id);

      return query select v_request_id, v_current;
    end;
    $function$;
    revoke all on function app_private.request_email_change(text) from public;
    grant execute on function app_private.request_email_change(text) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.confirm_email_change(p_token_hash text)
    returns table (account_id uuid, previous_email text, next_email text)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_request public.email_change_requests%rowtype;
      v_user_id uuid;
      v_current text;
    begin
      if p_token_hash is null or p_token_hash = '' then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      -- One lock order for everything that touches a request: the ACCOUNT first, then its requests.
      -- request_email_change and the CLI's approval take them in that order, so this one must too, or
      -- a request and a confirmation on the same account deadlock (40P01). The account is only known
      -- through the request, so the request is read without a lock, the account is locked, and the
      -- request is then locked and read again: whatever changed in between is seen by the second read.
      select request.user_id into v_user_id from public.email_change_requests request where request.token_hash = p_token_hash;
      if not found then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      select account.email into v_current from auth."user" account where account.id = v_user_id for update;
      if not found then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      -- The row lock is what makes the link single-use under two concurrent confirmations.
      select * into v_request from public.email_change_requests request where request.token_hash = p_token_hash for update;
      if not found or v_request.user_id <> v_user_id or v_request.status <> 'approved'
         or v_request.token_expires_at <= pg_catalog.now() or v_current <> v_request.old_email
      then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      -- The credential changed after the request (the person reset the password, as the notice told
      -- them to): whoever asked may not have been them, so the link is dead. Same answer as any other
      -- dead link.
      if v_request.credential_fingerprint is distinct from app_private.credential_fingerprint(v_user_id) then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      -- An agency owner's swap needs the holder confirmed outside the product, at approval. The
      -- account may have become an owner between the approval and now (accepting an activation
      -- invitation), so the approval's record is checked again here.
      if v_request.ownership_confirmed_at is null
         and exists (select 1 from public.agencies agency where agency.owner_user_id = v_user_id)
      then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      -- Addresses are stored normalized (user_email_normalized), so equality is the whole check.
      if exists (select 1 from auth."user" other where other.email = v_request.new_email) then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      begin
        update auth."user"
        set email = v_request.new_email, "emailVerified" = true, "updatedAt" = pg_catalog.now()
        where id = v_request.user_id;
      exception when unique_violation then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end;

      -- Every session ends, and so does any password-reset link already sent to the old mailbox:
      -- whoever still reads it must not be able to take the account over after the swap.
      delete from auth.session where "userId" = v_request.user_id;
      delete from auth.verification where value = v_request.user_id::text;

      update public.email_change_requests
      set status = 'completed', completed_at = pg_catalog.now(), token_hash = null, token_expires_at = null
      where id = v_request.id;

      insert into audit.events (action, actor_user_id, target_type, target_id)
      values ('email_change.completed', v_request.user_id, 'email_change_request', v_request.id);

      return query select v_request.user_id, v_request.old_email, v_request.new_email;
    end;
    $function$;
    revoke all on function app_private.confirm_email_change(text) from public;
    grant execute on function app_private.confirm_email_change(text) to ageniza_app;
  `);

  await knex.raw(`
    -- Barrier 1: called by the password reset right after the new credential is stored. It closes
    -- the open requests of the account that were made under another credential, which also kills
    -- their link. It takes the account lock first, like every path (see confirm_email_change).
    -- It only ever closes what barrier 2 would refuse anyway, so it is harmless to anyone who calls it
    -- without having changed the credential: nothing is cancelled for a credential that did not move.
    create function app_private.supersede_email_change_requests(p_user_id uuid)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_closed integer;
    begin
      if p_user_id is null then
        return 0;
      end if;

      perform 1 from auth."user" account where account.id = p_user_id for update;

      with closed as (
        update public.email_change_requests open_request
        set status = 'superseded',
            token_hash = null,
            token_expires_at = null,
            decided_at = pg_catalog.now()
        where open_request.user_id = p_user_id
          and open_request.status in ('pending', 'approved')
          and open_request.credential_fingerprint is distinct from app_private.credential_fingerprint(p_user_id)
        returning open_request.id
      ), audited as (
        insert into audit.events (action, actor_user_id, target_type, target_id)
        select 'email_change.superseded_by_credential', p_user_id, 'email_change_request', closed.id from closed
        returning 1
      )
      select pg_catalog.count(*)::integer into v_closed from audited;

      return v_closed;
    end;
    $function$;
    revoke all on function app_private.supersede_email_change_requests(uuid) from public;
    grant execute on function app_private.supersede_email_change_requests(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
