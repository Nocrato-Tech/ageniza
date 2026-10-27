// The agency's plan, the 14-day trial, its limits and the read-only state after it (issues #708 and #709). Forward-only.
//
// Structural: docs/business/decisions/2026-10-26-estrutural-a-agencia-nasce-pelo-produto-em-trial-de-14-dias.md and
// 2026-10-27-estrutural-o-que-o-somente-leitura-deixa-e-como-o-trial-e-contado.md (what reduces access stays writable,
// counts hold under concurrency, the worker stops mailing an expired agency and media retention keeps running).
//
//  - `agencies.plan` ('trial', 'ativo', 'isenta') and `trial_ends_at`, present exactly when the plan is 'trial'. Every
//    agency that exists today becomes 'isenta' (the default, which only the owner role and the security definer functions can
//    use: the application role has no INSERT on agencies; a trial is only ever created by create_trial_agency).
//  - One trial per account: a partial unique index on the owner, which holds under concurrent creation. An expired trial
//    keeps counting, so the trial is not renewed by creating another agency.
//  - Read-only: a BEFORE trigger, first in name order, on every table that holds agency data refuses insert, update and
//    delete when the agency's trial has ended (A0090). It governs writes made with an actor bound, which is every request
//    of a person, also inside security definer functions (`session_user` stays the application role). The worker writes
//    without an actor (notification bookkeeping, media retention, the scheduled archive): maintenance, not the agency's
//    writes. A request path that writes with no actor (accepting an invitation for a new account) checks explicitly.
//    Reducing access stays writable: removing a collaborator, removing a portal access and cancelling an invitation,
//    each recognised by the exact change of the row (nothing else may change with it).
//  - Limits of an agency in trial: 3 active clients (archived ones do not count) and 3 collaborators, the Owner and the
//    pending collaborator invitations included (portal invitations do not count). Each check takes an advisory lock of
//    the agency, so two concurrent creations cannot both see room for one (A0091, A0092).
//  - `create_trial_agency(name)`: the actor (from the transaction) with a verified e-mail and no other trial becomes Owner
//    with the Admin membership, and the agency gets a storage quota of 2 GiB in `agency_storage_quotas`.
//  - Invitations of an agency whose trial has ended are neither valid nor acceptable, and its notifications stop.
//
// Error codes: A0090 read-only, A0091 client limit, A0092 collaborator limit, A0093 unverified e-mail, A0094 the account
// already has a trial.

const TRIAL_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

const AGENCY_TABLES = ['agency_memberships', 'clients', 'invitations', 'media_assets', 'roles'];
const CLIENT_TABLES = [
  'client_brand_sections',
  'client_memberships',
  'client_personas',
  'client_thread_comments',
  'client_threads',
  'content_media',
  'content_tasks',
  'contents',
  'media_folders',
  'notification_queue',
  'story_script_scenes',
  'story_scripts'
];

const REPLACEMENTS = [
  [
    'app_private.invitation_by_token_hash(text)',
    "and agency.status = 'active'",
    "and agency.status = 'active'\n          and app_private.agency_accepts_writes(agency.id)"
  ],
  [
    'app_private.accept_invitation(text,uuid,text,text,boolean)',
    "or agency.status <> 'active'",
    "or agency.status <> 'active'\n         or not app_private.agency_accepts_writes(agency.id)"
  ],
  [
    'app_private.notification_item_still_holds(text,uuid,uuid,uuid)',
    "and agency.status = 'active'",
    "and agency.status = 'active'\n          and app_private.agency_accepts_writes(agency.id)"
  ]
];

