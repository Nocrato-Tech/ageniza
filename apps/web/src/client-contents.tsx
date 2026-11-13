import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Check, Hourglass, PenLine, Send, TriangleAlert } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { ContentPeriodResponseSchema, type ContentFormat, type ContentListItem, type ContentPeriodResponse } from '@ageniza/contracts';
import { AvatarGroup, Button, ButtonLink, Chip, EmptyState, LateBadge, Pill, Skeleton, StatusTag } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import { useClientDetail } from './client-detail.js';
import { contentsAddress } from './content-address.js';
import { daysBetween, dayOfMonthLabel, monthPeriod, saoPauloClock, shortDayLabel, todayInSaoPaulo } from './content-dates.js';
import { ContentCover } from './content-cover.js';
import { CARD_FORMAT_LABELS, DISPLAY_LABELS, DISPLAY_TAGS, displayState, type DisplayState } from './content-labels.js';
import { useApiClient } from './http.js';
import { portalEntryAddress, portalShareMessage, whatsappShareUrl } from './portal-access-share.js';

/** How many "em produção" rows show before "ver todos": the group is the biggest one and the least urgent. */
const PRODUCTION_PREVIEW = 2;

const monthFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });

export const clientMonthContentsKey = (agencyId: string, clientId: string, from: string, to: string) =>
  ['agency', agencyId, 'contents', clientId, from, to] as const;

/** The contents of the client planned in the current month (São Paulo), read once for the header and the tab. */
export const useClientMonthContents = (clientId: string, enabled: boolean) => {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const period = monthPeriod(todayInSaoPaulo());
  return useQuery({
    queryKey: clientMonthContentsKey(agency.agencyId, clientId, period.from, period.to),
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/clients/:clientId/contents', { agencyId: agency.agencyId, clientId })}?from=${period.from}&to=${period.to}`,
      response: ContentPeriodResponseSchema,
      signal
    }),
    enabled
  });
};

/** The query of the calendar or of the folders on the tab address: an old bookmark, which routes.tsx sends on before the list is read. */
export const hasLegacyContentsQuery = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return ['visao', 'data', 'vista'].some((key) => params.has(key));
};

/** "16 conteúdos em novembro · 2 esperando o cliente": the count is the tab's (the API's), the second part is read from the list. */
export const contentsMetaLine = (count: number | undefined, period: ContentPeriodResponse | undefined): string | null => {
  if (count === undefined) return null;
  const month = monthFormatter.format(new Date());
  const head = `${count} ${count === 1 ? 'conteúdo' : 'conteúdos'} em ${month}`;
  const waiting = period?.data.contents.filter((content) => content.status === 'awaiting_approval').length ?? 0;
  return waiting > 0 ? `${head} · ${waiting} esperando o cliente` : head;
};

type Grouping = 'acao' | 'data' | 'formato';

const GROUPINGS: readonly { readonly value: Grouping; readonly label: string }[] = [
  { value: 'acao', label: 'Por quem precisa agir' },
  { value: 'data', label: 'Por data' },
  { value: 'formato', label: 'Por formato' }
];

const parseGrouping = (raw: string | null): Grouping => (raw === 'data' || raw === 'formato' ? raw : 'acao');

interface Group {
  readonly key: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly items: readonly Item[];
}

interface Item {
  readonly content: ContentListItem;
  readonly state: DisplayState;
}

const ACTION_GROUPS: readonly { readonly key: string; readonly title: string; readonly icon: ReactNode; readonly states: readonly DisplayState[] }[] = [
  { key: 'waiting', title: 'Esperando o cliente', icon: <Hourglass />, states: ['awaiting_approval'] },
  { key: 'late', title: 'Atrasado', icon: <TriangleAlert />, states: ['late'] },
  { key: 'production', title: 'Em produção', icon: <PenLine />, states: ['in_production', 'adjusting'] },
  { key: 'approved', title: 'Aprovado e agendado', icon: <CalendarClock />, states: ['approved', 'scheduled'] },
  { key: 'published', title: 'Publicado', icon: <Check />, states: ['published'] }
];

const FORMAT_ORDER: readonly ContentFormat[] = ['carousel', 'reels', 'image', 'long_video', 'vsl'];

