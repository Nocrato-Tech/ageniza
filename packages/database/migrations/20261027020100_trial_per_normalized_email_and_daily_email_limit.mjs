// One trial per normalized e-mail and the daily e-mail limit of an agency (review of #725). Forward-only.
//
// Structural: docs/business/decisions/2026-10-26-estrutural-a-agencia-nasce-pelo-produto-em-trial-de-14-dias.md, items 7
// and 8, and 2026-10-27-estrutural-o-que-o-somente-leitura-deixa-e-como-o-trial-e-contado.md.
//
//  - `app_private.trial_email_key(email)`: lower case, without the `+alias` and, in gmail.com and googlemail.com, without
//    dots and with the domain unified. `agencies.trial_owner_email_key` keeps the key of the Owner for an agency in trial,
//    and a partial unique index on it holds the rule under concurrency. `create_trial_agency` computes the key, takes an
//    advisory lock on it and checks it before inserting; the per-owner index stays as a second barrier.
//  - The daily e-mail limit: every invitation the agency sends (collaborator and portal, created or resent: each one is a
//    new row of `invitations`) counts in the day of São Paulo. 20 a day in trial and 200 otherwise, or
//    `agencies.daily_email_limit` when the operation sets it. The count waits for an advisory lock of the agency and runs
//    only under READ COMMITTED. Past the limit: A0095, and nothing is written.

const TRIAL_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

export async function up(knex) {
  await knex.raw(`
    create function app_private.trial_email_key(p_email text)
    returns text
    language plpgsql
    immutable
    set search_path = ''
    as $function$
    declare
      v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
      v_at integer;
      v_local text;
      v_domain text;
    begin
      if v_email is null then
        return null;
      end if;
      v_at := pg_catalog.length(v_email) - pg_catalog.strpos(pg_catalog.reverse(v_email), '@') + 1;
      if pg_catalog.strpos(v_email, '@') = 0 then
        return v_email;
      end if;
      v_local := pg_catalog.substr(v_email, 1, v_at - 1);
      v_domain := pg_catalog.substr(v_email, v_at + 1);
      v_local := pg_catalog.split_part(v_local, '+', 1);
      if v_domain in ('gmail.com', 'googlemail.com') then
        v_local := pg_catalog.replace(v_local, '.', '');
        v_domain := 'gmail.com';
      end if;
      return v_local || '@' || v_domain;
    end;
    $function$;
    revoke all on function app_private.trial_email_key(text) from public;

    alter table public.agencies add column trial_owner_email_key text null;
    update public.agencies agency
       set trial_owner_email_key = app_private.trial_email_key(person.email)
      from auth."user" person
     where person.id = agency.owner_user_id and agency.plan = 'trial';
    alter table public.agencies add constraint agencies_trial_owner_email_key_check
      check (plan <> 'trial' or trial_owner_email_key is not null);
    create unique index agencies_one_trial_per_email_key on public.agencies (trial_owner_email_key) where plan = 'trial';

    alter table public.agencies add column daily_email_limit integer null;
    alter table public.agencies add constraint agencies_daily_email_limit_check
      check (daily_email_limit is null or daily_email_limit between 0 and 100000);
  `);

  await knex.raw(`
    create or replace function app_private.can_create_trial_agency()
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select app_private.current_user_id() is not null
        and exists (select 1 from auth."user" person where person.id = app_private.current_user_id() and person."emailVerified" = true)
        and not exists (
          select 1 from public.agencies agency
          where agency.plan = 'trial'
            and (agency.owner_user_id = app_private.current_user_id()
                 or agency.trial_owner_email_key = (
                   select app_private.trial_email_key(person.email) from auth."user" person where person.id = app_private.current_user_id())))
    $function$;

    create or replace function app_private.create_trial_agency(p_name text)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_key text;
      v_admin_role_id uuid;
      v_agency_id uuid;
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'An agency is created by an authenticated person.';
      end if;
      select app_private.trial_email_key(person.email) into v_key
      from auth."user" person where person.id = v_actor and person."emailVerified" = true;
      if v_key is null then
        raise exception using errcode = 'A0093', message = 'Only an account with a verified e-mail creates an agency.';
      end if;
      -- One creation at a time per normalized e-mail and per account; the unique indexes are the last word.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_trial_agency:' || v_key, 0));
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('create_trial_agency:' || v_actor::text, 0));
      if exists (
        select 1 from public.agencies agency
        where agency.plan = 'trial' and (agency.owner_user_id = v_actor or agency.trial_owner_email_key = v_key)
      ) then
        raise exception using errcode = 'A0094', message = 'The account already has an agency in trial.';
      end if;

      select role.id into v_admin_role_id from public.roles role where role.agency_id is null and role.key = 'admin';

      insert into public.agencies (name, status, owner_user_id, plan, trial_ends_at, trial_owner_email_key)
      values (p_name, 'active', v_actor, 'trial', pg_catalog.now() + interval '14 days', v_key)
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
  `);

  await knex.raw(`
    create function app_private.agency_daily_email_limit(p_agency_id uuid)
    returns integer
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select coalesce(agency.daily_email_limit, case when agency.plan = 'trial' then 20 else 200 end)
      from public.agencies agency where agency.id = p_agency_id
    $function$;
    revoke all on function app_private.agency_daily_email_limit(uuid) from public;

    create function app_private.enforce_daily_email_limit()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_limit integer;
      v_count bigint;
    begin
      if app_private.role_bypasses_rls(session_user) or new.purpose not in ('collaborator_invite', 'client_invite') then
        return new;
      end if;
      perform app_private.require_read_committed();
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agency_daily_email_limit:' || new.agency_id::text, 0));
      v_limit := app_private.agency_daily_email_limit(new.agency_id);
      -- An unknown agency is refused by the policy and the foreign key, not here.
      if v_limit is null then
        return new;
      end if;
      -- A statement of its own, after the lock, so it sees what the holder committed. The last two days by instant
      -- narrow the index range; the day of São Paulo decides.
      select pg_catalog.count(*) into v_count
      from public.invitations invitation
      where invitation.agency_id = new.agency_id
        and invitation.purpose in ('collaborator_invite', 'client_invite')
        and invitation.created_at > pg_catalog.now() - interval '2 days'
        and app_private.sao_paulo_date(invitation.created_at) = app_private.sao_paulo_date(pg_catalog.now());
      if v_count >= v_limit then
        raise exception using errcode = 'A0095', message = 'The agency reached its daily e-mail limit.';
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.enforce_daily_email_limit() from public;

    create index invitations_agency_created_at on public.invitations (agency_id, created_at);

    create trigger "02_invitations_daily_email_limit"
      before insert on public.invitations
      for each row execute function app_private.enforce_daily_email_limit();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
