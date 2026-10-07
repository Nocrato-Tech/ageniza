import { HttpError } from '@ageniza/core';

/**
 * The public answer for a lost database race (deadlock or serialization failure, issue #325): 409,
 * never any detail of what raced, and repeating the call is the answer. Shared by every route that
 * translates `isRetryableConflict` from `@ageniza/database`.
 */
export const tryAgain = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'TRY_AGAIN',
  message: 'Houve um conflito momentâneo. Tente de novo.'
});