export async function up(knex) {
  await knex.raw(`
    alter table public.agencies add column plan text not null default 'isenta';
    alter table public.agencies add column trial_ends_at timestamptz null;
    alter table public.agencies add constraint agencies_plan_check check (plan in ('trial', 'ativo', 'isenta'));
    alter table public.agencies add constraint agencies_trial_ends_at_check check ((plan = 'trial') = (trial_ends_at is not null));
    create unique index agencies_one_trial_per_owner on public.agencies (owner_user_id) where plan = 'trial';
  `);

  await knex.raw(`
    -- Unknown agency: false, so a typo fails closed.
    create function app_private.agency_accepts_writes(p_agency_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select coalesce(
        (select agency.plan <> 'trial' or agency.trial_ends_at > pg_catalog.now() from public.agencies agency where agency.id = p_agency_id),
        false
      )
    $function$;
    revoke all on function app_private.agency_accepts_writes(uuid) from public;

    -- TG_ARGV[0]: the column that leads to the agency ('agency_id' or 'client_id').
    create function app_private.refuse_write_to_read_only_agency()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then pg_catalog.to_jsonb(old) end;
      v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then pg_catalog.to_jsonb(new) end;
      v_key text;
      v_agency_id uuid;
    begin
      if app_private.role_bypasses_rls(session_user) or app_private.current_user_id() is null then
        return case when tg_op = 'DELETE' then old else new end;
      end if;

      -- What reduces access is accepted whatever the plan: the exact transition and nothing else in the row.
      if tg_op = 'UPDATE' then
        if tg_table_name in ('agency_memberships', 'client_memberships')
           and v_old ->> 'status' = 'active' and v_new ->> 'status' = 'removed'
           and (v_old - array['status', 'updated_at']) = (v_new - array['status', 'updated_at']) then
          return new;
        end if;
        if tg_table_name = 'invitations'
           and v_old ->> 'revoked_at' is null and v_new ->> 'revoked_at' is not null
           and (v_old - 'revoked_at') = (v_new - 'revoked_at') then
          return new;
        end if;
      end if;

      foreach v_key in array array[v_old ->> tg_argv[0], v_new ->> tg_argv[0]] loop
        continue when v_key is null;
        if tg_argv[0] = 'client_id' then
          select client.agency_id into v_agency_id from public.clients client where client.id = v_key::uuid;
        else
          v_agency_id := v_key::uuid;
        end if;
        if v_agency_id is not null and not app_private.agency_accepts_writes(v_agency_id) then
          raise exception using errcode = 'A0090', message = 'The agency is read-only: its trial has ended.';
        end if;
      end loop;
      return case when tg_op = 'DELETE' then old else new end;
    end;
    $function$;
    revoke all on function app_private.refuse_write_to_read_only_agency() from public;
  `);

  for (const table of AGENCY_TABLES) {
    await knex.raw(`
      create trigger "00_${table}_agency_accepts_writes"
        before insert or update or delete on public.${table}
        for each row execute function app_private.refuse_write_to_read_only_agency('agency_id');
    `);
  }
  for (const table of CLIENT_TABLES) {
    await knex.raw(`
      create trigger "00_${table}_agency_accepts_writes"
        before insert or update or delete on public.${table}
        for each row execute function app_private.refuse_write_to_read_only_agency('client_id');
    `);
  }

  await knex.raw(`
    -- Serializes the counts of one agency in trial. Taken only for a trial: other agencies never wait on it.
    create function app_private.lock_trial_limits(p_agency_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if not exists (select 1 from public.agencies agency where agency.id = p_agency_id and agency.plan = 'trial') then
        return false;
      end if;
      -- A snapshot taken once per transaction would count past the lock.
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_trial_limits:' || p_agency_id::text, 0));
      return true;
    end;
    $function$;
    revoke all on function app_private.lock_trial_limits(uuid) from public;

    -- Seats taken by people other than p_user_id/p_email: active memberships, the Owner by possession, pending
    -- collaborator invitations.
    create function app_private.trial_collaborator_seats(p_agency_id uuid, p_user_id uuid, p_email text)
    returns bigint
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        (select pg_catalog.count(distinct seat.user_id) from (
           select membership.user_id
           from public.agency_memberships membership
           where membership.agency_id = p_agency_id and membership.status = 'active'
           union
           select agency.owner_user_id
           from public.agencies agency
           where agency.id = p_agency_id and agency.owner_user_id is not null
         ) seat
         where p_user_id is null or seat.user_id <> p_user_id)
        +
        (select pg_catalog.count(distinct invitation.email)
         from public.invitations invitation
         where invitation.agency_id = p_agency_id
           and invitation.purpose = 'collaborator_invite'
           and invitation.used_at is null
           and invitation.revoked_at is null
           and invitation.expires_at > pg_catalog.now()
           and (p_email is null or invitation.email <> p_email))
    $function$;
    revoke all on function app_private.trial_collaborator_seats(uuid, uuid, text) from public;

    create function app_private.enforce_trial_limits()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_email text;
      v_count bigint;
    begin
      if app_private.role_bypasses_rls(session_user) then
        return new;
      end if;

      if tg_table_name = 'clients' then
        if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
          return new;
        end if;
        -- The count is a statement of its own, after the lock: under READ COMMITTED it sees what the holder committed.
        if not app_private.lock_trial_limits(new.agency_id) then
          return new;
        end if;
        select pg_catalog.count(*) into v_count from public.clients client
        where client.agency_id = new.agency_id and client.status = 'active' and client.id <> new.id;
        if v_count >= 3 then
          raise exception using errcode = 'A0091', message = 'The trial allows at most 3 active clients.';
        end if;
      elsif tg_table_name = 'agency_memberships' then
        if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
          return new;
        end if;
        select person.email into v_email from auth."user" person where person.id = new.user_id;
        if not app_private.lock_trial_limits(new.agency_id) then
          return new;
        end if;
        v_count := app_private.trial_collaborator_seats(new.agency_id, new.user_id, v_email);
        if v_count >= 3 then
          raise exception using errcode = 'A0092', message = 'The trial allows at most 3 collaborators.';
        end if;
      elsif tg_table_name = 'invitations' then
        if new.purpose <> 'collaborator_invite' then
          return new;
        end if;
        if not app_private.lock_trial_limits(new.agency_id) then
          return new;
        end if;
        v_count := app_private.trial_collaborator_seats(new.agency_id, null, new.email);
        if v_count >= 3 then
          raise exception using errcode = 'A0092', message = 'The trial allows at most 3 collaborators.';
        end if;
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.enforce_trial_limits() from public;

    create trigger "01_clients_trial_limits"
      before insert or update of status on public.clients
      for each row execute function app_private.enforce_trial_limits();
    create trigger "01_agency_memberships_trial_limits"
      before insert or update of status on public.agency_memberships
      for each row execute function app_private.enforce_trial_limits();
    create trigger "01_invitations_trial_limits"
      before insert on public.invitations
      for each row execute function app_private.enforce_trial_limits();
  `);

  await knex.raw(`
    -- Whether the actor may create an agency now: a verified e-mail and no agency in trial as Owner, expired or not.
    create function app_private.can_create_trial_agency()
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select app_private.current_user_id() is not null
        and exists (select 1 from auth."user" person where person.id = app_private.current_user_id() and person."emailVerified" = true)
        and not exists (select 1 from public.agencies agency where agency.owner_user_id = app_private.current_user_id() and agency.plan = 'trial')
    $function$;
    revoke all on function app_private.can_create_trial_agency() from public;
    grant execute on function app_private.can_create_trial_agency() to ageniza_app;

    create function app_private.create_trial_agency(p_name text)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_admin_role_id uuid;
      v_agency_id uuid;
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'An agency is created by an authenticated person.';
      end if;
      -- One creation at a time per account; the unique index is the last word.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_trial_agency:' || v_actor::text, 0));
      if not exists (select 1 from auth."user" person where person.id = v_actor and person."emailVerified" = true) then
        raise exception using errcode = 'A0093', message = 'Only an account with a verified e-mail creates an agency.';
      end if;
      if exists (select 1 from public.agencies agency where agency.owner_user_id = v_actor and agency.plan = 'trial') then
        raise exception using errcode = 'A0094', message = 'The account already has an agency in trial.';
      end if;

      select role.id into v_admin_role_id from public.roles role where role.agency_id is null and role.key = 'admin';

      insert into public.agencies (name, status, owner_user_id, plan, trial_ends_at)
      values (p_name, 'active', v_actor, 'trial', pg_catalog.now() + interval '14 days')
      returning id into v_agency_id;

      insert into public.agency_memberships (agency_id, user_id, role_id)
      values (v_agency_id, v_actor, v_admin_role_id);

      insert into public.agency_storage_quotas (agency_id, quota_bytes)
      values (v_agency_id, ${TRIAL_STORAGE_BYTES});

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('agency.created', v_actor, v_agency_id, 'agency', v_agency_id);

      return v_agency_id;
    end;
    $function$;
    revoke all on function app_private.create_trial_agency(text) from public;
    grant execute on function app_private.create_trial_agency(text) to ageniza_app;
  `);

  for (const [signature, before, after] of REPLACEMENTS) {
    const { rows } = await knex.raw('select pg_catalog.pg_get_functiondef(?::pg_catalog.regprocedure) as definition', [signature]);
    const definition = rows[0].definition;
    const occurrences = definition.split(before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${signature} must contain "${before}" exactly once, found ${occurrences}.`);
    }
    await knex.raw(definition.replace(before, () => after));
  }
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
