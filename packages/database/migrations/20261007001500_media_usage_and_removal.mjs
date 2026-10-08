// Issues #384 and the database half of #253. Forward-only, like every migration here.
//
// Decisions: docs/business/decisions/2026-10-07-a-cota-soma-a-agencia-inteira-por-funcao-propria.md,
// ...-remover-midia-e-por-funcao-e-se-recusa-em-conteudo-ja-enviado.md and
// ...-a-pasta-pai-se-trava-por-funcao-propria.md. It adds functions, one trigger and one index, and replaces
// `submit_content` and `publish_content` (20261007001200) only to add what is said at the end.
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
// Isolation (security review of #394): these functions lock a row and then read the state again in a new statement,
// which only sees what other transactions committed in READ COMMITTED. In REPEATABLE READ or SERIALIZABLE the
// re-read is the old snapshot, and the lock of a row nobody updated does not fail, so a media could leave a content
// that was just given it. `app_private.require_read_committed` refuses any other level with 40001, which the API
// already answers as "try again"; `remove_media_asset`, `lock_media_folder`, `submit_content` and `publish_content`
// call it first. The API runs every transaction in READ COMMITTED.
//
// The cover (#396): `contents_guard` reads `removed_at` of a cover without locking it, so a cover set at the instant
// the media is removed could keep a removed file. `0_contents_lock_cover` (BEFORE, so it sorts ahead of the guard)
// takes the media FOR SHARE: in READ COMMITTED it waits for a removal in flight and the guard then reads the new
// `removed_at` (A0069); in REPEATABLE READ it fails with 40001. `submit_content` and `publish_content` also refuse a removed cover (A0065).
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

    create function app_private.require_read_committed()
    returns void
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
        raise exception using errcode = '40001', message = 'This operation runs in READ COMMITTED.';
      end if;
    end;
    $function$;
    revoke all on function app_private.require_read_committed() from public;

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
      perform app_private.require_read_committed();

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

  await knex.raw(`
    create function app_private.contents_lock_cover()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      -- A cover that is not found or not readable is left to the policy and the foreign key, as contents_guard does.
      perform 1 from public.media_assets asset where asset.id = new.cover_asset_id for share;
      return new;
    end;
    $function$;
    revoke all on function app_private.contents_lock_cover() from public;

    create trigger "0_contents_lock_cover"
      before insert or update of cover_asset_id on public.contents
      for each row
      when (new.cover_asset_id is not null)
      execute function app_private.contents_lock_cover();
  `);

  await knex.raw(`
    create or replace function app_private.submit_content(p_content_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      perform app_private.require_read_committed();
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status = 'awaiting_approval' then
        return;
      end if;
      if v_content.status not in ('in_production', 'adjusting') then
        raise exception using errcode = 'A0062', message = 'Only a content in production or in adjustment is sent for approval.';
      end if;
      if not app_private.content_media_is_complete(p_content_id, v_content.format) then
        raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
      end if;
      if exists (
        select 1 from public.media_assets asset where asset.id = v_content.cover_asset_id and asset.removed_at is not null
      ) then
        raise exception using errcode = 'A0065', message = 'The cover of a content was removed.';
      end if;
      if exists (select 1 from public.content_tasks task where task.content_id = p_content_id and task.status <> 'approved') then
        raise exception using errcode = 'A0066', message = 'Every subtask is approved before the content is sent.';
      end if;

      update public.contents set status = 'awaiting_approval' where id = p_content_id;
    end;
    $function$;

    create or replace function app_private.publish_content(p_content_id uuid, p_published_on date)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      perform app_private.require_read_committed();
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.publicar');

      if v_content.status = 'published' then
        return;
      end if;
      if v_content.status <> 'approved' then
        raise exception using errcode = 'A0062', message = 'Only an approved content is published.';
      end if;
      if not app_private.content_media_is_complete(p_content_id, v_content.format) then
        raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
      end if;
      if exists (
        select 1 from public.media_assets asset where asset.id = v_content.cover_asset_id and asset.removed_at is not null
      ) then
        raise exception using errcode = 'A0065', message = 'The cover of a content was removed.';
      end if;

      update public.contents set status = 'published', published_on = p_published_on where id = p_content_id;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
