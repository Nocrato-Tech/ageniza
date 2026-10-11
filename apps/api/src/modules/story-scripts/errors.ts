import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

/**
 * What the writes of the story scripts answer when the database refuses (#258). One place, so the same refusal is
 * the same answer on every route of a side, and nothing the database raises here is a 500:
 *
 * - `A0050`: the script is not there for this caller (absent, another client's or agency's, a draft the caller
 *   cannot read, no permission, no link): 404, never an existence oracle;
 * - `A0051`: the client is archived (`send_story_script`): 409 for the agency;
 * - `A0020`: the archive of the client won the race for a write into its child (trigger of 20261007001400): 409
 *   `CLIENT_ARCHIVED` for the agency and 404 for the portal, which never learns that a client is archived;
 * - `A0052`: the script is not in the state the operation needs: 409;
 * - `40P01` and `40001`: a lost race, "try again".
 */

export type Side = 'agency' | 'portal';
export type Operation = 'edit' | 'send' | 'record';

export const notFound = (message: string): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message });
export const clientNotFound = (): HttpError => notFound('Client not found.');
export const scriptNotFound = (): HttpError => notFound('Story script not found.');

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

const STATE_MESSAGES: Record<Operation, string> = {
  edit: 'Roteiro já enviado não é editado.',
  send: 'Só um roteiro em rascunho é enviado.',
  record: 'Só um roteiro enviado é marcado como gravado.'
};

export const scriptState = (operation: Operation): HttpError => new HttpError({
  statusCode: 409,
  code: 'STORY_SCRIPT_STATE',
  message: STATE_MESSAGES[operation]
});

export const scenesMismatch = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'STORY_SCENES_MISMATCH',
  message: 'O roteiro mudou: recarregue e envie todas as cenas, na ordem desejada.'
});

export const translateDatabaseError = (error: unknown, side: Side, operation: Operation): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  switch (databaseErrorCode(error)) {
    case 'A0050': return scriptNotFound();
    case 'A0051': return side === 'agency' ? clientArchived() : clientNotFound();
    case 'A0020': return side === 'agency' ? clientArchived() : clientNotFound();
    case 'A0052': return scriptState(operation);
    default: return undefined;
  }
};
