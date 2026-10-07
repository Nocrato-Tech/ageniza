// Issues #247 and #371. Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-10-01-conteudo-impacto-estrutural.md (points 1 and 6) and the
// two 2026-10-07 files that record the choices made here (`conteudo-pastas-de-midia-e-midia-com-cliente-no-banco`
// and `o-banco-carimba-o-autor-e-a-confirmacao-da-midia`). It alters `media_assets` and `clients`, replaces the
// `media_assets` policies and backfills the default folders.
//
// #247 -- Conteúdo's database foundation for the media library (specs/conteudo.md §2, §3, §6):
//
//  1. The five `conteudo.*` permissions and their presets. Sales and Finance get none.
//  2. `media_folders`: a client's folders, two levels at most. The level is enforced by foreign keys
//     over generated columns, not by a trigger, so it holds for every writer and under concurrency:
//     a parent must be a first-level folder of the same client. `is_default` is set only by the
//     `security definer` function below; `ageniza_app` writes `client_id`, `parent_id` and `name`
//     on INSERT and `name` of a non-default folder on UPDATE, never DELETE.
//  3. `media_assets.client_id`, `folder_id` and `removed_at`. A folder and a client of the media must
//     be the same client and the same agency (composite foreign keys). A column born here has no
//     write grant until a writer needs it: INSERT of `client_id` and `folder_id` (the upload),
//     nothing for `removed_at`, which arrives with the migration that guards "media used by an
//     approved content cannot be removed" (rule 12), and no UPDATE of the two others.
//  4. Policies: a media without client keeps `midia.enviar`; a media of a client is read with
//     `conteudo.visualizar` and written with `conteudo.operar`. Nothing here lets a portal link read
//     a folder or a media.
//  5. The four default folders for every existing client (backfill) and for each new one (trigger).
//     The function is idempotent: a partial unique index plus `on conflict do nothing`.
//
// #371 -- what the caller could still choose on `media_assets` after #295:
//
//  - `created_by_user_id` leaves the INSERT grant and defaults to the actor bound in the
//    transaction (`app_private.current_user_id()`), so nobody can author a media as someone else.
//  - `confirmed_at` leaves the UPDATE grant; the trigger stamps it on the pending -> confirmed
//    transition.
//  - The trigger gains the direction of `video_processing_status` (not_applicable|pending ->
//    processing -> ready|failed, retry processing -> pending; leaving not_applicable only with the
//    confirmation), the result columns written once with `ready`, and `multipart_upload_id` set
//    once while the upload is pending. Same shape as #295: security invoker, only for
//    `current_user = 'ageniza_app'`, reading OLD after the row lock.
//
// `select ... for update` keeps working for `ageniza_app` on `media_assets` (the upload and the worker
// lock the row): it needs UPDATE on some column, and the column grants stay. Nothing here revokes UPDATE
// from a whole table.

