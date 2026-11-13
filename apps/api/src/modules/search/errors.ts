import { AGENCY_SEARCH_TERM_MIN_LENGTH } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

const forbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.'
});

/** The refusal of a term that is too short once the accents are folded: the one the contract gives a short term, naming the field and never the value. */
export const termTooShort = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'q', code: 'too_small', message: `String must contain at least ${AGENCY_SEARCH_TERM_MIN_LENGTH} character(s)` }] }
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
