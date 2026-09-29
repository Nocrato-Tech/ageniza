// CLIENTS module foundation (issue #122). This migration is intentionally forward-only: schema
// and policy corrections must be made by a subsequent migration, never by changing an applied file.
//
// Structural per docs/business/structural-changes.md, recorded in docs/business/decisions.md
// (2026-09-26, "ESTRUTURAL: os campos do cliente entram como colunas em `clients`" and
// "ESTRUTURAL: a conversa com o cliente é uma tabela de threads por cliente, com assunto tipado"):
// this alters the already-deployed `clients` table, and `client_threads` is the shape Conteúdo
// will extend with a `content_id` column rather than a second conversation table.
//
// Scope is the schema, permissions and RLS only. The `security definer` functions that archive,
// reactivate and re-open a client (issue #123) are a separate migration by design.

export async function up(knex) {
  await knex.raw(`
    -- All nullable, no backfill: no real client data exists before deploy (specs/clientes.md §3).
    alter table public.clients
      add column photo_key text null,
      add column legal_name text null
        check (legal_name is null or octet_length(legal_name) <= 256),
      add column tax_id text null
        check (tax_id is null or tax_id ~ '^[0-9]{11}$' or tax_id ~ '^[0-9]{14}$'),
      add column segment text null
        check (segment is null or octet_length(segment) <= 120),
      add column website text null
        check (website is null or (website ~ '^https?://' and octet_length(website) <= 2048)),
      add column instagram_handle text null
        check (instagram_handle is null or instagram_handle ~ '^[A-Za-z0-9._]{1,30}$'),
      add column contact_name text null
        check (contact_name is null or octet_length(contact_name) <= 256),
      add column contact_phone text null
        check (contact_phone is null or octet_length(contact_phone) <= 32),
      add column contact_email text null
        check (contact_email is null or (contact_email like '%@%' and octet_length(contact_email) <= 320)),
      add column closing_date date null,
      add column archived_at timestamptz null,
      add column updated_by uuid null references auth."user"(id);

    -- The expression normalizes whitespace, not just its ends: btrim(name) alone still lets
    -- "Padaria Central" and "Padaria  Central" (or a tab, or a NBSP instead of a space) coexist as
    -- two distinct active names, which rule 7 does not intend. chr(160) is NBSP; \s then collapses
    -- every remaining run of ASCII whitespace to one space before the final btrim/lower. The API
    -- (#124) must normalize a candidate name with this exact expression before comparing or erroring
    -- on conflict, or its message and this index will disagree (documented on issue #124).
    create unique index clients_active_name_unique
      on public.clients (agency_id, lower(btrim(regexp_replace(replace(name, chr(160), ' '), '\s+', ' ', 'g'))))
      where status = 'active';

    -- Narrowing the UPDATE grant is what keeps status, archived_at and closing_date out of reach
    -- of ordinary writes: those three change only through the security definer functions of #123.
    -- Delete is removed outright; no route deletes a business entity (AGENTS.md).
    revoke delete on public.clients from ageniza_app;
    revoke update on public.clients from ageniza_app;
    grant update (
      name, photo_key, legal_name, tax_id, segment, website, instagram_handle,
      contact_name, contact_phone, contact_email, updated_by, updated_at
    ) on public.clients to ageniza_app;

    -- INSERT is column-restricted the same way: the table grant clients inherited from the
    -- foundation's default privileges covered every column, so a caller holding only
    -- cliente.cadastrar (no cliente.arquivar) could set closing_date/archived_at directly, bypassing
    -- set_client_closing_date's validation (#123) and producing an 'active' row with archived_at
    -- already filled -- a state specs/clientes.md §3 does not allow. status, closing_date,
    -- archived_at, created_at and updated_at are left to their defaults; updated_by is not part of
    -- registration (nobody has "last edited" a client that was just created).
    revoke insert on public.clients from ageniza_app;
    grant insert (
      id, agency_id, name, photo_key, legal_name, tax_id, segment, website, instagram_handle,
      contact_name, contact_phone, contact_email
    ) on public.clients to ageniza_app;

    create policy clients_insert on public.clients
      for insert to ageniza_app
      with check (status = 'active' and app_private.has_agency_permission(agency_id, 'cliente.cadastrar'));

    -- updated_by stays in the UPDATE grant (it is how "quem alterou por último" gets recorded), but
    -- WITH CHECK pins it to the caller: without this, any column grant that includes updated_by lets
    -- an editor attribute the change to somebody else, including a user in another agency.
    create policy clients_update on public.clients
      for update to ageniza_app
      using (status = 'active' and app_private.has_agency_permission(agency_id, 'cliente.operar'))
      with check (
        status = 'active'
        and app_private.has_agency_permission(agency_id, 'cliente.operar')
        and updated_by = app_private.current_user_id()
      );
  `);

  await knex.raw(`
    -- Every RLS policy below needs a client's agency without a join; this mirrors is_agency_member
    -- and is_client_member and follows the same grant shape (issue #122).
    create function app_private.client_agency_id(p_client_id uuid)
    returns uuid
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select agency_id from public.clients where id = p_client_id
    $$;
    revoke all on function app_private.client_agency_id(uuid) from public;
    grant execute on function app_private.client_agency_id(uuid) to ageniza_app;

    -- "Cliente arquivado não aceita escrita" (specs/clientes.md §5, rule 6) is checked by every
    -- write policy below; this is the one place that rule is spelled out.
    create function app_private.client_is_active(p_client_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $$
      select exists (select 1 from public.clients where id = p_client_id and status = 'active')
    $$;
    revoke all on function app_private.client_is_active(uuid) from public;
    grant execute on function app_private.client_is_active(uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- One row per filled section; 'personas' is not a row here, it is the table below.
    create table public.client_brand_sections (
      client_id uuid not null references public.clients(id),
      section_key text not null check (section_key in (
        'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'observations'
      )),
      body text null check (body is null or octet_length(body) <= 20000),
      colors jsonb null check (colors is null or jsonb_typeof(colors) = 'array'),
      archetype text null check (archetype is null or archetype in (
        'Inocente', 'Sábio', 'Explorador', 'Fora-da-lei', 'Mago', 'Herói', 'Amante',
        'Bobo da corte', 'Cara comum', 'Cuidador', 'Governante', 'Criador'
      )),
      updated_by uuid null references auth."user"(id),
      updated_at timestamptz not null default now(),
      primary key (client_id, section_key),
      -- Ties each free-form column to the one section_key it belongs to.
      constraint client_brand_sections_section_shape check (
        case section_key
          when 'colors' then body is null and archetype is null
          when 'archetype' then body is null and colors is null
          else colors is null and archetype is null
        end
      )
    );

    create table public.client_personas (
      id uuid not null default gen_random_uuid() primary key,
      client_id uuid not null references public.clients(id),
      name text not null check (btrim(name) <> '' and octet_length(name) <= 120),
      description text null check (description is null or octet_length(description) <= 5000),
      pains text null check (pains is null or octet_length(pains) <= 5000),
      desires text null check (desires is null or octet_length(desires) <= 5000),
      objections text null check (objections is null or octet_length(objections) <= 5000),
      status text not null default 'active' check (status in ('active', 'archived')),
      updated_by uuid null references auth."user"(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index client_personas_client_status_idx on public.client_personas (client_id, status);

    -- No "status" column: open/resolved is derived from resolved_at vs. the latest comment
    -- (specs/clientes.md §4), which is what lets the client re-open a thread just by commenting.
    create table public.client_threads (
      id uuid not null default gen_random_uuid() primary key,
      client_id uuid not null references public.clients(id),
      section_key text null check (section_key is null or section_key in (
        'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'
      )),
      persona_id uuid null references public.client_personas(id),
      opened_by uuid not null references auth."user"(id),
      opened_side text not null check (opened_side in ('agency', 'client')),
      resolved_at timestamptz null,
      resolved_by uuid null references auth."user"(id),
      created_at timestamptz not null default now(),
      constraint client_threads_subject_check check (num_nonnulls(section_key, persona_id) = 1)
    );
    create index client_threads_client_section_idx on public.client_threads (client_id, section_key);
    create index client_threads_client_persona_idx on public.client_threads (client_id, persona_id);

    -- client_id is repeated so the RLS below never has to join through the thread to find the
    -- tenant (specs/clientes.md §3). Immutable by grant: no UPDATE, no DELETE for ageniza_app.
    create table public.client_thread_comments (
      id uuid not null default gen_random_uuid() primary key,
      thread_id uuid not null references public.client_threads(id),
      client_id uuid not null references public.clients(id),
      author_user_id uuid not null references auth."user"(id),
      author_side text not null check (author_side in ('agency', 'client')),
      body text not null check (btrim(body) <> '' and octet_length(body) <= 5000),
      created_at timestamptz not null default now()
    );
    create index client_thread_comments_thread_created_idx on public.client_thread_comments (thread_id, created_at);

    -- Every table in public is tenant data or authorization data and must be protected.
    alter table public.client_brand_sections enable row level security;
    alter table public.client_brand_sections force row level security;
    alter table public.client_personas enable row level security;
    alter table public.client_personas force row level security;
    alter table public.client_threads enable row level security;
    alter table public.client_threads force row level security;
    alter table public.client_thread_comments enable row level security;
    alter table public.client_thread_comments force row level security;

    -- New tables inherit select/insert/update/delete to ageniza_app from the foundation migration's
    -- default privileges; these grants are rewritten explicitly rather than relied on implicitly,
    -- and narrowed to exactly what specs/clientes.md §5 (rules 4 and 5) allows.
    -- Column-restricted, not table-level: a table-wide UPDATE grant would let a WITH CHECK that
    -- reads client_id off the *new* row (as client_brand_sections_update below does) be satisfied
    -- by rewriting client_id itself to a client the caller also has cliente.operar on, moving the
    -- row to another tenant. Excluding the PK columns from the grant closes that off at the
    -- privilege check, before RLS is even evaluated.
    revoke all on public.client_brand_sections from ageniza_app;
    grant select, insert on public.client_brand_sections to ageniza_app;
    grant update (body, colors, archetype, updated_by, updated_at) on public.client_brand_sections to ageniza_app;

    -- Same reasoning: id and client_id stay out of the UPDATE grant so a persona can never be
    -- reassigned to another client through an ordinary update.
    revoke all on public.client_personas from ageniza_app;
    grant select, insert on public.client_personas to ageniza_app;
    grant update (name, description, pains, desires, objections, status, updated_by, updated_at) on public.client_personas to ageniza_app;

    -- INSERT is column-restricted like clients: resolved_at/resolved_by/created_at stay off the
    -- grant so a caller (either side) cannot open a thread that is already "resolved" -- num_nonnulls
    -- on section_key/persona_id already forces exactly one subject, but nothing else stopped a portal
    -- member from setting resolved_at/resolved_by on the INSERT itself, attributing a resolution to
    -- someone else and burying the thread out of "aguardando a agência" the moment it is created.
    revoke all on public.client_threads from ageniza_app;
    grant select on public.client_threads to ageniza_app;
    grant insert (id, client_id, section_key, persona_id, opened_by, opened_side) on public.client_threads to ageniza_app;
    grant update (resolved_at, resolved_by) on public.client_threads to ageniza_app;

    -- Same reasoning for client_thread_comments: created_at off the INSERT grant. The thread's
    -- open/resolved state and "most recent first" ordering both depend on comparing created_at
    -- across rows, so a caller-supplied timestamp -- backdated or postdated -- forges that order and
    -- the state derived from it, for a table the SPEC calls immutable.
    revoke all on public.client_thread_comments from ageniza_app;
    grant select on public.client_thread_comments to ageniza_app;
    grant insert (id, thread_id, client_id, author_user_id, author_side, body) on public.client_thread_comments to ageniza_app;
  `);

  await knex.raw(`
    -- A CHECK cannot reach across tables; a trigger is what guarantees a thread's persona_id
    -- belongs to the same client_id (specs/clientes.md §5), independent of who is writing.
    create function app_private.check_thread_persona_client()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
    begin
      if new.persona_id is not null and not exists (
        select 1 from public.client_personas persona
        where persona.id = new.persona_id and persona.client_id = new.client_id
      ) then
        raise exception using
          errcode = 'A0010',
          message = 'Thread persona does not belong to this client.';
      end if;
      return new;
    end;
    $$;

    revoke all on function app_private.check_thread_persona_client() from public;

    create trigger client_threads_persona_client_check
      before insert or update on public.client_threads
      for each row execute function app_private.check_thread_persona_client();

    -- Same reasoning as above, for the client_id repeated on client_thread_comments.
    create function app_private.check_comment_thread_client()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
    begin
      if not exists (
        select 1 from public.client_threads thread
        where thread.id = new.thread_id and thread.client_id = new.client_id
      ) then
        raise exception using
          errcode = 'A0011',
          message = 'Comment client does not match its thread client.';
      end if;
      return new;
    end;
    $$;
    revoke all on function app_private.check_comment_thread_client() from public;

    create trigger client_thread_comments_client_check
      before insert on public.client_thread_comments
      for each row execute function app_private.check_comment_thread_client();

    -- The UPDATE grant on client_threads only ever reaches this trigger through a resolve (the
    -- grant covers just resolved_at/resolved_by), so every row that gets here is being resolved.
    -- Stamping resolved_at unconditionally means a caller-supplied value -- backdated to hide a
    -- late response, or postdated so "comentário novo reabre" (SPEC §4) can never trigger again --
    -- is always overwritten, and resolved_at can never end up null again: there is no "unresolve".
    create function app_private.stamp_thread_resolved_at()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $$
    begin
      new.resolved_at := pg_catalog.now();
      return new;
    end;
    $$;
    revoke all on function app_private.stamp_thread_resolved_at() from public;

    create trigger client_threads_resolve_stamp
      before update on public.client_threads
      for each row execute function app_private.stamp_thread_resolved_at();
  `);

  await knex.raw(`
    create policy client_brand_sections_select on public.client_brand_sections
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or app_private.is_client_member(client_id)
      );

    -- updated_by = current_user_id() in WITH CHECK is what keeps "quem alterou por último" honest:
    -- the column stays in the INSERT/UPDATE grant (the API has to be able to set it at all), so
    -- without this an editor could stamp the change with any user id, including one from another
    -- agency or the portal.
    create policy client_brand_sections_insert on public.client_brand_sections
      for insert to ageniza_app
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
        and updated_by = app_private.current_user_id()
      );

    create policy client_brand_sections_update on public.client_brand_sections
      for update to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
      )
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
        and updated_by = app_private.current_user_id()
      );

    -- The portal never sees an archived persona (specs/clientes.md §5, rule 4); the agency side
    -- has no such filter because collaborators keep working with an archived persona's history.
    create policy client_personas_select on public.client_personas
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or (app_private.is_client_member(client_id) and status = 'active')
      );

    create policy client_personas_insert on public.client_personas
      for insert to ageniza_app
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
        and updated_by = app_private.current_user_id()
      );

    create policy client_personas_update on public.client_personas
      for update to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
      )
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
        and updated_by = app_private.current_user_id()
      );

    -- The portal branch also requires the thread's persona (if any) to still be active: specs/
    -- clientes.md §4 says an archived persona's threads go read-only for the portal, and reading
    -- them at all is the more basic half of that -- an archived persona already "some do portal",
    -- so a conversation about it should not keep surfacing there either. The agency side is
    -- unfiltered: collaborators keep the full history regardless of persona status.
    create policy client_threads_select on public.client_threads
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or (
          app_private.is_client_member(client_id)
          and (
            persona_id is null
            or exists (select 1 from public.client_personas persona where persona.id = persona_id and persona.status = 'active')
          )
        )
      );

    -- The side cannot be forged: 'agency' requires cliente.operar, 'client' requires the vínculo,
    -- and opened_by must be the caller -- the pair of side and credential is what the API's route
    -- choice (agency vs. portal) is checked against (specs/clientes.md §5, rule 10).
    create policy client_threads_insert on public.client_threads
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and opened_by = app_private.current_user_id()
        and (
          (opened_side = 'agency' and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar'))
          or (opened_side = 'client' and app_private.is_client_member(client_id))
        )
        and (
          persona_id is null
          or exists (select 1 from public.client_personas persona where persona.id = persona_id and persona.status = 'active')
        )
      );

    -- Resolving is the only UPDATE the column grant allows, and only cliente.operar reaches it --
    -- a vínculo de cliente never satisfies has_agency_permission, so it never writes resolved_at.
    -- resolved_by = current_user_id() in WITH CHECK stops a resolver from attributing the resolution
    -- to someone else (the client_threads_resolve_stamp trigger separately pins resolved_at to
    -- now(), so together neither column is forgeable). The persona-active clause matches the SPEC's
    -- "threads ficam somente leitura" for an archived persona: resolving is a write, so it is refused
    -- the same as any other write once the persona behind the thread is archived.
    create policy client_threads_resolve on public.client_threads
      for update to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
        and (
          persona_id is null
          or exists (select 1 from public.client_personas persona where persona.id = persona_id and persona.status = 'active')
        )
      )
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
        and resolved_by = app_private.current_user_id()
      );

    -- Same persona-active filter as client_threads_select, reached through the thread since a
    -- comment does not carry persona_id itself.
    create policy client_thread_comments_select on public.client_thread_comments
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or (
          app_private.is_client_member(client_id)
          and exists (
            select 1
            from public.client_threads thread
            left join public.client_personas persona on persona.id = thread.persona_id
            where thread.id = thread_id
              and thread.client_id = client_thread_comments.client_id
              and (thread.persona_id is null or persona.status = 'active')
          )
        )
      );

    create policy client_thread_comments_insert on public.client_thread_comments
      for insert to ageniza_app
      with check (
        app_private.client_is_active(client_id)
        and author_user_id = app_private.current_user_id()
        and (
          (author_side = 'agency' and app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar'))
          or (author_side = 'client' and app_private.is_client_member(client_id))
        )
        and exists (
          select 1
          from public.client_threads thread
          left join public.client_personas persona on persona.id = thread.persona_id
          where thread.id = thread_id
            and thread.client_id = client_thread_comments.client_id
            and (thread.persona_id is null or persona.status = 'active')
        )
      );
  `);

  await knex.raw(`
    insert into public.permissions (key, description) values
      ('cliente.visualizar', 'Ver clientes, estudo de marca e conversas.'),
      ('cliente.operar', 'Editar cadastro e estudo de marca, e conversar com o cliente.'),
      ('cliente.cadastrar', 'Cadastrar cliente novo.'),
      ('cliente.arquivar', 'Encerrar contrato, arquivar e reativar cliente.'),
      ('cliente.remover_usuario', 'Remover e reativar pessoa do portal do cliente.');

    insert into public.role_permissions (role_id, permission_key)
    select role.id, preset.permission_key
    from public.roles role
    join (
      values
        ('cliente.visualizar', array['admin', 'account_manager', 'production', 'sales', 'finance']),
        ('cliente.operar', array['admin', 'account_manager']),
        ('cliente.cadastrar', array['admin', 'account_manager']),
        ('cliente.arquivar', array['admin']),
        ('cliente.remover_usuario', array['admin'])
    ) as preset(permission_key, role_keys) on role.key = any(preset.role_keys)
    where role.agency_id is null;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
