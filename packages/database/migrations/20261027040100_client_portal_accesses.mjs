// The access to a client's portal is given to an e-mail, and the account is optional (issue #711, epic #718).
// Structural: docs/business/decisions/2026-10-26-estrutural-o-acesso-ao-portal-e-por-e-mail-e-a-conta-e-opcional.md.
//
// This file creates `client_portal_accesses`, backfills it from `client_memberships` (removed links included, so Reativar keeps
// working) and ties every membership to the access that originated it. The authorship columns and the notification queue are
// 20261027040200; the single-purpose functions that write the table are 20261027040300.
//
// `ageniza_app` writes nothing here: no INSERT, no UPDATE, no DELETE, no policy for them. The triggers below therefore guard the
// writers that remain (the `security definer` functions of 20261027040300, the owner, operations), and they are written so a
// caller cannot forge the thing they look at: they read the STATE of the two tables, never a setting the caller could set.

export async function up(knex) {
  await knex.raw(`
    create table public.client_portal_accesses (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references public.clients (id) on delete cascade,
      -- Lower case and trimmed, exactly as auth."user".email: the login compares this with the account's address.
      email text not null,
      -- Null until an account with this address, verified, loads its contexts (app_private.link_client_portal_accesses). The cascade and the
      -- set null are for the delete that only the owner can make (a test teardown, a retention purge); the application role has no DELETE.
      user_id uuid references auth."user" (id) on delete set null,
      status text not null default 'active',
      -- What the approval links of the access carry (T7). It only advances, and only when the access is removed.
      generation integer not null default 1,
      -- When the account entered the portal of THIS client (the first time it resolved or selected it). The link alone does not
      -- set it: the link happens at any load of the contexts, and the list of the agency must not turn "ainda não entrou" into
      -- the name of an account just because that account used another agency. Null while nobody has entered.
      first_entered_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint client_portal_accesses_email_check check (
        email = lower(btrim(email)) and email like '%@%' and char_length(email) between 3 and 320
      ),
      constraint client_portal_accesses_status_check check (status in ('active', 'removed')),
      constraint client_portal_accesses_generation_check check (generation >= 1),
      -- One access per address in a client, removed or not: adding a removed address again reactivates this row.
      constraint client_portal_accesses_client_id_email_key unique (client_id, email),
      -- One access per account in a client (several NULLs are allowed: an access without account is nobody's).
      constraint client_portal_accesses_client_id_user_id_key unique (client_id, user_id),
      -- The target of the composite foreign keys that keep an authorship inside the client of its access.
      constraint client_portal_accesses_id_client_id_key unique (id, client_id)
    );

    -- What the link asks at every load of the contexts: the active accesses of an address that no account has taken.
    create index client_portal_accesses_waiting_email_idx on public.client_portal_accesses (email) where user_id is null and status = 'active';

    alter table public.client_portal_accesses enable row level security;
    alter table public.client_portal_accesses force row level security;

    -- Whoever reads the Acessos tab (cliente.convidar_usuario), and whoever removes or reactivates from it (cliente.remover_usuario),
    -- who has to read the access it changes. An access with no account matches no actor here: the policy never looks at user_id.
    create policy client_portal_accesses_select on public.client_portal_accesses
      for select using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.convidar_usuario')
        or app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.remover_usuario')
      );

    revoke all on public.client_portal_accesses from public;
    revoke all on public.client_portal_accesses from ageniza_app;
    grant select on public.client_portal_accesses to ageniza_app;
  `);

  await knex.raw(`
    -- security invoker, OLD against NEW: the identity of the row, the generation and the account never move except the ways below.
    create function app_private.client_portal_access_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if new.generation <> 1 and tg_op = 'INSERT' then
        raise exception using errcode = '42501', message = 'A portal access is born in its first generation.';
      end if;
      if tg_op = 'INSERT' then
        return new;
      end if;

      if (new.id, new.client_id, new.email, new.created_at) is distinct from (old.id, old.client_id, old.email, old.created_at) then
        raise exception using errcode = '42501', message = 'The address and the client of a portal access never change; remove it and add the other address.';
      end if;

      if new.first_entered_at is not null and old.first_entered_at is not null and new.first_entered_at <> old.first_entered_at then
        raise exception using errcode = '42501', message = 'The first entry of an account into a portal is written once.';
      end if;

      if new.generation is distinct from old.generation then
        if not (old.status = 'active' and new.status = 'removed' and new.generation = old.generation + 1) then
          raise exception using errcode = '42501', message = 'The generation of a portal access only advances, and only when it is removed.';
        end if;
      elsif old.status = 'active' and new.status = 'removed' then
        raise exception using errcode = '42501', message = 'Removing a portal access advances its generation.';
      end if;

      -- Account to none (the address changed hands) and none to account (the link) are the two moves; one account never
      -- passes straight to another.
      if old.user_id is not null and new.user_id is not null and new.user_id <> old.user_id then
        raise exception using errcode = '42501', message = 'A portal access never passes straight from one account to another.';
      end if;

      return new;
    end;
    $function$;

    create trigger client_portal_accesses_guard
      before insert or update on public.client_portal_accesses
      for each row execute function app_private.client_portal_access_guard();

    revoke all on function app_private.client_portal_access_guard() from public;
  `);

  // The backfill. Memberships are unique per (client, user) and the address of an account is unique, so no pair collides. The
  // removed ones come along as removed, and every row starts in its first generation: no approval link exists yet.
  await knex.raw(`
    -- The people who are in the portal today have entered it: the list shows them as it did.
    insert into public.client_portal_accesses (client_id, email, user_id, status, first_entered_at, created_at, updated_at)
    select membership.client_id, lower(btrim(account.email)), membership.user_id, membership.status, membership.created_at, membership.created_at, membership.updated_at
    from public.client_memberships membership
    join auth."user" account on account.id = membership.user_id;

    alter table public.client_memberships add column portal_access_id uuid;

    update public.client_memberships membership
    set portal_access_id = access.id
    from public.client_portal_accesses access
    where access.client_id = membership.client_id and access.user_id = membership.user_id;

    alter table public.client_memberships alter column portal_access_id set not null;
    alter table public.client_memberships
      add constraint client_memberships_portal_access_fkey
      foreign key (portal_access_id, client_id) references public.client_portal_accesses (id, client_id);

    -- A removed link stays behind as history when its access passes on to the account that owns the address now, so an access
    -- can have several removed links and at most one active.
    create index client_memberships_portal_access_idx on public.client_memberships (portal_access_id);
    create unique index client_memberships_active_access_key
      on public.client_memberships (portal_access_id) where status = 'active';

    grant select (portal_access_id) on public.client_memberships to ageniza_app;
  `);

  await knex.raw(`
    -- The link only exists in the state its access allows (security invoker; it reads the STATE of the access, which no caller
    -- can set, and not a setting of the transaction).
    --   active  -> the access is active and belongs to the same account;
    --   removed -> the access is removed, or it no longer belongs to this account.
    -- A write that names no access is the legacy writer (a fixture, a restore): it gets the access of the account, created if
    -- it has none, so a membership is never born without one.
    create function app_private.client_membership_follows_access()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_access public.client_portal_accesses%rowtype;
      v_email text;
    begin
      if tg_op = 'INSERT' and new.portal_access_id is null then
        select * into v_access from public.client_portal_accesses where client_id = new.client_id and user_id = new.user_id;
        if not found then
          select lower(btrim(account.email)) into v_email from auth."user" account where account.id = new.user_id;
          select * into v_access from public.client_portal_accesses where client_id = new.client_id and email = v_email and user_id is null;
          if found then
            update public.client_portal_accesses
            set user_id = new.user_id, status = new.status, first_entered_at = pg_catalog.now(),
                generation = generation + case when status = 'active' and new.status = 'removed' then 1 else 0 end
            where id = v_access.id returning * into v_access;
          else
            insert into public.client_portal_accesses (client_id, email, user_id, status, first_entered_at)
            values (new.client_id, v_email, new.user_id, new.status, pg_catalog.now())
            returning * into v_access;
          end if;
        end if;
        new.portal_access_id := v_access.id;
      end if;

      select * into v_access from public.client_portal_accesses where id = new.portal_access_id;
      if not found or v_access.client_id <> new.client_id then
        raise exception using errcode = '42501', message = 'A portal membership follows an access of its own client.';
      end if;

      if new.status = 'active' then
        if v_access.status <> 'active' or v_access.user_id is distinct from new.user_id then
          raise exception using errcode = '42501', message = 'A portal membership is active only while its access is active and belongs to the same account.';
        end if;
      elsif v_access.status = 'active' and v_access.user_id is not distinct from new.user_id then
        raise exception using errcode = '42501', message = 'A portal membership leaves the portal only together with its access.';
      end if;

      return new;
    end;
    $function$;

    create trigger client_memberships_follow_access
      before insert or update of status, user_id, client_id, portal_access_id on public.client_memberships
      for each row execute function app_private.client_membership_follows_access();

    -- The other side, checked when the transaction ends so the writers may order their two statements as they need: an access is
    -- never active and linked without the active membership of its account, nor removed or unlinked with one still active.
    -- security definer: a deferred trigger runs as the role that commits (the application role, when a function of the access
    -- wrote the rows), and that role sees no membership through RLS without an actor. It only raises; it returns nothing.
    create function app_private.client_portal_access_has_its_membership()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_access public.client_portal_accesses%rowtype;
    begin
      -- The row as it is when the transaction ends, not the version this event was queued with: a function writes the same access
      -- more than once.
      select * into v_access from public.client_portal_accesses where id = new.id;
      if not found then
        return null;
      end if;

      if v_access.status = 'active' and v_access.user_id is not null then
        if not exists (
          select 1 from public.client_memberships membership
          where membership.portal_access_id = v_access.id and membership.user_id = v_access.user_id and membership.status = 'active'
        ) then
          raise exception using errcode = '42501', message = 'An active portal access with an account carries the active membership of that account.';
        end if;
      elsif exists (
        select 1 from public.client_memberships membership where membership.portal_access_id = v_access.id and membership.status = 'active'
      ) then
        raise exception using errcode = '42501', message = 'A removed portal access, or one without an account, carries no active membership.';
      end if;
      return null;
    end;
    $function$;

    create constraint trigger client_portal_accesses_have_their_membership
      after insert or update of status, user_id on public.client_portal_accesses
      deferrable initially deferred
      for each row execute function app_private.client_portal_access_has_its_membership();

    revoke all on function app_private.client_membership_follows_access() from public;
    revoke all on function app_private.client_portal_access_has_its_membership() from public;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
