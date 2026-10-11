import { z } from 'zod';

import {
  CalendarDaySchema,
  CONTENT_CAPTION_MAX_LENGTH,
  CONTENT_CAROUSEL_MAX_MEDIA,
  CONTENT_TITLE_MAX_LENGTH,
  ContentCaptionSchema,
  ContentTitleSchema,
  type ContentDetail,
  type ContentFormat,
  type UpdateContentRequest
} from '@ageniza/contracts';

import { HttpClientError } from './http.js';

/** What the person edits, in the shape of the inputs: a time or a caption left empty is `''`, never `null`. */
export interface ContentFormValues {
  readonly title: string;
  readonly format: ContentFormat;
  readonly publishOn: string;
  readonly publishAtTime: string;
  readonly folderId: string;
  readonly caption: string;
  readonly mediaAssetIds: readonly string[];
  readonly coverAssetId: string | null;
}

export type ContentField = 'title' | 'publishOn' | 'publishAtTime' | 'caption' | 'folderId' | 'media' | 'cover';
export type ContentFieldErrors = Partial<Record<ContentField, string>>;

/** Only a video has a cover to choose; an image or a carousel is its own picture. */
export const hasCover = (format: ContentFormat): boolean => format !== 'image' && format !== 'carousel';

export const valuesOf = (content: ContentDetail): ContentFormValues => ({
  title: content.title,
  format: content.format,
  publishOn: content.publishOn,
  publishAtTime: content.publishAtTime?.slice(0, 5) ?? '',
  folderId: content.folderId,
  caption: content.caption ?? '',
  mediaAssetIds: [...content.media].sort((a, b) => a.position - b.position).map((item) => item.id),
  coverAssetId: content.coverAssetId
});

export const characterCount = (value: string): number => Array.from(value).length;

const titleIssue = (value: string): string | undefined => {
  if (ContentTitleSchema.safeParse(value).success) return undefined;
  if (value.trim() === '') return 'Informe o título.';
  if (characterCount(value.trim()) > CONTENT_TITLE_MAX_LENGTH) return `O título passa de ${CONTENT_TITLE_MAX_LENGTH} caracteres.`;
  return 'O título tem caracteres que não são aceitos.';
};

const captionIssue = (value: string): string | undefined => {
  if (ContentCaptionSchema.safeParse(value).success) return undefined;
  if (characterCount(value.trim()) > CONTENT_CAPTION_MAX_LENGTH) return 'A legenda passa de 2.200 caracteres.';
  return 'A legenda tem caracteres que não são aceitos.';
};

/** The same rules the API applies, read before anything is sent; the API stays the one that decides. */
export const validate = (values: ContentFormValues): ContentFieldErrors => {
  const errors: ContentFieldErrors = {};
  const title = titleIssue(values.title);
  if (title !== undefined) errors.title = title;
  if (!CalendarDaySchema.safeParse(values.publishOn).success) errors.publishOn = 'Informe o dia da publicação.';
  const caption = captionIssue(values.caption);
  if (caption !== undefined) errors.caption = caption;
  if (values.folderId === '') errors.folderId = 'Escolha a pasta.';
  if (values.format !== 'carousel' && values.mediaAssetIds.length > 1) errors.media = 'Este formato leva uma mídia só.';
  if (values.mediaAssetIds.length > CONTENT_CAROUSEL_MAX_MEDIA) errors.media = `Um carrossel leva até ${CONTENT_CAROUSEL_MAX_MEDIA} mídias.`;
  return errors;
};

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Only what changed: a save of the title never carries the media list, and never touches the approval it does not change. */
export const changesOf = (saved: ContentFormValues, form: ContentFormValues): UpdateContentRequest => {
  const changes: { -readonly [Key in keyof UpdateContentRequest]: UpdateContentRequest[Key] } = {};
  if (form.title.trim() !== saved.title.trim()) changes.title = form.title;
  if (form.format !== saved.format) changes.format = form.format;
  if (form.publishOn !== saved.publishOn) changes.publishOn = form.publishOn;
  if (form.publishAtTime !== saved.publishAtTime) changes.publishAtTime = form.publishAtTime === '' ? null : form.publishAtTime;
  if (form.caption.trim() !== saved.caption.trim()) changes.caption = form.caption.trim() === '' ? null : form.caption;
  if (form.folderId !== saved.folderId) changes.folderId = form.folderId;
  if (form.coverAssetId !== saved.coverAssetId) changes.coverAssetId = form.coverAssetId;
  if (!sameList(form.mediaAssetIds, saved.mediaAssetIds)) changes.mediaAssetIds = [...form.mediaAssetIds];
  return changes;
};

