import { randomUUID } from 'node:crypto';

import {
  ARCHETYPE_LABELS,
  type Archetype,
  type BrandColor,
  type BrandSectionKey,
  type BrandStudyResponse,
  type BrandStudySection,
  type BrandStudySectionUpdate,
  type Client,
  type ClientListSort,
  type ClientSummary,
  type CreatePersonaRequest,
  type Persona,
  type UpdateClientRequest,
  type UpdatePersonaRequest,
  type WritableBrandSectionKey
} from '@ageniza/contracts';
import { databaseErrorCode, raw, type DatabaseClient, type SqlBinding } from '@ageniza/database';

import { foldTextSql } from '../../plugins/infra/sql-text.js';
import { latestCommentSideSql, openThreadSql } from './thread-state.js';

export type ClientTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/** One `clients` row as read or returned by this module; `closing_date` is text, never a Date. */
export interface ClientRow {
  readonly id: string;
  /** The row's own tenant: the photo scope is built from it, never from the (case-insensitive) URL. */
  readonly agency_id: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly photo_key: string | null;
  readonly legal_name: string | null;
  readonly tax_id: string | null;
  readonly segment: string | null;
  readonly website: string | null;
  readonly instagram_handle: string | null;
  readonly contact_name: string | null;
  readonly contact_phone: string | null;
  readonly contact_email: string | null;
  readonly closing_date: string | null;
  readonly archived_at: Date | null;
}

interface SummaryRow {
  readonly brand_study_filled: string | number;
  readonly threads_awaiting_agency: string | number;
  readonly threads_answered_by_agency: string | number;
  readonly active_portal_members: string | number;
}

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

const CLIENT_COLUMNS = `
  id, agency_id, name, status, photo_key, legal_name, tax_id, segment, website, instagram_handle,
  contact_name, contact_phone, contact_email, closing_date::text as closing_date, archived_at
`;

/** Body field -> column, the only columns a PATCH may write. Order fixes the bind order. */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof UpdateClientRequest, string]> = [
  ['name', 'name'],
  ['legalName', 'legal_name'],
  ['taxId', 'tax_id'],
  ['segment', 'segment'],
  ['website', 'website'],
  ['instagramHandle', 'instagram_handle'],
  ['contactName', 'contact_name'],
  ['contactPhone', 'contact_phone'],
  ['contactEmail', 'contact_email']
];

const ACTIVE_NAME_CONSTRAINT = 'clients_active_name_unique';

/**
 * True only for the active-name unique index. The 409 is detected from this violation, never from
 * a pre-flight SELECT, so two concurrent creations still produce exactly one winner and one 409.
 */
export const isActiveClientNameConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  (error as { constraint?: unknown }).constraint === ACTIVE_NAME_CONSTRAINT;

export const createClient = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly name: string }
): Promise<ClientRow> => {
  const result = await raw<RawRows<ClientRow>>(transaction, `
    insert into public.clients (agency_id, name)
    values (?::uuid, ?)
    returning ${CLIENT_COLUMNS}
  `, [input.agencyId, input.name]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Client insert did not return a row.');
  return row;
};

/** Reads the client inside the agency. A missing row covers nonexistent, other-agency and, via RLS, inaccessible. */
export const loadClient = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string }
): Promise<ClientRow | undefined> => {
  const result = await raw<RawRows<ClientRow>>(transaction, `
    select ${CLIENT_COLUMNS}
    from public.clients
    where id = ?::uuid and agency_id = ?::uuid
  `, [input.clientId, input.agencyId]);
  return result.rows[0];
};

/**
 * Locks an active client of the agency and returns its current photo reference with the row's own
 * ids (the lowercase ones the readers sign against, whatever case the URL carried). `for update` also
 * has to pass the `clients_update` policy, so an archived client, one of another agency, or a
 * caller without `cliente.operar` all come back as `undefined` -- the caller tells 404 from 409
 * with `loadClient`, which only needs the read policy.
 *
 * The lock is what serializes concurrent photo changes of one client: without it several
 * transactions read the same "previous" key, each commits its own, and all but one object is
 * orphaned in a storage that has no quota.
 */
export const lockActiveClientPhoto = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string }
): Promise<{ readonly photoKey: string | null; readonly agencyId: string; readonly clientId: string } | undefined> => {
  const result = await raw<RawRows<{ photo_key: string | null; agency_id: string; id: string }>>(transaction, `
    select photo_key, agency_id, id
    from public.clients
    where id = ?::uuid and agency_id = ?::uuid and status = 'active'
    for update
  `, [input.clientId, input.agencyId]);
  const row = result.rows[0];
  return row === undefined ? undefined : { photoKey: row.photo_key, agencyId: row.agency_id, clientId: row.id };
};

