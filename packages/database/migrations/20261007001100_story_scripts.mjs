// Issue #248. Forward-only, like every migration here.
//
// Only new objects: two tables, three trigger functions and two `security definer` functions. The
// `revoke` that closes the default privileges on a new table is what the structural gate looks at,
// so the choices made here are recorded in
// docs/business/decisions/2026-10-07-conteudo-roteiro-de-stories-no-banco.md.
//
// specs/conteudo.md §3 (entities), §4 (states), §5 rules 1, 2 and 4, §6 (RLS).
//
// `story_scripts` -- a client's script for one day of stories, `draft` -> `sent` -> `recorded`:
//
//  - `status`, `recorded_by` and `recorded_at` are not insertable and not updatable by
//    `ageniza_app`. The only writers are `app_private.send_story_script` (needs `conteudo.operar`
//    and `conteudo.visualizar`) and `app_private.record_story_script` (needs an active link to the
//    client, nothing from the agency). Both are `security definer` and check the caller inside, before
//    taking the row lock, so a caller who may not act never waits on another tenant's lock.
//  - A BEFORE UPDATE trigger (security invoker, no `current_user` shortcut: the two functions above run
//    as the owner, and the direction must hold for them too) allows `draft -> sent` and `sent -> recorded`
//    and nothing else, never changes the identity columns, and stamps `recorded_by` / `recorded_at` from the
//    actor bound in the transaction and from `now()`. Nothing the caller sends reaches them.
//  - `ageniza_app` writes `script_on` (the day) and nothing else, and only while the script is a draft: the
//    trigger refuses the edit of a sent or recorded script with `A0052`. That rule is NOT in the policy on
//    purpose: the policy lets every operator see and lock the row (`select ... for update` needs the UPDATE
//    policy's USING to pass and would silently return zero rows otherwise), and one rule lives in one place.
//  - Read: the agency with `conteudo.visualizar`; the portal only a `sent` or `recorded` script of the
//    client it is linked to. The portal branch asks for the link, not for the absence of a collaborator
//    role: a person who is both reads, through the agency branch, whatever the agency role allows, and a
//    person with a client link and no `conteudo.*` reads only what the portal reads.
//  - Write (INSERT and UPDATE): `conteudo.operar` AND `conteudo.visualizar` (a write that cannot read its
//    own row is a blind write), and the client must be active (rule 14 and "cliente arquivado não recebe
//    roteiro novo"). The active-client test is in WITH CHECK only, for the same reason as above: the lock
//    must work, and the write then fails loudly instead of returning zero rows.
//  - No DELETE.
//
// `story_script_scenes` -- ordered scenes (`position`, `text`, optional `guidance`) of a script. It carries
// `client_id` too, tied to the script by a composite foreign key, so a policy never joins to find the
// tenant. A scene is added or edited only while its script is a draft; the BEFORE trigger takes
// `select ... for share` on the script row, which conflicts with the row lock that `send_story_script`
// takes, so a scene cannot slip into a script that is being sent at that same moment (READ COMMITTED
// would let a sub-select in a policy do exactly that). The scene has no DELETE: the SPEC's modal adds and
// reorders scenes, it does not remove them.
// `unique (script_id, position)` is deferrable, so one UPDATE can swap two positions.
//
// Text columns refuse a value that is only whitespace (ASCII, NBSP, the Unicode space separators) and
// are capped at 20000 bytes. Zero-width characters and control characters are refused by the route's
// schema (#258), not here.
//
// Stable error codes for the API (#258):
//   A0050 -> 404  script not found, of another client or agency, a draft the caller cannot read, or the
//                 caller lacks the permission or the link (one error for all: never an existence oracle)
//   A0051 -> 409  the client is archived
//   A0052 -> 409  the script is not in the state the operation needs (a sent script is not edited,
//                 a recorded one is not sent again, a draft is not recorded)

const isBlank = (column) =>
  `regexp_replace(${column}, '[[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+', '', 'g') = ''`;

