import { CalendarDaySchema, CONTENT_CAPTION_MAX_LENGTH } from '@ageniza/contracts';

import { characterCount, hasCover, type ContentFormValues } from './content-form.js';
import { ContentCover } from './content-cover.js';
import { fullDayLabel } from './content-dates.js';
import { FORMAT_LABELS } from './content-labels.js';

/** The counter reads "1.204/2.200", the way the caption is written in Portuguese. */
export const captionCounter = (caption: string): string =>
  `${characterCount(caption.trim()).toLocaleString('pt-BR')}/${CONTENT_CAPTION_MAX_LENGTH.toLocaleString('pt-BR')}`;

/**
 * The post as it will look, while it is edited. A video shows its cover (or its own thumbnail while it has none),
 * anything else its first media. Every string is a React text child, never markup.
 */
export function ContentPreview({ values, handle }: { values: ContentFormValues; handle: string | null }) {
  const first = values.mediaAssetIds[0] ?? null;
  const shown = hasCover(values.format) ? (values.coverAssetId ?? first) : first;
  const caption = values.caption.trim();
  return <figure className="content-preview" aria-label="Prévia do post">
    <figcaption className="content-preview__handle">{handle === null ? 'Sem perfil do Instagram' : `@${handle}`}</figcaption>
    <ContentCover assetId={shown} format={values.format} className="content-preview__media" />
    <p className="content-preview__meta">
      {FORMAT_LABELS[values.format]}
      {values.mediaAssetIds.length > 1 && <> · {values.mediaAssetIds.length} mídias</>}
    </p>
    <p className="content-preview__title">{values.title.trim() === '' ? 'Sem título' : values.title}</p>
    <p className="content-preview__caption">{caption === '' ? 'Sem legenda' : caption}</p>
    <p className="content-preview__when">
      {CalendarDaySchema.safeParse(values.publishOn).success ? <time dateTime={values.publishOn}>{fullDayLabel(values.publishOn)}</time> : 'Sem data'}
      {values.publishAtTime !== '' && <> · {values.publishAtTime}</>}
    </p>
  </figure>;
}