/**
 * Points the client at a new photo object, or clears it with `null`. Only valid after
 * `lockActiveClientPhoto` found the row: a write that matches nothing here is a bug, not a state.
 */
export const setClientPhotoKey = async (
  transaction: ClientTransaction,
  input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly actorUserId: string;
    readonly photoKey: string | null;
  }
): Promise<void> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.clients
    set photo_key = ?, updated_by = ?::uuid, updated_at = now()
    where id = ?::uuid and agency_id = ?::uuid
    returning id
  `, [input.photoKey, input.actorUserId, input.clientId, input.agencyId]);
  if (result.rows.length !== 1) throw new Error('The locked client photo reference could not be written.');
};

/**
 * Applies the PATCH. A field absent from the body is left untouched; an explicit null clears it.
 * `updated_by` is always the session user and `updated_at` is stamped here, never taken from the
 * body. Zero rows means the RLS `clients_update` policy refused an archived (or out-of-reach) row;
 * the route turns that into the archived 409 or the indistinct 404.
 */
export const updateClient = async (
  transaction: ClientTransaction,
  input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly actorUserId: string;
    readonly changes: UpdateClientRequest;
  }
): Promise<ClientRow | undefined> => {
  const assignments = ['updated_by = ?::uuid', 'updated_at = now()'];
  const bindings: SqlBinding[] = [input.actorUserId];
  for (const [field, column] of UPDATABLE_COLUMNS) {
    const value = input.changes[field];
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      bindings.push(value);
    }
  }
  bindings.push(input.clientId, input.agencyId);
  const result = await raw<RawRows<ClientRow>>(transaction, `
    update public.clients
    set ${assignments.join(', ')}
    where id = ?::uuid and agency_id = ?::uuid
    returning ${CLIENT_COLUMNS}
  `, bindings);
  return result.rows[0];
};

/**
 * Whether a `client_brand_sections` row counts as filled: the one definition the summary count and
 * the portal's "seção não preenchida" rule (#130) share. `personas` has no row; an active persona
 * fills it instead. The alias is a fixed literal chosen in this repository.
 */
export const sectionFilledSql = (sectionAlias: string): string => `case ${sectionAlias}.section_key
            when 'colors' then ${sectionAlias}.colors is not null
              and jsonb_typeof(${sectionAlias}.colors) = 'array'
              and jsonb_array_length(${sectionAlias}.colors) > 0
            when 'archetype' then ${sectionAlias}.archetype is not null
            else ${sectionAlias}.body is not null and btrim(${sectionAlias}.body) <> ''
          end`;

/**
 * How many of the seven sections are filled: the one definition the agency summary and the portal's
 * Início share. Two `?` placeholders, both the client id. `personas` counts as one filled section
 * when at least one persona is active.
 */
export const BRAND_STUDY_FILLED_SQL = `(
        select count(*)
        from public.client_brand_sections section
        where section.client_id = ?::uuid
          and ${sectionFilledSql('section')}
      ) + (
        case when exists (
          select 1 from public.client_personas persona
          where persona.client_id = ?::uuid and persona.status = 'active'
        ) then 1 else 0 end
      )`;

/**
 * The General tab summary (specs/clientes.md section 6). `personas` counts as one filled section
 * when at least one persona is active; "aguardando a agência" and "com resposta da agência" come
 * from the single thread-state definition, so this count cannot drift from the listing (#125).
 */
export const loadClientSummary = async (transaction: ClientTransaction, clientId: string): Promise<ClientSummary> => {
  const result = await raw<RawRows<SummaryRow>>(transaction, `
    select
      ${BRAND_STUDY_FILLED_SQL} as brand_study_filled,
      (
        select count(*) from public.client_threads thread
        where thread.client_id = ?::uuid
          and ${openThreadSql('thread')}
          and ${latestCommentSideSql('thread')} = 'client'
      ) as threads_awaiting_agency,
      (
        select count(*) from public.client_threads thread
        where thread.client_id = ?::uuid
          and ${openThreadSql('thread')}
          and ${latestCommentSideSql('thread')} = 'agency'
      ) as threads_answered_by_agency,
      (
        select count(*) from public.client_memberships membership
        where membership.client_id = ?::uuid and membership.status = 'active'
      ) as active_portal_members
  `, [clientId, clientId, clientId, clientId, clientId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Client summary query returned no row.');
  return {
    brandStudyFilled: Number(row.brand_study_filled),
    threadsAwaitingAgency: Number(row.threads_awaiting_agency),
    threadsAnsweredByAgency: Number(row.threads_answered_by_agency),
    activePortalMembers: Number(row.active_portal_members)
  };
};

export interface ClientListFilters {
  /** The route defaults `status` to `active` (SPEC §6). */
  readonly status: 'active' | 'archived';
  readonly search?: string;
  readonly sort: ClientListSort;
  /** False for a caller without `cliente.convidar_usuario`: the count is not even computed. */
  readonly includePendingInvitations: boolean;
}

export interface ClientListRow {
  readonly id: string;
  readonly agency_id: string;
  readonly name: string;
  readonly photo_key: string | null;
  readonly instagram_handle: string | null;
  readonly status: 'active' | 'archived';
  readonly closing_date: string | null;
  readonly threads_awaiting_agency: string | number;
  /** Null when the caller has no `cliente.convidar_usuario`, so the route omits the field. */
  readonly pending_invitations: string | number | null;
}

export interface ClientListPage {
  readonly items: readonly ClientListRow[];
  readonly totalItems: number;
}

/**
 * Escapes the LIKE metacharacters so a search for `100%` or `a_b` is literal, not a wildcard. The
 * backslash escape character is the one declared next to every `like` clause below.
 */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Lists one page of an agency's clients (issue #125). The query starts from `public.clients`
 * filtered by the route's agency; RLS is the second barrier and never the tenant filter (issue
 * #186 lesson: a caller who belongs to two agencies must still get only the agency in the URL).
 *
 * The "aguardando a agência" count comes from the single definition in `thread-state.ts`, the same
 * one the detail summary and the portal use, and is a correlated subquery over `client_threads`
 * so the `client_thread_comments (thread_id, created_at)` index from #122 answers the last-comment
 * lookup. The count of the whole filtered set rides the page's own statement (`count(*) over ()`),
 * so `data` and `totalItems` come from one snapshot; only a page past the end asks again.
 *
 * A parameter the SPEC does not declare does not exist: the caller only ever adds the named
 * conditions above, and every value is a bind.
 */
export const listClients = async (
  transaction: ClientTransaction,
  agencyId: string,
  filters: ClientListFilters,
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<ClientListPage> => {
  const conditions = ['client.agency_id = ?::uuid', 'client.status = ?'];
  const bindings: SqlBinding[] = [agencyId, filters.status];

  if (filters.search !== undefined) {
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    // The SPEC's search box says "@", but the handle is stored without it; a leading `@` typed by
    // the person means the handle, so it is dropped for the handle clause only. A lone `@` stays:
    // stripping it would turn the clause into a wildcard matching every client with a handle.
    const handleTerm = filters.search.startsWith('@') && filters.search.length > 1
      ? filters.search.slice(1)
      : filters.search;
    const handlePattern = `%${escapeLikePattern(handleTerm)}%`;
    conditions.push(`(
      ${foldTextSql('client.name')} like ${foldTextSql('?')} escape '\\'
      or ${foldTextSql('client.legal_name')} like ${foldTextSql('?')} escape '\\'
      or ${foldTextSql('client.instagram_handle')} like ${foldTextSql('?')} escape '\\'
    )`);
    bindings.push(pattern, pattern, handlePattern);
  }

  const where = conditions.join('\n    and ');
  // One grouped count for the agency's page, computed once (`as materialized`, otherwise the
  // planner may rescan the small aggregate per row): the `invitations_pending_equivalent_unique`
  // partial index (agency_id first) serves the filter, and the cost no longer grows with every
  // other agency's pending invitations. The count exists only for a caller who may see the badge;
  // a caller without `cliente.convidar_usuario` gets null, so the route omits the field instead of
  // zeroing it.
  const pendingInvitationsCte = filters.includePendingInvitations
    ? `with pending_invitations as materialized (
        select invitation.client_id as client_id, count(*) as pending_count
        from public.invitations invitation
        where invitation.agency_id = ?::uuid
          and invitation.purpose = 'client_invite'
          and invitation.used_at is null
          and invitation.revoked_at is null
          and invitation.expires_at > now()
        group by invitation.client_id
      )`
    : '';
  const pendingInvitationsJoin = filters.includePendingInvitations
    ? 'left join pending_invitations on pending_invitations.client_id = client.id'
    : '';
  // coalesce turns "no pending invitation for this client" into a real zero for a caller who may
  // see the badge: the omitted field is for the unauthorized caller, not for the zero count.
  const pendingInvitationsColumn = filters.includePendingInvitations
    ? 'coalesce(pending_invitations.pending_count, 0)'
    : 'null::bigint';
  // The CTE's agency bind appears before the WHERE binds in the statement text.
  const itemBindings: SqlBinding[] = filters.includePendingInvitations ? [agencyId, ...bindings] : [...bindings];

  // A derived table because PostgreSQL does not accept an output alias inside an ORDER BY
  // expression (`ORDER BY threads_awaiting_agency > 0` over the subquery output is valid).
  // The folded name is compared byte by byte (`collate "C"`), so space, hyphen and digit order the
  // same in every database, like the collaborators list (#355).
  const foldedName = `${foldTextSql('listing.name')} collate "C"`;
  const orderBy = filters.sort === 'name:asc'
    ? `${foldedName} asc, listing.id asc`
    : `(listing.threads_awaiting_agency > 0) desc, ${foldedName} asc, listing.id asc`;

  const itemsResult = await raw<RawRows<ClientListRow & { readonly total: string | number }>>(transaction, `
    ${pendingInvitationsCte}
    select
      listing.id,
      listing.agency_id,
      listing.name,
      listing.photo_key,
      listing.instagram_handle,
      listing.status,
      listing.closing_date,
      listing.threads_awaiting_agency,
      listing.pending_invitations,
      count(*) over () as total
    from (
      select
        client.id,
        client.agency_id,
        client.name,
        client.photo_key,
        client.instagram_handle,
        client.status,
        client.closing_date::text as closing_date,
        (
          select count(*)
          from public.client_threads thread
          where thread.client_id = client.id
            and ${openThreadSql('thread')}
            and ${latestCommentSideSql('thread')} = 'client'
        ) as threads_awaiting_agency,
        ${pendingInvitationsColumn} as pending_invitations
      from public.clients client
      ${pendingInvitationsJoin}
      where ${where}
    ) as listing
    order by ${orderBy}
    limit ? offset ?
  `, [...itemBindings, pagination.pageSize, pagination.offset]);

  if (itemsResult.rows.length > 0) {
    return { items: itemsResult.rows, totalItems: Number(itemsResult.rows[0]?.total ?? 0) };
  }
  // An empty first page is the whole truth; a second count could only answer from another snapshot.
  if (pagination.offset === 0) return { items: [], totalItems: 0 };

  const countResult = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total
    from public.clients client
    where ${where}
  `, bindings);
  return { items: [], totalItems: Number(countResult.rows[0]?.total ?? 0) };
};

