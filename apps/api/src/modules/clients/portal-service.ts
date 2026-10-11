import type {
  BrandColor,
  BrandSectionKey,
  PortalBrandStudyResponse,
  PortalBrandStudySection,
  PortalHome,
  PortalPersona
} from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import {
  BRAND_STUDY_FILLED_SQL,
  BRAND_SECTION_KEYS,
  archetypeKeyOfLabel,
  type ClientRow,
  type ClientTransaction
} from './service.js';
import { latestCommentSideSql, openThreadSql } from './thread-state.js';

/**
 * The portal's reads of its own client (specs/clientes.md sections 2, 6 and 7).
 *
 * Row-level security says who may read a row, not from which side. A collaborator who also has a
 * client link reads every client of the agency, archived personas included, through the agency
 * branch of each policy, so a rule that holds only for the portal is written in the SQL of these
 * functions and never left to the policy. Every statement is scoped to the client the guard proved
 * (`request.clientContext`), never to a request value. Nothing here reads `auth."user"`: the portal
 * shows no person on these routes, and the only link it reads is the caller's own.
 */

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface PortalClientRow extends ClientRow {
  readonly agency_id: string;
  readonly agency_name: string;
  readonly onboarding_seen_at: Date | null;
}

/**
 * The client of the portal and the caller's own link. The link is the one the guard proved, by id,
 * and `onboarding_seen_at` is read from it and from no other: two people of one client have two
 * values. The client and its agency must be active here too, so an archive that lands between the
 * guard and this read is a missing row and not a served one.
 */
export const loadPortalClient = async (
  transaction: ClientTransaction,
  input: { readonly clientId: string; readonly clientMembershipId: string }
): Promise<PortalClientRow | undefined> => {
  const result = await raw<RawRows<PortalClientRow>>(transaction, `
    select
      client.id, client.name, client.status, client.photo_key, client.legal_name, client.tax_id,
      client.segment, client.website, client.instagram_handle, client.contact_name, client.contact_phone,
      client.contact_email, client.closing_date::text as closing_date, client.archived_at,
      client.agency_id, agency.name as agency_name,
      membership.onboarding_seen_at
    from public.clients client
    join public.agencies agency on agency.id = client.agency_id
    join public.client_memberships membership on membership.client_id = client.id
    where client.id = ?::uuid
      and client.status = 'active'
      and agency.status = 'active'
      and membership.id = ?::uuid
      and membership.user_id = app_private.current_user_id()
      and membership.status = 'active'
  `, [input.clientId, input.clientMembershipId]);
  return result.rows[0];
};

interface PortalHomeRow {
  readonly brand_study_filled: string | number;
  readonly threads_answered_by_agency: string | number;
}

/**
 * The Início summary. "Com resposta da agência" is the single thread-state definition, restricted to
 * the threads the portal can read: one about an archived persona is read-only history the portal
 * does not show, so it is not a reply waiting for the person either.
 */
export const loadPortalHome = async (transaction: ClientTransaction, clientId: string): Promise<PortalHome> => {
  const result = await raw<RawRows<PortalHomeRow>>(transaction, `
    select
      ${BRAND_STUDY_FILLED_SQL} as brand_study_filled,
      (
        select count(*) from public.client_threads thread
        where thread.client_id = ?::uuid
          and ${openThreadSql('thread')}
          and ${latestCommentSideSql('thread')} = 'agency'
          and (
            thread.persona_id is null
            or exists (
              select 1 from public.client_personas persona
              where persona.id = thread.persona_id and persona.client_id = thread.client_id and persona.status = 'active'
            )
          )
      ) as threads_answered_by_agency
  `, [clientId, clientId, clientId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Portal home query returned no row.');
  return {
    brandStudyFilled: Number(row.brand_study_filled),
    threadsAnsweredByAgency: Number(row.threads_answered_by_agency)
  };
};

interface PortalSectionRow {
  readonly section_key: BrandSectionKey;
  readonly body: string | null;
  readonly colors: unknown;
  readonly archetype: string | null;
  readonly updated_at: Date;
}

interface PortalPersonaRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly pains: string | null;
  readonly desires: string | null;
  readonly objections: string | null;
  readonly updated_at: Date;
}

const portalSectionFromRow = (row: PortalSectionRow | undefined, key: BrandSectionKey): PortalBrandStudySection => {
  if (row === undefined) return { key, body: null, colors: null, archetype: null, updatedAt: null };
  return {
    key,
    body: row.body,
    colors: (row.colors as BrandColor[] | null) ?? null,
    archetype: archetypeKeyOfLabel(row.archetype),
    updatedAt: new Date(row.updated_at).toISOString()
  };
};

const portalPersonaFromRow = (row: PortalPersonaRow): PortalPersona => ({
  id: row.id,
  name: row.name,
  description: row.description,
  pains: row.pains,
  desires: row.desires,
  objections: row.objections,
  status: 'active',
  updatedAt: new Date(row.updated_at).toISOString()
});

/**
 * The seven sections and the active personas of the client. The statements do not select `updated_by`
 * at all, so who edited internally cannot reach the response by a mapping slip, and the persona query
 * filters `status = 'active'` itself: an archived persona is invisible to the portal and visible to
 * the agency, and the policy cannot tell the two callers apart for a collaborator with a client link.
 */
export const loadPortalBrandStudy = async (transaction: ClientTransaction, clientId: string): Promise<PortalBrandStudyResponse> => {
  const home = await raw<RawRows<{ readonly brand_study_filled: string | number }>>(transaction, `
    select ${BRAND_STUDY_FILLED_SQL} as brand_study_filled
  `, [clientId, clientId]);
  const sections = await raw<RawRows<PortalSectionRow>>(transaction, `
    select section.section_key, section.body, section.colors, section.archetype, section.updated_at
    from public.client_brand_sections section
    where section.client_id = ?::uuid
  `, [clientId]);
  const personas = await raw<RawRows<PortalPersonaRow>>(transaction, `
    select persona.id, persona.name, persona.description, persona.pains, persona.desires, persona.objections, persona.updated_at
    from public.client_personas persona
    where persona.client_id = ?::uuid and persona.status = 'active'
    order by persona.created_at asc, persona.id asc
  `, [clientId]);
  return {
    filled: Number(home.rows[0]?.brand_study_filled ?? 0),
    sections: BRAND_SECTION_KEYS.map((key) => portalSectionFromRow(sections.rows.find((row) => row.section_key === key), key)),
    personas: personas.rows.map(portalPersonaFromRow)
  };
};
