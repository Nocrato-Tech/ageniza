import { useQueries, useQueryClient } from '@tanstack/react-query';

import { ThreadListResponseSchema, type ClientDetailResponse, type Persona, type ThreadSubject } from '@ageniza/contracts';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { clientDetailQueryKey } from './client-detail.js';
import { awaitsViewer, Conversation, routesOf, scopeKeyOf, type ConversationScope } from './conversation.js';
import { useApiClient } from './http.js';
import { SECTION_ORDER, type SectionKey } from './brand-study-model.js';

/**
 * The conversations of one subject of the study. Writing them also moves the detail's summary and
 * the roster's "aguardando" badge, so both are invalidated here (SPEC section 6).
 */
export function StudyConversation({ client, subject, subjectLabel, readOnly, headingLevel }: {
  client: ClientDetailResponse;
  subject: ThreadSubject;
  subjectLabel: string;
  readOnly: boolean;
  headingLevel?: 3 | 4;
}) {
  const blocked = useWriteBlocked();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const canOperate = useCan('cliente.operar');
  return <Conversation
    scope={{ side: 'agency', agencyId: agency.agencyId, clientId: client.id }}
    subject={subject}
    subjectLabel={subjectLabel}
    canWrite={canOperate}
    readOnly={readOnly || client.status !== 'active'}
    planBlockedReason={blocked}
    headingLevel={headingLevel}
    onWritten={() => {
      void queryClient.invalidateQueries({ queryKey: clientDetailQueryKey(agency.agencyId, client.id) });
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'clients'], predicate: (query) => typeof query.queryKey[3] === 'object' });
    }}
  />;
}

const OPEN_THREADS_PAGE_SIZE = 100;

/** How many open conversations wait for the agency, per section and per active persona; `undefined` until it is known. */
export interface AwaitingCounts {
  readonly section: Readonly<Record<SectionKey, number | undefined>>;
  readonly persona: Readonly<Record<string, number | undefined>>;
}

/**
 * The listing takes one subject at a time, so the index asks once per section and once per active persona. The
 * keys live under the conversation scope: any write a `Conversation` makes (open, answer, resolve) refreshes them.
 */
export function useAwaitingCounts(clientId: string, personas: readonly Persona[]): AwaitingCounts {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const scope: ConversationScope = { side: 'agency', agencyId: agency.agencyId, clientId };
  const subjects = [
    ...SECTION_ORDER.map((key) => ({ id: `section:${key}`, query: `sectionKey=${key}` })),
    ...personas.filter((persona) => persona.status === 'active').map((persona) => ({ id: `persona:${persona.id}`, query: `personaId=${persona.id}` }))
  ];
  const results = useQueries({
    queries: subjects.map((subject) => ({
      queryKey: [...scopeKeyOf(scope), 'awaiting', subject.id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const page = await httpClient.request({
          path: `${routesOf(scope).threads}?${subject.query}&state=open&pageSize=${OPEN_THREADS_PAGE_SIZE}`,
          response: ThreadListResponseSchema,
          signal
        });
        return page.data.filter((thread) => awaitsViewer(thread, 'agency')).length;
      }
    }))
  });
  const countOf = (id: string): number | undefined => results[subjects.findIndex((subject) => subject.id === id)]?.data;
  return {
    section: Object.fromEntries(SECTION_ORDER.map((key) => [key, countOf(`section:${key}`)])) as Record<SectionKey, number | undefined>,
    persona: Object.fromEntries(subjects.filter((subject) => subject.id.startsWith('persona:')).map((subject) => [subject.id.slice('persona:'.length), countOf(subject.id)]))
  };
}

/** The pending total of a section for the index: its own thread, plus its personas' for Personas. */
export const awaitingOf = (key: SectionKey, counts: AwaitingCounts): number | undefined => {
  const own = counts.section[key];
  if (key !== 'personas') return own;
  const values = [own, ...Object.values(counts.persona)];
  return values.every((value) => value === undefined) ? undefined : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
};
