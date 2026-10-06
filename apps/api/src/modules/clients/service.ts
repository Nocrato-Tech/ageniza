import type { Client, ClientListSort, ClientSummary, UpdateClientRequest } from '@ageniza/contracts';
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

// Accented letters mapped to their unaccented form, lowercase **and** uppercase: `lower` only
// folds letters the database locale knows, so under collation `C` it leaves `Á` untouched and the
// fold would depend on the server locale. The trailing combining marks (U+0300..U+030C) have no
// counterpart in `to`, so `translate` deletes them: a name stored decomposed (NFD) folds exactly
// like the composed (NFC) form of the same name.
const SEARCH_FOLD_FROM = 'áàâãäåéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030a\u030b\u030c';
const SEARCH_FOLD_TO = 'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN';

/**
 * Case- and accent-insensitive form of a text expression (SPEC §6 listagem: search matches name,
 * razão social and @ "sem diferenciar maiúsculas nem acento"). The database has no `unaccent`
 * extension and adding one is a migration, which the contribution rules keep in its own change;
 * `translate` folds the accents in SQL instead, and both the column and the search term go
 * through this exact expression so they can never diverge.
 *
 * The argument is always a fixed column or bind placeholder chosen here, never a request value.
 */
const foldTextSql = (expression: string): string => `translate(lower(${expression}), '${SEARCH_FOLD_FROM}', '${SEARCH_FOLD_TO}')`;

/**
 * Lists one page of an agency's clients (issue #125). The query starts from `public.clients`
 * filtered by the route's agency; RLS is the second barrier and never the tenant filter (issue
 * #186 lesson: a caller who belongs to two agencies must still get only the agency in the URL).
 *
 * The "aguardando a agência" count comes from the single definition in `thread-state.ts`, the same
 * one the detail summary and the portal use, and is a correlated subquery over `client_threads`
 * so the `client_thread_comments (thread_id, created_at)` index from #122 answers the last-comment
 * lookup. The count of the whole filtered set is a second, simple `count(*)`, never all the rows.
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
  // The subquery is only computed for a caller who may see the badge; a caller without
  // `cliente.convidar_usuario` gets null, so the route omits the field instead of zeroing it.
  const pendingInvitationsSelect = filters.includePendingInvitations
    ? `(
        select count(*)
        from public.invitations invitation
        where invitation.client_id = client.id
          and invitation.purpose = 'client_invite'
          and invitation.used_at is null
          and invitation.revoked_at is null
          and invitation.expires_at > now()
      )`
    : 'null::bigint';

  const countResult = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total
    from public.clients client
    where ${where}
  `, bindings);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);

  // A derived table because PostgreSQL does not accept an output alias inside an ORDER BY
  // expression (`ORDER BY threads_awaiting_agency > 0` over the subquery output is valid).
  const orderBy = filters.sort === 'name:asc'
    ? `${foldTextSql('listing.name')} asc, listing.id asc`
    : `(listing.threads_awaiting_agency > 0) desc, ${foldTextSql('listing.name')} asc, listing.id asc`;

  const itemsResult = await raw<RawRows<ClientListRow>>(transaction, `
    select
      listing.id,
      listing.name,
      listing.photo_key,
      listing.instagram_handle,
      listing.status,
      listing.closing_date,
      listing.threads_awaiting_agency,
      listing.pending_invitations
    from (
      select
        client.id,
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
        ${pendingInvitationsSelect} as pending_invitations
      from public.clients client
      where ${where}
    ) as listing
    order by ${orderBy}
    limit ? offset ?
  `, [...bindings, pagination.pageSize, pagination.offset]);

  return { items: itemsResult.rows, totalItems };
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
