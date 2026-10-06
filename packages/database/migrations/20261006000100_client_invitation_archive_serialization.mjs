// Serializes a portal invite with the archive of its client (issue #123, security re-review of PR #202).
// Forward-only, and a new migration: 20261006000050_client_lifecycle_functions.mjs is not edited.
//
// Structural per docs/business/structural-changes.md, recorded in docs/business/decisions.md,
// 2026-10-06 ("ESTRUTURAL: convite de portal e arquivamento do mesmo cliente se serializam por
// trava de linha").
//
// The race: T1 archives a client and has not committed; T2 inserts a client_invite. T2's snapshot
// still sees the client as active, so `invitations_insert` lets the row in, and the insert then
// waits on the foreign key to the client that T1 holds locked. When T1 commits, T2 completes: an
// archived client with a pending invite (specs/clientes.md §5 rules 6 and 15). The policy cannot
// close this alone, because it judges a snapshot the concurrent commit already made stale.
//
// The fix is an AFTER INSERT trigger, so it runs once the policy's WITH CHECK has passed: an
// unauthorized caller is refused by the policy and never waits on another tenant's row. It locks
// the client with FOR SHARE and re-reads the status after any wait; FOR SHARE conflicts with the
// FOR UPDATE of archive_client and archive_due_clients, and with any later write to that row.
// AFTER triggers fire in name order and the foreign key's own check is `RI_ConstraintTrigger_*`, so
// this one is named to sort before it: the lock is taken here, without leaning on the foreign key's
// wait to see the new status, and removing the lock is visible to the test.
//
// The opposite order needs no help: archive_client's FOR UPDATE waits for the insert's lock and its
// next statement, with a fresh snapshot, revokes the new invite.
//
// The function is `security definer` on purpose: a row lock also needs the client's UPDATE policy to
// pass, which a caller who may only invite does not satisfy, so as `ageniza_app` it would lock
// nothing and refuse a legitimate invite. It takes no argument beyond the inserted row, reads one
// column and writes nothing, so it gives the caller no new power.
//
// Error code, like the lifecycle functions' (the API, #131, translates it):
//   A0020 -> 404  the client is no longer active (or does not exist) by the time the invite lands

export async function up(knex) {
  await knex.raw(`
    create function app_private.lock_active_client_for_invitation()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if new.purpose <> 'client_invite' then
        return null;
      end if;

      perform 1
      from public.clients
      where id = new.client_id
        and status = 'active'
      for share;

      if not found then
        raise exception using errcode = 'A0020', message = 'Client not found.';
      end if;

      return null;
    end;
    $function$;
    revoke all on function app_private.lock_active_client_for_invitation() from public;

    create trigger "0_invitations_lock_active_client"
      after insert on public.invitations
      for each row
      execute function app_private.lock_active_client_for_invitation();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
