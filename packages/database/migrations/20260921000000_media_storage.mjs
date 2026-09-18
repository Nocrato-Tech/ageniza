// STORAGE-21 database domain. This migration is intentionally forward-only: schema and policy
// corrections must be made by a subsequent migration, never by changing an applied file.
//
// `media_assets` tracks direct-to-R2 uploads (issue #21). A row is created *before* the browser
// uploads anything (status 'pending'), so the object key -- and therefore tenant isolation -- is
// decided by the API, never by client input. `confirmed_size_bytes`/`confirmed_content_type` are
// filled in only from a server-side HeadObject after upload; they are never trusted from the client.

export async function up(knex) {
  await knex.raw(`
    create table public.media_assets (
      id uuid not null default gen_random_uuid() primary key,
      agency_id uuid not null references public.agencies(id),
      category text not null check (category in ('image', 'video')),
      declared_content_type text not null check (btrim(declared_content_type) <> ''),
      extension text not null check (extension ~ '^[a-z0-9]{1,10}$'),
      object_key text not null unique,
      status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
      declared_size_bytes bigint not null check (declared_size_bytes > 0),
      confirmed_size_bytes bigint null check (confirmed_size_bytes is null or confirmed_size_bytes > 0),
      confirmed_content_type text null,
      multipart_upload_id text null,
      rejected_reason text null,
      created_by_user_id uuid not null references auth."user"(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      confirmed_at timestamptz null,
      -- The object key is minted by the API from (agency_id, id, extension) and never from client
      -- input; this keeps every row's key in exactly one agency's namespace by construction.
      constraint media_assets_object_key_shape check (
        object_key = agency_id::text || '/' || id::text || '/original.' || extension
      )
    );
    create index media_assets_agency_status_idx on public.media_assets (agency_id, status);

    -- Per-tenant override of the default quota (STORAGE_QUOTA_DEFAULT_BYTES/_OBJECT_COUNT). A
    -- missing row means "use the deployment default"; usage itself is computed on demand from
    -- media_assets (status = 'confirmed'), not tracked by a running counter here.
    create table public.agency_storage_quotas (
      agency_id uuid not null primary key references public.agencies(id),
      quota_bytes bigint null check (quota_bytes is null or quota_bytes > 0),
      quota_object_count bigint null check (quota_object_count is null or quota_object_count > 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    -- Every table in public is tenant data or authorization data and must be protected.
    alter table public.media_assets enable row level security;
    alter table public.media_assets force row level security;
    alter table public.agency_storage_quotas enable row level security;
    alter table public.agency_storage_quotas force row level security;

    -- No delete grant: a rejected upload keeps its row as history. The object itself is removed
    -- from the bucket by the API before the row is marked 'rejected'.
    grant select, insert, update on public.media_assets to ageniza_app;
    grant select on public.agency_storage_quotas to ageniza_app;

    insert into public.permissions (key, description) values
      ('midia.enviar', 'Enviar e confirmar arquivos de mídia para a agência.');

    insert into public.role_permissions (role_id, permission_key)
    select role.id, permission.key
    from public.roles role
    cross join public.permissions permission
    where role.agency_id is null
      and role.key = 'admin'
      and permission.key = 'midia.enviar';

    create policy media_assets_select on public.media_assets
      for select to ageniza_app
      using (app_private.has_agency_permission(agency_id, 'midia.enviar'));

    create policy media_assets_insert on public.media_assets
      for insert to ageniza_app
      with check (app_private.has_agency_permission(agency_id, 'midia.enviar'));

    create policy media_assets_update on public.media_assets
      for update to ageniza_app
      using (app_private.has_agency_permission(agency_id, 'midia.enviar'))
      with check (app_private.has_agency_permission(agency_id, 'midia.enviar'));

    create policy agency_storage_quotas_select on public.agency_storage_quotas
      for select to ageniza_app
      using (app_private.has_agency_permission(agency_id, 'midia.enviar'));
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
