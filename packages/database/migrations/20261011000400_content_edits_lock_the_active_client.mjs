// Issue #408. Forward-only. Decision: docs/business/decisions/2026-10-11-toda-edicao-de-conteudo-trava-o-cliente-ativo.md.
//
// Rule 14 of specs/conteudo.md was serialized with the archive only for the INSERT of a content and for the move of
// `publish_on` (20261007001400). Any other edit read the client as active under its own snapshot and could commit after an
// archive that was still uncommitted. The trigger of the move becomes the trigger of every edit of a column the application
// role may write, with the function the ten children use: A0020 in READ COMMITTED, 40001 from an older snapshot, and 42501
// from `contents_update` when the archive was already committed.
//
// Status and revision stay out: the functions that write them already take the client first, and the archive writes the
// status itself, holding the client. A row trigger runs after the content row is locked, so an UPDATE takes "content, then
// client", the reverse of the archive; the cycle is the accepted one of 2026-10-10 (40P01, TRY_AGAIN).

export async function up(knex) {
  await knex.raw(`
    drop trigger "0_contents_move_lock_active_client" on public.contents;

    create trigger "0_contents_edit_lock_active_client"
      after update of title, format, publish_on, publish_at_time, caption, folder_id, cover_asset_id, owner_user_id
      on public.contents
      for each row
      when (
        (old.title, old.format, old.publish_on, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id)
        is distinct from
        (new.title, new.format, new.publish_on, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id)
      )
      execute function app_private.lock_active_client_of_child();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