/** What makes an approved content go back to "aguardando aprovação" (`specs/conteudo.md` rule 6): the caption, the media, the cover or the format. */
export const resetsApproval = (changes: UpdateContentRequest): boolean =>
  changes.caption !== undefined || changes.mediaAssetIds !== undefined || changes.coverAssetId !== undefined || changes.format !== undefined;

const ISSUE_FIELDS: ReadonlyArray<readonly [string, ContentField]> = [
  ['title', 'title'],
  ['publishOn', 'publishOn'],
  ['publishAtTime', 'publishAtTime'],
  ['caption', 'caption'],
  ['folderId', 'folderId'],
  ['mediaAssetIds', 'media'],
  ['coverAssetId', 'cover']
];

const FIELD_MESSAGES: Readonly<Record<ContentField, string>> = {
  title: 'O título não foi aceito. Revise o texto.',
  publishOn: 'O dia da publicação não foi aceito.',
  publishAtTime: 'A hora não foi aceita.',
  caption: 'A legenda não foi aceita. Revise o texto.',
  folderId: 'A pasta não foi aceita.',
  media: 'A mídia escolhida não foi aceita.',
  cover: 'A capa escolhida não foi aceita.'
};

const IssuesSchema = z.object({ issues: z.array(z.object({ path: z.string() })) });

/** The fields the API refused, by the path of each issue; the words are the screen's own, never the server's. */
export const refusedFields = (details: unknown): ContentFieldErrors => {
  const parsed = IssuesSchema.safeParse(details);
  if (!parsed.success) return {};
  const errors: ContentFieldErrors = {};
  for (const issue of parsed.data.issues) {
    const match = ISSUE_FIELDS.find(([path]) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`));
    if (match !== undefined) errors[match[1]] = FIELD_MESSAGES[match[1]];
  }
  return errors;
};

export interface SaveRefusal {
  readonly message: string;
  readonly fields: ContentFieldErrors;
}

export const SAVE_FAILED = 'Não foi possível salvar o conteúdo. Tente de novo.';

/** The screen's own words for each refusal of a save: what the server wrote is never shown. */
export const saveRefusal = (error: unknown, creating = false): SaveRefusal => {
  if (error instanceof HttpClientError) {
    if (error.status === 400 && error.code === 'VALIDATION_ERROR') {
      const fields = refusedFields(error.details);
      return { message: Object.keys(fields).length > 0 ? 'Revise os campos marcados.' : 'Revise os dados do conteúdo.', fields };
    }
    if (error.status === 400 && error.code === 'CONTENT_MEDIA_INVALID') return { message: 'A mídia ou a capa escolhida não pode ser usada neste conteúdo.', fields: { media: 'Escolha outra mídia.' } };
    if (error.status === 400 && error.code === 'CONTENT_FOLDER_INVALID') return { message: 'A pasta escolhida não é uma pasta deste cliente.', fields: { folderId: 'Escolha outra pasta.' } };
    if (error.status === 409 && error.code === 'CLIENT_ARCHIVED') return { message: 'Este cliente está arquivado: o conteúdo é só leitura.', fields: {} };
    if (error.status === 409 && error.code === 'CONTENT_NOT_EDITABLE') return { message: 'Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.', fields: {} };
    if (error.status === 409 && error.code === 'CONTENT_MEDIA_INCOMPLETE') {
      return { message: 'A mídia não cobre este formato. Depois do envio para aprovação, não se troca entre carrossel e uma mídia só: cancele e reagende o conteúdo.', fields: { media: 'A mídia não cobre este formato.' } };
    }
    if (error.status === 409 && error.code === 'CONTENT_FOLDER_IN_USE') {
      return { message: 'A pasta não muda enquanto o conteúdo tem mídia ou capa. Tire as duas, salve, e escolha a outra pasta.', fields: { folderId: 'Tire a mídia e a capa antes de trocar a pasta.' } };
    }
    if (error.status === 409 && error.code === 'TRY_AGAIN') return { message: 'Outra alteração aconteceu ao mesmo tempo. Salve de novo.', fields: {} };
    if (error.status === 403) return { message: 'Você não tem permissão para alterar conteúdos.', fields: {} };
    if (error.status === 404) return { message: creating ? 'Este cliente não existe mais.' : 'Este conteúdo não existe mais.', fields: {} };
  }
  return { message: SAVE_FAILED, fields: {} };
};
