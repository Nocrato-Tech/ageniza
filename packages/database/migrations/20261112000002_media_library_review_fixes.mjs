// Decision: docs/business/decisions/2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover.md (rules 9 and 10).
// The fixes of the security review of the media library (round 1). Forward-only; the one backfill is the one of `filed_at`.
//
//  1. `delete_media_folder` held the folder but not the media in it. An upload pending for more than a day is "abandoned", and one that
//     was confirmed while the folder went could be confirmed after the emptiness was read and then lose its folder (a confirmed file with
//     no folder: out of every list, still counted in the quota). The media of the folder are now locked FOR UPDATE, in the order of their
//     id, before the emptiness is read, so the read comes after any confirmation that was running, and a confirmation behind the delete
//     finds the upload rejected. Every statement that lets a file go of the folder carries the state of the file it lets go of, and a
//     file that is confirmed and not removed is never one of them: if one is left, the folder is refused with A0083, as before.
//  2. The two CHECKs of the name and the alternative text refuse the whole Bidi_Control set. U+061C (the Arabic letter mark) was the
//     one missing, and U+2028 and U+2029 (line and paragraph separator) go in as well: the name and the alternative text are one line.
//     The columns are only born in 20261112000000, but a row that already has one of these characters is cleaned first (replaced by a
//     space; a text left with nothing becomes null) so that the new CHECKs do not stop the migration.
//  3. `filed_at` is the instant a file was put in its folder by a person: the confirmation of the upload, the rename of the file and
//     its move to a folder (decision rule 10, the folder in use now). `updated_at` is written by more than that (the alternative text,
//     the processing of a video), so it could not say it. Nobody writes the column: `media_assets_stamp_filed_at` derives it from the
//     transition of the row, the way `confirmed_at` is stamped, and `ageniza_app` gets no grant on it. A confirmed file always has one, and a
//     row that is not confirmed has none (the owner can still move a row back, as a correction, and then the instant goes).
//     Backfill: the files that exist were filed when they were confirmed (`coalesce(confirmed_at, updated_at)`), since no rename or
//     move existed before.

const BIDI_AND_SEPARATORS = String.raw`\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff`;
const NEW_CHARACTERS = String.raw`\u061c\u2028\u2029`;

export async function up(knex) {
  await knex.raw(`
    -- 2. The rows that already have one of the characters the CHECKs now refuse. The edit lock refuses an archived client, and this is no edit.
    alter table public.media_assets disable trigger "0_media_assets_edit_lock_active_client";
    update public.media_assets
    set file_name = nullif(pg_catalog.btrim(pg_catalog.regexp_replace(file_name, '[${NEW_CHARACTERS}]', ' ', 'g')), '')
    where file_name ~ '[${NEW_CHARACTERS}]';
    update public.media_assets
    set alt_text = nullif(pg_catalog.btrim(pg_catalog.regexp_replace(alt_text, '[${NEW_CHARACTERS}]', ' ', 'g')), '')
    where alt_text ~ '[${NEW_CHARACTERS}]';
    alter table public.media_assets enable trigger "0_media_assets_edit_lock_active_client";

    alter table public.media_assets
      drop constraint media_assets_file_name_shape,
      drop constraint media_assets_alt_text_shape,
      add constraint media_assets_file_name_shape check (
        file_name is null
        or (
          file_name = pg_catalog.btrim(file_name)
          and pg_catalog.char_length(file_name) between 1 and 255
          and file_name !~ '[/\\\\]'
          and file_name !~ '^\\.+$'
          and file_name !~ '[${BIDI_AND_SEPARATORS}]'
        )
      ),
      add constraint media_assets_alt_text_shape check (
        alt_text is null
        or (
          pg_catalog.char_length(alt_text) between 1 and 500
          and alt_text !~ '[${BIDI_AND_SEPARATORS}]'
        )
      );

    -- 3. The instant a file was filed. The backfill comes before the trigger, which would not let it write.
    alter table public.media_assets add column filed_at timestamptz null;
    update public.media_assets set filed_at = coalesce(confirmed_at, updated_at) where status = 'confirmed';
    alter table public.media_assets
      add constraint media_assets_filed_at_confirmed check ((status = 'confirmed') = (filed_at is not null));

    create function app_private.media_asset_stamps_filed_at()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if tg_op = 'INSERT' then
        -- Only a seed, an import or a test inserts a file that is already confirmed: the application inserts a pending upload.
        new.filed_at := case when new.status = 'confirmed' then coalesce(new.confirmed_at, new.updated_at) end;
      elsif old.status <> 'confirmed' and new.status = 'confirmed' then
        new.filed_at := pg_catalog.now();
      elsif new.status = 'confirmed' and (
        new.file_name is distinct from old.file_name
        or (new.folder_id is not null and new.folder_id is distinct from old.folder_id)
      ) then
        new.filed_at := pg_catalog.now();
      elsif new.status <> 'confirmed' then
        new.filed_at := null;
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.media_asset_stamps_filed_at() from public;

    create trigger media_assets_stamp_filed_at
      before insert or update on public.media_assets
      for each row
      execute function app_private.media_asset_stamps_filed_at();

    -- 1. The folder with its media held.
    create or replace function app_private.delete_media_folder(p_folder_id uuid)
    returns void
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

      perform 1 from public.clients client where client.id = v_folder.client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0081', message = 'The client is archived.';
      end if;

      if v_folder.is_default then
        raise exception using errcode = 'A0086', message = 'A default folder is not deleted.';
      end if;

      select folder.* into v_folder from public.media_folders folder where folder.id = p_folder_id for update;
      if not found then
        raise exception using errcode = 'A0080', message = 'Folder not found.';
      end if;

      -- The media are held before they are counted: a confirmation that is running keeps its row until it commits, so the count
      -- below (a new statement) reads it as confirmed, and one that comes after finds the upload rejected, never a file with no folder.
      perform 1 from public.media_assets asset where asset.folder_id = p_folder_id order by asset.id for update;

      if exists (
        select 1
        from public.media_assets asset
        where asset.folder_id = p_folder_id
          and (
            (asset.status = 'confirmed' and asset.removed_at is null)
            or (asset.status = 'pending' and asset.updated_at >= pg_catalog.now() - interval '24 hours')
          )
      ) then
        raise exception using errcode = 'A0083', message = 'The folder holds files.';
      end if;
      if exists (select 1 from public.media_folders child where child.parent_id = p_folder_id) then
        raise exception using errcode = 'A0084', message = 'The folder has subfolders.';
      end if;
      if exists (select 1 from public.contents content where content.folder_id = p_folder_id) then
        raise exception using errcode = 'A0085', message = 'Contents are tied to the folder.';
      end if;

      update public.media_assets
      set status = 'rejected', rejected_reason = 'folder_deleted', folder_id = null, updated_at = pg_catalog.now()
      where folder_id = p_folder_id and status = 'pending';

      update public.media_assets
      set folder_id = null
      where folder_id = p_folder_id and (status = 'rejected' or removed_at is not null);

      -- Whatever is left is a file that is confirmed and not removed: it is never let go of.
      if exists (select 1 from public.media_assets asset where asset.folder_id = p_folder_id) then
        raise exception using errcode = 'A0083', message = 'The folder holds files.';
      end if;

      delete from public.media_folders where id = p_folder_id;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
