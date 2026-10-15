import type { ReactNode } from 'react';
import { CalendarDays } from 'lucide-react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { ContentDetailSchema, ThreadListResponseSchema, type ContentListItem, type ConversationSide, type ThreadListResponse } from '@ageniza/contracts';
import { FormatTag, StatusTag } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { formatAgencyDayMonth } from './client-detail.js';
import { ContentCover } from './content-cover.js';
import { dayMonthNameLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES, PLATFORM_LABELS, STATUS_LABELS, STATUS_TAGS } from './content-labels.js';
import { useApiClient } from './http.js';

const CAPTION_EXCERPT_LENGTH = 140;

const captionExcerpt = (caption: string | null): string => {
  if (caption === null) return 'Sem legenda';
  const letters = Array.from(caption.replace(/\s+/g, ' ').trim());
  return letters.length <= CAPTION_EXCERPT_LENGTH ? letters.join('') : `${letters.slice(0, CAPTION_EXCERPT_LENGTH).join('')}…`;
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

const SIDE_LABELS: Readonly<Record<ConversationSide, string>> = { agency: 'Agência', client: 'Cliente' };

type LastMessage = UseQueryResult<ThreadListResponse>;

/** The last message of the conversation, as text: who wrote, what, and the day in São Paulo. Nothing when the list is empty. */
const lastMessageRow = (query: LastMessage): ReactNode => {
  if (query.isError) return <><dt>Última mensagem</dt><dd>Não foi possível carregar a última mensagem.</dd></>;
  if (query.data === undefined) return <><dt>Última mensagem</dt><dd>Carregando…</dd></>;
  const last = query.data.data[0]?.lastComment;
  if (last === undefined) return null;
  return <><dt>Última mensagem</dt><dd>{SIDE_LABELS[last.side]}: “{last.excerpt}” · {formatAgencyDayMonth(last.at)}</dd></>;
};

/**
 * The floating card of a calendar card (`specs/conteudo.md` section 7): what the card is too small to hold. The
 * cover, the title, the day, the tags and the hint come from the list; the caption, the subtasks and the conversation are
 * read only while the card is open, once per content.
 */
export function ContentHoverCard({ content, clientId, movable }: { content: ContentListItem; clientId: string; movable: boolean }) {
  return <div className="content-hover">
    <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="content-hover__cover" bare={content.thumbnailAssetId === null} />
    <p className="content-hover__title">{`${FORMAT_LABELS[content.format]}: ${content.title}`}</p>
    <p className="content-hover__when">
      <span className="ui-icon" aria-hidden="true"><CalendarDays /></span>
      <span>{dayMonthNameLabel(content.publishOn)} · {PLATFORM_LABELS[content.platform]}{content.publishAtTime === null ? '' : ` · ${content.publishAtTime}`}</span>
    </p>
    <ContentHoverDetail clientId={clientId} contentId={content.id} />
    <ul className="content-hover__tags">
      <li><FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag></li>
      <li><StatusTag status={STATUS_TAGS[content.status]}>{STATUS_LABELS[content.status]}</StatusTag></li>
    </ul>
    {movable && <p className="content-hover__hint">Arraste para outro dia</p>}
  </div>;
}

function ContentHoverDetail({ clientId, contentId }: { clientId: string; contentId: string }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const detail = useQuery({
    queryKey: ['agency', agency.agencyId, 'contents', clientId, 'detail', contentId],
    queryFn: ({ signal }) => httpClient.request({
      path: apiPath('/agencies/:agencyId/clients/:clientId/contents/:contentId', { agencyId: agency.agencyId, clientId, contentId }),
      response: ContentDetailSchema,
      signal
    })
  });

  // The text of the last message is in the conversation route (#259), asked only for a content that has comments.
  const lastMessage = useQuery({
    queryKey: ['agency', agency.agencyId, 'contents', clientId, 'last-message', contentId],
    queryFn: ({ signal }) => httpClient.request({
      path: `${apiPath('/agencies/:agencyId/clients/:clientId/threads', { agencyId: agency.agencyId, clientId })}?contentId=${encodeURIComponent(contentId)}`,
      response: ThreadListResponseSchema,
      signal
    }),
    enabled: detail.data !== undefined && detail.data.conversation.commentCount > 0
  });

  if (detail.isPending) return <p className="content-hover__note">Carregando detalhes…</p>;
  if (detail.isError) return <p className="content-hover__note">Não foi possível carregar os detalhes.</p>;

  const { caption, owner, tasks, conversation } = detail.data;
  const delivered = tasks.filter((task) => task.status === 'delivered').length;
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const approved = tasks.length - delivered - pending;
  const subtasks = tasks.length === 0
    ? 'Sem subtarefas'
    : [
      `${approved} de ${tasks.length} aprovadas`,
      delivered > 0 ? `${delivered} ${plural(delivered, 'entregue', 'entregues')}` : null,
      pending > 0 ? `${pending} ${plural(pending, 'pendente', 'pendentes')}` : null
    ].filter((part) => part !== null).join(' · ');
  const comments = conversation.commentCount === 0
    ? 'Sem comentários'
    : `${conversation.commentCount} ${plural(conversation.commentCount, 'comentário', 'comentários')}${conversation.lastCommentAt === null ? '' : ` · último em ${formatAgencyDayMonth(conversation.lastCommentAt)}`}`;

  return <dl className="content-hover__detail">
    <dt>Legenda</dt><dd>{captionExcerpt(caption)}</dd>
    {owner !== null && <><dt>Responsável</dt><dd>{owner.name}</dd></>}
    <dt>Subtarefas</dt><dd>{subtasks}</dd>
    <dt>Conversa</dt><dd>{comments}</dd>
    {conversation.commentCount > 0 && lastMessageRow(lastMessage)}
  </dl>;
}
