import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCheck, ChevronRight, Clock, TriangleAlert } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import {
  CalendarDaySchema,
  PortalContentAwaitingResponseSchema,
  PortalContentProgressResponseSchema,
  type PortalContentOpenListItem,
  type PortalContentProgressResponse
} from '@ageniza/contracts';
import { ButtonLink, EmptyState, LateBadge, Mascot, ProgressBar, Realce, Skeleton, StatusTag } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { dayOfMonthLabel, daysBetween, saoPauloClock, shortDayLabel, startOfWeek, todayInSaoPaulo } from './content-dates.js';
import { useAuthSession, useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { PortalStageEmpty, usePortalClient } from './portal.js';
import { PortalContentCover } from './portal-content-cover.js';
import { PortalMaterialRequests } from './portal-material-requests.js';
import { portalPostAddress } from './portal-status.js';
import { PortalTodayScripts } from './portal-story-scripts.js';

const AWAITING_PATH = '/clients/:clientId/contents/awaiting-approval';
const PROGRESS_PATH = '/clients/:clientId/contents/progress';

/** Three covers are what the board shows; the rest of what waits is one tap away, in Conteúdos. */
const AWAITING_COVERS = 3;

const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'] as const;

/** The weekday of a day from its text, never from a `Date`: the week of the calendar starts on Sunday. */
const weekdayName = (day: string): string => WEEKDAY_NAMES[daysBetween(startOfWeek(day), day)]!;

/** "quinta, 12 nov": the day as the board words it. */
const dayLabel = (day: string): string => `${weekdayName(day)}, ${shortDayLabel(day)}`;

/** "18h" or "18h30": the hour of a São Paulo clock, from "HH:MM" or "HH:MM:SS". */
const hourLabel = (time: string): string => {
  const [hour = '', minute = '00'] = time.split(':');
  return `${Number(hour)}h${minute === '00' ? '' : minute}`;
};

const isDay = (value: string | null): value is string => value !== null && CalendarDaySchema.safeParse(value).success;

/** "Responda até quinta, 12 nov, 18h": the deadline of the round in the day and hour of São Paulo; with no hour, the day only. */
const deadlineOf = (content: PortalContentOpenListItem, today: string): { text: string; expired: boolean } | null => {
  const approval = content.approval;
  if (approval === null) return null;
  const instant = approval.dueAt === null ? null : saoPauloClock(new Date(approval.dueAt));
  const day = instant?.day ?? (isDay(approval.dueOn) ? approval.dueOn : null);
  if (day === null) return null;
  const at = `${dayLabel(day)}${instant === null ? '' : `, ${hourLabel(instant.time)}`}`;
  return day < today ? { text: `Venceu ${at}`, expired: true } : { text: `Responda até ${at}`, expired: false };
};

/** "hoje às 18h", "amanhã", "sexta, 13 nov às 12h": when the next approved post goes on air, in São Paulo. */
const whenOf = (publishOn: string, publishAtTime: string | null, today: string): string => {
  const days = daysBetween(today, publishOn);
  const day = days === 0 ? 'hoje' : days === 1 ? 'amanhã' : dayLabel(publishOn);
  return publishAtTime === null ? day : `${day} às ${hourLabel(publishAtTime)}`;
};

function AwaitingCard({ clientId, content, today }: { clientId: string; content: PortalContentOpenListItem; today: string }) {
  // "Atrasado" is the publication day that passed, which is not the deadline of the round (decision 2026-11-11).
  const late = content.publishOn < today;
  const deadline = deadlineOf(content, today);
  return <li>
    <Link className="portal-cover-link portal-postcard" to={portalPostAddress(clientId, content.id)}>
      <PortalContentCover clientId={clientId} contentId={content.id} assetId={content.thumbnailAssetId} format={content.format} className="portal-cover" />
      <span className="portal-postcard__body">
        <span className="portal-cover-link__title">{content.title}</span>
        <span className="portal-postcard__tag">
          {late ? <LateBadge /> : <StatusTag status="waiting">Aguardando você</StatusTag>}
        </span>
        {late
          ? <span className="portal-postcard__due portal-postcard__due--urgent"><TriangleAlert aria-hidden="true" />A data de publicação já passou</span>
          : deadline !== null && <span className={`portal-postcard__due${deadline.expired ? ' portal-postcard__due--urgent' : ''}`}>
            {deadline.expired ? <TriangleAlert aria-hidden="true" /> : <Clock aria-hidden="true" />}{deadline.text}
          </span>}
      </span>
    </Link>
  </li>;
}

/** What waits for the person: the number the API counted, the three nearest covers, and the one action that leads to the first of them. */
function PortalAwaiting({ clientId, count }: { clientId: string; count: number }) {
  const httpClient = useApiClient();
  const today = todayInSaoPaulo();
  const covers = useQuery({
    queryKey: ['portal', clientId, 'contents', 'awaiting', 'home'],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(AWAITING_PATH, { clientId })}?pageSize=${AWAITING_COVERS}`,
      response: PortalContentAwaitingResponseSchema,
      signal
    })
  });
  // The API answers the deadline that comes first first: the review starts there, and Conteúdos is the way while it is not known.
  const first = covers.data?.data[0];
  const reviewPath = first === undefined ? `/portal/${clientId}/conteudos` : portalPostAddress(clientId, first.id);

  return <section className="portal-hero portal-home__awaiting" aria-labelledby="portal-home-awaiting-title">
    <div className="portal-hero__text">
      <h2 id="portal-home-awaiting-title" className="portal-headline"><Realce>{count} {count === 1 ? 'post' : 'posts'}</Realce> esperando sua aprovação</h2>
      <p className="portal-hero__lede">Toque em um post para ver como vai ficar no Instagram. Aprovando, a agência é avisada e cuida da publicação.</p>
    </div>
    {covers.isPending && covers.errorUpdateCount === 0
      ? <div className="portal-covers" aria-hidden="true"><Skeleton className="portal-covers__skeleton" /><Skeleton className="portal-covers__skeleton" /><Skeleton className="portal-covers__skeleton" /></div>
      : covers.data === undefined
        ? <EmptyState kind="failure" mascot className="portal-empty" headingLevel={3} title="Não foi possível carregar os posts." retrying={covers.isFetching} onRetry={() => { void covers.refetch(); }} />
        : <ul className="portal-covers">
          {covers.data.data.map((content) => <AwaitingCard key={content.id} clientId={clientId} content={content} today={today} />)}
        </ul>}
    <div className="portal-hero__cta">
      <ButtonLink className="portal-action" as={Link} to={reviewPath} size="lg" leadingIcon={<CheckCheck />}>
        {count === 1 ? 'Revisar o post' : `Revisar os ${count} posts`}
      </ButtonLink>
      {count > 1 && <span className="portal-hero__hint">Começamos pelo que vence primeiro.</span>}
    </div>
  </section>;
}

/** The month answered with nothing in it: nothing waits for the person's decision, and there is no progress to tell. */
function PortalNothingToApprove() {
  return <PortalStageEmpty icon="thumb-up" tone="teal">
    <EmptyState
      kind="good-news"
      className="portal-empty"
      headingLevel={2}
      title="Nada para aprovar"
      description="Quando a agência enviar um post para aprovação, ele aparece aqui."
    />
  </PortalStageEmpty>;
}

function GoodNews({ clientId, progress }: { clientId: string; progress: PortalContentProgressResponse['data'] }) {
  const today = todayInSaoPaulo();
  const percent = Math.round((progress.approved / progress.total) * 100);
  const month = MONTH_NAMES[Number(progress.month.slice(5, 7)) - 1] ?? '';
  const { next } = progress;
  return <section className="portal-win" aria-labelledby="portal-home-news-title">
    <div className="portal-win__row">
      <div className="portal-win__head">
        <p className="portal-win__eyebrow">Boa notícia</p>
        <h2 id="portal-home-news-title" className="portal-win__title">Seu feed de {month} já está {percent}% aprovado</h2>
      </div>
      <Mascot variant="friendly" height={104} className="portal-win__mascot" />
    </div>
    <ProgressBar tone="teal" label={`Posts aprovados em ${month}`} value={progress.approved} max={progress.total} />
    <p className="portal-win__text">
      {progress.approved} de {progress.total} posts aprovados.
      {next !== null && <> O primeiro vai ao ar {whenOf(next.publishOn, next.publishAtTime, today)}: <strong>{next.title}</strong>.</>}
    </p>
    <Link className="portal-win__link" to={`/portal/${clientId}/conteudos?situacao=approved`}>
      Ver o que vai ao ar esta semana<ArrowRight aria-hidden="true" />
    </Link>
  </section>;
}

/** Nothing waits for the person: the month so far, told as good news. Only an answer that came says so; a failure never does. */
function PortalProgress({ clientId }: { clientId: string }) {
  const httpClient = useApiClient();
  const progress = useQuery({
    queryKey: ['portal', clientId, 'contents', 'progress'],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath(PROGRESS_PATH, { clientId }),
      response: PortalContentProgressResponseSchema,
      signal
    })
  });
  if (progress.isPending && progress.errorUpdateCount === 0) {
    return <div className="portal-win portal-win--loading" aria-hidden="true"><Skeleton className="portal-win__skeleton" /></div>;
  }
  if (progress.data === undefined) {
    return <EmptyState kind="failure" mascot className="portal-empty" headingLevel={2} title="Não foi possível carregar o andamento do mês." retrying={progress.isFetching} onRetry={() => { void progress.refetch(); }} />;
  }
  return progress.data.data.total === 0 ? <PortalNothingToApprove /> : <GoodNews clientId={clientId} progress={progress.data.data} />;
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

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The Início (specs/clientes.md §7; decision 2026-11-11, "o Início do portal segue o quadro"): the date and the greeting, what waits for
 * the client (up to three covers and the review that starts at the first) or, when nothing does, the good news of the month; then what
 * the agency asked for, which is not there when nothing is open, and the story script of today, which is not there when the agency sent
 * none (decision 2026-11-11, item 3). There is no "Nesta semana": the week is in Conteúdos.
 */
export function PortalHomePage() {
  const client = usePortalClient();
  const { clienteId = '' } = useParams();
  const session = useAuthSession(useAuthSessionStore());
  useDocumentTitle('Início — Portal do cliente — Ageniza');

  const awaiting = client.home.contentsAwaitingApproval;
  const asked = awaiting + client.home.materialRequestsOpen;
  const firstName = session.user?.name.trim().split(/\s+/)[0] ?? '';
  const today = todayInSaoPaulo();
  const answered = client.home.threadsAnsweredByAgency;

  return <section className="portal-home" aria-labelledby="portal-home-title">
    <header className="portal-home__head">
      <p className="portal-home__eyebrow">{capitalized(weekdayName(today))}, {dayOfMonthLabel(today)}</p>
      <h1 id="portal-home-title" className="portal-home__greeting">{firstName === '' ? 'Olá' : `Olá, ${firstName}`}</h1>
      {asked > 0 && <p className="portal-home__lede">
        A {client.agencyName} espera {asked} {asked === 1 ? 'resposta sua. Leva' : 'respostas suas. Cada uma leva'} menos de um minuto.
      </p>}
    </header>
    {awaiting > 0 && <PortalAwaiting clientId={clienteId} count={awaiting} />}
    <div className="portal-home__split">
      <PortalMaterialRequests clientId={clienteId} />
      {awaiting === 0 && <PortalProgress clientId={clienteId} />}
    </div>
    {awaiting === 0 && <PortalNextAction clientId={clienteId} answered={answered} />}
    <PortalTodayScripts clientId={clienteId} />
  </section>;
}