// --- Brand study and personas (specs/clientes.md section 3) ---------------------------------

/** The seven sections, always returned in this order. */
export const BRAND_SECTION_KEYS: readonly BrandSectionKey[] = [
  'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'
];

const ARCHETYPE_KEY_BY_LABEL = new Map<string, Archetype>(
  Object.entries(ARCHETYPE_LABELS).map(([key, label]) => [label, key as Archetype])
);

export const archetypeLabel = (key: Archetype): string => ARCHETYPE_LABELS[key];

/** The contract key of a stored archetype label, or null for a value the contract does not know. */
export const archetypeKeyOfLabel = (label: string | null): Archetype | null =>
  label === null ? null : ARCHETYPE_KEY_BY_LABEL.get(label) ?? null;

/**
 * The name of the user who last saved a row, resolved only through the agency tie -- an active
 * membership or ownership of the client's agency. `auth."user"` has no RLS, so reading it
 * unconstrained would expose a name from another tenant; a removed membership is not a tie
 * anymore, so the name resolves to NULL once the person leaves the agency.
 */
const updaterNameSql = (userIdExpression: string, agencyIdExpression: string): string => `
  (select "user".name from auth."user" "user"
   where "user".id = ${userIdExpression}
     and (
       exists (select 1 from public.agency_memberships membership
               where membership.agency_id = ${agencyIdExpression} and membership.user_id = ${userIdExpression}
                 and membership.status = 'active')
       or exists (select 1 from public.agencies agency
                  where agency.id = ${agencyIdExpression} and agency.owner_user_id = ${userIdExpression})
     ))`;

