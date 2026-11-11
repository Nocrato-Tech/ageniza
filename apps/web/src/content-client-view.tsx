import { CalendarDaySchema, type ContentDetail, type ContentFormat } from '@ageniza/contracts';
import { FormatTag, StatusTag } from '@ageniza/ui';

import { hasCover } from './content-form.js';
import { ContentCover } from './content-cover.js';
import { fullDayLabel } from './content-dates.js';
import { FORMAT_LABELS, FORMAT_TONES } from './content-labels.js';
import { PORTAL_STATUS_LABELS, PORTAL_STATUS_TAGS, type PortalStatus } from './portal-status.js';

/** From "aguardando aprovação" on, the portal also shows the time, the media, the caption and the day it was published. */
interface OpenView {
  readonly publishAtTime: string | null;
  readonly caption: string | null;
  readonly shownAssetId: string | null;
  readonly mediaCount: number;
  readonly publishedOn: string | null;
}

/** Only what the portal answers for the content: the title, the day, the format and the state, plus the open part once it left production. */
export interface ClientView {
  readonly status: PortalStatus;
  readonly title: string;
  readonly format: ContentFormat;
  readonly publishOn: string;
  readonly open: OpenView | null;
}

/**
 * The content as the portal answers it (`PortalContentDetail`): subtasks, the person in charge, the internal deadline and the agency's
 * conversation are not copied into the view, so nothing below can show them. A cancelled content is not in the portal at all.
 */
export const clientViewOf = (content: ContentDetail): ClientView | null => {
  if (content.status === 'cancelled') return null;
  const base = { status: content.status, title: content.title, format: content.format, publishOn: content.publishOn };
  if (content.status === 'in_production') return { ...base, open: null };
  const first = [...content.media].sort((left, right) => left.position - right.position)[0]?.id ?? null;
  return {
    ...base,
    open: {
      publishAtTime: content.publishAtTime,
      caption: content.caption,
      shownAssetId: hasCover(content.format) ? (content.coverAssetId ?? first) : first,
      mediaCount: content.media.length,
      publishedOn: content.publishedOn
    }
  };
};

const dayText = (day: string): string => (CalendarDaySchema.safeParse(day).success ? fullDayLabel(day) : day);

/**
 * "Como o cliente vê": a preview, on the agency's screen, of how the content is in the portal in the state it is now. It is not the portal:
 * the media comes from the agency's own route, and nothing here asks the portal for anything.
 */
export function ContentClientView({ content }: { content: ContentDetail }) {
  const view = clientViewOf(content);
  if (view === null) {
    return <p className="form-hint" role="note">Este conteúdo foi cancelado: o cliente não o vê no portal.</p>;
  }
  const { open } = view;
  const caption = open?.caption?.trim() ?? '';
  return <section className="client-view" aria-label="Como o cliente vê">
    <p className="form-hint" role="note">
      Prévia do conteúdo como o portal o mostra agora. Fica de fora para o cliente: subtarefas, responsável, prazo interno e a conversa da agência durante a produção.
    </p>
    <article className="client-view__post">
      <h3 className="client-view__title">{view.title}</h3>
      <ul className="client-view__meta" aria-label="Dados do conteúdo">
        <li><StatusTag status={PORTAL_STATUS_TAGS[view.status]}>{PORTAL_STATUS_LABELS[view.status]}</StatusTag></li>
        <li><FormatTag format={FORMAT_TONES[view.format]}>{FORMAT_LABELS[view.format]}</FormatTag></li>
        <li>
          <time dateTime={view.publishOn}>{dayText(view.publishOn)}</time>
          {open?.publishAtTime != null && <> · {open.publishAtTime}</>}
        </li>
        {open?.publishedOn != null && <li>Publicado em <time dateTime={open.publishedOn}>{dayText(open.publishedOn)}</time></li>}
      </ul>
      {open === null
        ? <p className="client-view__hint">Em produção, o cliente vê só o título, o dia e o formato. A mídia e a legenda aparecem quando o conteúdo é enviado para aprovação.</p>
        : <>
          {open.mediaCount === 0
            ? <p className="client-view__hint">Este conteúdo ainda não tem mídia.</p>
            : <ContentCover assetId={open.shownAssetId} format={view.format} className="content-preview__media" />}
          {open.mediaCount > 1 && <p className="client-view__hint">{open.mediaCount} mídias, que o cliente passa uma a uma.</p>}
          {caption === '' ? <p className="client-view__hint">Este post não tem legenda.</p> : <p className="client-view__caption">{caption}</p>}
          {view.status === 'awaiting_approval' && <p className="client-view__hint">O cliente pode aprovar ou pedir ajuste.</p>}
        </>}
    </article>
  </section>;
}
