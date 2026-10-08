import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  ARCHETYPE_LABELS,
  PortalBrandStudyResponseSchema,
  type PortalBrandStudyResponse,
  type PortalPersona
} from '@ageniza/contracts';
import { Button, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { Conversation } from './conversation.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { portalClientQueryKey, usePortalClient } from './portal.js';

/**
 * The portal's Marca (specs/clientes.md section 7, issue #143): the study made for the client, in
 * reading only, in the client's language, and the conversations the client opens about each part.
 * Nothing here edits the study, and nothing here knows the agency's routes: the conversation runs
 * on the client side, so even a collaborator who is also a portal member acts here as the client.
 */

const NOT_PREPARED = 'Sua agência está preparando esta parte';
const LOAD_FAILED = 'Não foi possível carregar a sua marca. Tente de novo.';

/** The seven fixed sections, in the order of the study; the labels are the client's, not the agency's. */
const SECTIONS = [
  { key: 'branding', label: 'Sobre sua marca' },
  { key: 'tone_of_voice', label: 'Como sua marca fala' },
  { key: 'colors', label: 'Cores' },
  { key: 'positioning', label: 'Posicionamento' },
  { key: 'archetype', label: 'Personalidade da marca' },
  { key: 'personas', label: 'Quem é seu público' },
  { key: 'observations', label: 'Observações' }
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

export const portalBrandStudyQueryKey = (clientId: string) => ['portal', clientId, 'brand-study'] as const;

/** One part of the study the client can suggest on: a section's own content, whatever its shape. */
function SectionContent({ sectionKey, study }: { sectionKey: Exclude<SectionKey, 'personas'>; study: PortalBrandStudyResponse }) {
  const section = study.sections.find((item) => item.key === sectionKey);
  if (sectionKey === 'colors') {
    return <ul className="brand-colors">
      {(section?.colors ?? []).map((color) => <li key={`${color.name}-${color.hex}`} className="brand-colors__item">
        <span className="brand-colors__swatch" style={{ background: color.hex }} aria-hidden="true" />
        <span>{color.name}</span>
        <span className="brand-colors__hex">{color.hex}</span>
      </li>)}
    </ul>;
  }
  if (sectionKey === 'archetype') {
    const archetype = section?.archetype ?? null;
    return <p className="brand-section__body">{archetype === null ? '' : ARCHETYPE_LABELS[archetype]}</p>;
  }
  return <p className="brand-section__body">{section?.body ?? ''}</p>;
}

/** Filled as the study defines it: text after trimming, one color, one archetype, one active persona. */
const isFilled = (sectionKey: SectionKey, study: PortalBrandStudyResponse): boolean => {
  if (sectionKey === 'personas') return study.personas.length > 0;
  const section = study.sections.find((item) => item.key === sectionKey);
  if (section === undefined) return false;
  if (sectionKey === 'colors') return (section.colors?.length ?? 0) > 0;
  if (sectionKey === 'archetype') return section.archetype !== null;
  return (section.body ?? '').trim() !== '';
};

const PERSONA_FIELDS = [
  { key: 'description', label: 'Descrição' },
  { key: 'pains', label: 'Dores' },
  { key: 'desires', label: 'Desejos' },
  { key: 'objections', label: 'Objeções' }
] as const;

function PersonaCard({ persona, onWritten }: { persona: PortalPersona; onWritten: () => void }) {
  const client = usePortalClient();
  const fields = PERSONA_FIELDS.filter((field) => persona[field.key] !== null);
  return <li className="portal-persona">
    <h3 className="portal-persona__name">{persona.name}</h3>
    {fields.length > 0 && <dl className="brand-persona__fields">
      {fields.map((field) => <div key={field.key} className="portal-persona__field">
        <dt>{field.label}</dt><dd>{persona[field.key]}</dd>
      </div>)}
    </dl>}
    <Conversation
      scope={{ side: 'client', clientId: client.id }}
      subject={{ personaId: persona.id }}
      subjectLabel={persona.name}
      canWrite
      readOnly={false}
      headingLevel={4}
      onWritten={onWritten}
    />
  </li>;
}

export function PortalBrandPage() {
  const client = usePortalClient();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  useDocumentTitle('Marca — Portal do cliente — Ageniza');

  const study = useQuery({
    queryKey: portalBrandStudyQueryKey(client.id),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/clients/:clientId/brand-study', { clientId: client.id }),
      response: PortalBrandStudyResponseSchema,
      signal
    })
  });

  // A suggestion moves the Início's count of answers; the study itself is not touched.
  const onWritten = (): void => { void queryClient.invalidateQueries({ queryKey: portalClientQueryKey(client.id) }); };

  if (study.isPending) {
    return <section className="portal-brand" aria-busy="true" aria-label="Carregando sua marca">
      {SECTIONS.map((section) => <Skeleton key={section.key} className="brand-section-skeleton" />)}
    </section>;
  }

  if (study.data === undefined) {
    return <section className="portal-brand">
      <h1>Sua marca</h1>
      <div className="brand-study__error" role="alert">
        <p>{LOAD_FAILED}</p>
        <Button onClick={() => { void study.refetch(); }} loading={study.isFetching}>Tentar de novo</Button>
      </div>
    </section>;
  }

  const data = study.data;
  return <section className="portal-brand" aria-labelledby="portal-brand-title">
    <h1 id="portal-brand-title">Sua marca</h1>
    {SECTIONS.map((section) => {
      const filled = isFilled(section.key, data);
      const titleId = `portal-brand-${section.key}`;
      return <section key={section.key} className="brand-section" aria-labelledby={titleId}>
        <header className="brand-section__header"><h2 id={titleId}>{section.label}</h2></header>
        {!filled && <p className="brand-section__body">{NOT_PREPARED}</p>}
        {filled && section.key === 'personas' && <ul className="portal-persona-list">
          {data.personas.map((persona) => <PersonaCard key={persona.id} persona={persona} onWritten={onWritten} />)}
        </ul>}
        {filled && section.key !== 'personas' && <SectionContent sectionKey={section.key} study={data} />}
        {filled && <Conversation
          scope={{ side: 'client', clientId: client.id }}
          subject={{ sectionKey: section.key }}
          subjectLabel={section.label}
          canWrite
          readOnly={false}
          headingLevel={3}
          onWritten={onWritten}
        />}
      </section>;
    })}
  </section>;
}