export async function up(knex) {
  await knex.raw(`
    create table public.story_scripts (
      id uuid not null default gen_random_uuid() primary key,
      client_id uuid not null references public.clients(id),
      script_on date not null,
      status text not null default 'draft' check (status in ('draft', 'sent', 'recorded')),
      recorded_by uuid null references auth."user"(id),
      recorded_at timestamptz null,
      created_at timestamptz not null default now(),
      constraint story_scripts_id_client_id_key unique (id, client_id),
      constraint story_scripts_recorded_check check (
        (status = 'recorded') = (recorded_by is not null and recorded_at is not null)
        and (recorded_by is null) = (recorded_at is null)
      )
    );
    create index story_scripts_client_day_idx on public.story_scripts (client_id, script_on);

    alter table public.story_scripts enable row level security;
    alter table public.story_scripts force row level security;

    revoke all on public.story_scripts from ageniza_app;
    grant select on public.story_scripts to ageniza_app;
    grant insert (id, client_id, script_on) on public.story_scripts to ageniza_app;
    grant update (script_on) on public.story_scripts to ageniza_app;

    create policy story_scripts_select on public.story_scripts
      for select to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
        or (status in ('sent', 'recorded') and app_private.is_client_member(client_id))
      );

    create policy story_scripts_insert on public.story_scripts
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      );

    create policy story_scripts_update on public.story_scripts
      for update to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      )
      with check (
        app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      );
  `);

  await knex.raw(`
    create table public.story_script_scenes (
      id uuid not null default gen_random_uuid() primary key,
      script_id uuid not null,
      client_id uuid not null,
      position integer not null check (position >= 1),
      text text not null check (not (${isBlank('text')}) and octet_length(text) <= 20000),
      guidance text null check (guidance is null or (not (${isBlank('guidance')}) and octet_length(guidance) <= 20000)),
      created_at timestamptz not null default now(),
      constraint story_script_scenes_script_fk foreign key (script_id, client_id)
        references public.story_scripts (id, client_id),
      constraint story_script_scenes_position_key unique (script_id, position) deferrable initially immediate
    );

    alter table public.story_script_scenes enable row level security;
    alter table public.story_script_scenes force row level security;

    revoke all on public.story_script_scenes from ageniza_app;
    grant select on public.story_script_scenes to ageniza_app;
    grant insert (id, script_id, client_id, position, text, guidance) on public.story_script_scenes to ageniza_app;
    grant update (position, text, guidance) on public.story_script_scenes to ageniza_app;

    create policy story_script_scenes_select on public.story_script_scenes
      for select to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
        or (
          app_private.is_client_member(client_id)
          and exists (
            select 1 from public.story_scripts script
            where script.id = script_id and script.status in ('sent', 'recorded')
          )
        )
      );

    create policy story_script_scenes_insert on public.story_script_scenes
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      );

    create policy story_script_scenes_update on public.story_script_scenes
      for update to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      )
      with check (
        app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      );
  `);

  await knex.raw(`
    create function app_private.story_scripts_guard_update()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if (new.id, new.client_id, new.created_at) is distinct from (old.id, old.client_id, old.created_at) then
        raise exception using
          errcode = '42501',
          message = 'The identity of a story script never changes.';
      end if;

      if new.status is distinct from old.status then
        if (old.status, new.status) not in (('draft', 'sent'), ('sent', 'recorded')) then
          raise exception using
            errcode = '42501',
            message = 'A story script only moves from draft to sent and from sent to recorded.';
        end if;

        if new.script_on is distinct from old.script_on then
          raise exception using
            errcode = '42501',
            message = 'A change of state carries no other change.';
        end if;

        if new.status = 'sent' then
          if new.recorded_by is not null or new.recorded_at is not null then
            raise exception using
              errcode = '42501',
              message = 'A script that was only sent has no recording.';
          end if;
        else
          -- Fixed here, from the actor bound in this transaction: no caller chooses who recorded or when.
          new.recorded_by := app_private.current_user_id();
          new.recorded_at := pg_catalog.now();
          if new.recorded_by is null then
            raise exception using
              errcode = '42501',
              message = 'A story script is recorded by a person.';
          end if;
        end if;
      else
        if (new.recorded_by, new.recorded_at) is distinct from (old.recorded_by, old.recorded_at) then
          raise exception using
            errcode = '42501',
            message = 'Who recorded a story script, and when, is written once, with the state.';
        end if;

        if new.script_on is distinct from old.script_on and old.status <> 'draft' then
          raise exception using
            errcode = 'A0052',
            message = 'A story script that was sent is no longer edited.';
        end if;
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.story_scripts_guard_update() from public;

    create trigger story_scripts_guard_update
      before update on public.story_scripts
      for each row
      execute function app_private.story_scripts_guard_update();

    create function app_private.story_script_scenes_guard_write()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_status text;
    begin
      if current_user <> 'ageniza_app' then
        return new;
      end if;

      -- FOR SHARE conflicts with the FOR UPDATE of send_story_script: whoever comes second waits and then
      -- reads the committed state. A script not found here is left to the policy and the foreign key.
      select script.status into v_status
      from public.story_scripts script
      where script.id = new.script_id
      for share;

      if found and v_status <> 'draft' then
        raise exception using
          errcode = 'A0052',
          message = 'The scenes of a story script that was sent are no longer edited.';
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.story_script_scenes_guard_write() from public;

    create trigger story_script_scenes_guard_write
      before insert or update on public.story_script_scenes
      for each row
      execute function app_private.story_script_scenes_guard_write();
  `);

  await knex.raw(`
    create function app_private.send_story_script(p_script_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_agency_id uuid;
      v_status text;
    begin
      -- The permission is checked BEFORE the lock, and an unknown script answers like a forbidden one.
      select script.client_id into v_client_id from public.story_scripts script where script.id = p_script_id;
      if not found then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      v_agency_id := app_private.client_agency_id(v_client_id);
      if not (
        app_private.has_agency_permission(v_agency_id, 'conteudo.operar')
        and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      select script.status into v_status from public.story_scripts script where script.id = p_script_id for update;

      if not app_private.client_is_active(v_client_id) then
        raise exception using errcode = 'A0051', message = 'The client is archived.';
      end if;

      -- Idempotent: sending a script that was already sent changes nothing.
      if v_status = 'sent' then
        return;
      end if;

      if v_status <> 'draft' then
        raise exception using errcode = 'A0052', message = 'Only a draft is sent.';
      end if;

      update public.story_scripts set status = 'sent' where id = p_script_id;
    end;
    $function$;
    revoke all on function app_private.send_story_script(uuid) from public;
    grant execute on function app_private.send_story_script(uuid) to ageniza_app;

    create function app_private.record_story_script(p_script_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
    begin
      select script.client_id, script.status into v_client_id, v_status
      from public.story_scripts script
      where script.id = p_script_id;

      -- Only an active person of the portal of this client records. An agency permission, the Owner's
      -- ownership and a removed link all fail the same way: the script is "not found".
      if not found or not app_private.is_client_member(v_client_id) then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      -- The portal never sees a draft, so it must not learn that one exists. A person who is also a
      -- collaborator with conteudo.visualizar already reads it and is told the truth below.
      if v_status = 'draft' and not app_private.has_agency_permission(
        app_private.client_agency_id(v_client_id), 'conteudo.visualizar'
      ) then
        raise exception using errcode = 'A0050', message = 'Story script not found.';
      end if;

      select script.status into v_status from public.story_scripts script where script.id = p_script_id for update;

      -- Idempotent, and the first person to record stays the one recorded.
      if v_status = 'recorded' then
        return;
      end if;

      if v_status <> 'sent' then
        raise exception using errcode = 'A0052', message = 'Only a sent script is recorded.';
      end if;

      update public.story_scripts set status = 'recorded' where id = p_script_id;
    end;
    $function$;
    revoke all on function app_private.record_story_script(uuid) from public;
    grant execute on function app_private.record_story_script(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
