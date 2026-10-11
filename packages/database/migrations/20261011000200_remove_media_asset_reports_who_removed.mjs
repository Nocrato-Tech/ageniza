// Review of #406 (#253): `remove_media_asset` answers whether THIS call removed the media.
//
// The route audits `media.removed` once per media (decision 2026-10-07 on removing a media, item 6: repeating is
// neither an error nor a second audit event). It decided that by reading `removed_at` BEFORE the function took the
// lock of the media, so two removals at the same instant both read "not removed", the second waited for the lock,
// found the media already removed and returned without an error, and both wrote the event. Only the function knows,
// after the lock, which call changed the row, so it says so: `true` when it set `removed_at`, `false` when the media
// was already out of its folder. A new statement after the lock sees what the other transaction committed.
//
// A function cannot change its return type in place, so this drops `remove_media_asset(uuid, uuid)` of 20261007001500
// and creates it again with `returns boolean`. Nothing depends on it (no view, no trigger); the body is the same
// except for the two `return` values, and it keeps `security definer`, the fixed `search_path`, the grants and the
// stable error codes (A0080, A0081, A0082) of that migration.
//
// Forward-only, like every migration here.

export async function up(knex) {
  await knex.raw(`
    drop function app_private.remove_media_asset(uuid, uuid);

    create function app_private.remove_media_asset(p_asset_id uuid, p_folder_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_agency_id uuid;
      v_asset public.media_assets;
    begin
      perform app_private.require_read_committed();

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
        -- Removed before this call, as seen after the lock: nothing changed, so the caller writes no audit event.
        return false;
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
      return true;
    end;
    $function$;
    revoke all on function app_private.remove_media_asset(uuid, uuid) from public;
    grant execute on function app_private.remove_media_asset(uuid, uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
