import { HttpError } from '@ageniza/core';
import { databaseErrorCode } from '@ageniza/database';

import { contentNotFound } from '../contents/errors.js';
import { translatePortalError, type PortalContentAction } from '../contents/portal-errors.js';

/**
 * One 404 for a link that is unknown, expired, replaced by a later generation of its access, of an access that was removed, of a
 * client that was archived, or of an agency that is suspended or read-only. The page cannot tell which, so the link is no oracle.
 */
export const approvalLinkInvalid = (): HttpError => new HttpError({
  statusCode: 404,
  code: 'APPROVAL_LINK_INVALID',
  message: 'Este link não vale mais. Abra o e-mail mais recente ou peça um novo à agência.'
});

/**
 * What the database refuses with (migration 20261027090200). `A0100` is the dead link; `A0090` (the agency is read-only) is the same dead
 * link for the person, who cannot do anything about it. The refusals of a decision are the portal's own (`A0060`, `A0062`, `A0063`,
 * `A0068`), translated the same way, so a decision through the link answers what the same decision in the portal answers.
 */
export const translateApprovalError = (error: unknown, action: PortalContentAction | 'read'): HttpError | undefined => {
  const code = databaseErrorCode(error);
  if (code === 'A0100' || code === 'A0090') return approvalLinkInvalid();
  if (action === 'read') return code === 'A0060' ? contentNotFound() : undefined;
  return translatePortalError(error, action);
};
