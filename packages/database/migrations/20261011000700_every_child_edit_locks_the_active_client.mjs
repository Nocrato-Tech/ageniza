// Issues #540 and #532. Forward-only. Decision: docs/business/decisions/2026-10-11-toda-edicao-das-filhas-do-cliente-trava-o-cliente-ativo.md,
// which extends 2026-10-11-toda-edicao-de-conteudo-trava-o-cliente-ativo.md (20261011000600) from `contents`, `story_scripts` and
// `story_script_scenes` to the other children of the client.
//
// The lock of a child was an AFTER INSERT trigger only (20261007001400). An UPDATE reads the client as active under the snapshot of
// its own statement, so it can commit after an archive that is still uncommitted: in READ COMMITTED the policy refuses it once the
// archive has committed, but not before, and from an older REPEATABLE READ snapshot the write lands after the archive. The edit
// triggers below take the client FOR SHARE (`lock_active_client_of_child`, the function of the ten children), re-read the status after
// the wait and raise A0020; from an older snapshot the FOR SHARE of an updated client row fails with 40001.
//
// Each trigger lists exactly the columns `ageniza_app` may UPDATE on its table (a test of the catalog compares the two), and its WHEN
// fires only when one of those values changes. The ones that only a function writes (`status` of a task, `parent_id`, `is_default`)
// are not granted and stay out: the functions already take the client first. The archive writes only `clients`, `invitations` and
// `contents`, so none of these rows is one it waits for, and the lock adds no cycle with it.
//
// `media_assets` (#532) is the one table where the trigger is NOT every granted column. The confirmation of an upload
// (`status` pending -> confirmed) is the write of a client's media that the archive must serialize: a media confirmed after the archive
// is a media of a client that no longer takes writes. The other granted columns are written by the worker after the confirmation
// (the thumbnail, the preview, the processing state), and refusing them for an archived client would leave a video processing forever; a
// rejection leaves the media out of the client's library, so it is not refused either. The `complete` route already refuses the client
// archived before the call and now maps A0020 to the same 409.

export async function up(knex) {
  await knex.raw(`
    create trigger "0_content_tasks_edit_lock_active_client"
      after update of title, description, assignee_user_id, due_on on public.content_tasks
      for each row
      when (
        (old.title, old.description, old.assignee_user_id, old.due_on)
        is distinct from
        (new.title, new.description, new.assignee_user_id, new.due_on)
      )
      execute function app_private.lock_active_client_of_child();

    create trigger "0_media_folders_edit_lock_active_client"
      after update of name on public.media_folders
      for each row
      when (old.name is distinct from new.name)
      execute function app_private.lock_active_client_of_child();

    create trigger "0_client_personas_edit_lock_active_client"
      after update of name, description, pains, desires, objections, status, updated_by, updated_at on public.client_personas
      for each row
      when (
        (old.name, old.description, old.pains, old.desires, old.objections, old.status, old.updated_by, old.updated_at)
        is distinct from
        (new.name, new.description, new.pains, new.desires, new.objections, new.status, new.updated_by, new.updated_at)
      )
      execute function app_private.lock_active_client_of_child();

    create trigger "0_client_brand_sections_edit_lock_active_client"
      after update of body, colors, archetype, updated_by, updated_at on public.client_brand_sections
      for each row
      when (
        (old.body, old.colors, old.archetype, old.updated_by, old.updated_at)
        is distinct from
        (new.body, new.colors, new.archetype, new.updated_by, new.updated_at)
      )
      execute function app_private.lock_active_client_of_child();

    create trigger "0_client_threads_edit_lock_active_client"
      after update of resolved_at, resolved_by on public.client_threads
      for each row
      when ((old.resolved_at, old.resolved_by) is distinct from (new.resolved_at, new.resolved_by))
      execute function app_private.lock_active_client_of_child();

    create trigger "0_media_assets_confirm_lock_active_client"
      after update of status on public.media_assets
      for each row
      when (old.status is distinct from new.status and new.status = 'confirmed')
      execute function app_private.lock_active_client_of_child();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
