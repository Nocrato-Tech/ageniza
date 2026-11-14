import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Hourglass, Send } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { AwaitingClientResponseSchema, ContentSummaryResponseSchema, type AwaitingClientContent } from '@ageniza/contracts';
import { Avatar, ButtonLink, EmptyState, LateBadge, Pill, Skeleton, Stage3D, StatusTag } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { dueDayLabel, waitingWording } from './approval-deadline.js';
import { contentsAddress } from './content-address.js';
import { ContentCover } from './content-cover.js';
import { todayInSaoPaulo } from './content-dates.js';
import { CARD_FORMAT_LABELS } from './content-labels.js';
import { clockLabel, longDayLabel, previousMonthName } from './home-dates.js';
import { useApiClient } from './http.js';
import { portalEntryAddress, portalShareMessage, whatsappShareUrl } from './portal-access-share.js';

const AWAITING_PATH = '/agencies/:agencyId/contents/awaiting-client';
const SUMMARY_PATH = '/agencies/:agencyId/contents/summary';

export const awaitingClientQueryKey = (agencyId: string) => ['agency', agencyId, 'awaiting-client'] as const;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

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

/** The counters of the blocks above the list. One key, so the blocks and the header's sentence ask once. */
export const useContentSummary = (agencyId: string, enabled = true) => {
  const httpClient = useApiClient();
  return useQuery({
    queryKey: ['agency', agencyId, 'contents-summary'],
    queryFn: ({ signal }) => httpClient.request({ path: apiPath(SUMMARY_PATH, { agencyId }), response: ContentSummaryResponseSchema, signal }),
    enabled,
    refetchOnMount: 'always'
  });
};

/** "Estático · deveria ter saído em 9 de novembro", or "Carrossel · enviado há 2 dias", then the deadline of the approval with its hour. */
const subtitleOf = (content: AwaitingClientContent): string => {
  const parts: string[] = [CARD_FORMAT_LABELS[content.format]];
  if (content.daysLate !== null) parts.push(`deveria ter saído em ${longDayLabel(content.publishOn)}`);
  else if (content.daysWaiting !== null) parts.push(waitingWording(content.daysWaiting));
  if (content.dueAt !== null && content.dueOn !== null) {
    parts.push(`${content.daysToDue !== null && content.daysToDue < 0 ? 'venceu' : 'vence'} ${dueDayLabel(content.dueOn)}, às ${clockLabel(content.dueAt)}`);
  }
  return parts.join(' · ');
};

const lateLabel = (days: number): string => `Atrasado ${plural(days, 'dia', 'dias')}`;

/**
 * "Parado no cliente" (decisions 2026-11-10 and 2026-11-11): what waits for a client's approval, by client, from the content sent
 * longest ago to the newest (the order of the API). The late ones are told by the publication day that passed; the deadline of the
 * approval (with its hour) is a line of each row. It says "nada parado" only when the query answered; when it did not, it says so
 * and offers to try again.
 */
