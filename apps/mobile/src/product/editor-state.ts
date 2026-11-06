import { ContentCaptionSchema, ContentDaySchema, ContentTitleSchema, ContentTimeSchema } from '@ageniza/contracts';
import type { PostInput } from './types';
export type EditorErrors = Partial<Record<keyof PostInput, string>>;
export type EditorDraft = { input: PostInput; createdId?: string; revision?: number };
export function editorErrors(input: PostInput, step: number): EditorErrors {
  const errors: EditorErrors = {};
  if (!input.clientId) errors.clientId = 'Escolha o cliente deste conteúdo.';
  if (!ContentTitleSchema.safeParse(input.title).success) errors.title = 'Informe um título de até 120 caracteres.';
  if (!input.folderId) errors.folderId = 'Escolha uma pasta para as mídias.';
  if (step > 0) {
    if (!ContentCaptionSchema.safeParse(input.caption).success) errors.caption = 'Use até 2.200 caracteres na legenda.';
    if (!ContentDaySchema.safeParse(input.date).success) errors.date = 'Escolha uma data válida para a publicação.';
    if (input.time && !ContentTimeSchema.safeParse(input.time).success) errors.time = 'Informe um horário válido, como 18:00.';
  }
  return errors;
}
