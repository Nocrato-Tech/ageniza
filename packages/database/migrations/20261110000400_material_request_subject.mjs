// The request for material as a subject of the conversation with the client (scope telas-melhorias, subtask S2).
// Structural: docs/business/decisions/2026-11-10-estrutural-pedido-de-material-e-assunto-proprio-da-conversa-do-cliente.md. The
// conversation of the client stays one table with the subject in typed columns: a request is a thread of the client with no content,
// no section and no persona, so the decision of 2026-11-07 (the portal does not read the conversation of a content in production) is
// untouched.
//
//  - `is_material_request` is the subject. It counts as one more subject in the check of "exactly one", under the same constraint name.
//  - `due_on` is the deadline, only with the request, from today to 90 days ahead in America/Sao_Paulo: the check IS the one of the
//    approval round (`check_approval_round_input`, error A0120), so the two cannot drift. The wrapper keeps the instant a parameter no
//    caller can set (the trigger passes `now()`, and the wrapper has no grant to the application role), so a test fixes it as the owner.
//  - Only the agency opens a request: `client_threads_material_request_agency_check` holds it whatever the policy says.
//
// The application role gets INSERT of the two columns and no UPDATE: the subject and the deadline never change after the thread is
// born. The policies are not changed, on purpose, because they already say what the decision asks: the portal of the client reads a
// thread with no content in any state and comments in it for the person with an active link to that client; the agency reads it like
// the other conversations and opens, comments and resolves it with `cliente.operar`, which is the permission of the conversations of
// the client; only the agency resolves; a comment of the client reopens a resolved thread, as in every conversation (20260930000300).

export async function up(knex) {
  await knex.raw(`
    alter table public.client_threads
      add column is_material_request boolean not null default false,
      add column due_on date;

    alter table public.client_threads
      drop constraint client_threads_subject_check,
      add constraint client_threads_subject_check check (
        num_nonnulls(section_key, persona_id, content_id) + (case when is_material_request then 1 else 0 end) = 1
      ),
      add constraint client_threads_material_request_agency_check check (not is_material_request or opened_side = 'agency'),
      add constraint client_threads_due_on_check check (due_on is null or is_material_request);

    grant insert (is_material_request, due_on) on public.client_threads to ageniza_app;

    create function app_private.check_material_request_due_on(p_due_on date, p_at timestamptz)
    returns void
    language plpgsql
    stable
    set search_path = ''
    as $function$
    begin
      perform app_private.check_approval_round_input(p_due_on, null, p_at);
    end;
    $function$;
    revoke all on function app_private.check_material_request_due_on(date, timestamptz) from public;

    -- security definer only to reach the internal check, which the application role cannot execute; it reads nothing but NEW.
    create function app_private.refuse_material_request_due_on_out_of_range()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.check_material_request_due_on(new.due_on, pg_catalog.now());
      return new;
    end;
    $function$;
    revoke all on function app_private.refuse_material_request_due_on_out_of_range() from public;

    create trigger client_threads_material_request_due_on
      before insert on public.client_threads
      for each row execute function app_private.refuse_material_request_due_on_out_of_range();
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
