import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  PortalContentAwaitingResponseSchema,
  PortalContentPeriodResponseSchema,
  type PortalContentListItem
} from '@ageniza/contracts';
import { Button, EmptyState, FormatTag, Select, Skeleton, StatusTag } from '@ageniza/ui';

import { apiPath } from './api-path.js';
import { dayMonthLabel, fullDayLabel, monthPeriod, parseAnchor, periodTitle, shiftAnchor, todayInSaoPaulo, weekdayShortLabel } from './content-dates.js';
import { FEED_FORMATS } from './content-feed.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { useDocumentTitle } from './document-title.js';
import { useApiClient } from './http.js';
import { PortalContentCover } from './portal-content-cover.js';
import { usePortalClient } from './portal.js';
import { PORTAL_STATUS_LABELS, PORTAL_STATUS_TAGS, portalPostAddress as postAddress, type PortalStatus } from './portal-status.js';

const LIST_PATH = '/clients/:clientId/contents';
const AWAITING_PATH = '/clients/:clientId/contents/awaiting-approval';

/** Two rows of the grid of three: what waits for the person is a few posts to look at, not a list to scroll. */
const AWAITING_PAGE_SIZE = 6;

const STATUS_FILTERS: readonly PortalStatus[] = ['approved', 'awaiting_approval', 'adjusting', 'in_production', 'published'];
const STATUS_OPTIONS = STATUS_FILTERS.map((status) => ({ value: status, label: PORTAL_STATUS_LABELS[status] }));

type Vista = 'calendar' | 'feed';

const parseVista = (raw: string | null): Vista => (raw === 'feed' ? 'feed' : 'calendar');
const parseStatus = (raw: string | null): PortalStatus | '' => STATUS_FILTERS.find((status) => status === raw) ?? '';

/** The file that serves as the cover of a content in production does not exist for the portal: the response has no such field. */
const coverOf = (content: PortalContentListItem): string | null => (content.status === 'in_production' ? null : content.thumbnailAssetId);

/** The grid of the profile, the latest first; the order inside a day is the day's own, read backwards (as in the agency feed). */
const timeOf = (content: PortalContentListItem): string => (content.status === 'in_production' ? '99:99' : content.publishAtTime ?? '99:99');

