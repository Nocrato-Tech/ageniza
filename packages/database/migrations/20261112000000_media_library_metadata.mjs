// Decisions: docs/business/decisions/2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover.md and
// 2026-11-11-estrutural-a-midia-aceita-pdf-audio-e-svg-como-logo.md. Forward-only, no backfill: the media that exists keeps a null
// name, null dimensions and a null alternative text, and stays a photo or a video.
//
// `media_assets` gains `file_name`, `width`, `height` and `alt_text`, all nullable, and the category goes from two values to five
// (image, video, pdf, audio, logo). The logo is an image the agency marks as one, so an SVG is only ever a `logo`.
//
//  - `file_name` is written once, by the INSERT of the upload, and never becomes an object key (`object_key` keeps its shape check).
//    A CHECK refuses a path separator, a control or bidirectional character, a name of dots only and more than 255 characters, so a
//    caller that skips the route meets the same rule.
//  - `file_name` and `alt_text` are the two columns an edit may write (column grant, the policy of the UPDATE stays the one of the
//    table). An edit of either takes the active client FOR SHARE (`0_media_assets_edit_lock_active_client`, as every edit of a child
//    of the client), so a rename that loses the race with the archive is refused with A0020.
//  - `width` and `height` are granted for UPDATE only because the confirmation (an image) and the worker (a video, with the end of its
//    processing) write them with the row they already update. `media_assets_dimensions_written_once` holds them to that: both
//    together, once, only in those two transitions.
//  - The folder of a media is not a granted column (the two composite foreign keys of `content_media` and `contents` tie a content to
//    it). `move_media_asset` is the one writer, with the order of locks of `remove_media_asset` (client FOR SHARE, the media, then the
//    contents that use it) and the same refusal: a media in use by any content is not moved, because the foreign key of that content
//    would be violated by the new folder.
//  - Only a photo or a video enters a content: `set_content_media` selects them by category, and the cover was already a confirmed
//    `image` (`contents_guard`), which a logo is not.

const REPLACEMENT = {
  signature: 'app_private.set_content_media(uuid, uuid[])',
  before: 'and asset.removed_at is null;',
  after: "and asset.removed_at is null\n        and asset.category in ('image', 'video');"
};

export async function up(knex) {
  await knex.raw(`
    alter table public.media_assets
      add column file_name text null,
      add column width integer null,
      add column height integer null,
      add column alt_text text null,
      drop constraint media_assets_category_check,
      add constraint media_assets_category_check check (category in ('image', 'video', 'pdf', 'audio', 'logo')),
      add constraint media_assets_file_name_shape check (
        file_name is null
        or (
          file_name = pg_catalog.btrim(file_name)
          and pg_catalog.char_length(file_name) between 1 and 255
          and file_name !~ '[/\\\\]'
          and file_name !~ '^\\.+$'
          and file_name !~ '[\\u0001-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]'
        )
      ),
      add constraint media_assets_alt_text_shape check (
        alt_text is null
        or (
          pg_catalog.char_length(alt_text) between 1 and 500
          and alt_text !~ '[\\u0001-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]'
        )
      ),
      add constraint media_assets_dimensions_shape check (
        (width is null) = (height is null)
        and (width is null or (width between 1 and 100000 and height between 1 and 100000))
      ),
      add constraint media_assets_dimensions_category check (width is null or category in ('image', 'video', 'logo'));

    create index media_assets_client_recent_idx
      on public.media_assets (client_id, created_at desc, id desc)
      where client_id is not null and status = 'confirmed' and removed_at is null;

    grant insert (file_name) on public.media_assets to ageniza_app;
    grant update (file_name, alt_text, width, height) on public.media_assets to ageniza_app;

    create trigger "0_media_assets_edit_lock_active_client"
      after update of file_name, alt_text on public.media_assets
      for each row
      when ((old.file_name, old.alt_text) is distinct from (new.file_name, new.alt_text))
      execute function app_private.lock_active_client_of_child();

    create function app_private.media_asset_dimensions_are_written_once()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if app_private.role_bypasses_rls(current_user) then
        return new;
      end if;

      if (new.width, new.height) is distinct from (old.width, old.height) then
        if old.width is not null or old.height is not null or new.width is null or new.height is null then
          raise exception using
            errcode = '42501',
            message = 'The dimensions of a media are written once, together.';
        end if;

        if not (
          (new.category in ('image', 'logo') and old.status = 'pending' and new.status = 'confirmed')
          or (
            new.category = 'video' and old.status = 'confirmed' and new.status = 'confirmed'
            and old.video_processing_status = 'processing' and new.video_processing_status = 'ready'
          )
        ) then
          raise exception using
            errcode = '42501',
            message = 'The dimensions are written with the confirmation of an image or the end of the processing of a video.';
        end if;
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.media_asset_dimensions_are_written_once() from public;

    create trigger media_assets_dimensions_written_once
      before update on public.media_assets
      for each row
      execute function app_private.media_asset_dimensions_are_written_once();

    create function app_private.move_media_asset(p_asset_id uuid, p_folder_id uuid)
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

      -- The permission is checked BEFORE any lock, and every refusal reads the same: no media, no folder of the same client, no right.
      select asset.client_id, asset.agency_id into v_client_id, v_agency_id
      from public.media_assets asset
      where asset.id = p_asset_id and asset.client_id is not null;

      if not found
        or not (
          app_private.has_agency_permission(v_agency_id, 'conteudo.operar')
          and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
        )
        or not exists (select 1 from public.media_folders folder where folder.id = p_folder_id and folder.client_id = v_client_id)
      then
        raise exception using errcode = 'A0080', message = 'Media not found.';
      end if;

      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0081', message = 'The client is archived.';
      end if;

      select asset.* into v_asset from public.media_assets asset where asset.id = p_asset_id for update;
      if v_asset.status <> 'confirmed' or v_asset.removed_at is not null then
        raise exception using errcode = 'A0080', message = 'Media not found.';
      end if;
      if v_asset.folder_id is not distinct from p_folder_id then
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
        where content.id in (select item.content_id from public.content_media item where item.asset_id = p_asset_id)
          or content.cover_asset_id = p_asset_id
      ) then
        raise exception using errcode = 'A0082', message = 'A media used by a content is not moved.';
      end if;

      update public.media_assets set folder_id = p_folder_id, updated_at = pg_catalog.now() where id = p_asset_id;
      return true;
    end;
    $function$;
    revoke all on function app_private.move_media_asset(uuid, uuid) from public;
    grant execute on function app_private.move_media_asset(uuid, uuid) to ageniza_app;
  `);

  const { rows } = await knex.raw('select pg_catalog.pg_get_functiondef(?::pg_catalog.regprocedure) as definition', [REPLACEMENT.signature]);
  const definition = rows[0].definition;
  const occurrences = definition.split(REPLACEMENT.before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${REPLACEMENT.signature} must contain "${REPLACEMENT.before}" exactly once, found ${occurrences}.`);
  }
  await knex.raw(definition.replace(REPLACEMENT.before, () => REPLACEMENT.after));
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
