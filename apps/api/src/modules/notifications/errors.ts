import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

/**
 * What the database may raise under the four routes, in one place so nothing it raises is a 500:
 *
 * - `40P01` and `40001`: a lost race, "try again";
 * - `42501`: the database barrier refused (no account bound, or a policy): 403, the answer of the guard;
 * - `22P02`: an id that is not a uuid reached the database: the same 404 as a notification that is not there;
 * - any other `A00xx`: a rule of the database refused the write; for a notification that is the same 404, which tells nothing
 *   about what exists. The refusals of the plan keep the answer the global handler gives them.
 */
const PLAN_REFUSALS: ReadonlySet<string> = new Set(['A0090', 'A0091', 'A0092', 'A0095']);

export const notificationNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Notification not found.' });

export const forbidden = (): HttpError => new HttpError({
  statusCode: 403,
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.'
});

export const translateDatabaseError = (error: unknown): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  const code = databaseErrorCode(error);
  if (code === undefined) return undefined;
  if (code === '42501') return forbidden();
  if (code === '22P02') return notificationNotFound();
  if (/^A00\d\d$/.test(code) && !PLAN_REFUSALS.has(code)) return notificationNotFound();
  return undefined;
};