export interface BrandSectionRow {
  readonly section_key: BrandSectionKey;
  readonly body: string | null;
  readonly colors: unknown;
  readonly archetype: string | null;
  readonly updated_by: string | null;
  readonly updated_by_name: string | null;
  readonly updated_at: Date;
}

export interface PersonaRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly pains: string | null;
  readonly desires: string | null;
  readonly objections: string | null;
  readonly status: 'active' | 'archived';
  readonly updated_by: string | null;
  readonly updated_by_name: string | null;
  readonly updated_at: Date;
}

const BRAND_SECTION_COLUMNS = `
  section.section_key, section.body, section.colors, section.archetype, section.updated_by,
  ${updaterNameSql('section.updated_by', 'client.agency_id')} as updated_by_name, section.updated_at
`;

const PERSONA_COLUMNS = `
  persona.id, persona.name, persona.description, persona.pains, persona.desires, persona.objections,
  persona.status, persona.updated_by,
  ${updaterNameSql('persona.updated_by', 'client.agency_id')} as updated_by_name, persona.updated_at
`;

/** True only for a row-level-security rejection; used to translate a concurrent archive into 409. */
export const isRowLevelSecurityViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42501';

/** The trigger of 20261007001400 found the client no longer active after waiting for the archive that held it. */
export const isClientNoLongerActive = (error: unknown): boolean => databaseErrorCode(error) === 'A0020';

