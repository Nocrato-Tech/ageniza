// Issue #249. Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-10-01-conteudo-impacto-estrutural.md (points 1 and 3) and
// docs/business/decisions/2026-10-07-conteudo-conteudo-no-banco.md, which records what the SPEC leaves open.
// Besides the three new tables it adds a unique constraint to `media_assets`.
//
// specs/conteudo.md §3 (entities), §4 (states), §5 rules 1 to 7, 9, 10, 11 and 14, §6 (RLS).
//
// `contents`:
//  - `status`, the approval, the publication and the cancellation columns are neither insertable nor
//    updatable by `ageniza_app`. They change only through the `security definer` functions below, each of
//    which checks the caller inside before taking the row lock, and a BEFORE UPDATE trigger (security
//    invoker, no `current_user` shortcut: the functions run as the owner and the direction must hold for them)
//    allows the transitions of §4 and nothing else, stamps `approved_by`/`approved_at`/`published_at`/
//    `cancelled_at` from the bound actor and from `now()`, and annuls an approval when the caption, the cover
//    or the format of an approved content changes (rule 6).
//  - The portal has NO policy on this table, on `content_media` or on `media_assets`: it reads through
//    `app_private.portal_contents` (title, date, format and status for a content in production, the rest only from
//    "awaiting approval" on) and `app_private.portal_content_media` (the columns of a media a client needs, and only
//    of a content it may open). Nothing internal (owner, approval reason, who approved, who uploaded, the storage
//    keys) is in a table or a row a client link can read.
//  - What a state needs is checked again whenever the database moves a content there by itself: an approved or
//    waiting content whose media or format changes keeps a media that fits its format, and `publish_content`
//    checks it too.
//  - The owner of a content is the value that authorizes approving its subtasks, so changing it needs
//    `conteudo.aprovar_pela_agencia` (42501), and a subtask records who approved it and when.
//  - `revision` counts the changes of caption, cover, format and media. Approving takes the revision the person
//    saw, so a caption edited between the reading and the click is refused instead of approved unseen.
//  - Published and cancelled contents are not edited at all; a date moves in every other state.
//  - Day rules (a publication is not in the future, an undo happens on the day of the publication) use
//    `app_private.sao_paulo_date`, never the server's zone, so they are tested at fixed instants.
//
// `content_media` is written only by `app_private.set_content_media` (the whole ordered list at once), which
// is how a media leaves a content without a DELETE for `ageniza_app`. Composite foreign keys tie the media to
// the client and the folder of the content, and the cover to the same folder.
//
// `content_tasks` has no policy a client link satisfies. `status` and `return_comment` change only through the
// three task functions; approving or returning needs to be the content's owner or to hold
// `conteudo.aprovar_pela_agencia`. A person named as owner or assignee must be an active collaborator who can
// see Conteúdo (trigger), so nobody is named to act on what they cannot read.
//
// Stable error codes for the API:
//   A0060 -> 404  content not found, of another client or agency, or the caller lacks the permission or the link
//   A0061 -> 409  the client is archived
//   A0062 -> 409  the content is not in the state the operation needs
//   A0063 -> 409  the content changed since the revision the caller saw
//   A0064 -> 409  a publication is undone only on the day it was made
//   A0065 -> 409  the media is not complete for the format
//   A0066 -> 409  a subtask is not approved
//   A0067 -> 400  the publication date is missing or in the future
//   A0068 -> 400  a reason or a comment is blank or too long
//   A0069 -> 400  invalid media selection or cover
//   A0070 -> 404  task not found, or the caller cannot read it
//   A0071 -> 409  the task (or its content) is not in the state the operation needs
//   A0073 -> 400  the person named is not an active collaborator who can see Conteúdo
//   A0074 -> 403  the caller reads the task but may not do this to it

const isBlank = (column) =>
  `regexp_replace(${column}, '[[:space:]\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+', '', 'g') = ''`;

const OPEN_TO_CLIENT = "('awaiting_approval', 'adjusting', 'approved', 'published')";

