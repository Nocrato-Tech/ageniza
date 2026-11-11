import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import {
  PortalContentAwaitingResponseSchema,
  PortalContentPeriodResponseSchema,
  type PortalContentListItem,
  type PortalContentOpenListItem
} from '@ageniza/contracts';
import { ButtonLink, EmptyState, FormatTag, Realce, Skeleton, StatusTag } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { ApprovalRound } from './approval-deadline.js';
import { addDays, dayMonthLabel, startOfWeek, todayInSaoPaulo, weekdayShortLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { useAuthSession, useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { usePortalClient } from './portal.js';
import { PortalContentCover } from './portal-content-cover.js';
import { PortalFailure } from './portal-failure.js';
import { PortalMaterialRequests } from './portal-material-requests.js';
import { PORTAL_STATUS_LABELS, PORTAL_STATUS_TAGS, portalPostAddress } from './portal-status.js';
import { PortalTodayScripts } from './portal-story-scripts.js';

const LIST_PATH = '/clients/:clientId/contents';
const AWAITING_PATH = '/clients/:clientId/contents/awaiting-approval';

/** Two covers are what a phone shows side by side; the rest of what waits is one tap away, in Conteúdos. */
const AWAITING_COVERS = 2;
const WEEK_ROWS = 5;

const dayLabel = (day: string): string => `${weekdayShortLabel(day)}, ${dayMonthLabel(day)}`;

const coverOf = (content: PortalContentListItem): string | null => (content.status === 'in_production' ? null : content.thumbnailAssetId);

/** What waits for the person: the number the API counted, the nearest covers, and the one action that leads to them. */
function PortalAwaiting({ clientId, count }: { clientId: string; count: number }) {
  const httpClient = useApiClient();
  const covers = useQuery({
    queryKey: ['portal', clientId, 'contents', 'awaiting', 'home'],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(AWAITING_PATH, { clientId })}?pageSize=${AWAITING_COVERS}`,
      response: PortalContentAwaitingResponseSchema,
      signal
    })
  });

  return <section className="portal-section portal-home__awaiting" aria-labelledby="portal-home-awaiting-title">
    <h2 id="portal-home-awaiting-title" className="portal-headline"><Realce>{count} {count === 1 ? 'post' : 'posts'}</Realce> esperando sua aprovação</h2>
    {covers.isPending
      ? <div className="portal-covers" aria-hidden="true"><Skeleton className="portal-covers__skeleton" /><Skeleton className="portal-covers__skeleton" /></div>
      : covers.isError && covers.data === undefined
        ? <PortalFailure title="Não foi possível carregar os posts." fetching={covers.isFetching} onRetry={() => { void covers.refetch(); }} />
        : <ul className="portal-covers">
          {covers.data!.data.map((content: PortalContentOpenListItem) => <li key={content.id}>
            <Link className="portal-cover-link" to={portalPostAddress(clientId, content.id)}>
              <PortalContentCover clientId={clientId} contentId={content.id} assetId={content.thumbnailAssetId} format={content.format} className="portal-cover" />
              <span className="portal-cover-link__title">{content.title}</span>
              <span className="portal-meta">
                <FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag>
                <span>{dayLabel(content.publishOn)}</span>
              </span>
              <ApprovalRound approval={content.approval} showNote={false} />
            </Link>
          </li>)}
        </ul>}
    <ButtonLink className="portal-action" as={Link} to={`/portal/${clientId}/conteudos`} size="lg" trailingIcon={<ArrowRight />}>
      {count === 1 ? 'Revisar o post' : `Revisar os ${count} posts`}
    </ButtonLink>
  </section>;
}

/** The count of the Início answered and is zero: nothing is waiting for the person's decision. It says nothing about a request for material, which has its own block. */
function PortalNothingToApprove() {
  return <EmptyState
    kind="good-news"
    className="portal-empty"
    headingLevel={2}
    title="Nada para aprovar"
    description="Quando a agência enviar um post para aprovação, ele aparece aqui."
  />;
}

/** Nothing waits for the person: the next thing is the answer of the agency, or the study of the brand. */
function PortalNextAction({ clientId, answered }: { clientId: string; answered: number }) {
  const text = answered > 0
    ? `A agência respondeu ${answered} ${answered === 1 ? 'sugestão sua' : 'sugestões suas'}`
    : 'Conheça o estudo da sua marca';
  return <Link className="portal-next" to={`/portal/${clientId}/marca`}>
    <span className="portal-next__text">{text}</span>
    <span className="portal-next__link">ver<ChevronRight aria-hidden="true" /></span>
  </Link>;
}

/** The week of the person, Monday to Sunday: what is planned, with its state in words, and what already moved. */
function PortalWeek({ clientId }: { clientId: string }) {
  const httpClient = useApiClient();
  const from = startOfWeek(todayInSaoPaulo());
  const to = addDays(from, 6);
  const week = useQuery({
    queryKey: ['portal', clientId, 'contents', 'period', from, to],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(LIST_PATH, { clientId })}?from=${from}&to=${to}`,
      response: PortalContentPeriodResponseSchema,
      signal
    })
  });

  // What waits for the person is already above, with its own action.
  const rows = (week.data?.data ?? []).filter((content) => content.status !== 'awaiting_approval');
  const shown = rows.slice(0, WEEK_ROWS);

  return <section className="portal-section portal-home__week" aria-labelledby="portal-home-week-title">
    <h2 id="portal-home-week-title" className="portal-section__title">Nesta semana</h2>
    {week.isPending
      ? <div className="portal-rows__skeleton" aria-hidden="true"><Skeleton /><Skeleton /></div>
      : week.isError && week.data === undefined
        ? <PortalFailure title="Não foi possível carregar a semana." fetching={week.isFetching} onRetry={() => { void week.refetch(); }} />
        : shown.length === 0
          ? week.data!.data.length > 0
            ? <EmptyState
              className="portal-empty"
              headingLevel={3}
              title="Os posts desta semana esperam sua aprovação"
              description="Eles estão no alto desta tela."
            />
            : <EmptyState
              mascot
              className="portal-empty"
              headingLevel={3}
              title="Nenhum post planejado para esta semana"
              description="Quando a agência planejar, os posts aparecem aqui."
              action={<ButtonLink as={Link} to={`/portal/${clientId}/conteudos`} variant="secondary">Ver o mês</ButtonLink>}
            />
          : <>
            <ul className="portal-rows">
              {shown.map((content) => <li key={content.id}>
                <Link className="portal-row" to={portalPostAddress(clientId, content.id)}>
                  <PortalContentCover clientId={clientId} contentId={content.id} assetId={coverOf(content)} format={content.format} className="portal-row__cover" />
                  <span className="portal-row__text">
                    <span className="portal-row__title">{content.title}</span>
                    <span className="portal-meta">
                      <StatusTag status={PORTAL_STATUS_TAGS[content.status]}>{PORTAL_STATUS_LABELS[content.status]}</StatusTag>
                      <span>{dayLabel(content.publishOn)}</span>
                    </span>
                  </span>
                  <ChevronRight className="portal-row__go" aria-hidden="true" />
                </Link>
              </li>)}
            </ul>
            {rows.length > shown.length && <Link className="portal-more" to={`/portal/${clientId}/conteudos`}>Ver todos os conteúdos</Link>}
          </>}
  </section>;
}

