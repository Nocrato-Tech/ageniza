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
      -- inserting the new one never races into the one-open-request index.
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
      insert into public.email_change_requests (user_id, old_email, new_email)
      values (v_user_id, v_current, v_new)
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
      v_current text;
    begin
      if p_token_hash is null or p_token_hash = '' then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      -- The row lock is what makes the link single-use under two concurrent confirmations.
      select * into v_request from public.email_change_requests request where request.token_hash = p_token_hash for update;
      if not found or v_request.status <> 'approved' or v_request.token_expires_at <= pg_catalog.now() then
        raise exception using errcode = 'A0042', message = 'Link is not valid.';
      end if;

      select account.email into v_current from auth."user" account where account.id = v_request.user_id for update;
      if not found or v_current <> v_request.old_email then
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
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
