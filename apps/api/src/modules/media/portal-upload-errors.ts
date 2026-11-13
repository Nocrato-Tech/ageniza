import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

/**
 * What the database refuses the portal's upload with (migration 20261113000100, `specs/conteudo.md` section 3), as answers a person of
 * the portal may read. Nothing here, in a message, a code or a detail, speaks of the plan, the quota, the storage or the billing of the
 * agency (decision 2026-11-06 "o portal não expõe a cobrança" and item 5 of 2026-11-11): the agency that cannot take the file and the
 * agency that is read-only share the one sentence of the portal, and the global handler is never reached with an `A0090`, because its
 * text is the trial's.
 */

export const PORTAL_PAUSED_MESSAGE = 'A aprovação está pausada no momento. A agência já foi avisada.';

/** One answer for a request, a file, a link or an agency that is not there for this person: it never says which. */
export const portalRequestNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Pedido não encontrado.' });

export const portalRequestResolved = (): HttpError => new HttpError({ statusCode: 409, code: 'REQUEST_RESOLVED', message: 'Este pedido já foi resolvido e não recebe mais arquivos.' });

export const portalUploadNotPending = (): HttpError => new HttpError({ statusCode: 409, code: 'UPLOAD_NOT_PENDING', message: 'Este envio já foi concluído ou cancelado.' });

export const translatePortalUploadError = (error: unknown): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  switch (databaseErrorCode(error)) {
    case 'A0130': return portalRequestNotFound();
    case 'A0131': return portalRequestResolved();
    case 'A0132': return new HttpError({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'O arquivo passa do tamanho máximo de 25 MB.' });
    case 'A0133': return new HttpError({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Envie uma foto (PNG, JPEG, WebP ou GIF) ou um áudio.' });
    case 'A0134': return new HttpError({ statusCode: 409, code: 'REQUEST_FULL', message: 'Este pedido já recebeu o máximo de 20 arquivos.' });
    case 'A0135': return portalUploadNotPending();
    case 'A0136': return new HttpError({ statusCode: 409, code: 'UPLOAD_UNAVAILABLE', message: PORTAL_PAUSED_MESSAGE });
    case 'A0090': return new HttpError({ statusCode: 409, code: 'AGENCY_READ_ONLY', message: PORTAL_PAUSED_MESSAGE });
    default: return undefined;
  }
};

/** The file the bytes turned down: the reason is one of `PortalMaterialUploadRejectionReason`, and the reservation is already gone. */
export const portalUploadRejected = (reason: string): HttpError => new HttpError({
  statusCode: 422,
  code: 'UPLOAD_REJECTED',
  message: 'O arquivo foi recusado.',
  details: { reason }
});
