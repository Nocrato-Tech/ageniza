import { ContentCaptionSchema, ContentDaySchema, ContentTitleSchema, ContentTimeSchema } from '@ageniza/contracts';
import type { Asset, PostInput } from './types';
import { coverIssue } from './media-rules';
export type EditorErrors = Partial<Record<keyof PostInput, string>>;
export type EditorDraft = { input: PostInput; createdId?: string; revision?: number };
export function editorErrors(input: PostInput, step: number, assets?: Asset[]): EditorErrors {
  const errors: EditorErrors = {};
  if (!input.clientId) errors.clientId = 'Escolha o cliente deste conteúdo.';
  if (!ContentTitleSchema.safeParse(input.title).success) errors.title = 'Informe um título de até 120 caracteres.';
  if (!input.folderId) errors.folderId = 'Escolha uma pasta para as mídias.';
  if (step > 0) {
    const maximum = input.format === 'carousel' ? 20 : 1;
    if (input.mediaIds.length > maximum) errors.mediaIds = `Este formato aceita até ${maximum} arquivo${maximum > 1 ? 's' : ''} na publicação. Remova os excedentes; a imagem de capa é escolhida separadamente abaixo.`;
    if (assets && input.mediaIds.some((id) => !assets.some((asset) => asset.id === id && asset.clientId === input.clientId && asset.folderId === input.folderId))) errors.mediaIds = 'Uma mídia não está disponível nesta pasta. Remova a seleção e escolha um arquivo da pasta atual.';
    if (assets && input.coverId) errors.coverId = coverIssue(assets.find((asset) => asset.id === input.coverId), input);
    if (!ContentCaptionSchema.safeParse(input.caption).success) errors.caption = 'Use até 2.200 caracteres na legenda.';
    if (!ContentDaySchema.safeParse(input.date).success) errors.date = 'Escolha uma data válida para a publicação.';
    if (input.time && !ContentTimeSchema.safeParse(input.time).success) errors.time = 'Informe um horário válido, como 18:00.';
  }
  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value !== undefined));
}
