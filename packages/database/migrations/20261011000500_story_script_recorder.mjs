// Issue #258. Forward-only, like every migration here. Only a new object: one read function.
//
// A recorded story script shows who recorded it (specs/conteudo.md §3, #248 review): a collaborator
// with a client link can record too, so the name has to be the one of the person's LINK to this client,
// not "somebody". The portal cannot read it under RLS: `client_memberships` shows a person only their own
// link (and the agency's members every link), so the person who recorded is invisible to the other people of
// the portal. Like `thread_comment_authors` (20261007000800), one `security definer`, single-purpose function
// is the read path of both sides, so that they cannot drift.
//
// For one script it answers the person who recorded it and the name on `auth."user"` reached THROUGH
// that person's link to the script's client, and nothing else. The access check repeats the
// `story_scripts_select` predicate with the functions the policy calls: the agency with
// `conteudo.visualizar`, or the active person of the client's portal, and only for a script that is
// recorded (a draft or a merely sent one has no recorder, and the portal never learns a draft exists).
// A caller who cannot read the script gets zero rows, exactly like a script that does not exist.
// A link removed later still answers: the recording is history, and the name that signed it stays.
// `search_path` is empty and every object is schema-qualified.

export async function up(knex) {
  await knex.raw(`
    create function app_private.story_script_recorder(p_script_id uuid)
    returns table (recorded_by uuid, name text)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select script.recorded_by, member.name
      from public.story_scripts script
      join public.client_memberships link
        on link.client_id = script.client_id
       and link.user_id = script.recorded_by
      join auth."user" member on member.id = link.user_id
      where script.id = p_script_id
        and script.status = 'recorded'
        and (
          app_private.has_agency_permission(app_private.client_agency_id(script.client_id), 'conteudo.visualizar')
          or app_private.is_client_member(script.client_id)
        )
    $function$;

    revoke all on function app_private.story_script_recorder(uuid) from public;
    grant execute on function app_private.story_script_recorder(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
