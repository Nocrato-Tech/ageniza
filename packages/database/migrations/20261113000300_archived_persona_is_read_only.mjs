// Issue #891. Forward-only. Decision: docs/business/decisions/2026-11-13-persona-arquivada-e-somente-leitura.md.
//
// An archived persona is read-only: the only write it takes is the one that changes its status (unarchive), and that write changes
// nothing else. The policies of `client_personas` do not look at the status of the row they update, so the application role could
// write an archived persona through any client. The trigger is BEFORE UPDATE, so a write that waited on a lock (an archive that
// was still uncommitted) is judged on the row the archive left, not on the one it read first.
//
// "Nothing else" is every column but `status`, `updated_by` and `updated_at`, compared through the whole row, so a column added later
// is read-only too without editing this function. No column, policy or grant changes. Error code A0137 is mapped to 409
// PERSONA_READ_ONLY by the clients module. The owner (migrations, operations, the demo seed) is not constrained, like the lock of
// the children: a role that RLS does not constrain skips it, by attribute and not by name (20261010000300); session_user cannot be
// changed by `ageniza_app`. The function is security invoker and reads no table.

export async function up(knex) {
  await knex.raw(`
    create function app_private.refuse_archived_persona_edit()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if app_private.role_bypasses_rls(session_user) then
        return new;
      end if;

      if new.status = 'archived'
        or (pg_catalog.to_jsonb(new) operator(pg_catalog.-) array['status', 'updated_by', 'updated_at'])
          is distinct from (pg_catalog.to_jsonb(old) operator(pg_catalog.-) array['status', 'updated_by', 'updated_at']) then
        raise exception using errcode = 'A0137', message = 'Persona is archived and read-only.';
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.refuse_archived_persona_edit() from public;

    create trigger "0_client_personas_archived_read_only"
      before update on public.client_personas
      for each row
      when (old.status = 'archived')
      execute function app_private.refuse_archived_persona_edit();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