export async function up(knex) {
  await knex.raw(`
    create function app_private.sao_paulo_date(p_at timestamptz)
    returns date
    language sql
    stable
    set search_path = ''
    as $function$
      select (p_at at time zone 'America/Sao_Paulo')::date
    $function$;
    revoke all on function app_private.sao_paulo_date(timestamptz) from public;
    grant execute on function app_private.sao_paulo_date(timestamptz) to ageniza_app;

    create function app_private.agency_user_can(p_agency_id uuid, p_user_id uuid, p_permission text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1 from public.agencies agency
        where agency.id = p_agency_id and agency.status = 'active' and agency.owner_user_id = p_user_id
      ) or exists (
        select 1
        from public.agencies agency
        join public.agency_memberships membership on membership.agency_id = agency.id
        join public.roles role on role.id = membership.role_id
        join public.role_permissions role_permission on role_permission.role_id = role.id
        where agency.id = p_agency_id
          and agency.status = 'active'
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and (role.agency_id is null or role.agency_id = agency.id)
          and role_permission.permission_key = p_permission
      )
    $function$;
    revoke all on function app_private.agency_user_can(uuid, uuid, text) from public;

    alter table public.media_assets
      add constraint media_assets_id_client_id_folder_id_key unique (id, client_id, folder_id);
  `);

  await knex.raw(`
    create table public.contents (
      id uuid not null default gen_random_uuid() primary key,
      client_id uuid not null references public.clients(id),
      title text not null check (char_length(title) <= 120 and not (${isBlank('title')})),
      platform text not null,
      format text not null,
      publish_on date not null,
      publish_at_time time null,
      caption text null check (caption is null or char_length(caption) <= 2200),
      folder_id uuid not null,
      cover_asset_id uuid null,
      owner_user_id uuid not null default app_private.current_user_id() references auth."user"(id),
      status text not null default 'in_production' check (
        status in ('in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled')
      ),
      revision integer not null default 1,
      approved_by uuid null references auth."user"(id),
      approved_at timestamptz null,
      approved_by_agency_reason text null check (
        approved_by_agency_reason is null
        or (not (${isBlank('approved_by_agency_reason')}) and octet_length(approved_by_agency_reason) <= 5000)
      ),
      published_on date null,
      published_at timestamptz null,
      cancelled_at timestamptz null,
      created_at timestamptz not null default now(),
      constraint contents_id_client_id_key unique (id, client_id),
      constraint contents_id_client_id_folder_id_key unique (id, client_id, folder_id),
      constraint contents_platform_format_check check ((platform, format) in (
        ('instagram', 'image'), ('instagram', 'carousel'), ('instagram', 'reels'),
        ('instagram', 'long_video'), ('instagram', 'vsl')
      )),
      constraint contents_folder_fk foreign key (folder_id, client_id)
        references public.media_folders (id, client_id),
      constraint contents_cover_fk foreign key (cover_asset_id, client_id, folder_id)
        references public.media_assets (id, client_id, folder_id),
      constraint contents_state_shape check (
        (status in ('approved', 'published')) = (approved_by is not null)
        and (approved_by is null) = (approved_at is null)
        and (approved_by_agency_reason is null or approved_by is not null)
        and (status = 'published') = (published_on is not null)
        and (published_on is null) = (published_at is null)
        and (status = 'cancelled') = (cancelled_at is not null)
      )
    );
    create index contents_client_day_idx on public.contents (client_id, publish_on);
    create index contents_client_status_idx on public.contents (client_id, status);

    alter table public.contents enable row level security;
    alter table public.contents force row level security;

    revoke all on public.contents from ageniza_app;
    grant select on public.contents to ageniza_app;
    grant insert (id, client_id, title, platform, format, publish_on, publish_at_time, caption, folder_id, cover_asset_id, owner_user_id)
      on public.contents to ageniza_app;
    grant update (title, format, publish_on, publish_at_time, caption, folder_id, cover_asset_id, owner_user_id)
      on public.contents to ageniza_app;

    create policy contents_select on public.contents
      for select to ageniza_app
      using (app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar'));

    create policy contents_insert on public.contents
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      );

    create policy contents_update on public.contents
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
    create function app_private.content_open_to_client(p_content_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select exists (
        select 1 from public.contents content
        where content.id = p_content_id
          and content.status in ${OPEN_TO_CLIENT}
          and app_private.is_client_member(content.client_id)
      )
    $function$;
    revoke all on function app_private.content_open_to_client(uuid) from public;
    grant execute on function app_private.content_open_to_client(uuid) to ageniza_app;

    create table public.content_media (
      content_id uuid not null,
      asset_id uuid not null,
      client_id uuid not null,
      folder_id uuid not null,
      position integer not null check (position between 1 and 20),
      created_at timestamptz not null default now(),
      primary key (content_id, asset_id),
      constraint content_media_content_fk foreign key (content_id, client_id, folder_id)
        references public.contents (id, client_id, folder_id),
      constraint content_media_asset_fk foreign key (asset_id, client_id, folder_id)
        references public.media_assets (id, client_id, folder_id),
      constraint content_media_position_key unique (content_id, position) deferrable initially immediate
    );
    create index content_media_asset_idx on public.content_media (asset_id);

    alter table public.content_media enable row level security;
    alter table public.content_media force row level security;

    revoke all on public.content_media from ageniza_app;
    grant select on public.content_media to ageniza_app;

    create policy content_media_select on public.content_media
      for select to ageniza_app
      using (app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar'));
  `);

  await knex.raw(`
    create table public.content_tasks (
      id uuid not null default gen_random_uuid() primary key,
      content_id uuid not null,
      client_id uuid not null,
      title text not null check (octet_length(title) <= 1024 and not (${isBlank('title')})),
      description text null check (description is null or octet_length(description) <= 20000),
      assignee_user_id uuid not null references auth."user"(id),
      due_on date not null,
      status text not null default 'pending' check (status in ('pending', 'delivered', 'approved')),
      return_comment text null check (
        return_comment is null or (not (${isBlank('return_comment')}) and octet_length(return_comment) <= 5000 and status = 'pending')
      ),
      approved_by uuid null references auth."user"(id),
      approved_at timestamptz null,
      created_at timestamptz not null default now(),
      constraint content_tasks_content_fk foreign key (content_id, client_id)
        references public.contents (id, client_id),
      constraint content_tasks_approval_shape check (
        (status = 'approved') = (approved_by is not null) and (approved_by is null) = (approved_at is null)
      )
    );
    create index content_tasks_content_idx on public.content_tasks (content_id);

    alter table public.content_tasks enable row level security;
    alter table public.content_tasks force row level security;

    revoke all on public.content_tasks from ageniza_app;
    grant select on public.content_tasks to ageniza_app;
    grant insert (id, content_id, client_id, title, description, assignee_user_id, due_on) on public.content_tasks to ageniza_app;
    grant update (title, description, assignee_user_id, due_on) on public.content_tasks to ageniza_app;

    create policy content_tasks_select on public.content_tasks
      for select to ageniza_app
      using (app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar'));

    create policy content_tasks_insert on public.content_tasks
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.operar')
        and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'conteudo.visualizar')
      );

    create policy content_tasks_update on public.content_tasks
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
    create function app_private.contents_check_references()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      -- The owner decides who may approve a subtask, so a person who only operates cannot move it to themselves.
      if tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id and not app_private.has_agency_permission(
        app_private.client_agency_id(new.client_id), 'conteudo.aprovar_pela_agencia'
      ) then
        raise exception using
          errcode = '42501',
          message = 'Only who approves for the agency changes the person in charge of a content.';
      end if;

      if (tg_op = 'INSERT' or new.owner_user_id is distinct from old.owner_user_id) and not app_private.agency_user_can(
        app_private.client_agency_id(new.client_id), new.owner_user_id, 'conteudo.visualizar'
      ) then
        raise exception using
          errcode = 'A0073',
          message = 'The person in charge of a content is an active collaborator who can see Conteúdo.';
      end if;

      -- A content that waits for approval or is approved keeps a media that fits its format.
      if tg_op = 'UPDATE' and new.format is distinct from old.format and old.status in ('awaiting_approval', 'approved')
        and not app_private.content_media_is_complete(new.id, new.format)
      then
        raise exception using
          errcode = 'A0065',
          message = 'The media is not complete for the new format.';
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.contents_check_references() from public;

    create trigger contents_check_references
      before insert or update on public.contents
      for each row
      execute function app_private.contents_check_references();

    create function app_private.content_tasks_check_people()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id) and not app_private.agency_user_can(
        app_private.client_agency_id(new.client_id), new.assignee_user_id, 'conteudo.visualizar'
      ) then
        raise exception using
          errcode = 'A0073',
          message = 'The person in charge of a task is an active collaborator who can see Conteúdo.';
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.content_tasks_check_people() from public;

    create trigger content_tasks_check_people
      before insert or update on public.content_tasks
      for each row
      execute function app_private.content_tasks_check_people();

    create function app_private.contents_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
      v_category text;
      v_status text;
      v_removed_at timestamptz;
    begin
      if new.cover_asset_id is not null and (tg_op = 'INSERT' or new.cover_asset_id is distinct from old.cover_asset_id) then
        select asset.category, asset.status, asset.removed_at into v_category, v_status, v_removed_at
        from public.media_assets asset
        where asset.id = new.cover_asset_id;
        -- A cover that is not found is left to the policy and the foreign key.
        if found and (v_category <> 'image' or v_status <> 'confirmed' or v_removed_at is not null) then
          raise exception using
            errcode = 'A0069',
            message = 'The cover of a content is a confirmed image that was not removed.';
        end if;
      end if;

      if tg_op = 'INSERT' then
        return new;
      end if;

      if (new.id, new.client_id, new.platform, new.created_at) is distinct from (old.id, old.client_id, old.platform, old.created_at) then
        raise exception using
          errcode = '42501',
          message = 'The identity of a content never changes.';
      end if;

      if new.status is distinct from old.status then
        if (old.status, new.status) not in (
          ('in_production', 'awaiting_approval'), ('adjusting', 'awaiting_approval'), ('approved', 'awaiting_approval'),
          ('awaiting_approval', 'approved'), ('awaiting_approval', 'adjusting'),
          ('approved', 'published'), ('published', 'approved'),
          ('in_production', 'cancelled'), ('awaiting_approval', 'cancelled'), ('adjusting', 'cancelled'), ('approved', 'cancelled'),
          ('cancelled', 'in_production')
        ) then
          raise exception using
            errcode = '42501',
            message = 'A content only moves along the transitions of its life cycle.';
        end if;

        if (new.title, new.format, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id)
          is distinct from (old.title, old.format, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id)
          or (new.publish_on is distinct from old.publish_on and not (old.status = 'cancelled' and new.status = 'in_production'))
        then
          raise exception using
            errcode = '42501',
            message = 'A change of state carries no other change.';
        end if;

        if new.status = 'awaiting_approval' then
          new.approved_by := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'approved' and old.status = 'awaiting_approval' then
          -- Fixed here, from the actor bound in this transaction: no caller chooses who approved or when.
          new.approved_by := app_private.current_user_id();
          new.approved_at := pg_catalog.now();
          if new.approved_by is null then
            raise exception using
              errcode = '42501',
              message = 'A content is approved by a person.';
          end if;
        elsif new.status = 'approved' then
          if old.published_at is null or app_private.sao_paulo_date(old.published_at) <> v_today then
            raise exception using
              errcode = 'A0064',
              message = 'A publication is undone only on the day it was made.';
          end if;
          new.approved_by := old.approved_by;
          new.approved_at := old.approved_at;
          new.approved_by_agency_reason := old.approved_by_agency_reason;
          new.published_on := null;
          new.published_at := null;
        elsif new.status = 'published' then
          if new.published_on is null or new.published_on > v_today then
            raise exception using
              errcode = 'A0067',
              message = 'The real date of a publication is today or before, in America/Sao_Paulo.';
          end if;
          new.published_at := pg_catalog.now();
        elsif new.status = 'cancelled' then
          new.cancelled_at := pg_catalog.now();
          new.approved_by := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'in_production' then
          new.cancelled_at := null;
        end if;
      else
        if (new.approved_by, new.approved_at, new.approved_by_agency_reason, new.published_on, new.published_at, new.cancelled_at)
          is distinct from (old.approved_by, old.approved_at, old.approved_by_agency_reason, old.published_on, old.published_at, old.cancelled_at)
        then
          raise exception using
            errcode = '42501',
            message = 'Who approved, who published and who cancelled a content, and when, is written with the state.';
        end if;

        if old.status in ('published', 'cancelled') and (
          new.title, new.format, new.publish_on, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id
        ) is distinct from (
          old.title, old.format, old.publish_on, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id
        ) then
          raise exception using
            errcode = 'A0062',
            message = 'A published or cancelled content is no longer edited.';
        end if;

        if new.caption is distinct from old.caption
          or new.cover_asset_id is distinct from old.cover_asset_id
          or new.format is distinct from old.format
        then
          new.revision := old.revision + 1;
          if old.status = 'approved' then
            new.status := 'awaiting_approval';
            new.approved_by := null;
            new.approved_at := null;
            new.approved_by_agency_reason := null;
          end if;
        end if;
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.contents_guard() from public;

    create trigger contents_guard
      before insert or update on public.contents
      for each row
      execute function app_private.contents_guard();

    create function app_private.content_tasks_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_content_status text;
    begin
      if tg_op = 'UPDATE' and (new.id, new.content_id, new.client_id, new.created_at)
        is distinct from (old.id, old.content_id, old.client_id, old.created_at)
      then
        raise exception using
          errcode = '42501',
          message = 'The identity of a task never changes.';
      end if;

      if tg_op = 'UPDATE' and new.status is distinct from old.status then
        if (old.status, new.status) not in (('pending', 'delivered'), ('delivered', 'approved'), ('delivered', 'pending')) then
          raise exception using
            errcode = '42501',
            message = 'A task only moves from pending to delivered, from delivered to approved, and back to pending.';
        end if;

        if (new.title, new.description, new.assignee_user_id, new.due_on)
          is distinct from (old.title, old.description, old.assignee_user_id, old.due_on)
        then
          raise exception using
            errcode = '42501',
            message = 'A change of state carries no other change.';
        end if;

        if new.status = 'pending' then
          if new.return_comment is null then
            raise exception using
              errcode = 'A0068',
              message = 'A task is returned with a comment.';
          end if;
        else
          new.return_comment := null;
        end if;
        if new.status = 'approved' then
          -- Fixed here, from the actor bound in this transaction: nobody chooses who approved or when.
          new.approved_by := app_private.current_user_id();
          new.approved_at := pg_catalog.now();
          if new.approved_by is null then
            raise exception using
              errcode = '42501',
              message = 'A task is approved by a person.';
          end if;
        end if;
        return new;
      end if;

      if tg_op = 'UPDATE' and (new.return_comment, new.approved_by, new.approved_at)
        is distinct from (old.return_comment, old.approved_by, old.approved_at)
      then
        raise exception using
          errcode = '42501',
          message = 'The comment of a returned task, and who approved it, are written with the state.';
      end if;

      if tg_op = 'UPDATE' and old.status = 'approved' and (new.title, new.description, new.assignee_user_id, new.due_on)
        is distinct from (old.title, old.description, old.assignee_user_id, old.due_on)
      then
        raise exception using
          errcode = 'A0071',
          message = 'An approved task is no longer edited.';
      end if;

      -- FOR SHARE conflicts with the FOR UPDATE that submit_content takes: a task cannot slip in while a content is
      -- being sent. A content not found here is left to the policy and the foreign key.
      select content.status into v_content_status
      from public.contents content
      where content.id = new.content_id
      for share;

      if found and v_content_status in ('published', 'cancelled') then
        raise exception using
          errcode = 'A0071',
          message = 'The tasks of a published or cancelled content are no longer edited.';
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.content_tasks_guard() from public;

    create trigger content_tasks_guard
      before insert or update on public.content_tasks
      for each row
      execute function app_private.content_tasks_guard();
  `);

  await knex.raw(`
    create function app_private.lock_content_for_agency(p_content_id uuid, p_permission text)
    returns public.contents
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
      v_agency_id uuid;
    begin
      -- The permission is checked BEFORE the lock, and an unknown content answers like a forbidden one.
      select content.* into v_content from public.contents content where content.id = p_content_id;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      v_agency_id := app_private.client_agency_id(v_content.client_id);
      if not (
        app_private.has_agency_permission(v_agency_id, p_permission)
        and app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.* into v_content from public.contents content where content.id = p_content_id for update;

      if not app_private.client_is_active(v_content.client_id) then
        raise exception using errcode = 'A0061', message = 'The client is archived.';
      end if;

      return v_content;
    end;
    $function$;
    revoke all on function app_private.lock_content_for_agency(uuid, text) from public;

    create function app_private.content_media_is_complete(p_content_id uuid, p_format text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        case p_format
          when 'image' then summary.total = 1 and summary.images = 1
          when 'carousel' then summary.total between 2 and 20
          else summary.total = 1 and summary.videos = 1
        end
        and summary.unusable = 0
      from (
        select
          count(*) as total,
          count(*) filter (where asset.category = 'image') as images,
          count(*) filter (where asset.category = 'video') as videos,
          count(*) filter (where asset.status <> 'confirmed' or asset.removed_at is not null) as unusable
        from public.content_media item
        join public.media_assets asset on asset.id = item.asset_id
        where item.content_id = p_content_id
      ) summary
    $function$;
    revoke all on function app_private.content_media_is_complete(uuid, text) from public;

    create function app_private.set_content_media(p_content_id uuid, p_asset_ids uuid[])
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
      v_current uuid[];
      v_found integer;
      v_max integer;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status in ('published', 'cancelled') then
        raise exception using errcode = 'A0062', message = 'A published or cancelled content is no longer edited.';
      end if;

      v_max := case when v_content.format = 'carousel' then 20 else 1 end;
      if p_asset_ids is null
        or cardinality(p_asset_ids) > v_max
        or cardinality(p_asset_ids) <> (select count(distinct item) from unnest(p_asset_ids) as item)
        or array_position(p_asset_ids, null) is not null
      then
        raise exception using errcode = 'A0069', message = 'A content selects one media, or up to 20 for a carousel, never the same twice.';
      end if;

      -- A folder belongs to one client (foreign key), so the folder alone ties the media to the client of the content.
      select count(*) into v_found
      from public.media_assets asset
      where asset.id = any (p_asset_ids)
        and asset.folder_id = v_content.folder_id
        and asset.removed_at is null;
      if v_found <> cardinality(p_asset_ids) then
        raise exception using errcode = 'A0069', message = 'A content selects only media of its own folder.';
      end if;

      select coalesce(array_agg(item.asset_id order by item.position), '{}'::uuid[]) into v_current
      from public.content_media item
      where item.content_id = p_content_id;
      if v_current = p_asset_ids then
        return;
      end if;

      delete from public.content_media where content_id = p_content_id;
      insert into public.content_media (content_id, asset_id, client_id, folder_id, position)
      select p_content_id, item.asset_id, v_content.client_id, v_content.folder_id, item.position::integer
      from unnest(p_asset_ids) with ordinality as item(asset_id, position);

      -- A content that waits for approval or is approved never holds a media that does not fit its format.
      if v_content.status in ('awaiting_approval', 'approved') and not app_private.content_media_is_complete(p_content_id, v_content.format) then
        raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
      end if;

      update public.contents
      set revision = revision + 1,
          status = case when status = 'approved' then 'awaiting_approval' else status end
      where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.set_content_media(uuid, uuid[]) from public;
    grant execute on function app_private.set_content_media(uuid, uuid[]) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.submit_content(p_content_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status = 'awaiting_approval' then
        return;
      end if;
      if v_content.status not in ('in_production', 'adjusting') then
        raise exception using errcode = 'A0062', message = 'Only a content in production or in adjustment is sent for approval.';
      end if;
      if not app_private.content_media_is_complete(p_content_id, v_content.format) then
        raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
      end if;
      if exists (select 1 from public.content_tasks task where task.content_id = p_content_id and task.status <> 'approved') then
        raise exception using errcode = 'A0066', message = 'Every subtask is approved before the content is sent.';
      end if;

      update public.contents set status = 'awaiting_approval' where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.submit_content(uuid) from public;
    grant execute on function app_private.submit_content(uuid) to ageniza_app;

    create function app_private.approve_content(p_content_id uuid, p_revision integer)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
    begin
      select content.client_id, content.status into v_client_id, v_status
      from public.contents content
      where content.id = p_content_id;

      -- Only an active person of the portal of this client approves: the agency permission, the Owner's ownership
      -- and a removed link all fail the same way. A content the portal cannot open yet is "not found" for it, but a
      -- collaborator who also reads it through the agency is told the truth below.
      if not found or not app_private.is_client_member(v_client_id) or (
        v_status not in ${OPEN_TO_CLIENT}
        and not app_private.has_agency_permission(app_private.client_agency_id(v_client_id), 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id
      for update;

      -- Idempotent, and the first person to approve stays the one who approved.
      if v_status = 'approved' then
        return;
      end if;
      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval is approved.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      update public.contents set status = 'approved' where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.approve_content(uuid, integer) from public;
    grant execute on function app_private.approve_content(uuid, integer) to ageniza_app;

    create function app_private.approve_content_by_agency(p_content_id uuid, p_revision integer, p_reason text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.aprovar_pela_agencia');

      if p_reason is null or ${isBlank('p_reason')} or octet_length(p_reason) > 5000 then
        raise exception using errcode = 'A0068', message = 'An approval outside the platform carries its reason.';
      end if;
      if v_content.status = 'approved' then
        return;
      end if;
      if v_content.status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval is approved.';
      end if;
      if p_revision is distinct from v_content.revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      update public.contents set status = 'approved', approved_by_agency_reason = p_reason where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.approve_content_by_agency(uuid, integer, text) from public;
    grant execute on function app_private.approve_content_by_agency(uuid, integer, text) to ageniza_app;

    create function app_private.publish_content(p_content_id uuid, p_published_on date)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.publicar');

      if v_content.status = 'published' then
        return;
      end if;
      if v_content.status <> 'approved' then
        raise exception using errcode = 'A0062', message = 'Only an approved content is published.';
      end if;
      if not app_private.content_media_is_complete(p_content_id, v_content.format) then
        raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
      end if;

      update public.contents set status = 'published', published_on = p_published_on where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.publish_content(uuid, date) from public;
    grant execute on function app_private.publish_content(uuid, date) to ageniza_app;

    create function app_private.unpublish_content(p_content_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.publicar');

      if v_content.status = 'approved' then
        return;
      end if;
      if v_content.status <> 'published' then
        raise exception using errcode = 'A0062', message = 'Only a published content is unpublished.';
      end if;

      update public.contents set status = 'approved' where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.unpublish_content(uuid) from public;
    grant execute on function app_private.unpublish_content(uuid) to ageniza_app;

    create function app_private.cancel_content(p_content_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.cancelar');

      if v_content.status = 'cancelled' then
        return;
      end if;
      if v_content.status = 'published' then
        raise exception using errcode = 'A0062', message = 'A published content is not cancelled.';
      end if;

      update public.contents set status = 'cancelled' where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.cancel_content(uuid) from public;
    grant execute on function app_private.cancel_content(uuid) to ageniza_app;

    create function app_private.reschedule_content(p_content_id uuid, p_publish_on date default null)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status <> 'cancelled' then
        raise exception using errcode = 'A0062', message = 'Only a cancelled content is rescheduled.';
      end if;

      update public.contents
      set status = 'in_production', publish_on = coalesce(p_publish_on, publish_on)
      where id = p_content_id;
    end;
    $function$;
    revoke all on function app_private.reschedule_content(uuid, date) from public;
    grant execute on function app_private.reschedule_content(uuid, date) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.lock_content_task(p_task_id uuid, p_actor_must_approve boolean)
    returns public.content_tasks
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_task public.content_tasks;
      v_content public.contents;
      v_agency_id uuid;
    begin
      select task.* into v_task from public.content_tasks task where task.id = p_task_id;
      if not found then
        raise exception using errcode = 'A0070', message = 'Content task not found.';
      end if;

      v_agency_id := app_private.client_agency_id(v_task.client_id);
      if not app_private.has_agency_permission(v_agency_id, 'conteudo.visualizar') then
        raise exception using errcode = 'A0070', message = 'Content task not found.';
      end if;

      -- The content is locked before the task, always in this order, and only FOR SHARE: submit_content takes it FOR UPDATE.
      select content.* into v_content from public.contents content where content.id = v_task.content_id for share;

      if p_actor_must_approve then
        if v_content.owner_user_id is distinct from app_private.current_user_id()
          and not app_private.has_agency_permission(v_agency_id, 'conteudo.aprovar_pela_agencia')
        then
          raise exception using errcode = 'A0074', message = 'Only the owner of the content, or who approves for the agency, approves a task.';
        end if;
      elsif v_task.assignee_user_id is distinct from app_private.current_user_id() then
        raise exception using errcode = 'A0074', message = 'Only the person in charge of a task delivers it.';
      end if;

      select task.* into v_task from public.content_tasks task where task.id = p_task_id for update;

      if not app_private.client_is_active(v_task.client_id) then
        raise exception using errcode = 'A0061', message = 'The client is archived.';
      end if;
      if v_content.status in ('published', 'cancelled') then
        raise exception using errcode = 'A0071', message = 'The tasks of a published or cancelled content are no longer edited.';
      end if;

      return v_task;
    end;
    $function$;
    revoke all on function app_private.lock_content_task(uuid, boolean) from public;

    create function app_private.deliver_content_task(p_task_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_task public.content_tasks;
    begin
      v_task := app_private.lock_content_task(p_task_id, false);

      if v_task.status = 'delivered' then
        return;
      end if;
      if v_task.status <> 'pending' then
        raise exception using errcode = 'A0071', message = 'Only a pending task is delivered.';
      end if;

      update public.content_tasks set status = 'delivered' where id = p_task_id;
    end;
    $function$;
    revoke all on function app_private.deliver_content_task(uuid) from public;
    grant execute on function app_private.deliver_content_task(uuid) to ageniza_app;

    create function app_private.approve_content_task(p_task_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_task public.content_tasks;
    begin
      v_task := app_private.lock_content_task(p_task_id, true);

      if v_task.status = 'approved' then
        return;
      end if;
      if v_task.status <> 'delivered' then
        raise exception using errcode = 'A0071', message = 'Only a delivered task is approved.';
      end if;

      update public.content_tasks set status = 'approved' where id = p_task_id;
    end;
    $function$;
    revoke all on function app_private.approve_content_task(uuid) from public;
    grant execute on function app_private.approve_content_task(uuid) to ageniza_app;

    create function app_private.return_content_task(p_task_id uuid, p_comment text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_task public.content_tasks;
    begin
      v_task := app_private.lock_content_task(p_task_id, true);

      if p_comment is null or ${isBlank('p_comment')} or octet_length(p_comment) > 5000 then
        raise exception using errcode = 'A0068', message = 'A task is returned with a comment.';
      end if;
      if v_task.status <> 'delivered' then
        raise exception using errcode = 'A0071', message = 'Only a delivered task is returned.';
      end if;

      update public.content_tasks set status = 'pending', return_comment = p_comment where id = p_task_id;
    end;
    $function$;
    revoke all on function app_private.return_content_task(uuid, text) from public;
    grant execute on function app_private.return_content_task(uuid, text) to ageniza_app;
  `);

  await knex.raw(`
    create function app_private.portal_contents(
      p_client_id uuid,
      p_from date default null,
      p_to date default null,
      p_statuses text[] default null,
      p_content_id uuid default null
    )
    returns table (
      id uuid, title text, platform text, format text, publish_on date, status text,
      revision integer, publish_at_time time, caption text, cover_asset_id uuid, published_on date
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        content.id, content.title, content.platform, content.format, content.publish_on, content.status,
        case when content.status = 'in_production' then null else content.revision end,
        case when content.status = 'in_production' then null else content.publish_at_time end,
        case when content.status = 'in_production' then null else content.caption end,
        case when content.status = 'in_production' then null else content.cover_asset_id end,
        case when content.status = 'in_production' then null else content.published_on end
      from public.contents content
      where content.client_id = p_client_id
        and app_private.is_client_member(p_client_id)
        and content.status <> 'cancelled'
        and (p_from is null or content.publish_on >= p_from)
        and (p_to is null or content.publish_on <= p_to)
        and (p_statuses is null or content.status = any (p_statuses))
        and (p_content_id is null or content.id = p_content_id)
      order by content.publish_on, content.id
    $function$;
    revoke all on function app_private.portal_contents(uuid, date, date, text[], uuid) from public;
    grant execute on function app_private.portal_contents(uuid, date, date, text[], uuid) to ageniza_app;

    -- The original key is agency_id/asset_id/original.extension by constraint, so it is not returned.
    create function app_private.portal_content_media(p_content_id uuid)
    returns table (
      asset_id uuid, role text, item_position integer, category text, extension text, content_type text,
      size_bytes bigint, duration_seconds numeric, video_processing_status text, thumbnail_object_key text, preview_object_key text
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        asset.id, entry.role, entry.item_position, asset.category, asset.extension, asset.confirmed_content_type,
        asset.confirmed_size_bytes, asset.video_duration_seconds, asset.video_processing_status,
        asset.thumbnail_object_key, asset.preview_object_key
      from public.contents content
      cross join lateral (
        select content.cover_asset_id as asset_id, 'cover'::text as role, 0 as item_position
        where content.cover_asset_id is not null
        union all
        select item.asset_id, 'media'::text, item.position
        from public.content_media item
        where item.content_id = content.id
      ) entry
      join public.media_assets asset on asset.id = entry.asset_id
      where content.id = p_content_id
        and app_private.content_open_to_client(content.id)
        and asset.status = 'confirmed'
        and asset.removed_at is null
      order by entry.role, entry.item_position
    $function$;
    revoke all on function app_private.portal_content_media(uuid) from public;
    grant execute on function app_private.portal_content_media(uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
