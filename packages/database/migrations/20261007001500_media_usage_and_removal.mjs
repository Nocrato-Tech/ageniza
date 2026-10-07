// Issues #384 and the database half of #253. Forward-only, like every migration here.
//
// Decisions: docs/business/decisions/2026-10-07-a-cota-soma-a-agencia-inteira-por-funcao-propria.md,
// ...-remover-midia-e-por-funcao-e-se-recusa-em-conteudo-ja-enviado.md and
// ...-a-pasta-pai-se-trava-por-funcao-propria.md. It only adds functions and one index.
//
// Three pieces the routes of the media library need and `ageniza_app` cannot do by itself:
//
//  1. `agency_media_usage`: the storage quota summed over the whole agency. The sum used to be a plain
//     SELECT under the caller's RLS, and a role that uploads (`midia.enviar`) does not read the media of
//     a client (`conteudo.visualizar`), so it would have undercounted. The function is `security definer`
//     and checks inside that the caller may upload, one way or the other.
//  2. `remove_media_asset`: `media_assets.removed_at` has no write grant (20261007000900), so a media
//     leaves its folder only here. It needs `conteudo.operar` and `conteudo.visualizar`, takes the client
//     (shared) and the asset, then locks every content that uses the media as a file or as a cover
//     before it reads their state: a content that is being approved or published at that moment is
//     waited for, and a removal that wins the race makes `content_media_is_complete` refuse the next
//     transition. A content waiting for approval is protected too (see the decision): approving does not
//     check the media again, so letting it go would approve a post whose file is gone.
//  3. `lock_media_folder`: `select ... for update` as `ageniza_app` locks nothing on a default folder
//     (the UPDATE policy excludes `is_default`), so a route that serializes on the parent folder asks
//     the database to do it. FOR UPDATE, not NO KEY UPDATE: a child insert takes KEY SHARE on the parent
//     through its foreign key, and only FOR UPDATE makes it wait.
//
// The lock on the client of an INSERT (a folder or a media born while the client is being archived) is
// not here: it is the AFTER INSERT trigger of 20261007001400.
//
// The removed media keeps counting in the quota, because the object is still in storage until the
// retention flow deletes it, and stays readable to RLS: contents_guard (security invoker) reads
// `removed_at` of a cover to refuse a removed one, and a policy that hid the row would turn that
// refusal into "not found, left to the foreign key". The folder listing filters `removed_at is null`.
//
// Stable error codes for the API:
//   A0080 -> 404  media or folder not found, of another client or agency, not confirmed, or the caller
//                 lacks the permission (one error for all: never an existence oracle)
//   A0081 -> 409  the client is archived
//   A0082 -> 409  the media is used by a content that is awaiting approval, approved or published

export async function up(knex) {
  await knex.raw(`
    create index contents_cover_asset_idx on public.contents (cover_asset_id) where cover_asset_id is not null;

    create function app_private.agency_media_usage(
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
        and (p_exclude_asset_id is null or asset.id <> p_exclude_asset_id)
        and (
          asset.status = 'confirmed'
          or (asset.status = 'pending' and asset.updated_at >= pg_catalog.now() - (p_pending_window_seconds * interval '1 second'))
        );
    end;
    $function$;
    revoke all on function app_private.agency_media_usage(uuid, integer, uuid) from public;
    grant execute on function app_private.agency_media_usage(uuid, integer, uuid) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.remove_media_asset(p_asset_id uuid, p_folder_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_agency_id uuid;
      v_asset public.media_assets;
    begin
      -- The permission is checked BEFORE any lock, and every refusal reads the same.
      select asset.client_id, asset.agency_id into v_client_id, v_agency_id
      from public.media_assets asset
      where asset.id = p_asset_id and asset.folder_id = p_folder_id;

      if not found or not (
        app_private.has_agency_permission(v_agency_id, 'conteudo.operar')
        and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0080', message = 'Media not found.';
      end if;

      -- Shared with the other writers of the client and in conflict with archiving it; client first, as archive_client does.
      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0081', message = 'The client is archived.';
      end if;

      select asset.* into v_asset from public.media_assets asset where asset.id = p_asset_id for update;
      if v_asset.status <> 'confirmed' then
        raise exception using errcode = 'A0080', message = 'Media not found.';
      end if;
      if v_asset.removed_at is not null then
        return;
      end if;

      perform 1
      from public.contents content
      where content.id in (select item.content_id from public.content_media item where item.asset_id = p_asset_id)
        or content.cover_asset_id = p_asset_id
      for update;

      -- A new statement: after a wait it sees the state the other transaction committed.
      if exists (
        select 1
        from public.contents content
        where (
            content.id in (select item.content_id from public.content_media item where item.asset_id = p_asset_id)
            or content.cover_asset_id = p_asset_id
          )
          and content.status in ('awaiting_approval', 'approved', 'published')
      ) then
        raise exception using errcode = 'A0082', message = 'A media used by a content that was sent for approval is not removed.';
      end if;

      update public.media_assets set removed_at = pg_catalog.now(), updated_at = pg_catalog.now() where id = p_asset_id;
    end;
    $function$;
    revoke all on function app_private.remove_media_asset(uuid, uuid) from public;
    grant execute on function app_private.remove_media_asset(uuid, uuid) to ageniza_app;

    create function app_private.lock_media_folder(p_folder_id uuid)
    returns public.media_folders
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_folder public.media_folders;
      v_agency_id uuid;
    begin
      select folder.* into v_folder from public.media_folders folder where folder.id = p_folder_id;
      if found then
        v_agency_id := app_private.client_agency_id(v_folder.client_id);
      end if;

      if not found or not (
        app_private.has_agency_permission(v_agency_id, 'conteudo.operar')
        and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0080', message = 'Folder not found.';
      end if;

      select folder.* into v_folder from public.media_folders folder where folder.id = p_folder_id for update;
      return v_folder;
    end;
    $function$;
    revoke all on function app_private.lock_media_folder(uuid) from public;
    grant execute on function app_private.lock_media_folder(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
