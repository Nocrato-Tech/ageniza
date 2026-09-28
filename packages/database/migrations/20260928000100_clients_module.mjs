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

    -- The index -- not a prior SELECT in the API -- is what makes uniqueness hold under
    -- concurrent inserts (specs/clientes.md §5, rule 6; issue #122 acceptance).
    create unique index clients_active_name_unique
      on public.clients (agency_id, lower(btrim(name)))
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

    create policy clients_insert on public.clients
      for insert to ageniza_app
      with check (status = 'active' and app_private.has_agency_permission(agency_id, 'cliente.cadastrar'));

    create policy clients_update on public.clients
      for update to ageniza_app
      using (status = 'active' and app_private.has_agency_permission(agency_id, 'cliente.operar'))
      with check (status = 'active' and app_private.has_agency_permission(agency_id, 'cliente.operar'));
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
    revoke all on public.client_brand_sections from ageniza_app;
    grant select, insert, update on public.client_brand_sections to ageniza_app;

    revoke all on public.client_personas from ageniza_app;
    grant select, insert, update on public.client_personas to ageniza_app;

    revoke all on public.client_threads from ageniza_app;
    grant select, insert on public.client_threads to ageniza_app;
    grant update (resolved_at, resolved_by) on public.client_threads to ageniza_app;

    revoke all on public.client_thread_comments from ageniza_app;
    grant select, insert on public.client_thread_comments to ageniza_app;
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

    create trigger client_thread_comments_client_check
      before insert on public.client_thread_comments
      for each row execute function app_private.check_comment_thread_client();
  `);

  await knex.raw(`
    create policy client_brand_sections_select on public.client_brand_sections
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or app_private.is_client_member(client_id)
      );

    create policy client_brand_sections_insert on public.client_brand_sections
      for insert to ageniza_app
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
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
      );

    create policy client_threads_select on public.client_threads
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or app_private.is_client_member(client_id)
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
    create policy client_threads_resolve on public.client_threads
      for update to ageniza_app
      using (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
      )
      with check (
        app_private.has_agency_permission(app_private.client_agency_id(client_id), 'cliente.operar')
        and app_private.client_is_active(client_id)
      );

    create policy client_thread_comments_select on public.client_thread_comments
      for select to ageniza_app
      using (
        app_private.is_agency_member(app_private.client_agency_id(client_id))
        or app_private.is_client_member(client_id)
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
