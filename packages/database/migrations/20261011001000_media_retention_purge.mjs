// Issue #607 (database half; the job of the worker is the next pull request). Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-10-11-midia-removida-sai-do-armazenamento-30-dias-depois-e-a-linha-fica.md. It adds a column to
// `media_assets` and changes what the quota function counts. specs/conteudo.md §3 (`removed_at`: "o arquivo sai pelo fluxo de retenção")
// and §8 ("a remoção lógica entra no fluxo de retenção").
//
// A removed media (20261007001500) leaves its folder and stays in storage. This is the other half of that sentence: after the retention period
// the file leaves the bucket and the row stays, stamped, for the audit.
//
//  - `purged_at` says the objects of the media are gone from storage. It has no grant to `ageniza_app` (a new column is not writable until a
//    migration grants it), so only the function below writes it, and a check keeps it from existing on a media that was never removed.
//  - `media_retention_period()` is the one place the 30 days live. The list and the stamp read it, so they cannot keep two periods.
//  - `media_due_for_purge(limit)` is what the worker asks: the removed, not yet purged media whose period is over, with the keys of what
//    to delete (the original, the staging key, and the thumbnail and the preview of a video), the oldest first. It leaves out a media that
//    a content waiting for approval, approved or published uses (rule 12), which `remove_media_asset` already refuses and which this
//    asks again, since the file of a content the client is looking at is never what a clock deletes.
//  - `mark_media_purged(asset)` is what the worker calls AFTER it deleted the objects: under the lock of the media, and of the contents that
//    use it (as `remove_media_asset` takes them), it asks the same two questions again and stamps `purged_at`, writing `media.purged` to the
//    audit. It answers whether it stamped. Deleting before stamping, never the reverse, is what makes a crash between the two a repeated
//    delete (which storage answers as done) instead of a file that stays for ever with a row that says it left. A removed media cannot gain
//    a use after the list was read: a content refuses a removed file (A0069 on the cover, `content_media_is_complete` on the files).
//  - Both are `security definer`, closed to PUBLIC and open to `ageniza_app`, which is the role the worker connects as, and both refuse a
//    caller with an actor bound to the transaction (42501): every request of the API binds one and the worker never does, so a request
//    cannot ask for the keys of the files, as it cannot read the queue of e-mail (20261011000100). They need READ COMMITTED (40001
//    otherwise), because they lock and then read again.
//  - `agency_media_usage` stops counting what was purged and keeps counting what was only removed: the object of the second is still in
//    storage, and "quem remove muita mídia não ganha cota de volta até a retenção apagar o arquivo" (decision of 2026-10-07).
//
// Error codes: none new. A refused caller is 42501, a wrong isolation is 40001 and a wrong limit is 22023.

export async function up(knex) {
  await knex.raw(`
    alter table public.media_assets
      add column purged_at timestamptz null,
      add constraint media_assets_purged_after_removal check (purged_at is null or removed_at is not null);

    create function app_private.media_retention_period()
    returns interval
    language sql
    immutable
    set search_path = ''
    as $function$
      select interval '30 days'
    $function$;
    revoke all on function app_private.media_retention_period() from public;

    create function app_private.media_due_for_purge(p_limit integer)
    returns table (
      asset_id uuid,
      agency_id uuid,
      object_key text,
      upload_object_key text,
      thumbnail_object_key text,
      preview_object_key text
    )
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The media to purge is read by the worker, not by a request.';
      end if;
      if p_limit is null or p_limit < 1 or p_limit > 500 then
        raise exception using errcode = '22023', message = 'The batch is between 1 and 500 media.';
      end if;

      return query
      select asset.id, asset.agency_id, asset.object_key, asset.upload_object_key, asset.thumbnail_object_key, asset.preview_object_key
      from public.media_assets asset
      where asset.removed_at is not null
        and asset.purged_at is null
        and asset.removed_at <= pg_catalog.now() - app_private.media_retention_period()
        and not exists (
          select 1
          from public.contents content
          where content.status in ('awaiting_approval', 'approved', 'published')
            and (
              content.cover_asset_id = asset.id
              or exists (select 1 from public.content_media item where item.content_id = content.id and item.asset_id = asset.id)
            )
        )
      order by asset.removed_at, asset.id
      limit p_limit;
    end;
    $function$;
    revoke all on function app_private.media_due_for_purge(integer) from public;
    grant execute on function app_private.media_due_for_purge(integer) to ageniza_app;

    create function app_private.mark_media_purged(p_asset_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_asset public.media_assets;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'A media is marked as purged by the worker, not by a request.';
      end if;

      select asset.* into v_asset from public.media_assets asset where asset.id = p_asset_id for update;
      if not found or v_asset.removed_at is null or v_asset.purged_at is not null then
        return false;
      end if;
      if v_asset.removed_at > pg_catalog.now() - app_private.media_retention_period() then
        return false;
      end if;

      -- The contents that use it are locked before their state is read, as remove_media_asset does: one that is being sent for approval
      -- at this moment is waited for, and its state is the one this reads next.
      perform 1
      from public.contents content
      where content.id in (select item.content_id from public.content_media item where item.asset_id = p_asset_id)
        or content.cover_asset_id = p_asset_id
      for update;

      if exists (
        select 1
        from public.contents content
        where (
            content.id in (select item.content_id from public.content_media item where item.asset_id = p_asset_id)
            or content.cover_asset_id = p_asset_id
          )
          and content.status in ('awaiting_approval', 'approved', 'published')
      ) then
        return false;
      end if;

      update public.media_assets
      set purged_at = pg_catalog.now(), updated_at = pg_catalog.now()
      where id = p_asset_id;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
      values ('media.purged', null, v_asset.agency_id, 'media_asset', p_asset_id, 'job:media.purge-removed');

      return true;
    end;
    $function$;
    revoke all on function app_private.mark_media_purged(uuid) from public;
    grant execute on function app_private.mark_media_purged(uuid) to ageniza_app;

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
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
