import { ContentCaptionSchema, ContentDaySchema, ContentTitleSchema, ContentTimeSchema } from '@ageniza/contracts';
import type { PostInput } from './types';

export function validateInput(input: PostInput) {
  ContentTitleSchema.parse(input.title); ContentCaptionSchema.parse(input.caption); ContentDaySchema.parse(input.date);
  if (input.time) ContentTimeSchema.parse(input.time);
  if (!input.clientId || !input.folderId) throw new Error('Selecione o cliente e a pasta de mídia.');
}
