import type { ContentDetail, ContentFormat, PortalContentApproval } from '@ageniza/contracts';

import { useAgencyContext } from './agency.js';
import { ApprovalRound } from './approval-deadline.js';
import { hasCover } from './content-form.js';
import { ContentCover } from './content-cover.js';
import { PostMeta, STATE_NOTES, type PostMetaContent } from './portal-content.js';

/** From "aguardando aprovação" on, the portal also shows the media and the caption. */
interface OpenView {
  readonly caption: string | null;
  readonly shownAssetId: string | null;
  readonly mediaCount: number;
}

/**
 * Only what the portal answers for the content (`PortalContentDetail`): the title, the day and the format, and from "aguardando aprovação" on the
 * time, the media, the caption, the day it was published and the round (until when, and the agency's note). Subtasks, the person in charge,
 * the internal deadline and the agency's conversation are not copied into the view, so nothing below can show them.
 */
export interface ClientView {
  readonly meta: PostMetaContent;
  readonly title: string;
  readonly format: ContentFormat;
  readonly approval: PortalContentApproval | null;
  readonly open: OpenView | null;
}

/** A cancelled content is not in the portal at all. */
export const clientViewOf = (content: ContentDetail): ClientView | null => {
  if (content.status === 'cancelled') return null;
  const { title, format } = content;
  if (content.status === 'in_production') {
    return { meta: { id: content.id, title, format, publishOn: content.publishOn, status: 'in_production' }, title, format, approval: null, open: null };
  }
  const first = [...content.media].sort((left, right) => left.position - right.position)[0]?.id ?? null;
  return {
    meta: { status: content.status, format, publishOn: content.publishOn, publishAtTime: content.publishAtTime, publishedOn: content.publishedOn },
    title,
    format,
    approval: content.approval === null ? null : { dueOn: content.approval.dueOn, note: content.approval.note },
    open: { caption: content.caption, shownAssetId: hasCover(format) ? (content.coverAssetId ?? first) : first, mediaCount: content.media.length }
  };
};

/**
 * "Como o cliente vê": a preview, on the agency's screen, of how the content is in the portal in the state it is now. It is not the portal:
 * the media comes from the agency's own route, and nothing here asks the portal for anything. The meta line, the notes of each state and the
 * round are the portal's own parts, so the two cannot say different things.
 */
export function ContentClientView({ content }: { content: ContentDetail }) {
  const agency = useAgencyContext();
  const view = clientViewOf(content);
  if (view === null) {
    return <p className="form-hint" role="note">Este conteúdo foi cancelado: o cliente não o vê no portal.</p>;
  }
  const { open, meta } = view;
  const caption = open?.caption?.trim() ?? '';
  const stateNote = STATE_NOTES[meta.status];
  return <section className="client-view" aria-label="Como o cliente vê">
    <p className="form-hint" role="note">
      Prévia do conteúdo como o portal o mostra agora. Fica de fora para o cliente: subtarefas, responsável, prazo interno e a conversa da agência durante a produção.
    </p>
    <article className="client-view__post">
      <h3 className="client-view__title">{view.title}</h3>
      <PostMeta content={meta} />
      {open === null
        ? <p className="portal-post__hint">Em produção, o cliente vê só o título, o dia e o formato. A mídia e a legenda aparecem quando o conteúdo é enviado para aprovação.</p>
        : <>
          {stateNote !== undefined && <p className="portal-post__hint">{stateNote}</p>}
          {meta.status === 'awaiting_approval' && <ApprovalRound approval={view.approval} agencyName={agency.agencyName} />}
          {open.mediaCount === 0
            ? <p className="portal-post__hint">Este conteúdo ainda não tem mídia.</p>
            : <ContentCover assetId={open.shownAssetId} format={view.format} className="content-preview__media" />}
          {open.mediaCount > 1 && <p className="portal-post__hint">{open.mediaCount} mídias, que o cliente passa uma a uma.</p>}
          {caption === '' ? <p className="portal-post__hint">Este post não tem legenda.</p> : <p className="portal-post__caption">{caption}</p>}
          {meta.status === 'awaiting_approval' && <p className="portal-post__hint">O cliente pode aprovar ou pedir ajuste.</p>}
        </>}
    </article>
  </section>;
}
