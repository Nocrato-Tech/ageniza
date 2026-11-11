import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import type { BrandStudyResponse } from '@ageniza/contracts';

import { clientDetailQueryKey } from './client-detail.js';
import { HttpClientError } from './http.js';

export const NOT_INFORMED = 'Não informado';
export const LOAD_FAILED = 'Não foi possível carregar o estudo de marca. Tente de novo.';
export const SAVE_FAILED = 'Não foi possível salvar. Tente de novo.';
export const VALIDATION_FAILED = 'Revise os dados informados.';
export const NO_PERMISSION = 'Você não tem permissão para editar o estudo de marca.';
export const ARCHIVED_READ_ONLY = 'Cliente arquivado: o estudo de marca está somente leitura.';

/** `specs/clientes.md` §3: the seven fixed sections, always present and always in this order. */
export const SECTION_LABELS = {
  branding: 'Branding',
  tone_of_voice: 'Tom de voz',
  colors: 'Cores',
  positioning: 'Posicionamento',
  archetype: 'Arquétipo',
  personas: 'Personas',
  observations: 'Observações'
} as const;

export type SectionKey = keyof typeof SECTION_LABELS;
export const SECTION_ORDER: readonly SectionKey[] = ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'];
export type TextSectionKey = 'branding' | 'tone_of_voice' | 'positioning' | 'observations';

/** What the address says about a section: ASCII, so it survives being pasted in a chat. */
export const SECTION_SLUGS: Readonly<Record<SectionKey, string>> = {
  branding: 'branding',
  tone_of_voice: 'tom-de-voz',
  colors: 'cores',
  positioning: 'posicionamento',
  archetype: 'arquetipo',
  personas: 'personas',
  observations: 'observacoes'
};

const SECTION_BY_SLUG = new Map(SECTION_ORDER.map((key) => [SECTION_SLUGS[key], key] as const));

export const brandStudyQueryKey = (agencyId: string, clientId: string) =>
  ['agency', agencyId, 'clients', 'brand-study', clientId] as const;

export const sectionSearch = (key: SectionKey): string => `?secao=${SECTION_SLUGS[key]}`;
export const personaSearch = (personaId: string): string => `?secao=${SECTION_SLUGS.personas}&persona=${personaId}`;

export interface StudySelection {
  readonly section: SectionKey;
  /** Set only while the personas section shows the profile of one persona. */
  readonly personaId: string | null;
}

/**
 * Which section and persona the address opens. A section that is not one of the seven falls to the first,
 * and a persona that is not in the study is ignored, so a stale or mistyped link never errors.
 * `?persona=` alone opens that persona; next to another section it is ignored.
 */
export const resolveSelection = (params: URLSearchParams, personas: readonly { readonly id: string }[]): StudySelection => {
  const first: StudySelection = { section: SECTION_ORDER[0]!, personaId: null };
  const slug = params.get('secao');
  const requested = params.get('persona');
  const personaId = requested !== null && personas.some((persona) => persona.id === requested) ? requested : null;
  if (slug === null) return personaId === null ? first : { section: 'personas', personaId };
  const section = SECTION_BY_SLUG.get(slug);
  if (section === undefined) return first;
  return { section, personaId: section === 'personas' ? personaId : null };
};

/** The §3 rule of "filled", per section, as `sectionFilledSql` in the API defines it (the response carries only the total, in `filled`). */
export const isSectionFilled = (key: SectionKey, study: BrandStudyResponse): boolean => {
  if (key === 'personas') return study.personas.some((persona) => persona.status === 'active');
  const section = study.sections.find((item) => item.key === key);
  if (section === undefined) return false;
  if (key === 'colors') return section.colors !== null && section.colors.length > 0;
  if (key === 'archetype') return section.archetype !== null;
  return (section.body ?? '').trim() !== '';
};

/** Validation issues carry the field path the API refused; only that field is marked. */
export const refusedName = (details: unknown): boolean => {
  const parsed = z.object({ issues: z.array(z.object({ path: z.string() })) }).safeParse(details);
  return parsed.success && parsed.data.issues.some((issue) => issue.path === 'name' || issue.path.startsWith('name.'));
};

export const sectionMutationError = (error: unknown): string => {
  if (!(error instanceof HttpClientError)) return SAVE_FAILED;
  if (error.code === 'CLIENT_ARCHIVED') return ARCHIVED_READ_ONLY;
  if (error.code === 'FORBIDDEN' || error.status === 403) return NO_PERMISSION;
  if (error.status === 400) return VALIDATION_FAILED;
  return SAVE_FAILED;
};

/** Invalidates the study (counter/recheck) and the detail's General summary (SPEC §6). */
export const invalidateStudyWrites = (queryClient: QueryClient, agencyId: string, clientId: string): void => {
  void queryClient.invalidateQueries({ queryKey: brandStudyQueryKey(agencyId, clientId) });
  void queryClient.invalidateQueries({ queryKey: clientDetailQueryKey(agencyId, clientId) });
};
