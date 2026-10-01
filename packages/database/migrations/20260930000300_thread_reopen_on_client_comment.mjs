// Issue #212. Forward-only, like every migration in this repo.
//
// A client comment that arrives during a resolution used to be swallowed: `created_at` and
// `resolved_at` both default to `now()`, which is the transaction start, so a comment whose
// transaction began before the resolve and committed after it lands with `created_at` earlier than
// `resolved_at`. The derived state (apps/api/src/modules/clients/thread-state.ts) then still calls
// the thread resolved and the new client question leaves "aguardando a agência".
//
// This migration makes the reopen explicit and serializes the two operations on the thread row:
//
//  - `app_private.reopen_thread_on_client_comment()` is a DEFERRABLE INITIALLY DEFERRED constraint
//    trigger: it fires at COMMIT, so the last committer wins. A client comment that commits after a
//    resolve reopens the thread no matter when either transaction started. It locks the thread row
//    (`for update`) before reading it, so it serializes with a resolve that still holds that lock
//    and never clears a resolution it did not see.
//  - The resolve itself is an UPDATE of `client_threads`, which locks the thread row for the rest
//    of its transaction, so comment and resolve serialize on the same row.
//
// `security definer` is required: a portal client has no `cliente.operar`, so it cannot update the
// thread through RLS. The function is single-purpose -- it only clears `resolved_at`/`resolved_by`
// of the thread of a client comment -- and every object is schema-qualified under `set search_path`.
// No column grant is added and no policy is relaxed.
//
// Structural per docs/business/structural-changes.md (it adds triggers to deployed tables and
// revokes the function from public); recorded in docs/business/decisions.md, 2026-10-01.

export async function up(knex) {
  await knex.raw(`
    create function app_private.reopen_thread_on_client_comment()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_resolved boolean;
    begin
      -- Only a client comment reopens; an agency comment never does.
      if new.author_side <> 'client' then
        return null;
      end if;

      -- Lock the thread before reading: a concurrent resolve holds this row lock, so the read sees
      -- its committed value and the clear below is never based on a stale snapshot.
      select (thread.resolved_at is not null)
      into v_resolved
      from public.client_threads thread
      where thread.id = new.thread_id
      for update;

      if not found or not v_resolved then
        return null;
      end if;

      update public.client_threads
      set resolved_at = null, resolved_by = null
      where id = new.thread_id;

      return null;
    end;
    $function$;
    revoke all on function app_private.reopen_thread_on_client_comment() from public;

    -- Deferred so it runs at COMMIT: the client comment that commits last reopens the thread.
    create constraint trigger client_thread_comments_reopen
      after insert on public.client_thread_comments
      deferrable initially deferred
      for each row execute function app_private.reopen_thread_on_client_comment();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