export const feedItems = (contents: readonly PortalContentListItem[]): PortalContentListItem[] => contents
  .filter((content) => FEED_FORMATS.has(content.format))
  .sort((a, b) => {
    if (a.publishOn !== b.publishOn) return a.publishOn < b.publishOn ? 1 : -1;
    if (timeOf(a) !== timeOf(b)) return timeOf(a) < timeOf(b) ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

/** What waits for the person, at the top: the covers of the contents awaiting approval, the nearest day first (the API's order). */
function Awaiting({ clientId }: { clientId: string }) {
  const httpClient = useApiClient();
  const awaiting = useQuery({
    queryKey: ['portal', clientId, 'contents', 'awaiting'],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(AWAITING_PATH, { clientId })}?pageSize=${AWAITING_PAGE_SIZE}`,
      response: PortalContentAwaitingResponseSchema,
      signal
    })
  });

  if (awaiting.isPending) return <div className="portal-awaiting" aria-hidden="true"><Skeleton className="portal-awaiting__skeleton" /></div>;
  if (awaiting.isError && awaiting.data === undefined) {
    return <section className="portal-awaiting" aria-labelledby="portal-awaiting-title">
      <h2 id="portal-awaiting-title" className="portal-section__title">O que precisa de você</h2>
      <div className="portal-error" role="alert">
        <p>Não foi possível carregar o que precisa de você.</p>
        <Button variant="secondary" loading={awaiting.isFetching} onClick={() => { void awaiting.refetch(); }}>Tentar de novo</Button>
      </div>
    </section>;
  }
  const { data, meta } = awaiting.data!;
  if (meta.totalItems === 0) return null;
  return <section className="portal-awaiting" aria-labelledby="portal-awaiting-title">
    <h2 id="portal-awaiting-title" className="portal-section__title">O que precisa de você <span>({meta.totalItems})</span></h2>
    <ul className="portal-awaiting__list">
      {data.map((content) => <li key={content.id} className="portal-awaiting__item">
        <PortalContentCover clientId={clientId} contentId={content.id} assetId={content.thumbnailAssetId} format={content.format} className="portal-awaiting__cover" />
        <p className="portal-awaiting__title"><Link className="portal-card-link" to={postAddress(clientId, content.id)}>{content.title}</Link></p>
        <p className="portal-awaiting__day">{dayMonthLabel(content.publishOn)}</p>
      </li>)}
    </ul>
    {meta.totalItems > data.length && <p className="portal-awaiting__more">Mostrando {data.length} de {meta.totalItems}</p>}
  </section>;
}

function ContentCard({ clientId, content }: { clientId: string; content: PortalContentListItem }) {
  return <article className="portal-card" data-status={content.status} data-format={FORMAT_TONES[content.format]}>
    <PortalContentCover clientId={clientId} contentId={content.id} assetId={coverOf(content)} format={content.format} className="portal-card__cover" />
    <div className="portal-card__text">
      <p className="portal-card__title"><Link className="portal-card-link" to={postAddress(clientId, content.id)}>{content.title}</Link></p>
      <p className="portal-meta">
        <FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag>
        <StatusTag status={PORTAL_STATUS_TAGS[content.status]}>{PORTAL_STATUS_LABELS[content.status]}</StatusTag>
      </p>
    </div>
  </article>;
}

/** The month as a list by day, as a phone reads it: a grid of seven columns has no room at 390 px. */
function MonthList({ clientId, contents }: { clientId: string; contents: readonly PortalContentListItem[] }) {
  const byDay = new Map<string, PortalContentListItem[]>();
  for (const content of contents) byDay.set(content.publishOn, [...(byDay.get(content.publishOn) ?? []), content]);
  return <ol className="portal-days">
    {[...byDay].map(([day, items]) => <li key={day} className="portal-day">
      <p className="portal-day__label">
        <time dateTime={day}>
          <span aria-hidden="true">{Number(day.slice(8, 10))} {weekdayShortLabel(day)}</span>
          <span className="visually-hidden">{fullDayLabel(day)}</span>
        </time>
      </p>
      <ul className="portal-day__items">
        {items.map((content) => <li key={content.id}><ContentCard clientId={clientId} content={content} /></li>)}
      </ul>
    </li>)}
  </ol>;
}

function Feed({ clientId, contents, today, handle, onBack }: { clientId: string; contents: readonly PortalContentListItem[]; today: string; handle: string | null; onBack: () => void }) {
  const items = feedItems(contents);
  if (items.length === 0) {
    return <EmptyState
      className="portal-empty"
      title="Nenhum post do feed planejado para este mês"
      description="O feed mostra imagens, carrosséis e reels. Os outros formatos estão na lista."
      action={<Button variant="secondary" onClick={onBack}>Ver a lista</Button>}
    />;
  }
  return <section className="content-feed" aria-label="Prévia do feed">
    {handle !== null && <p className="content-feed__handle">@{handle}</p>}
    <ol className="content-feed__grid">
      {items.map((content) => <li key={content.id} className="content-feed__tile" data-status={content.status}>
        <PortalContentCover clientId={clientId} contentId={content.id} assetId={coverOf(content)} format={content.format} className="content-feed__cover" />
        {content.publishOn > today && <span className="content-feed__planned">Planejado</span>}
        <span className="visually-hidden">{content.title} · {FORMAT_LABELS[content.format]} · {dayMonthLabel(content.publishOn)}</span>
      </li>)}
    </ol>
  </section>;
}

/**
 * `/portal/:clienteId/conteudos` (specs/conteudo.md section 7, issue #269): the owner of the business, on a phone, a few times a
 * week, to check what the agency planned. What waits for approval is on top, then the month, as a list by day or as the grid of
 * the feed. In production a content is its title, its day and its format, because that is all the API sends (rule 1 of the SPEC);
 * what the screen shows is what it was given. The month (`data`), the view (`vista`) and the status filter (`situacao`) are in the address, so a reload lands on the same screen.
 */
export function PortalContentsPage() {
  const httpClient = useApiClient();
  const client = usePortalClient();
  const clientId = client.id;
  const [searchParams, setSearchParams] = useSearchParams();
  useDocumentTitle('Conteúdos — Portal do cliente — Ageniza');

  const today = todayInSaoPaulo();
  const anchor = parseAnchor(searchParams.get('data'), today);
  const vista = parseVista(searchParams.get('vista'));
  const status = parseStatus(searchParams.get('situacao'));
  const period = monthPeriod(anchor);

  const contents = useQuery({
    queryKey: ['portal', clientId, 'contents', 'period', period.from, period.to],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath(LIST_PATH, { clientId })}?from=${period.from}&to=${period.to}`,
      response: PortalContentPeriodResponseSchema,
      signal
    })
  });

  const change = (name: string, value: string | null): void => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(name); else next.set(name, value);
    setSearchParams(next, { replace: true });
  };

  const shown = contents.data === undefined ? [] : status === '' || vista === 'feed' ? contents.data.data : contents.data.data.filter((content) => content.status === status);

  return <section className="portal-contents" aria-labelledby="portal-contents-title">
    <h1 id="portal-contents-title" className="portal-headline">Conteúdos</h1>
    <Awaiting clientId={clientId} />
    <div className="portal-contents__period" role="group" aria-label="Período">
      <Button variant="secondary" aria-label="Mês anterior" leadingIcon={<ChevronLeft />} onClick={() => change('data', shiftAnchor('month', anchor, -1))} />
      <h2 className="portal-contents__period-title" aria-live="polite">{periodTitle('month', anchor)}</h2>
      <Button variant="secondary" aria-label="Próximo mês" leadingIcon={<ChevronRight />} onClick={() => change('data', shiftAnchor('month', anchor, 1))} />
    </div>
    <div className="portal-contents__toggle" role="group" aria-label="Visão">
      <Button variant={vista === 'calendar' ? 'secondary' : 'ghost'} aria-pressed={vista === 'calendar'} onClick={() => change('vista', null)}>Calendário</Button>
      <Button variant={vista === 'feed' ? 'secondary' : 'ghost'} aria-pressed={vista === 'feed'} onClick={() => change('vista', 'feed')}>Feed</Button>
    </div>
    {vista === 'calendar' && <Select label="Filtro" placeholder="Todos" value={status} options={STATUS_OPTIONS} onChange={(value) => change('situacao', value === '' ? null : value)} />}
    {contents.isPending
      ? <div className="portal-contents__skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
      : contents.isError && contents.data === undefined
        ? <div className="portal-error" role="alert">
          <p>Não foi possível carregar os conteúdos. Tente de novo.</p>
          <Button variant="secondary" loading={contents.isFetching} onClick={() => { void contents.refetch(); }}>Tentar de novo</Button>
        </div>
        : contents.data!.data.length === 0
          ? <EmptyState
            mascot
            className="portal-empty"
            title="Nenhum conteúdo planejado para este mês"
            description="Quando a agência planejar, os posts aparecem aqui."
            action={anchor.slice(0, 7) === today.slice(0, 7) ? undefined : <Button variant="secondary" onClick={() => change('data', null)}>Ir para este mês</Button>}
          />
          : vista === 'feed'
            ? <Feed clientId={clientId} contents={shown} today={today} handle={client.instagramHandle} onBack={() => change('vista', null)} />
            : shown.length === 0
              ? <EmptyState
                className="portal-empty"
                title="Nenhum conteúdo nesta situação neste mês"
                action={<Button variant="secondary" onClick={() => change('situacao', null)}>Limpar o filtro</Button>}
              />
              : <MonthList clientId={clientId} contents={shown} />}
  </section>;
}
