// Decision: docs/business/decisions/2026-11-04-a-pasta-e-como-um-drive-o-conteudo-herda-a-midia-e-troca-de-pasta.md. Forward-only.
//
// 20261104000100 moved the folder of a content into `move_content_folder` but left the column grant of `contents.folder_id` as it was.
// With the grant, a direct UPDATE by `ageniza_app` of an approved or waiting content that holds no media and no cover passed, changing
// neither the status nor the revision: no foreign key trips on it, and nothing else asks for a new approval. The state does not come
// out of any route (submit_content wants a complete list, and set_content_media, move_content_folder and remove_media_asset refuse to
// empty or release it), but a column nobody writes should not be writable. The grant goes; `move_content_folder` is `security definer`
// and writes the column as its owner, so the move through it is the same.
//
// The edit trigger of 20261011000600 is tied to the columns `ageniza_app` may write by a catalog test, so it is recreated without
// `folder_id`. Nothing is lost: the function takes the client FOR SHARE before it writes (`lock_content_for_agency`), which is what the
// trigger would take again.
//
// About the lock order of 20261104000100 (client, content, then the media): the move takes the same locks in the same order as the
// other writers of a content, and `remove_media_asset` takes the client, the media and then the contents that use it. A race between
// the two can still end in a deadlock (40P01); it was reproduced with a PATCH that names the same folder and a list holding the media
// a removal is releasing. The API answers it as "try again" (409 TRY_AGAIN) and no data is left wrong, which is the accepted outcome
// of `set_content_media` already.

export async function up(knex) {
  await knex.raw(`
    revoke update (folder_id) on public.contents from ageniza_app;

    drop trigger "0_contents_edit_lock_active_client" on public.contents;

    create trigger "0_contents_edit_lock_active_client"
      after update of title, format, publish_on, publish_at_time, caption, cover_asset_id, owner_user_id
      on public.contents
      for each row
      when (
        (old.title, old.format, old.publish_on, old.publish_at_time, old.caption, old.cover_asset_id, old.owner_user_id)
        is distinct from
        (new.title, new.format, new.publish_on, new.publish_at_time, new.caption, new.cover_asset_id, new.owner_user_id)
      )
      execute function app_private.lock_active_client_of_child();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
