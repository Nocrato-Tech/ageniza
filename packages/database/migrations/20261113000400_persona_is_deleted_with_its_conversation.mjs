// Issue #891. Forward-only. Structural (a backfill and the first DELETE grant on a client table): docs/business/decisions/
// 2026-11-12-estrutural-a-persona-se-exclui-com-a-conversa-e-nao-se-arquiva.md.
//
// A persona is created, edited and deleted; it is never archived. Deleting it takes its conversation along.
//
//  - Backfill: the personas that were `archived` become `active` again. The stamps (`updated_by`, `updated_at`) are not touched: the
//    persona was not edited.
//  - No way to archive: the column stays, because the policies of five tables and the portal read it, but `check (status = 'active')`
//    holds it whoever writes (the owner too), the UPDATE grant on `status` is revoked, and the edit lock of the persona is created again
//    without it (that trigger lists exactly the columns `ageniza_app` may UPDATE, and a test of the catalog holds the two together).
//  - DELETE: `cliente.operar` on an active client, in the policy, like the policy of UPDATE. The grant is the table's only; `client_threads`
//    and `client_thread_comments` get none. What goes with the persona goes by the foreign keys (`on delete cascade`, which run as the owner
//    of the table and are not constrained by its RLS): the threads of the persona (`client_threads.persona_id`) and, through them, their
//    comments (`client_thread_comments.thread_id`). The notifications of a thread already cascade (20261112000200). Nothing else points
//    at a thread of a persona: `media_assets.material_request_thread_id` is only ever a request for material, and that foreign key stays
//    `no action`, so a row that did would stop the delete instead of being left without its thread.
//  - A BEFORE DELETE trigger takes the client FOR SHARE and re-reads its status, like the edit lock of the other children
//    (20261011000700): a delete that waited for an archive that was still uncommitted is refused with A0020 instead of landing on an
//    archived client. The owner (migrations, operations) is not constrained, by attribute and not by name (20261010000300).
//  - An AFTER DELETE trigger writes `persona.deleted` to `audit.events` in the same transaction, whoever deletes. Both functions have an
//    empty search_path; the first is security definer because `FOR SHARE` needs a privilege the application role does not have on `clients`.

export async function up(knex) {
  await knex.raw(`
    update public.client_personas set status = 'active' where status = 'archived';

    alter table public.client_personas drop constraint client_personas_status_check;
    alter table public.client_personas add constraint client_personas_status_check check (status = 'active');

    revoke update (status) on public.client_personas from ageniza_app;

    drop trigger "0_client_personas_edit_lock_active_client" on public.client_personas;
    create trigger "0_client_personas_edit_lock_active_client"
      after update of name, description, pains, desires, objections, age, occupation, location, traits, where_they_are, tone_that_works,
        updated_by, updated_at on public.client_personas
      for each row
      when (
        (old.name, old.description, old.pains, old.desires, old.objections, old.age, old.occupation, old.location, old.traits,
         old.where_they_are, old.tone_that_works, old.updated_by, old.updated_at)
        is distinct from
        (new.name, new.description, new.pains, new.desires, new.objections, new.age, new.occupation, new.location, new.traits,
         new.where_they_are, new.tone_that_works, new.updated_by, new.updated_at)
      )
      execute function app_private.lock_active_client_of_child();
  `);

  await knex.raw(`
    alter table public.client_threads
      drop constraint client_threads_persona_id_fkey,
      add constraint client_threads_persona_id_fkey foreign key (persona_id) references public.client_personas (id) on delete cascade;

    alter table public.client_thread_comments
      drop constraint client_thread_comments_thread_id_fkey,
      add constraint client_thread_comments_thread_id_fkey foreign key (thread_id) references public.client_threads (id) on delete cascade;
  `);

  await knex.raw(`
    grant delete on public.client_personas to ageniza_app;

    create policy client_personas_delete on public.client_personas
      for delete to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
      );

    create function app_private.lock_active_client_of_deleted_persona()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if app_private.role_bypasses_rls(session_user) then
        return old;
      end if;

      perform 1 from public.clients client where client.id = old.client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      return old;
    end;
    $function$;
    revoke all on function app_private.lock_active_client_of_deleted_persona() from public;

    create trigger "0_client_personas_delete_lock_active_client"
      before delete on public.client_personas
      for each row
      execute function app_private.lock_active_client_of_deleted_persona();

    create function app_private.audit_persona_deleted()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('persona.deleted', app_private.current_user_id(), app_private.client_agency_id(old.client_id), 'client_persona', old.id);
      return null;
    end;
    $function$;
    revoke all on function app_private.audit_persona_deleted() from public;

    create trigger "1_client_personas_audit_deleted"
      after delete on public.client_personas
      for each row
      execute function app_private.audit_persona_deleted();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