/**
 * The Início (specs/clientes.md §7, issues #141 and #271): greeting by the person's name, what the agency asked for (not there
 * when nothing is open), and one next action — the contents waiting for the client's approval when there are any, otherwise
 * "Nada para aprovar" and the agency's answer or the brand study — then the story script of today, which is not there when the
 * agency sent none, and the week.
 */
export function PortalHomePage() {
  const client = usePortalClient();
  const { clienteId = '' } = useParams();
  const session = useAuthSession(useAuthSessionStore());
  useDocumentTitle('Início — Portal do cliente — Ageniza');

  const awaiting = client.home.contentsAwaitingApproval;

  return <section className="portal-home" aria-labelledby="portal-home-title">
    <h1 id="portal-home-title" className="portal-home__greeting">Olá, {session.user?.name ?? ''}</h1>
    <div className="portal-home__main">
      <PortalMaterialRequests clientId={clienteId} />
      {awaiting > 0
        ? <PortalAwaiting clientId={clienteId} count={awaiting} />
        : <>
          <PortalNothingToApprove />
          <PortalNextAction clientId={clienteId} answered={client.home.threadsAnsweredByAgency} />
        </>}
      <PortalTodayScripts clientId={clienteId} />
    </div>
    <PortalWeek clientId={clienteId} />
  </section>;
}
