import { HttpError } from '@ageniza/core';
import { isRetryableConflict, withAuthenticatedUserTransaction, type DatabaseClient, type VerifiedUserClaims } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';
import { clientScopeOf, folderFunctionRefusal, isFolderParentViolation } from './folder-service.js';

/**
 * What the writes of the client's media library answer when the database refuses (#253). It is one place for the
 * routes that create a folder, upload into one and remove a media, so the same refusal is the same answer in all
 * three: a deadlock or a serialization failure is "try again", the lost race with the archive of the client is
 * 409 `CLIENT_ARCHIVED` in both of its windows, and nothing the database raises here is a 500.
 */

export const notFound = (message: string): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message });

export const forbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.'
});

export const clientArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_ARCHIVED',
  message: 'Cliente arquivado não pode ser editado.'
});

export const mediaInUse = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'MEDIA_IN_USE',
  message: 'Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida.'
});

export const parentNotFirstLevel = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'parentId', code: 'custom', message: 'parentId must be a first-level folder of this client.' }] }
});

/**
 * `A0080` is the folder (`lock_media_folder`): a folder that is absent, of another client or agency, or that the
 * caller may not use is one answer. The media of a removal raises the same code and says "Media asset not found."
 * in its own route before it gets here.
 */
export const translateClientMediaError = (error: unknown): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  if (isFolderParentViolation(error)) return parentNotFirstLevel();
  switch (folderFunctionRefusal(error)) {
    case 'not-found': return notFound('Folder not found.');
    case 'client-archived': return clientArchived();
    case 'in-use': return mediaInUse();
    default: return undefined;
  }
};

/**
 * The row-level security refused an INSERT after the route had read the client as open: the archive of the client
 * committed between that read and the statement (the one that is already committed when the route starts is caught
 * by reading the client AFTER the locks). The failed transaction is aborted, so the client is read again in a new
 * one: archived is the 409 the archive earned, and only a client that is still open means the caller really lacks
 * the permission.
 */
export const explainRefusedClientWrite = async (
  database: DatabaseClient,
  claims: VerifiedUserClaims,
  scope: { readonly agencyId: string; readonly clientId: string },
  whenAbsent: () => HttpError
): Promise<HttpError> => {
  const state = await withAuthenticatedUserTransaction(database, claims, (transaction) =>
    clientScopeOf(transaction, scope.agencyId, scope.clientId));
  if (state === 'archived') return clientArchived();
  if (state === 'not-found') return whenAbsent();
  return forbidden();
};