export async function up(knex) {
  await knex.raw(`
    insert into public.permissions (key, description) values
      ('conteudo.visualizar', 'Ver calendário, conteúdos, comentários, subtarefas, pastas e roteiros.'),
      ('conteudo.operar', 'Criar e editar conteúdo, gerir pastas e mídia, comentar, criar subtarefas, enviar para aprovação e roteirizar stories.'),
      ('conteudo.publicar', 'Marcar conteúdo como publicado e desfazer no mesmo dia.'),
      ('conteudo.aprovar_pela_agencia', 'Registrar aprovado fora da plataforma e substituir o responsável na aprovação de subtarefa.'),
      ('conteudo.cancelar', 'Cancelar conteúdo, que continua guardado.');

    insert into public.role_permissions (role_id, permission_key)
    select role.id, preset.permission_key
    from public.roles role
    join (
      values
        ('conteudo.visualizar', array['admin', 'account_manager', 'production']),
        ('conteudo.operar', array['admin', 'account_manager', 'production']),
        ('conteudo.publicar', array['admin', 'account_manager', 'production']),
        ('conteudo.aprovar_pela_agencia', array['admin', 'account_manager']),
        ('conteudo.cancelar', array['admin', 'account_manager'])
    ) as preset(permission_key, role_keys) on role.key = any(preset.role_keys)
    where role.agency_id is null;
  `);

  await knex.raw(`
    alter table public.clients
      add constraint clients_id_agency_id_key unique (id, agency_id);

    create table public.media_folders (
      id uuid not null default gen_random_uuid() primary key,
      client_id uuid not null references public.clients(id) on delete cascade,
      parent_id uuid null,
      -- chr(160) is NBSP, spelled out because a bare btrim leaves a tab or a no-break space as a name.
      name text not null check (
        btrim(regexp_replace(replace(name, chr(160), ' '), '[[:space:]]+', ' ', 'g')) <> '' and octet_length(name) <= 256
      ),
      is_default boolean not null default false,
      created_at timestamptz not null default now(),
      depth smallint generated always as (case when parent_id is null then 0 else 1 end) stored,
      parent_depth smallint generated always as (case when parent_id is null then null else 0 end) stored,
      constraint media_folders_id_client_id_key unique (id, client_id),
      constraint media_folders_id_client_id_depth_key unique (id, client_id, depth),
      constraint media_folders_parent_fk foreign key (parent_id, client_id, parent_depth)
        references public.media_folders (id, client_id, depth),
      constraint media_folders_default_is_first_level check (not is_default or parent_id is null)
    );
    create index media_folders_client_idx on public.media_folders (client_id);
    create index media_folders_parent_idx on public.media_folders (parent_id) where parent_id is not null;
    create unique index media_folders_default_name_key on public.media_folders (client_id, name) where is_default;

    alter table public.media_folders enable row level security;
    alter table public.media_folders force row level security;

    revoke all on public.media_folders from ageniza_app;
    grant select on public.media_folders to ageniza_app;
    grant insert (id, client_id, parent_id, name) on public.media_folders to ageniza_app;
    grant update (name) on public.media_folders to ageniza_app;

    create policy media_folders_select on public.media_folders
      for select to ageniza_app
      using (app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar'));

    create policy media_folders_insert on public.media_folders
      for insert to ageniza_app
      with check (
        not is_default
        and app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
      );

    create policy media_folders_update on public.media_folders
      for update to ageniza_app
      using (
        not is_default
        and app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
      )
      with check (
        not is_default
        and app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
      );
  `);

  await knex.raw(`
    create function app_private.create_default_media_folders(p_client_id uuid)
    returns void
    language sql
    security definer
    set search_path = ''
    as $function$
      insert into public.media_folders (client_id, name, is_default)
      select p_client_id, defaults.folder_name, true
      from (
        values ('Vídeos'), ('Imagens'), ('Carrosséis'), ('Ensaio fotográfico')
      ) as defaults(folder_name)
      on conflict (client_id, name) where is_default do nothing
    $function$;
    revoke all on function app_private.create_default_media_folders(uuid) from public;

    create function app_private.clients_create_default_media_folders()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.create_default_media_folders(new.id);
      return null;
    end;
    $function$;
    revoke all on function app_private.clients_create_default_media_folders() from public;

    create trigger clients_default_media_folders
      after insert on public.clients
      for each row
      execute function app_private.clients_create_default_media_folders();

    select app_private.create_default_media_folders(id) from public.clients;
  `);

  await knex.raw(`
    alter table public.media_assets
      add column client_id uuid null,
      add column folder_id uuid null,
      add column removed_at timestamptz null,
      add constraint media_assets_client_agency_fk foreign key (client_id, agency_id)
        references public.clients (id, agency_id),
      add constraint media_assets_folder_client_fk foreign key (folder_id, client_id)
        references public.media_folders (id, client_id),
      add constraint media_assets_folder_needs_client check (folder_id is null or client_id is not null);
    create index media_assets_client_folder_idx on public.media_assets (client_id, folder_id) where client_id is not null;

    alter table public.media_assets
      alter column created_by_user_id set default app_private.current_user_id();

    revoke insert (created_by_user_id) on public.media_assets from ageniza_app;
    revoke update (confirmed_at) on public.media_assets from ageniza_app;
    grant insert (client_id, folder_id) on public.media_assets to ageniza_app;

    drop policy media_assets_select on public.media_assets;
    drop policy media_assets_insert on public.media_assets;
    drop policy media_assets_update on public.media_assets;

    create policy media_assets_select on public.media_assets
      for select to ageniza_app
      using (
        (client_id is null and app_private.has_agency_permission(agency_id, 'midia.enviar'))
        or (client_id is not null and app_private.has_agency_permission(agency_id, 'conteudo.visualizar'))
      );

    create policy media_assets_insert on public.media_assets
      for insert to ageniza_app
      with check (
        (client_id is null and app_private.has_agency_permission(agency_id, 'midia.enviar'))
        or (
          client_id is not null
          and app_private.client_is_active(client_id)
          and app_private.has_agency_permission(agency_id, 'conteudo.operar')
        )
      );

    create policy media_assets_update on public.media_assets
      for update to ageniza_app
      using (
        (client_id is null and app_private.has_agency_permission(agency_id, 'midia.enviar'))
        or (client_id is not null and app_private.has_agency_permission(agency_id, 'conteudo.operar'))
      )
      with check (
        (client_id is null and app_private.has_agency_permission(agency_id, 'midia.enviar'))
        or (client_id is not null and app_private.has_agency_permission(agency_id, 'conteudo.operar'))
      );
  `);

  await knex.raw(`
    create or replace function app_private.media_asset_upload_state_is_forward_only()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if current_user <> 'ageniza_app' then
        return new;
      end if;

      if new.status is distinct from old.status then
        if old.status <> 'pending' or new.status not in ('confirmed', 'rejected') then
          raise exception using
            errcode = '42501',
            message = 'A media upload can only move from pending to confirmed or rejected.';
        end if;

        if new.status = 'confirmed' and (
          new.confirmed_size_bytes is null
          or new.confirmed_content_type is null
          or new.rejected_reason is not null
        ) then
          raise exception using
            errcode = '42501',
            message = 'A confirmed media upload carries its confirmed size, content type and time.';
        end if;

        if new.status = 'rejected' and (
          new.rejected_reason is null
          or pg_catalog.btrim(new.rejected_reason) = ''
          or new.confirmed_size_bytes is not null
          or new.confirmed_content_type is not null
          or new.confirmed_at is not null
        ) then
          raise exception using
            errcode = '42501',
            message = 'A rejected media upload carries its reason and no confirmation.';
        end if;

        if new.status = 'confirmed' then
          new.confirmed_at := pg_catalog.now();
        end if;
      elsif (new.confirmed_size_bytes, new.confirmed_content_type, new.confirmed_at, new.rejected_reason)
        is distinct from (old.confirmed_size_bytes, old.confirmed_content_type, old.confirmed_at, old.rejected_reason)
      then
        raise exception using
          errcode = '42501',
          message = 'The outcome of a media upload is written once, together with its status.';
      end if;

      if new.multipart_upload_id is distinct from old.multipart_upload_id and not (
        old.status = 'pending' and new.status = 'pending'
        and old.multipart_upload_id is null and new.multipart_upload_id is not null
      ) then
        raise exception using
          errcode = '42501',
          message = 'The multipart upload id is written once, while the upload is pending.';
      end if;

      if new.video_processing_status is distinct from old.video_processing_status then
        if not (
          (
            old.video_processing_status = 'not_applicable' and new.video_processing_status = 'pending'
            and old.status = 'pending' and new.status = 'confirmed'
          )
          or (
            old.status = 'confirmed' and new.status = 'confirmed'
            and (old.video_processing_status, new.video_processing_status) in (
              ('not_applicable', 'processing'), ('pending', 'processing'),
              ('processing', 'pending'), ('processing', 'ready'), ('processing', 'failed')
            )
          )
        ) then
          raise exception using
            errcode = '42501',
            message = 'Video processing only moves forward: pending, processing, then ready or failed; a retry returns to pending.';
        end if;

        if new.video_processing_status = 'ready' and (
          new.thumbnail_object_key is null
          or new.preview_object_key is null
          or new.video_duration_seconds is null
          or new.video_thumbnail_size_bytes is null
          or new.video_preview_size_bytes is null
          or new.video_processing_error is not null
          or new.video_processed_at is null
        ) then
          raise exception using
            errcode = '42501',
            message = 'A ready video carries its thumbnail, preview, duration, sizes and time, and no error.';
        end if;

        if new.video_processing_status = 'failed' and (
          new.video_processing_error is null
          or pg_catalog.btrim(new.video_processing_error) = ''
          or new.video_processed_at is null
          or (new.thumbnail_object_key, new.preview_object_key, new.video_duration_seconds,
              new.video_thumbnail_size_bytes, new.video_preview_size_bytes) is distinct from (old.thumbnail_object_key,
              old.preview_object_key, old.video_duration_seconds, old.video_thumbnail_size_bytes, old.video_preview_size_bytes)
        ) then
          raise exception using
            errcode = '42501',
            message = 'A failed video carries its reason and time and changes no result.';
        end if;

        if new.video_processing_status in ('pending', 'processing') and (
          new.video_processing_error is not null
          or new.video_processed_at is not null
          or (new.thumbnail_object_key, new.preview_object_key, new.video_duration_seconds,
              new.video_thumbnail_size_bytes, new.video_preview_size_bytes) is distinct from (old.thumbnail_object_key,
              old.preview_object_key, old.video_duration_seconds, old.video_thumbnail_size_bytes, old.video_preview_size_bytes)
        ) then
          raise exception using
            errcode = '42501',
            message = 'A video that is not finished carries no result, error or time.';
        end if;
      elsif (
        new.thumbnail_object_key, new.preview_object_key, new.video_duration_seconds, new.video_thumbnail_size_bytes,
        new.video_preview_size_bytes, new.video_processing_error, new.video_processed_at
      ) is distinct from (
        old.thumbnail_object_key, old.preview_object_key, old.video_duration_seconds, old.video_thumbnail_size_bytes,
        old.video_preview_size_bytes, old.video_processing_error, old.video_processed_at
      ) then
        raise exception using
          errcode = '42501',
          message = 'The result of video processing is written once, together with its status.';
      end if;

      return new;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
