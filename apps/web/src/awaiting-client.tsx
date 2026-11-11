import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Hourglass } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { AwaitingClientResponseSchema, type AwaitingClientResponse } from '@ageniza/contracts';
import { Avatar, EmptyState, FormatTag, Skeleton, Stage3D } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { AwaitingState } from './approval-deadline.js';
import { contentsAddress } from './content-address.js';
import { dayMonthLabel, weekdayShortLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { useApiClient } from './http.js';

const AWAITING_PATH = '/agencies/:agencyId/contents/awaiting-client';

export const awaitingClientQueryKey = (agencyId: string) => ['agency', agencyId, 'awaiting-client'] as const;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** One read for the list and for the summary cards above it: the same key, so the page asks once. */
const useAwaitingClient = (agencyId: string) => {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: awaitingClientQueryKey(agencyId),
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(AWAITING_PATH, { agencyId }),
      response: AwaitingClientResponseSchema,
      signal
    })
  });
};

const countOf = (data: AwaitingClientResponse): number => data.data.reduce((sum, group) => sum + group.contents.length, 0);

/**
 * "Parado no cliente" (decision 2026-11-10): what waits for a client's approval, grouped by client, in the order the API
 * gives (the most urgent first), each with the state of its deadline. The deadline is the approval's, never the publication's.
 * It says "nada parado" only when the query answered; when it did not, it says so and offers to try again.
 */
export function AwaitingClient({ agencyId }: { agencyId: string }) {
  const location = useLocation();
  const awaiting = useAwaitingClient(agencyId);

  const total = awaiting.data === undefined ? 0 : countOf(awaiting.data);

  return <section className="awaiting-client" aria-labelledby="awaiting-client-title">
    <div className="awaiting-client__head">
      <div className="awaiting-client__heading">
        <h2 id="awaiting-client-title" className="awaiting-client__title">Parado no cliente</h2>
        {awaiting.data !== undefined && total > 0 && <p className="awaiting-client__hint">Os mais urgentes primeiro.</p>}
      </div>
      {awaiting.data !== undefined && total > 0 && <p className="awaiting-client__count"><Hourglass aria-hidden="true" />{plural(total, 'conteúdo', 'conteúdos')} em {plural(awaiting.data.data.length, 'cliente', 'clientes')}</p>}
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
                <div className="awaiting-client__who">
                  <Avatar name={group.clientName} size="sm" />
                  <h3 className="awaiting-client__client">{group.clientName} <span className="awaiting-client__client-count">({group.contents.length})</span></h3>
                </div>
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

/**
 * The summary cards of the Início, from the same list as "Parado no cliente": how many contents wait for a client and, when
 * a deadline has passed, how many. Nothing is said before the list answers or when nothing waits (the good news is the list's),
 * and a card appears only with the action it asks for: a count without a way forward is not shown.
 */
export function AwaitingSummary({ agencyId }: { agencyId: string }) {
  const location = useLocation();
  const awaiting = useAwaitingClient(agencyId);
  if (awaiting.data === undefined) return null;
  const total = countOf(awaiting.data);
  if (total === 0) return null;

  const expired = awaiting.data.data.flatMap((group) => group.contents
    .filter((content) => content.daysToDue !== null && content.daysToDue < 0)
    .map((content) => ({ clientId: group.clientId, content })));
  const worst = expired.reduce<(typeof expired)[number] | undefined>((acc, entry) => (acc === undefined || entry.content.daysToDue! < acc.content.daysToDue! ? entry : acc), undefined);
  const truncated = awaiting.data.meta.truncated;

  return <ul className="home-summary" aria-label="Resumo do que espera o cliente">
    <li className="home-summary__card home-summary__card--violet" data-stage-host>
      <Stage3D src="/3d/clock.png" tone="violet" size="lg" breakout />
      <p className="home-summary__label">Esperando<span className="home-summary__label-rest"> o cliente</span></p>
      <p className="home-summary__number">{truncated ? `${total}+` : total}</p>
      <p className="home-summary__hint">{total === 1 ? 'conteúdo aguardando aprovação' : 'conteúdos aguardando aprovação'}</p>
      <Link className="home-summary__action" to={`/agencia/${agencyId}/conteudos`}>Abrir o calendário<ArrowRight aria-hidden="true" /></Link>
    </li>
    {worst !== undefined && <li className="home-summary__card home-summary__card--red" data-stage-host>
      <Stage3D src="/3d/flag.png" tone="red" size="lg" breakout />
      <p className="home-summary__label">Atrasados</p>
      <p className="home-summary__number">{expired.length}</p>
      <p className="home-summary__hint">{expired.length === 1 ? 'o prazo venceu sem resposta' : 'prazos venceram sem resposta'}</p>
      <Link
        className="home-summary__action"
        to={{ pathname: `${contentsAddress(agencyId, worst.clientId)}/${worst.content.id}`, search: `?data=${worst.content.publishOn}` }}
        state={location.state}
      >
        Abrir o mais atrasado<ArrowRight aria-hidden="true" />
      </Link>
    </li>}
  </ul>;
}