export const loadBrandSections = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string }
): Promise<BrandSectionRow[]> => {
  const result = await raw<RawRows<BrandSectionRow>>(transaction, `
    select ${BRAND_SECTION_COLUMNS}
    from public.client_brand_sections section
    join public.clients client on client.id = section.client_id
    where section.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.clientId, input.agencyId]);
  return [...result.rows];
};

export const loadBrandSection = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly sectionKey: BrandSectionKey }
): Promise<BrandSectionRow | undefined> => {
  const result = await raw<RawRows<BrandSectionRow>>(transaction, `
    select ${BRAND_SECTION_COLUMNS}
    from public.client_brand_sections section
    join public.clients client on client.id = section.client_id
    where section.client_id = ?::uuid and section.section_key = ? and client.agency_id = ?::uuid
  `, [input.clientId, input.sectionKey, input.agencyId]);
  return result.rows[0];
};

/**
 * Upsert one section. The shape is fixed by the key (the route rejects a body of another section
 * before this runs); `updated_by` is always the session user, which the RLS `WITH CHECK` also
 * enforces. False means the write matched nothing (the client was archived concurrently).
 */
export const upsertBrandSection = async (
  transaction: ClientTransaction,
  input: {
    readonly clientId: string;
    readonly sectionKey: WritableBrandSectionKey;
    readonly actorUserId: string;
    readonly value: BrandStudySectionUpdate;
  }
): Promise<boolean> => {
  let column: string;
  let valueExpression: string;
  let bind: SqlBinding;
  if ('body' in input.value) {
    column = 'body'; valueExpression = '?'; bind = input.value.body;
  } else if ('colors' in input.value) {
    column = 'colors'; valueExpression = '?::jsonb'; bind = JSON.stringify(input.value.colors);
  } else {
    column = 'archetype'; valueExpression = '?'; bind = archetypeLabel(input.value.archetype);
  }
  const result = await raw<RawRows<{ section_key: string }>>(transaction, `
    insert into public.client_brand_sections (client_id, section_key, ${column}, updated_by)
    values (?::uuid, ?, ${valueExpression}, ?::uuid)
    on conflict (client_id, section_key) do update
      set ${column} = excluded.${column}, updated_by = excluded.updated_by, updated_at = now()
    returning section_key
  `, [input.clientId, input.sectionKey, bind, input.actorUserId]);
  return result.rows[0] !== undefined;
};

export const loadPersonas = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string }
): Promise<PersonaRow[]> => {
  const result = await raw<RawRows<PersonaRow>>(transaction, `
    select ${PERSONA_COLUMNS}
    from public.client_personas persona
    join public.clients client on client.id = persona.client_id
    where persona.client_id = ?::uuid and client.agency_id = ?::uuid
    order by persona.created_at asc, persona.id asc
  `, [input.clientId, input.agencyId]);
  return [...result.rows];
};

export const loadPersona = async (
  transaction: ClientTransaction,
  input: { readonly agencyId: string; readonly clientId: string; readonly personaId: string }
): Promise<PersonaRow | undefined> => {
  const result = await raw<RawRows<PersonaRow>>(transaction, `
    select ${PERSONA_COLUMNS}
    from public.client_personas persona
    join public.clients client on client.id = persona.client_id
    where persona.id = ?::uuid and persona.client_id = ?::uuid and client.agency_id = ?::uuid
  `, [input.personaId, input.clientId, input.agencyId]);
  return result.rows[0];
};

export const createPersona = async (
  transaction: ClientTransaction,
  input: { readonly clientId: string; readonly actorUserId: string; readonly body: CreatePersonaRequest }
): Promise<string | undefined> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    insert into public.client_personas (id, client_id, name, description, pains, desires, objections, updated_by)
    values (?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?::uuid)
    returning id
  `, [
    randomUUID(), input.clientId, input.body.name,
    input.body.description ?? null, input.body.pains ?? null, input.body.desires ?? null, input.body.objections ?? null,
    input.actorUserId
  ]);
  return result.rows[0]?.id;
};

