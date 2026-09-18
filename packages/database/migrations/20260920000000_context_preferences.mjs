// AUTH-20C database domain. This migration is intentionally forward-only: schema and policy
// corrections must be made by a subsequent migration, never by changing an applied file.

export async function up(knex) {
  await knex.raw(`
    create table public.user_context_preferences (
      user_id uuid not null primary key references auth."user"(id),
      context_type text not null check (context_type in ('agency', 'client')),
      agency_id uuid null references public.agencies(id),
      client_id uuid null references public.clients(id),
      updated_at timestamptz not null default now(),
      constraint user_context_preferences_type_fields_check check (
        (context_type = 'agency' and agency_id is not null and client_id is null)
        or (context_type = 'client' and client_id is not null and agency_id is null)
      )
    );

    -- Every table in public is tenant data or authorization data and must be protected.
    alter table public.user_context_preferences enable row level security;
    alter table public.user_context_preferences force row level security;

    grant select, insert, update, delete on public.user_context_preferences to ageniza_app;

    create policy user_context_preferences_select on public.user_context_preferences
      for select to ageniza_app
      using (user_id = app_private.current_user_id());

    create policy user_context_preferences_insert on public.user_context_preferences
      for insert to ageniza_app
      with check (user_id = app_private.current_user_id());

    create policy user_context_preferences_update on public.user_context_preferences
      for update to ageniza_app
      using (user_id = app_private.current_user_id())
      with check (user_id = app_private.current_user_id());

    create policy user_context_preferences_delete on public.user_context_preferences
      for delete to ageniza_app
      using (user_id = app_private.current_user_id());

    -- AUTH-20B (#32) shipped only a select policy for client_memberships; AUTH-20C needs a client
    -- member to record their own onboarding-seen timestamp (POST /clients/:clientId/onboarding/seen),
    -- so this adds the missing update policy, scoped to the member's own row.
    create policy client_memberships_update on public.client_memberships
      for update to ageniza_app
      using (user_id = app_private.current_user_id())
      with check (user_id = app_private.current_user_id());
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
