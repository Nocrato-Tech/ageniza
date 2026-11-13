import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

const forbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.'
});

/**
 * What the database may raise under the search, never as a 500: a lost race (`40P01`, `40001`) is "try again", and `42501` is the
 * barrier of the database refusing, which is the answer the guard would have given. Nothing of the error, and never the term, is said.
 */
export const translateDatabaseError = (error: unknown): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  if (databaseErrorCode(error) === '42501') return forbidden();
  return undefined;
};
