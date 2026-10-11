import { CONTENT_PERIOD_MAX_ITEMS } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

export const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
export const forbidden = (): HttpError => new HttpError({ statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });

// One 404 for a client that does not exist, is another agency's or has a malformed id; the response never says which.
export const clientNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' });
// The same for a content: another client's, another agency's, absent and malformed are one answer.
export const contentNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Content not found.' });

export const clientArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_ARCHIVED',
  message: 'Cliente arquivado não pode ser editado.'
});

export const periodTooLarge = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_PERIOD_TOO_LARGE',
  message: `O período tem mais de ${CONTENT_PERIOD_MAX_ITEMS} itens. Consulte um período menor.`
});

export const contentNotEditable = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_NOT_EDITABLE',
  message: 'Conteúdo publicado ou cancelado não pode ser editado.'
});

export const mediaIncomplete = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_MEDIA_INCOMPLETE',
  message: 'A mídia do conteúdo não cobre este formato. Para trocar entre carrossel e formato de uma mídia só depois do envio para aprovação, cancele e reagende o conteúdo.'
});

export const mediaInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_MEDIA_INVALID',
  message: 'A mídia ou a capa escolhida não pode ser usada neste conteúdo.'
});

export const folderInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_FOLDER_INVALID',
  message: 'A pasta escolhida não é uma pasta deste cliente.'
});

export const folderInUse = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_FOLDER_IN_USE',
  message: 'A pasta não muda enquanto o conteúdo tem mídia ou capa.'
});

export const ownerInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_OWNER_INVALID',
  message: 'O responsável precisa ser um colaborador ativo que vê Conteúdo.'
});

/** What a write needs to read a refusal of the database the way the route would have answered it. */
export interface WriteContext {
  /** The body moves the folder of a content that already holds a cover: the cover's own key is then the folder's. */
  folderMoveKeepsCover: boolean;
}

/**
 * The database refusals this module answers by name (`app_private` codes of migration 20261007001200 and the
 * foreign keys of `contents`), so none of them reaches the caller as a 500. A refusal of the row-level policy
 * (42501) is not here: it is read back by the caller, because it can be a client archived in the meantime.
 */
export const translateDatabaseError = (error: unknown, context: WriteContext): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  switch (databaseErrorCode(error)) {
    case 'A0020':
    case 'A0061': return clientArchived();
    case 'A0060': return contentNotFound();
    case 'A0062': return contentNotEditable();
    case 'A0065': return mediaIncomplete();
    case 'A0069': return mediaInvalid();
    case 'A0073': return ownerInvalid();
    case 'A0074': return forbidden();
    case '23503': {
      switch ((error as { constraint?: unknown }).constraint) {
        case 'contents_folder_fk': return folderInvalid();
        case 'contents_cover_fk': return context.folderMoveKeepsCover ? folderInUse() : mediaInvalid();
        case 'content_media_content_fk': return folderInUse();
        case 'contents_owner_user_id_fkey': return ownerInvalid();
        default: return undefined;
      }
    }
    default: return undefined;
  }
};

