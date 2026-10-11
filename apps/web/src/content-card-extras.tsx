import { useQuery } from '@tanstack/react-query';

import { ContentDetailSchema } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { formatAgencyDayMonth } from './client-detail.js';
import { useApiClient } from './http.js';

const CAPTION_EXCERPT_LENGTH = 140;

const captionExcerpt = (caption: string | null): string => {
  if (caption === null) return 'Sem legenda';
  const letters = Array.from(caption.replace(/\s+/g, ' ').trim());
  return letters.length <= CAPTION_EXCERPT_LENGTH ? letters.join('') : `${letters.slice(0, CAPTION_EXCERPT_LENGTH).join('')}…`;
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * What the calendar card cannot hold (`specs/conteudo.md` section 7): the start of the caption, the subtasks
 * and the conversation. It reads the content only while someone is pointing at it, once per content.
 */
export function ContentHoverDetail({ id, clientId, contentId }: { id: string; clientId: string; contentId: string }) {
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

  if (detail.isPending) return <div role="tooltip" id={id} className="content-card__detail"><p>Carregando detalhes…</p></div>;
  if (detail.isError) return <div role="tooltip" id={id} className="content-card__detail"><p>Não foi possível carregar os detalhes.</p></div>;

  const { caption, tasks, conversation } = detail.data;
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

  return <div role="tooltip" id={id} className="content-card__detail">
    <dl>
      <dt>Legenda</dt><dd>{captionExcerpt(caption)}</dd>
      <dt>Subtarefas</dt><dd>{subtasks}</dd>
      <dt>Conversa</dt><dd>{comments}</dd>
    </dl>
  </div>;
}