const groupsOf = (items: readonly Item[], grouping: Grouping): readonly Group[] => {
  if (grouping === 'data') {
    const days = [...new Set(items.map((item) => item.content.publishOn))];
    return days.map((day) => ({ key: day, title: dayOfMonthLabel(day), icon: <CalendarClock />, items: items.filter((item) => item.content.publishOn === day) }));
  }
  if (grouping === 'formato') {
    return FORMAT_ORDER
      .map((format) => ({ key: format, title: CARD_FORMAT_LABELS[format], icon: <PenLine />, items: items.filter((item) => item.content.format === format) }))
      .filter((group) => group.items.length > 0);
  }
  return ACTION_GROUPS
    .map((group) => ({ key: group.key, title: group.title, icon: group.icon, items: items.filter((item) => group.states.includes(item.state)) }))
    .filter((group) => group.items.length > 0);
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "hoje, 18h", "17 nov": the day from the text, the hour when the content has one. */
const whenLabel = (content: ContentListItem, today: string): string => {
  const day = content.publishOn === today ? 'hoje' : shortDayLabel(content.publishOn);
  if (content.publishAtTime === null) return day;
  const minutes = content.publishAtTime.slice(3, 5);
  return `${day}, ${content.publishAtTime.slice(0, 2)}h${minutes === '00' ? '' : minutes}`;
};

/** "enviado há 2 dias": counted in São Paulo days between the send and today. */
const sentLabel = (sentAt: string, today: string): string => {
  const days = daysBetween(todayInSaoPaulo(new Date(sentAt)), today);
  if (days <= 0) return 'enviado hoje';
  return `enviado há ${plural(days, 'dia', 'dias')}`;
};

function ContentRow({ item, today, href, state }: { item: Item; today: string; href: { pathname: string; search: string }; state: unknown }) {
  const { content } = item;
  const late = item.state === 'late';
  const sub = late
    ? `${CARD_FORMAT_LABELS[content.format]} · deveria ter saído em ${shortDayLabel(content.publishOn)}`
    : `${CARD_FORMAT_LABELS[content.format]} · ${whenLabel(content, today)}${content.status === 'awaiting_approval' && content.approval !== null ? ` · ${sentLabel(content.approval.sentAt, today)}` : ''}`;
  return <li>
    <Link className="client-contents__row" to={href} state={state}>
      <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="client-contents__cover" />
      <span className="client-contents__main">
        <span className="client-contents__title">{content.title}</span>
        <span className="client-contents__sub">{sub}</span>
      </span>
      <span className="client-contents__end">
        {content.owner !== null && <AvatarGroup label="Responsável" people={[{ name: content.owner.name }]} />}
        {late
          ? <LateBadge>Atrasado {plural(daysBetween(content.publishOn, today), 'dia', 'dias')}</LateBadge>
          : <StatusTag status={DISPLAY_TAGS[item.state as Exclude<DisplayState, 'late'>]}>{DISPLAY_LABELS[item.state]}</StatusTag>}
      </span>
    </Link>
  </li>;
}

/**
 * The Conteúdos tab of the profile (decision 2026-11-11): the month's contents of the client as a list grouped by who has to act, by date or
 * by format. It is not a calendar: it reads the same period route, and every row opens the same content at the calendar's one address.
 */
export function ClientContentsTab() {
  const client = useClientDetail();
  const agency = useAgencyContext();
  const location = useLocation();
  const canSeeAccess = useCan('cliente.convidar_usuario');
  const [searchParams, setSearchParams] = useSearchParams();
  const [showAllProduction, setShowAllProduction] = useState(false);
  const contents = useClientMonthContents(client.id, true);
  const grouping = parseGrouping(searchParams.get('agrupar'));
  const now = saoPauloClock();
  const address = contentsAddress(agency.agencyId, client.id);

  if (contents.isPending && contents.errorUpdateCount === 0) {
    return <div className="client-contents__skeleton" aria-busy="true"><Skeleton /><Skeleton /><Skeleton /></div>;
  }
  if (contents.data === undefined) {
    return <EmptyState kind="failure" headingLevel={2} title="Não foi possível carregar os conteúdos. Tente de novo." retrying={contents.isFetching} onRetry={() => { void contents.refetch(); }} />;
  }

  const items: readonly Item[] = [...contents.data.data.contents]
    .filter((content) => content.status !== 'cancelled')
    .sort((a, b) => a.publishOn.localeCompare(b.publishOn) || (a.publishAtTime ?? '24').localeCompare(b.publishAtTime ?? '24'))
    .map((content) => ({ content, state: displayState(content, now) }));
  const month = monthFormatter.format(new Date());

  if (items.length === 0) {
    return <EmptyState title={`Nenhum conteúdo em ${month}`} description="Os conteúdos do cliente planejados para este mês aparecem aqui, agrupados pelo que precisa de quem." />;
  }

  const choose = (value: Grouping): void => {
    const next = new URLSearchParams(searchParams);
    if (value === 'acao') next.delete('agrupar'); else next.set('agrupar', value);
    setSearchParams(next, { replace: true, state: location.state });
  };
  const groups = groupsOf(items, grouping);

  return <div className="client-contents">
    <div className="client-contents__filters" role="group" aria-label="Agrupar">
      {GROUPINGS.map((option) => <Chip key={option.value} selected={grouping === option.value} onClick={() => choose(option.value)}>{option.label}</Chip>)}
    </div>
    {groups.map((group) => {
      const collapsed = grouping === 'acao' && group.key === 'production' && !showAllProduction && group.items.length > PRODUCTION_PREVIEW;
      const shown = collapsed ? group.items.slice(0, PRODUCTION_PREVIEW) : group.items;
      const headingId = `client-contents-${group.key}`;
      return <section key={group.key} className="client-contents__group" aria-labelledby={headingId}>
        <div className="client-contents__group-head">
          <div className="client-contents__group-title">
            <h2 id={headingId}>{group.title}</h2>
            <Pill icon={group.icon}>{group.items.length}</Pill>
          </div>
          {grouping === 'acao' && group.key === 'waiting' && canSeeAccess && client.status === 'active' && <ButtonLink
            variant="ghost"
            size="sm"
            leadingIcon={<Send />}
            href={whatsappShareUrl(portalShareMessage({ agencyName: agency.agencyName, clientName: client.name, personName: null, address: portalEntryAddress() }))}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Reenviar o link para ${client.name} (abre em nova aba)`}
          >Reenviar o link</ButtonLink>}
        </div>
        <ul className="client-contents__rows">
          {shown.map((item) => <ContentRow key={item.content.id} item={item} today={now.day} state={location.state} href={{ pathname: `${address}/${item.content.id}`, search: `?data=${item.content.publishOn}` }} />)}
        </ul>
        {collapsed && <p className="client-contents__more">+ {group.items.length - PRODUCTION_PREVIEW} em produção · <Button variant="ghost" size="sm" onClick={() => setShowAllProduction(true)}>ver todos</Button></p>}
      </section>;
    })}
    <p className="client-contents__note">Mostrando os conteúdos de {month}. Para outros períodos, abra o Calendário Editorial.</p>
  </div>;
}