const PERSONA_UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof UpdatePersonaRequest, string]> = [
  ['name', 'name'],
  ['description', 'description'],
  ['pains', 'pains'],
  ['desires', 'desires'],
  ['objections', 'objections']
];

/** A persona PATCH; false means the persona does not belong to this client (or is not there). */
export const updatePersona = async (
  transaction: ClientTransaction,
  input: {
    readonly clientId: string;
    readonly personaId: string;
    readonly actorUserId: string;
    readonly changes: UpdatePersonaRequest;
  }
): Promise<boolean> => {
  const assignments = ['updated_by = ?::uuid', 'updated_at = now()'];
  const bindings: SqlBinding[] = [input.actorUserId];
  for (const [field, column] of PERSONA_UPDATABLE_COLUMNS) {
    const value = input.changes[field];
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      bindings.push(value);
    }
  }
  bindings.push(input.personaId, input.clientId);
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.client_personas
    set ${assignments.join(', ')}
    where id = ?::uuid and client_id = ?::uuid
    returning id
  `, bindings);
  return result.rows[0] !== undefined;
};

/** Archive/unarchive; `status` is in the column UPDATE grant, `updated_by` is pinned by the RLS check. */
export const setPersonaStatus = async (
  transaction: ClientTransaction,
  input: {
    readonly clientId: string;
    readonly personaId: string;
    readonly actorUserId: string;
    readonly status: 'active' | 'archived';
  }
): Promise<boolean> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.client_personas
    set status = ?, updated_by = ?::uuid, updated_at = now()
    where id = ?::uuid and client_id = ?::uuid
    returning id
  `, [input.status, input.actorUserId, input.personaId, input.clientId]);
  return result.rows[0] !== undefined;
};

const updatedByFromRow = (row: { readonly updated_by: string | null; readonly updated_by_name: string | null }): BrandStudySection['updatedBy'] =>
  row.updated_by === null || row.updated_by_name === null ? null : { id: row.updated_by, name: row.updated_by_name };

export const brandSectionFromRow = (row: BrandSectionRow | undefined, key: BrandSectionKey): BrandStudySection => {
  if (row === undefined) {
    return { key, body: null, colors: null, archetype: null, updatedBy: null, updatedAt: null };
  }
  return {
    key,
    body: row.body,
    colors: (row.colors as BrandColor[] | null) ?? null,
    archetype: archetypeKeyOfLabel(row.archetype),
    updatedBy: updatedByFromRow(row),
    updatedAt: new Date(row.updated_at).toISOString()
  };
};

export const personaFromRow = (row: PersonaRow): Persona => ({
  id: row.id,
  name: row.name,
  description: row.description,
  pains: row.pains,
  desires: row.desires,
  objections: row.objections,
  status: row.status,
  updatedBy: updatedByFromRow(row),
  updatedAt: new Date(row.updated_at).toISOString()
});

export const brandStudyFromRows = (
  filled: number,
  sectionRows: readonly BrandSectionRow[],
  personaRows: readonly PersonaRow[]
): BrandStudyResponse => ({
  filled,
  sections: BRAND_SECTION_KEYS.map((key) => brandSectionFromRow(sectionRows.find((row) => row.section_key === key), key)),
  personas: personaRows.map(personaFromRow)
});

/** Maps a row to the HTTP contract; `photoUrl` is already signed (or null) by the caller. */
export const clientFromRow = (row: ClientRow, photoUrl: string | null): Client => ({
  id: row.id,
  name: row.name,
  status: row.status,
  photoUrl,
  legalName: row.legal_name,
  taxId: row.tax_id,
  segment: row.segment,
  website: row.website,
  instagramHandle: row.instagram_handle,
  contactName: row.contact_name,
  contactPhone: row.contact_phone,
  contactEmail: row.contact_email,
  closingDate: row.closing_date,
  archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString()
});
