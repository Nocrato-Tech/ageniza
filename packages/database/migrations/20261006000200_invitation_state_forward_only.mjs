// An invitation's end state is final (issue #290). Forward-only, and a new migration: the policy and
// the column grant it complements are in 20260925000000_invitation_update_permissions.mjs, which is
// not edited.
//
// Structural per docs/business/structural-changes.md, recorded in docs/business/decisions.md,
// 2026-10-06 ("ESTRUTURAL: o estado do convite só anda para frente, e quem garante é o banco").
//
// The hole: `invitations_update` checks which permission the caller holds, the grant lets
// `revoked_at` be written, and nothing checks the DIRECTION of the change. A role holding only
// `convite.cancelar` could set `revoked_at` back to null, and the original link of a revoked admin
// invitation then made the invitee an admin through `accept_invitation`, which trusts the row.
//
// The value comparison belongs in a BEFORE UPDATE trigger, not in a WITH CHECK sub-select (the
// Lessons in docs/security-review.md): the trigger reads OLD as it stands once the row is locked.
// Like `check_agency_membership_update`, it is security invoker and keyed on `current_user`, not on
// the `app.user_id` GUC, which ageniza_app can clear mid-statement. `accept_invitation` is security
// definer and writes `used_at` as the schema owner, so it reaches the trigger as the owner and is
// not governed; only the application role is. Writing the same value back is not a change.
//
// This trigger fires on UPDATE; the AFTER INSERT trigger PR #202 adds to the same table fires on
// INSERT, so the two never meet. Sorting by name only orders triggers of the same event.

export async function up(knex) {
  await knex.raw(`
    create function app_private.invitation_state_is_forward_only()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if current_user <> 'ageniza_app' then
        return new;
      end if;

      if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
        raise exception using
          errcode = '42501',
          message = 'A revoked invitation cannot be changed; create a new one.';
      end if;

      -- ageniza_app has no UPDATE grant on used_at today (only accept_invitation writes it); the
      -- check keeps a future grant from reopening the same hole.
      if old.used_at is not null and new.used_at is distinct from old.used_at then
        raise exception using
          errcode = '42501',
          message = 'A used invitation cannot be changed.';
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.invitation_state_is_forward_only() from public;

    create trigger invitations_state_forward_only
      before update on public.invitations
      for each row
      execute function app_private.invitation_state_is_forward_only();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
