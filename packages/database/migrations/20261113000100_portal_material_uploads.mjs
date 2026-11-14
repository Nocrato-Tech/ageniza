// Decision: docs/business/decisions/2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md (validated 2026-11-12). Forward-only, no
// backfill: the media that exists keeps no request and the side `agency`, which is what it is.
//
// The person of the portal sends photos and audio to an open request for material of her client, and reads back what she sent. The portal
// has no INSERT, no UPDATE and no SELECT on `media_assets`: it writes through three functions, the three steps of the upload the agency
// already has (start, confirm or reject), and reads through a fourth that answers only the columns the API needs (the lesson of the media
// of the portal: no table of the media is read directly, so the keys of the staging and the multipart id never reach her context).
//
//  - `media_assets.material_request_thread_id` ties a file to the request (a composite foreign key keeps it in the client of the request, a
//    CHECK keeps it from a media of the library with no client) and `uploaded_by_side` says who sent it. A file of the client carries its
//    request and a file with a request is the client's (`media_assets_client_upload_shape`). Neither column is granted to the application
//    role: the agency inserts and updates with the grants it has, and a file is never born a client's, or moved to another request, by it.
//  - The folder is the client's default folder "Enviados pelo cliente", created by the first upload (a lazy row, no backfill). It is an
//    `is_default` folder, so the model of the folders already keeps the agency from creating, renaming or deleting it (the INSERT and UPDATE
//    policies refuse `is_default`, `delete_media_folder` answers A0086, and there is no DELETE grant); the agency can still move a file out of it.
//  - `start_portal_material_upload` writes the pending row: the key of the object and its extension are built here from ids the database
//    read, the category comes from the type (image or audio, never an SVG, a video or a PDF), and it refuses the person who is not an active
//    link of that client, a request of another client or that is not a request for material, a resolved request, an archived client, an
//    agency that does not accept writes, a file above the ceiling, a request with its files, and an agency with less room than one file of the ceiling.
//    `confirm_portal_material_upload` and `reject_portal_material_upload` move the pending row of the same person to confirmed or rejected,
//    and a verdict about the bytes (type, size, dimensions, the room left) is recorded as a rejection, so the reservation does not hang.
//    Nothing that reaches the portal names the agency's plan or storage: the refusal for lack of room is `agency_unavailable` in the
//    verdict, as A0136 is at the start, and it asks whether the agency has room for the ceiling of one file (25 MiB), never for the size
//    the person declared or sent, so that the line where the answer flips is not the room the agency has left (the reservation and the
//    accounting still use the real size), and a read-only agency gets the neutral A0090 from the three functions, never the trigger's words.
//  - The only read of the portal is `list_portal_material_uploads`: a page of the files the person herself sent to a request, pending or
//    confirmed and not removed, while she is an active link of the client. It answers the columns of a listing and the final key of a
//    confirmed object (the API is the server that signs the read), never the key of the staging, the multipart id or the texts the agency
//    wrote. The agency reads the files of the client as it reads the rest of the library.
//  - The ceiling per file (25 MiB) and per request (20 files) are one copy each (`portal_upload_max_bytes`, `portal_upload_max_files`). The
//    storage of the agency is counted by the one function that counts it (`agency_storage_in_use`), which `agency_media_usage` now calls too.
//
// Locks, always in this order: the file being confirmed (its row), the agency's `media-quota:<agency>` advisory lock, the client FOR SHARE
// (conflicts with archiving it), the request FOR SHARE (conflicts with resolving it); everything is read again after the last wait. The agency's
// own upload takes the same quota lock before the client, and nothing here takes `agency_trial_limits:`, so the order of
// `lock_subscription_change` is untouched. Each function that locks refuses another isolation level than READ COMMITTED (40001), as the other
// locking functions do.
//
// Stable error codes for the API:
//   A0130 -> 404  the request, the file or the link of the person is not found, or the client is archived (one error: never an oracle)
//   A0131 -> 409  the request is resolved
//   A0132 -> 413  the file is above the ceiling
//   A0133 -> 415  the type is not accepted
//   A0134 -> 409  the request already holds its files
//   A0135 -> 409  the upload is not pending
//   A0136 -> 409  the agency cannot take the file (the storage is full): the portal says only that it is paused, never why
//   A0090 -> 409  the agency does not accept writes (the existing code; the portal says the same neutral thing)

const SYSTEM_FOLDER = 'Enviados pelo cliente';
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;

