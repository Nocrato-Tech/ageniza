import type { Client, ClientSummary, UpdateClientRequest } from '@ageniza/contracts';
import { raw, type DatabaseClient, type SqlBinding } from '@ageniza/database';

import { answeredByAgencySql, awaitingAgencySql } from './thread-state.js';

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
          and ${awaitingAgencySql('thread')}
      ) as threads_awaiting_agency,
      (
        select count(*) from public.client_threads thread
        where thread.client_id = ?::uuid
          and ${answeredByAgencySql('thread')}
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
