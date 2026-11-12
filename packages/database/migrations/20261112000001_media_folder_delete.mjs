// Decision: docs/business/decisions/2026-11-11-estrutural-a-midia-ganha-nome-dimensoes-texto-alternativo-renomear-e-mover.md (rule 9,
// the delete of a folder). Forward-only, no backfill; it adds one function and replaces one.
//
// `media_folders` has no DELETE grant and no DELETE policy, so a folder leaves only through `delete_media_folder`. The function is the
// whole rule: a folder that is not a default one and is empty. "Empty" is what the person sees plus what would break the foreign keys:
//
//  - no confirmed file that was not removed, and no upload that started in the last day (a pending upload is a file on its way into the
//    folder); the other rows that still point at the folder (a removed or purged media, a rejected upload, an upload abandoned for more
//    than a day) are history, and are let go of together with it: they keep their row (the audit and the retention read it) and lose the
//    folder, and an abandoned upload is closed as rejected so it cannot be confirmed into nothing;
//  - no subfolder and no content (a content is tied to its folder by foreign key, and its media with it).
//
// The order of locks is the one of `move_media_asset` and `remove_media_asset`: the permission is read BEFORE any lock, then the client
// FOR SHARE (conflicts with archiving it), then the folder FOR UPDATE, which waits for whoever holds the folder (an upload being started
// and a subfolder being created lock it the same way) and makes the emptiness be read after them, in a new statement.
// `move_media_asset` now takes the target folder FOR SHARE for the same reason: a move into a folder that is being deleted waits for the
// delete and finds the folder gone (A0080); a delete behind a move finds the file there (A0083). Without it the foreign key of the
// move would refuse with a 23503 after the delete committed.
//
// Stable error codes (the first three are the ones of 20261007001500):
//   A0080 -> 404  folder not found, of another agency, or the caller lacks the permission (one error: never an existence oracle)
//   A0081 -> 409  the client is archived
//   A0083 -> 409  the folder holds files (or an upload on its way)
//   A0084 -> 409  the folder has subfolders
//   A0085 -> 409  contents are tied to the folder
//   A0086 -> 409  a default folder is not deleted

const REPLACEMENT = {
  signature: 'app_private.move_media_asset(uuid, uuid)',
  before: 'select asset.* into v_asset from public.media_assets asset where asset.id = p_asset_id for update;',
  after: `-- The target folder is held, so a delete of it waits for this move and a move behind that delete finds it gone.
      perform 1 from public.media_folders folder where folder.id = p_folder_id and folder.client_id = v_client_id for share;
      if not found then
        raise exception using errcode = 'A0080', message = 'Media not found.';
      end if;

      select asset.* into v_asset from public.media_assets asset where asset.id = p_asset_id for update;`
};

export async function up(knex) {
  await knex.raw(`
    create function app_private.delete_media_folder(p_folder_id uuid)
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

      -- New statements: after the wait for the lock they see what the other transactions committed.
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

      update public.media_assets set folder_id = null where folder_id = p_folder_id;

      delete from public.media_folders where id = p_folder_id;
    end;
    $function$;
    revoke all on function app_private.delete_media_folder(uuid) from public;
    grant execute on function app_private.delete_media_folder(uuid) to ageniza_app;
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
