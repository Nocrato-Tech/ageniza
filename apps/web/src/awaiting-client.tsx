import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import { AwaitingClientResponseSchema } from '@ageniza/contracts';
import { EmptyState, FormatTag, Skeleton } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { AwaitingState } from './approval-deadline.js';
import { contentsAddress } from './content-address.js';
import { dayMonthLabel, weekdayShortLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { useApiClient } from './http.js';

const AWAITING_PATH = '/agencies/:agencyId/contents/awaiting-client';

export const awaitingClientQueryKey = (agencyId: string) => ['agency', agencyId, 'awaiting-client'] as const;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * "Parado no cliente" (decision 2026-11-10): what waits for a client's approval, grouped by client, in the order the API
 * gives (the most urgent first), each with the state of its deadline. The deadline is the approval's, never the publication's.
 * It says "nada parado" only when the query answered; when it did not, it says so and offers to try again.
 */
export function AwaitingClient({ agencyId }: { agencyId: string }) {
  const httpClient = useApiClient();
  const location = useLocation();
  const awaiting = useQuery({
    queryKey: awaitingClientQueryKey(agencyId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(AWAITING_PATH, { agencyId }),
      response: AwaitingClientResponseSchema,
      signal
    })
  });

  const total = awaiting.data?.data.reduce((sum, group) => sum + group.contents.length, 0) ?? 0;

  return <section className="awaiting-client" aria-labelledby="awaiting-client-title">
    <div className="awaiting-client__head">
      <h2 id="awaiting-client-title" className="awaiting-client__title">Parado no cliente</h2>
      {awaiting.data !== undefined && total > 0 && <p className="awaiting-client__count">{plural(total, 'conteúdo', 'conteúdos')} em {plural(awaiting.data.data.length, 'cliente', 'clientes')}</p>}
    </div>
    {awaiting.isPending
      ? <div className="awaiting-client__skeleton" aria-hidden="true"><Skeleton /><Skeleton /></div>
      : awaiting.isError && awaiting.data === undefined
        ? <EmptyState
          kind="failure"
          headingLevel={3}
          title="Não foi possível carregar o que está parado no cliente"
          description="A lista não respondeu. Isso não quer dizer que nada está esperando."
          onRetry={() => { void awaiting.refetch(); }}
        />
        : awaiting.data!.data.length === 0
          ? <EmptyState
            kind="good-news"
            headingLevel={3}
            title="Nada parado no cliente"
            description="Nenhum conteúdo está esperando a aprovação de um cliente."
          />
          : <>
            <ul className="awaiting-client__clients">
              {awaiting.data!.data.map((group) => <li key={group.clientId} className="awaiting-client__group">
                <h3 className="awaiting-client__client">{group.clientName} <span className="awaiting-client__client-count">({group.contents.length})</span></h3>
                <ul className="awaiting-client__items">
                  {group.contents.map((content) => <li key={content.id}>
                    <Link
                      className="awaiting-client__item"
                      to={{ pathname: `${contentsAddress(agencyId, group.clientId)}/${content.id}`, search: `?data=${content.publishOn}` }}
                      state={location.state}
                    >
                      <span className="awaiting-client__item-title">{content.title}</span>
                      <span className="awaiting-client__item-meta">
                        <FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag>
                        <span>Publicação: {weekdayShortLabel(content.publishOn)}, {dayMonthLabel(content.publishOn)}</span>
                      </span>
                      <AwaitingState daysToDue={content.daysToDue} daysWaiting={content.daysWaiting} />
                    </Link>
                  </li>)}
                </ul>
              </li>)}
            </ul>
            {awaiting.data!.meta.truncated && <p className="awaiting-client__more">Mostrando os {total} mais urgentes.</p>}
          </>}
  </section>;
}