export function AwaitingClient({ agencyId }: { agencyId: string }) {
  const location = useLocation();
  const agency = useAgencyContext();
  const awaiting = useAwaitingClient(agencyId);

  const groups = awaiting.data?.data ?? [];
  const total = groups.reduce((sum, group) => sum + group.contents.length, 0);
  const truncated = awaiting.data?.meta.truncated === true;

  return <section className="awaiting-client" id="parado" tabIndex={-1} aria-labelledby="awaiting-client-title">
    <div className="awaiting-client__head">
      <div className="awaiting-client__heading">
        <h2 id="awaiting-client-title" className="awaiting-client__title">Parado no cliente</h2>
        {total > 0 && <p className="awaiting-client__hint">Do mais antigo para o mais novo. O cliente responde pelo link.</p>}
      </div>
      {total > 0 && <Pill className="awaiting-client__count" icon={<Hourglass />}>{truncated ? `${total}+ posts` : plural(total, 'post', 'posts')}</Pill>}
    </div>
    {awaiting.isPending
      ? <div className="awaiting-client__skeleton" aria-hidden="true"><Skeleton /><Skeleton /></div>
      : awaiting.isError && awaiting.data === undefined
        ? <EmptyState
          kind="failure"
          mascot
          headingLevel={3}
          title="Não foi possível carregar o que está parado no cliente"
          description="A lista não respondeu. Isso não quer dizer que nada está esperando."
          onRetry={() => { void awaiting.refetch(); }}
          retrying={awaiting.isFetching}
        />
        : groups.length === 0
          ? <EmptyState
            kind="good-news"
            headingLevel={3}
            title="Nada parado no cliente"
            description="Nenhum conteúdo está esperando a aprovação de um cliente."
          />
          : <>
            <ul className="awaiting-client__clients">
              {groups.map((group) => {
                const [first, ...others] = group.approvers ?? [];
                const approver = first === undefined ? null : `${first}${others.length > 0 ? ` e mais ${others.length}` : ''}`;
                const message = portalShareMessage({ agencyName: agency.agencyName, clientName: group.clientName, personName: first ?? null, address: portalEntryAddress() });
                return <li key={group.clientId} className="awaiting-client__group">
                  <div className="awaiting-client__who">
                    <Avatar name={group.clientName} size="sm" />
                    <h3 className="awaiting-client__client">{group.clientName}</h3>
                    <span className="awaiting-client__client-count">{plural(group.contents.length, 'post', 'posts')}{approver === null ? '' : ` · ${approver}`}</span>
                    {group.approvers !== null && <ButtonLink
                      className="awaiting-client__resend"
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Send />}
                      href={whatsappShareUrl(message)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Reenviar o link para ${group.clientName} (abre em nova aba)`}
                    >Reenviar o link</ButtonLink>}
                  </div>
                  <ul className="awaiting-client__items">
                    {group.contents.map((content) => <li key={content.id}>
                      <Link
                        className="awaiting-client__item"
                        to={{ pathname: `${contentsAddress(agencyId, group.clientId)}/${content.id}`, search: `?data=${content.publishOn}` }}
                        state={location.state}
                      >
                        <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="awaiting-client__cover" />
                        <span className="awaiting-client__item-main">
                          <span className="awaiting-client__item-title">{content.title}</span>
                          <span className="awaiting-client__item-meta">{subtitleOf(content)}</span>
                        </span>
                        <span className="awaiting-client__item-end">
                          {content.daysLate !== null
                            ? <LateBadge>{lateLabel(content.daysLate)}</LateBadge>
                            : <StatusTag status="waiting">Aguardando aprovação</StatusTag>}
                        </span>
                      </Link>
                    </li>)}
                  </ul>
                </li>;
              })}
            </ul>
            {truncated && <p className="awaiting-client__more">Mostrando os {total} mais antigos.</p>}
          </>}
  </section>;
}

const scheduledHint = (count: number, lastPublishOn: string | null): string => {
  if (count === 0 || lastPublishOn === null) return 'nada programado ainda';
  return `${count === 1 ? 'programado' : 'programados'} até dia ${Number(lastPublishOn.slice(8, 10))}`;
};

const approvedHint = (thisMonth: number, lastMonth: number, month: string): string => {
  const diff = thisMonth - lastMonth;
  if (diff === 0) return `igual a ${month}`;
  return `${Math.abs(diff)} a ${diff > 0 ? 'mais' : 'menos'} que em ${month}`;
};

/**
 * The four blocks of the Início, each one a colour and one way forward (decision 2026-11-11): "Esperando" and "Atrasados" lead to the
 * list below; "Aprovados no mês" (with the month before) and "Agendados" ("programados até dia N", never "saem sozinhos") lead to
 * the calendar. Nothing is said before the counters answer, and a failure is never read as a zero.
 */
export function AwaitingSummary({ agencyId }: { agencyId: string }) {
  const location = useLocation();
  const summary = useContentSummary(agencyId);

  if (summary.isPending) return <div className="home-summary home-summary--loading" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>;
  if (summary.data === undefined) {
    return <EmptyState
      kind="failure"
      mascot
      title="Não foi possível carregar o resumo"
      description="Os números não responderam. Isso não quer dizer que está tudo zerado."
      onRetry={() => { void summary.refetch(); }}
      retrying={summary.isFetching}
    />;
  }

  const { awaitingClient, overdueAwaitingClient, approvedThisMonth, approvedLastMonth, scheduled } = summary.data.data;
  const month = previousMonthName(todayInSaoPaulo());
  const calendar = (estado: string) => ({ pathname: `/agencia/${agencyId}/conteudos`, search: `?estado=${estado}` });

  return <ul className="home-summary" aria-label="Resumo da semana">
    <li className="home-summary__item">
      <a className="home-summary__card home-summary__card--violet" href="#parado" data-stage-host>
        <Stage3D src="/3d/clock.png" tone="violet" size="lg" breakout />
        <span className="home-summary__label">Esperando<span className="home-summary__label-rest"> o cliente</span></span>
        <span className="home-summary__body">
          <span className="home-summary__number">{awaitingClient}</span>
          <span className="home-summary__hint">{awaitingClient === 1 ? 'post aguardando aprovação' : 'posts aguardando aprovação'}</span>
        </span>
        <span className="home-summary__action">Ver quem está parado<ArrowRight aria-hidden="true" /></span>
      </a>
    </li>
    <li className="home-summary__item">
      <a className="home-summary__card home-summary__card--red" href="#parado" data-stage-host>
        <Stage3D src="/3d/flag.png" tone="red" size="lg" breakout />
        <span className="home-summary__label">Atrasados</span>
        <span className="home-summary__body">
          <span className="home-summary__number">{overdueAwaitingClient}</span>
          <span className="home-summary__hint">a data passou sem aprovação</span>
        </span>
        <span className="home-summary__action">Cobrar o cliente<ArrowRight aria-hidden="true" /></span>
      </a>
    </li>
    <li className="home-summary__item">
      <Link className="home-summary__card home-summary__card--teal" to={calendar('aprovado')} state={location.state} data-stage-host>
        <Stage3D src="/3d/thumb-up.png" tone="teal" size="lg" breakout />
        <span className="home-summary__label">Aprovados<span className="home-summary__label-rest"> no mês</span></span>
        <span className="home-summary__body">
          <span className="home-summary__number">{approvedThisMonth}</span>
          <span className="home-summary__hint">{approvedHint(approvedThisMonth, approvedLastMonth, month)}</span>
        </span>
        <span className="home-summary__action">Agendar os aprovados<ArrowRight aria-hidden="true" /></span>
      </Link>
    </li>
    <li className="home-summary__item">
      <Link className="home-summary__card home-summary__card--sky" to={calendar('agendado')} state={location.state} data-stage-host>
        <Stage3D src="/3d/calender.png" tone="sky" size="lg" breakout />
        <span className="home-summary__label">Agendados</span>
        <span className="home-summary__body">
          <span className="home-summary__number">{scheduled.count}</span>
          <span className="home-summary__hint">{scheduledHint(scheduled.count, scheduled.lastPublishOn)}</span>
        </span>
        <span className="home-summary__action">Abrir o calendário<ArrowRight aria-hidden="true" /></span>
      </Link>
    </li>
  </ul>;
}