export async function up(knex) {
  await knex.raw(`
    alter table public.client_threads add constraint client_threads_id_client_id_key unique (id, client_id);

    alter table public.media_assets
      add column material_request_thread_id uuid null,
      add column uploaded_by_side text not null default 'agency',
      add constraint media_assets_uploaded_by_side_check check (uploaded_by_side in ('agency', 'client')),
      add constraint media_assets_request_thread_fk foreign key (material_request_thread_id, client_id)
        references public.client_threads (id, client_id),
      add constraint media_assets_request_needs_client check (material_request_thread_id is null or client_id is not null),
      add constraint media_assets_client_upload_shape check ((uploaded_by_side = 'client') = (material_request_thread_id is not null));

    create index media_assets_material_request_idx
      on public.media_assets (material_request_thread_id, created_at) where material_request_thread_id is not null;
  `);

  await knex.raw(`
    create function app_private.portal_upload_max_bytes()
    returns bigint
    language sql
    immutable
    set search_path = ''
    as $function$
      select ${MAX_FILE_BYTES}::bigint
    $function$;
    revoke all on function app_private.portal_upload_max_bytes() from public;

    create function app_private.portal_upload_max_files()
    returns integer
    language sql
    immutable
    set search_path = ''
    as $function$
      select ${MAX_FILES_PER_REQUEST}
    $function$;
    revoke all on function app_private.portal_upload_max_files() from public;

    -- What the portal may send: a photo or an audio. No SVG (it is only a logo of the library), no video, no PDF. The parameters of the type
    -- (the codecs of a recording) are not part of it, as in the media policy of the API.
    create function app_private.portal_upload_type(p_content_type text)
    returns table (content_type text, category text, extension text)
    language sql
    immutable
    set search_path = ''
    as $function$
      select kind.content_type, kind.category, kind.extension
      from (
        values
          ('image/png', 'image', 'png'),
          ('image/jpeg', 'image', 'jpg'),
          ('image/webp', 'image', 'webp'),
          ('image/gif', 'image', 'gif'),
          ('audio/mpeg', 'audio', 'mp3'),
          ('audio/mp4', 'audio', 'm4a'),
          ('audio/x-m4a', 'audio', 'm4a'),
          ('audio/wav', 'audio', 'wav'),
          ('audio/x-wav', 'audio', 'wav'),
          ('audio/wave', 'audio', 'wav'),
          ('audio/webm', 'audio', 'webm'),
          ('audio/ogg', 'audio', 'ogg')
      ) as kind(content_type, category, extension)
      where kind.content_type = pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(p_content_type, ';', 1)))
    $function$;
    revoke all on function app_private.portal_upload_type(text) from public;

    create function app_private.require_portal_upload_settings(
      p_default_quota_bytes bigint, p_default_quota_object_count bigint, p_pending_window_seconds integer
    )
    returns void
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if p_default_quota_bytes is null or p_default_quota_bytes <= 0
         or p_default_quota_object_count is null or p_default_quota_object_count <= 0 then
        raise exception using errcode = '22023', message = 'The default storage ceilings are positive.';
      end if;
      -- A NULL window would turn the comparison of the pending reservations into NULL and drop every one of them.
      if p_pending_window_seconds is null or p_pending_window_seconds < 0 then
        raise exception using errcode = '22023', message = 'The pending reservation window is a number of seconds, zero or more.';
      end if;
    end;
    $function$;
    revoke all on function app_private.require_portal_upload_settings(bigint, bigint, integer) from public;
  `);

  await knex.raw(`
    -- The storage in use by an agency, counted in one place: the confirmed files and the uploads still within the reservation window. The
    -- function the routes of the agency call asks who may read it first; the one the portal's functions call is internal, because the person
    -- of the portal holds none of those permissions and her own function has already checked who she is.
    create function app_private.agency_storage_in_use(
      p_agency_id uuid,
      p_pending_window_seconds integer,
      p_exclude_asset_id uuid default null
    )
    returns table (used_bytes bigint, used_object_count bigint)
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    begin
      -- A NULL window would turn the comparison below into NULL and drop every pending reservation.
      if p_pending_window_seconds is null or p_pending_window_seconds < 0 then
        raise exception using errcode = '22023', message = 'The pending reservation window is a number of seconds, zero or more.';
      end if;

      return query
      select
        coalesce(sum(case
          when asset.status = 'confirmed' then asset.confirmed_size_bytes
          when asset.status = 'pending' then asset.declared_size_bytes
        end), 0)::bigint,
        count(*)::bigint
      from public.media_assets asset
      where asset.agency_id = p_agency_id
        and asset.purged_at is null
        and (p_exclude_asset_id is null or asset.id <> p_exclude_asset_id)
        and (
          asset.status = 'confirmed'
          or (asset.status = 'pending' and asset.updated_at >= pg_catalog.now() - (p_pending_window_seconds * interval '1 second'))
        );
    end;
    $function$;
    revoke all on function app_private.agency_storage_in_use(uuid, integer, uuid) from public;

    create or replace function app_private.agency_media_usage(
      p_agency_id uuid,
      p_pending_window_seconds integer,
      p_exclude_asset_id uuid default null
    )
    returns table (used_bytes bigint, used_object_count bigint)
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    begin
      if not (
        app_private.has_agency_permission(p_agency_id, 'midia.enviar')
        or app_private.has_agency_permission(p_agency_id, 'conteudo.operar')
      ) then
        raise exception using errcode = '42501', message = 'The storage usage is read by who uploads.';
      end if;

      return query
      select usage.used_bytes, usage.used_object_count
      from app_private.agency_storage_in_use(p_agency_id, p_pending_window_seconds, p_exclude_asset_id) usage;
    end;
    $function$;

    -- Whether one more file fits: the request still has room for it and so does the storage of the agency (its own ceiling, or the default
    -- of the deployment that the API hands over). Null when it fits, otherwise the reason: 'request_full', or 'agency_unavailable' for the
    -- storage of the agency, a word that is safe to hand to the portal. The room is asked for the ceiling of one file, never for the size
    -- of this one: a number the person controls would make the line where the answer flips the room the agency has left. The caller holds
    -- the locks.
    create function app_private.portal_upload_refusal(
      p_agency_id uuid,
      p_thread_id uuid,
      p_exclude_asset_id uuid,
      p_default_quota_bytes bigint,
      p_default_quota_object_count bigint,
      p_pending_window_seconds integer
    )
    returns text
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    declare
      v_in_request bigint;
      v_quota_bytes bigint;
      v_quota_count bigint;
      v_used_bytes bigint;
      v_used_count bigint;
      v_held_bytes bigint;
      v_held_count bigint;
    begin
      select pg_catalog.count(*) into v_in_request
      from public.media_assets asset
      where asset.material_request_thread_id = p_thread_id
        and asset.removed_at is null
        and (p_exclude_asset_id is null or asset.id <> p_exclude_asset_id)
        and (
          asset.status = 'confirmed'
          or (asset.status = 'pending' and asset.updated_at >= pg_catalog.now() - (p_pending_window_seconds * interval '1 second'))
        );
      if v_in_request >= app_private.portal_upload_max_files() then
        return 'request_full';
      end if;

      select quota.quota_bytes, quota.quota_object_count into v_quota_bytes, v_quota_count
      from public.agency_storage_quotas quota
      where quota.agency_id = p_agency_id;
      v_quota_bytes := coalesce(v_quota_bytes, p_default_quota_bytes);
      v_quota_count := coalesce(v_quota_count, p_default_quota_object_count);

      select usage.used_bytes, usage.used_object_count into v_used_bytes, v_used_count
      from app_private.agency_storage_in_use(p_agency_id, p_pending_window_seconds, p_exclude_asset_id) usage;
      -- The reservations of the portal are left out of what the portal is told: the person makes them, sizes them and lets them go at will,
      -- so counting them would let her read the room the agency has left by probing. What counts for her is what is confirmed and what the
      -- agency itself holds; the route of the agency still counts every reservation.
      select coalesce(sum(asset.declared_size_bytes), 0)::bigint, pg_catalog.count(*)::bigint into v_held_bytes, v_held_count
      from public.media_assets asset
      where asset.agency_id = p_agency_id
        and asset.purged_at is null
        and asset.uploaded_by_side = 'client'
        and asset.status = 'pending'
        and (p_exclude_asset_id is null or asset.id <> p_exclude_asset_id)
        and asset.updated_at >= pg_catalog.now() - (p_pending_window_seconds * interval '1 second');
      v_used_bytes := v_used_bytes - v_held_bytes;
      v_used_count := v_used_count - v_held_count;
      if v_used_bytes + app_private.portal_upload_max_bytes() > v_quota_bytes or v_used_count + 1 > v_quota_count then
        return 'agency_unavailable';
      end if;

      return null;
    end;
    $function$;
    revoke all on function app_private.portal_upload_refusal(uuid, uuid, uuid, bigint, bigint, integer) from public;
  `);

  await knex.raw(`
    -- The pending file of the person, locked: the one place that says whose a file must be and what state it must be in to be finished. The
    -- person is read BEFORE the lock and every refusal reads the same (a file that is not hers, not a client's, or of a link she no longer
    -- holds); the state is read after it.
    create function app_private.lock_own_pending_portal_upload(p_asset_id uuid)
    returns public.media_assets
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_asset public.media_assets;
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'A file is finished by an authenticated person.';
      end if;

      perform 1
      from public.media_assets asset
      where asset.id = p_asset_id
        and asset.uploaded_by_side = 'client'
        and asset.created_by_user_id = v_actor
        and app_private.is_client_member(asset.client_id);
      if not found then
        raise exception using errcode = 'A0130', message = 'File not found.';
      end if;

      select asset.* into v_asset from public.media_assets asset where asset.id = p_asset_id for update;
      if v_asset.status <> 'pending' then
        raise exception using errcode = 'A0135', message = 'This upload is not pending.';
      end if;

      return v_asset;
    end;
    $function$;
    revoke all on function app_private.lock_own_pending_portal_upload(uuid) from public;

    -- The agency of the client when the person is an active link of that client and the conversation is a request for material of it, and
    -- the one answer of a request that is not there otherwise: the one place that says what a request of the portal is.
    create function app_private.require_portal_material_request(p_client_id uuid, p_thread_id uuid)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_agency_id uuid;
    begin
      select client.agency_id into v_agency_id
      from public.clients client
      where client.id = p_client_id
        and app_private.is_client_member(client.id)
        and exists (
          select 1
          from public.client_threads thread
          where thread.id = p_thread_id and thread.client_id = client.id and thread.is_material_request
        );
      if not found then
        raise exception using errcode = 'A0130', message = 'Request not found.';
      end if;
      return v_agency_id;
    end;
    $function$;
    revoke all on function app_private.require_portal_material_request(uuid, uuid) from public;

    create function app_private.start_portal_material_upload(
      p_client_id uuid,
      p_thread_id uuid,
      p_content_type text,
      p_declared_size_bytes bigint,
      p_file_name text,
      p_default_quota_bytes bigint,
      p_default_quota_object_count bigint,
      p_pending_window_seconds integer
    )
    returns table (
      asset_id uuid, agency_id uuid, category text, extension text, content_type text, object_key text, upload_object_key text
    )
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_agency_id uuid;
      v_kind record;
      v_resolved boolean;
      v_refusal text;
      v_folder_id uuid;
      v_asset_id uuid := pg_catalog.gen_random_uuid();
      v_object_key text;
      v_upload_object_key text;
    begin
      perform app_private.require_read_committed();
      if v_actor is null then
        raise exception using errcode = '42501', message = 'A file is sent by an authenticated person.';
      end if;
      perform app_private.require_portal_upload_settings(p_default_quota_bytes, p_default_quota_object_count, p_pending_window_seconds);

      -- The person, the client and the request, read BEFORE any lock; every refusal reads the same.
      v_agency_id := app_private.require_portal_material_request(p_client_id, p_thread_id);

      select kind.* into v_kind from app_private.portal_upload_type(p_content_type) kind;
      if not found then
        raise exception using errcode = 'A0133', message = 'This content type is not accepted.';
      end if;
      if p_declared_size_bytes is null or p_declared_size_bytes <= 0 then
        raise exception using errcode = '22023', message = 'The declared size is a positive number of bytes.';
      end if;
      if p_declared_size_bytes > app_private.portal_upload_max_bytes() then
        raise exception using errcode = 'A0132', message = 'The file is above the ceiling.';
      end if;

      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('media-quota:' || v_agency_id::text, 0));
      perform 1 from public.clients client where client.id = p_client_id for share;
      select (thread.resolved_at is not null) into v_resolved
      from public.client_threads thread
      where thread.id = p_thread_id
      for share;

      -- After the waits: an archive, a removed link or a resolution that committed while this one waited is seen here.
      if not app_private.is_client_member(p_client_id) then
        raise exception using errcode = 'A0130', message = 'Request not found.';
      end if;
      if v_resolved then
        raise exception using errcode = 'A0131', message = 'The request is resolved.';
      end if;
      if not app_private.agency_accepts_writes(v_agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency does not accept writes now.';
      end if;

      v_refusal := app_private.portal_upload_refusal(
        v_agency_id, p_thread_id, null, p_default_quota_bytes, p_default_quota_object_count, p_pending_window_seconds
      );
      if v_refusal = 'request_full' then
        raise exception using errcode = 'A0134', message = 'The request already holds its files.';
      elsif v_refusal is not null then
        raise exception using errcode = 'A0136', message = 'The agency cannot take this file now.';
      end if;

      insert into public.media_folders (client_id, name, is_default)
      values (p_client_id, '${SYSTEM_FOLDER}', true)
      on conflict (client_id, name) where is_default do nothing;
      select folder.id into v_folder_id
      from public.media_folders folder
      where folder.client_id = p_client_id and folder.is_default and folder.name = '${SYSTEM_FOLDER}';

      v_object_key := v_agency_id::text || '/' || v_asset_id::text || '/original.' || v_kind.extension;
      v_upload_object_key := 'staging/' || v_agency_id::text || '/' || v_asset_id::text || '/upload.' || v_kind.extension;
      insert into public.media_assets (
        id, agency_id, client_id, folder_id, category, declared_content_type, extension, file_name, object_key, upload_object_key,
        declared_size_bytes, material_request_thread_id, uploaded_by_side
      )
      values (
        v_asset_id, v_agency_id, p_client_id, v_folder_id, v_kind.category, v_kind.content_type, v_kind.extension, p_file_name,
        v_object_key, v_upload_object_key, p_declared_size_bytes, p_thread_id, 'client'
      );

      return query select v_asset_id, v_agency_id, v_kind.category, v_kind.extension, v_kind.content_type, v_object_key, v_upload_object_key;
    end;
    $function$;

    -- The API read the object after it was uploaded: p_content_type is the type its bytes turned out to have, p_size_bytes the size the
    -- storage reports, and the dimensions come from the bytes of an image. A verdict that is about the file is recorded and answered, not
    -- raised, so the rejection survives the request: 'confirmed', or 'rejected' with a reason (empty_object, content_type_mismatch,
    -- too_large, invalid_dimensions, request_full, agency_unavailable). None of them speaks of the plan or the storage of the agency.
    create function app_private.confirm_portal_material_upload(
      p_asset_id uuid,
      p_size_bytes bigint,
      p_content_type text,
      p_width integer,
      p_height integer,
      p_default_quota_bytes bigint,
      p_default_quota_object_count bigint,
      p_pending_window_seconds integer
    )
    returns table (outcome text, reason text)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_asset public.media_assets;
      v_kind record;
      v_resolved boolean;
      v_reason text;
    begin
      perform app_private.require_read_committed();
      perform app_private.require_portal_upload_settings(p_default_quota_bytes, p_default_quota_object_count, p_pending_window_seconds);

      v_asset := app_private.lock_own_pending_portal_upload(p_asset_id);

      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('media-quota:' || v_asset.agency_id::text, 0));
      perform 1 from public.clients client where client.id = v_asset.client_id for share;
      select (thread.resolved_at is not null) into v_resolved
      from public.client_threads thread
      where thread.id = v_asset.material_request_thread_id
      for share;

      if not app_private.is_client_member(v_asset.client_id) then
        raise exception using errcode = 'A0130', message = 'File not found.';
      end if;
      if v_resolved then
        raise exception using errcode = 'A0131', message = 'The request is resolved.';
      end if;
      if not app_private.agency_accepts_writes(v_asset.agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency does not accept writes now.';
      end if;

      select kind.* into v_kind from app_private.portal_upload_type(p_content_type) kind;
      v_reason := case
        when p_size_bytes is null or p_size_bytes <= 0 then 'empty_object'
        when v_kind.content_type is distinct from v_asset.declared_content_type or v_kind.category is distinct from v_asset.category then 'content_type_mismatch'
        when p_size_bytes > app_private.portal_upload_max_bytes() then 'too_large'
        when (p_width is null) <> (p_height is null)
          or (p_width is not null and (v_asset.category <> 'image' or p_width not between 1 and 100000 or p_height not between 1 and 100000))
          then 'invalid_dimensions'
        else app_private.portal_upload_refusal(
          v_asset.agency_id, v_asset.material_request_thread_id, v_asset.id,
          p_default_quota_bytes, p_default_quota_object_count, p_pending_window_seconds
        )
      end;

      if v_reason is not null then
        update public.media_assets
        set status = 'rejected', rejected_reason = v_reason, updated_at = pg_catalog.now()
        where id = v_asset.id;
        return query select 'rejected'::text, v_reason;
        return;
      end if;

      update public.media_assets
      set status = 'confirmed', confirmed_size_bytes = p_size_bytes, confirmed_content_type = v_kind.content_type,
          confirmed_at = pg_catalog.now(), width = p_width, height = p_height, updated_at = pg_catalog.now()
      where id = v_asset.id;
      return query select 'confirmed'::text, null::text;
    end;
    $function$;

    -- The upload that cannot be finished (the object is not there, or the API turned it down): the reservation is let go. The agency that
    -- does not accept writes is answered here, in the neutral words, before the trigger of the table answers with the ones about its trial.
    create function app_private.reject_portal_material_upload(p_asset_id uuid, p_reason text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_asset public.media_assets;
    begin
      perform app_private.require_read_committed();
      if p_reason is null or p_reason !~ '^[a-z][a-z_]{0,39}$' then
        raise exception using errcode = '22023', message = 'The reason is a short code in lower case.';
      end if;

      v_asset := app_private.lock_own_pending_portal_upload(p_asset_id);
      if not app_private.agency_accepts_writes(v_asset.agency_id) then
        raise exception using errcode = 'A0090', message = 'The agency does not accept writes now.';
      end if;

      update public.media_assets
      set status = 'rejected', rejected_reason = p_reason, updated_at = pg_catalog.now()
      where id = v_asset.id;
    end;
    $function$;

    -- A page of what the person sent to the request, oldest first, with the total of her files in it. It answers the columns of a listing,
    -- the type and size the file has now (the bytes read for a confirmed one, what was declared for a pending one) and the final key of a
    -- confirmed object, for the API to sign the read: never the key of the staging, the multipart id, the alt text or the folder. A page
    -- past the end answers one row with the total and no file (asset_id null), so the total never depends on there being a page.
    create function app_private.list_portal_material_uploads(p_client_id uuid, p_thread_id uuid, p_limit integer, p_offset bigint)
    returns table (
      total_count bigint, asset_id uuid, status text, category text, content_type text, size_bytes bigint, file_name text,
      width integer, height integer, created_at timestamptz, object_key text
    )
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'The files are read by an authenticated person.';
      end if;
      if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then
        raise exception using errcode = '22023', message = 'A page is one to a hundred files, from a position of zero or more.';
      end if;
      perform app_private.require_portal_material_request(p_client_id, p_thread_id);

      return query
      with mine as (
        select
          asset.id, asset.status, asset.category, asset.file_name, asset.width, asset.height, asset.created_at,
          case when asset.status = 'confirmed' then asset.confirmed_content_type else asset.declared_content_type end as content_type,
          case when asset.status = 'confirmed' then asset.confirmed_size_bytes else asset.declared_size_bytes end as size_bytes,
          case when asset.status = 'confirmed' then asset.object_key end as object_key
        from public.media_assets asset
        where asset.client_id = p_client_id
          and asset.material_request_thread_id = p_thread_id
          and asset.uploaded_by_side = 'client'
          and asset.created_by_user_id = v_actor
          and asset.status in ('pending', 'confirmed')
          and asset.removed_at is null
      )
      select
        total.n, page.id, page.status, page.category, page.content_type, page.size_bytes, page.file_name,
        page.width, page.height, page.created_at, page.object_key
      from (select pg_catalog.count(*) as n from mine) total
      left join (
        select mine.* from mine order by mine.created_at, mine.id limit p_limit offset p_offset
      ) page on true;
    end;
    $function$;

    revoke all on function app_private.start_portal_material_upload(uuid, uuid, text, bigint, text, bigint, bigint, integer) from public;
    revoke all on function app_private.confirm_portal_material_upload(uuid, bigint, text, integer, integer, bigint, bigint, integer) from public;
    revoke all on function app_private.reject_portal_material_upload(uuid, text) from public;
    revoke all on function app_private.list_portal_material_uploads(uuid, uuid, integer, bigint) from public;
    grant execute on function app_private.start_portal_material_upload(uuid, uuid, text, bigint, text, bigint, bigint, integer) to ageniza_app;
    grant execute on function app_private.confirm_portal_material_upload(uuid, bigint, text, integer, integer, bigint, bigint, integer) to ageniza_app;
    grant execute on function app_private.reject_portal_material_upload(uuid, text) to ageniza_app;
    grant execute on function app_private.list_portal_material_uploads(uuid, uuid, integer, bigint) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
