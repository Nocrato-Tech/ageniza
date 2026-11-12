import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';
import { clientNotFound, contentNotFound } from './errors.js';
import { revisionChanged } from './transition-errors.js';

/**
 * What the two moves of the portal answer when the database refuses (#257). The portal never learns that a client is
 * archived: a content that is gone, a client that was archived and a link that was removed are one 404, and nothing the
 * database raises is a 500:
 *
 * - `A0060`: the content is not there for this person (absent, another client's, not open yet, client archived while the
 *   request waited for the lock): 404;
 * - `A0020`, `A0061`: the archive of the client won the race for a write into one of its children: 404;
 * - `A0062`: the content is not awaiting approval (the route reads it again to tell a content that was cancelled meanwhile apart);
 * - `A0063`: the content changed since the revision the person read: 409;
 * - `A0068`: the comment of a request for changes, or the note of an approval, is blank or too long: 400 (the schema stops it first; the
 *   function is the second barrier), each with its own code;
 * - `40P01` and `40001`: a lost race, "try again".
 */

export type PortalContentAction = 'approve' | 'request-changes' | 'withdraw-approval';

const STATE_MESSAGES: Record<PortalContentAction, string> = {
  approve: 'Só um conteúdo aguardando aprovação é aprovado.',
  'request-changes': 'Só um conteúdo aguardando aprovação recebe um pedido de ajuste.',
  'withdraw-approval': 'Só é possível desfazer a aprovação antes da publicação.'
};

export const notAwaitingApproval = (action: PortalContentAction): HttpError => new HttpError({
  statusCode: 409,
  code: action === 'withdraw-approval' ? 'CONTENT_APPROVAL_CANNOT_BE_WITHDRAWN' : 'CONTENT_NOT_AWAITING_APPROVAL',
  message: STATE_MESSAGES[action]
});

export const commentInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_COMMENT_INVALID',
  message: 'Escreva o que precisa mudar, com até 5000 bytes.'
});

/** The note the client leaves with the approval has the rule of the agency's: the schema stops it first, the function is the second barrier. */
export const approvalNoteInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_APPROVAL_NOTE_INVALID',
  message: 'O recado para a agência tem até 500 caracteres e não pode ser só espaços. Deixe em branco para aprovar sem recado.'
});

// Absent, another content's, not open to the portal, removed and not yet confirmed are one answer.
export const mediaNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Media asset not found.' });

export const variantNotReady = (): HttpError => new HttpError({ statusCode: 409, code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' });

// The reason the worker recorded is internal: the portal is told only that it failed.
export const variantProcessingFailed = (): HttpError => new HttpError({ statusCode: 409, code: 'VARIANT_PROCESSING_FAILED', message: 'Video processing failed.' });

/**
 * A refusal that needs the route to read again before it can be named is `undefined` here: only `A0062` and `42501`. `withNote` is true for
 * the approval of the portal, the only decision that takes a note: there `A0068` is the note. The approval link of the e-mail takes none,
 * and answers `A0068` as the comment of its request for changes, as before.
 */
export const translatePortalError = (error: unknown, action: PortalContentAction, options: { readonly withNote?: boolean } = {}): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  switch (databaseErrorCode(error)) {
    case 'A0060': return contentNotFound();
    case 'A0020':
    case 'A0061': return clientNotFound();
    case 'A0062': return notAwaitingApproval(action);
    case 'A0063': return revisionChanged();
    case 'A0068': return action === 'approve' && options.withNote === true ? approvalNoteInvalid() : commentInvalid();
    default: return undefined;
  }
};
