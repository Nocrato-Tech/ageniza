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
  type ClientSummary,
  type CreatePersonaRequest,
  type Persona,
  type UpdateClientRequest,
  type UpdatePersonaRequest,
  type WritableBrandSectionKey
} from '@ageniza/contracts';
import { raw, type DatabaseClient, type SqlBinding } from '@ageniza/database';

import { latestCommentSideSql, openThreadSql } from './thread-state.js';

export type ClientTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/** One `clients` row as read or returned by this module; `closing_date` is text, never a Date. */
export interface ClientRow {
  readonly id: string;
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
  id, name, status, photo_key, legal_name, tax_id, segment, website, instagram_handle,
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
 * The General tab summary (specs/clientes.md section 6). `personas` counts as one filled section
 * when at least one persona is active; "aguardando a agência" and "com resposta da agência" come
 * from the single thread-state definition, so this count cannot drift from the listing (#125).
 */
export const loadClientSummary = async (transaction: ClientTransaction, clientId: string): Promise<ClientSummary> => {
  const result = await raw<RawRows<SummaryRow>>(transaction, `
    select
      (
        select count(*)
        from public.client_brand_sections section
        where section.client_id = ?::uuid
          and case section.section_key
            when 'colors' then section.colors is not null
              and jsonb_typeof(section.colors) = 'array'
              and jsonb_array_length(section.colors) > 0
            when 'archetype' then section.archetype is not null
            else section.body is not null and btrim(section.body) <> ''
          end
      ) + (
        case when exists (
          select 1 from public.client_personas persona
          where persona.client_id = ?::uuid and persona.status = 'active'
        ) then 1 else 0 end
      ) as brand_study_filled,
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

// --- Brand study and personas (specs/clientes.md section 3) ---------------------------------

/** The seven sections, always returned in this order. */
export const BRAND_SECTION_KEYS: readonly BrandSectionKey[] = [
  'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'
];

const ARCHETYPE_KEY_BY_LABEL = new Map<string, Archetype>(
  Object.entries(ARCHETYPE_LABELS).map(([key, label]) => [label, key as Archetype])
);

export const archetypeLabel = (key: Archetype): string => ARCHETYPE_LABELS[key];

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
    archetype: row.archetype === null ? null : ARCHETYPE_KEY_BY_LABEL.get(row.archetype) ?? null,
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
