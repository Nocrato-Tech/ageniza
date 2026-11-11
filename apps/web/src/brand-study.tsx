import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { BrandStudyResponseSchema, type BrandStudyResponse, type ClientDetailResponse } from '@ageniza/contracts';
import { EmptyState, Pill, Skeleton } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { StudyConversation, useAwaitingCounts } from './brand-study-conversation.js';
import { SectionIndex } from './brand-study-index.js';
import {
  brandStudyQueryKey,
  isSectionFilled,
  LOAD_FAILED,
  resolveSelection,
  SECTION_LABELS,
  SECTION_ORDER,
  SECTION_SLUGS,
  type SectionKey,
  type TextSectionKey
} from './brand-study-model.js';
import { PersonasSection } from './brand-study-personas.js';
import { ArchetypeSection, ColorsSection, PanelLayout, TextSection } from './brand-study-sections.js';
import { useClientDetail } from './client-detail.js';
import { useApiClient } from './http.js';

export { brandStudyQueryKey };

/** One section's content; each keeps its own editor state, so a draft survives a visit to another section. */
function SectionContent({ client, study, sectionKey, canEdit }: {
  client: ClientDetailResponse;
  study: BrandStudyResponse;
  sectionKey: Exclude<SectionKey, 'personas'>;
  canEdit: boolean;
}) {
  const section = study.sections.find((item) => item.key === sectionKey);
  if (sectionKey === 'colors') return <ColorsSection client={client} section={section} canEdit={canEdit} />;
  if (sectionKey === 'archetype') return <ArchetypeSection client={client} section={section} canEdit={canEdit} />;
  return <TextSection client={client} sectionKey={sectionKey as TextSectionKey} section={section} canEdit={canEdit} />;
}

function BrandStudyView({ client, study, canEdit }: { client: ClientDetailResponse; study: BrandStudyResponse; canEdit: boolean }) {
  const [params] = useSearchParams();
  const awaiting = useAwaitingCounts(client.id, study.personas);
  const selection = resolveSelection(params, study.personas);
  const filled = Object.fromEntries(SECTION_ORDER.map((key) => [key, isSectionFilled(key, study)])) as Record<SectionKey, boolean>;

  return <div className="brand-study brand-study--agency">
    <div className="brand-study__layout">
      <div className="brand-study__side">
        <header className="brand-study__header">
          <h2>Estudo de marca</h2>
          <Pill className="brand-study__count" icon={<Check />}>{study.filled} de 7 preenchidas</Pill>
        </header>
        <progress className="brand-study__progress" aria-label="Seções preenchidas" value={study.filled} max={SECTION_ORDER.length} />
        <SectionIndex active={selection.section} filled={filled} awaiting={awaiting} />
      </div>
      <div className="brand-study__main">
        {SECTION_ORDER.map((key) => {
          const open = key === selection.section;
          return <section key={key} className="brand-panel" data-section={SECTION_SLUGS[key]} aria-label={SECTION_LABELS[key]} hidden={!open}>
            {key === 'personas'
              ? <PersonasSection client={client} personas={study.personas} canEdit={canEdit} active={open} selectedId={selection.personaId} awaiting={awaiting} />
              : <PanelLayout conversation={open ? <StudyConversation client={client} subject={{ sectionKey: key }} subjectLabel={SECTION_LABELS[key]} readOnly={false} /> : null}>
                <SectionContent client={client} study={study} sectionKey={key} canEdit={canEdit} />
              </PanelLayout>}
          </section>;
        })}
      </div>
    </div>
  </div>;
}

/**
 * The brand-study tab (`specs/clientes.md` §7, issue #138): the seven fixed sections, always in the same
 * order and always present, one on screen at a time and chosen in an index (`?secao=`, and `?persona=` for the
 * profile of one persona), with in-place editing for `cliente.operar` on an active client.
 * Every edit invalidates the study and the client detail, so the counter here and the General tab
 * move together without a reload. The conversations of each section and persona are #142.
 */
export function ClientBrandStudyTab() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const client = useClientDetail();
  const canOperate = useCan('cliente.operar');
  const canEdit = canOperate && client.status === 'active';

  const study = useQuery({
    queryKey: brandStudyQueryKey(agency.agencyId, client.id),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/brand-study', { agencyId: agency.agencyId, clientId: client.id }),
      response: BrandStudyResponseSchema,
      signal
    })
  });

  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const failed = study.isError || (study.isPending && study.errorUpdateCount > 0);
  if (study.isPending && !failed) {
    return <div className="brand-study brand-study--agency" aria-busy="true">
      <div className="brand-study__layout">
        <div className="brand-study__side">
          <div className="brand-index brand-index--skeleton">
            {SECTION_ORDER.map((key) => <Skeleton key={key} className="brand-section-skeleton" />)}
          </div>
        </div>
        <Skeleton className="brand-card-skeleton" />
      </div>
    </div>;
  }

  if (failed && study.data === undefined) {
    return <EmptyState kind="failure" headingLevel={3} title={LOAD_FAILED} retrying={study.isFetching} onRetry={() => { void study.refetch(); }} />;
  }

  if (study.data === undefined) return null;
  return <BrandStudyView client={client} study={study.data} canEdit={canEdit} />;
}
