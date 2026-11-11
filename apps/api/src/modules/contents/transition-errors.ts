import { HttpError } from '@ageniza/core';
import { databaseErrorCode } from '@ageniza/database';

import { translateDatabaseError } from './errors.js';

/** The six moves of a content the agency makes (specs/conteudo.md section 6). */
export type TransitionAction = 'submit' | 'approve-by-agency' | 'publish' | 'unpublish' | 'cancel' | 'reschedule';

const STATE_MESSAGES: Record<TransitionAction, string> = {
  submit: 'Só um conteúdo em produção ou em ajuste é enviado para aprovação. Um conteúdo que já aguarda aprovação não muda de prazo nem de recado.',
  'approve-by-agency': 'Só um conteúdo aguardando aprovação é aprovado.',
  publish: 'Só um conteúdo aprovado é marcado como publicado.',
  unpublish: 'Só um conteúdo publicado volta a aprovado.',
  cancel: 'Um conteúdo publicado não é cancelado.',
  reschedule: 'Só um conteúdo cancelado é reagendado.'
};

export const contentState = (action: TransitionAction): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_STATE',
  message: STATE_MESSAGES[action]
});

export const revisionChanged = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_REVISION_CHANGED',
  message: 'O conteúdo mudou desde que você o leu. Recarregue e confira antes de aprovar.'
});

export const unpublishExpired = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_UNPUBLISH_EXPIRED',
  message: 'A publicação só se desfaz no dia em que foi marcada.'
});

export const tasksNotApproved = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_TASKS_NOT_APPROVED',
  message: 'Todas as subtarefas precisam estar aprovadas antes do envio.'
});

/** A media that is still uploading is not media yet: the client never receives a post to approve that has not finished uploading. */
export const mediaNotConfirmed = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_MEDIA_NOT_CONFIRMED',
  message: 'O conteúdo tem mídia que ainda não terminou de subir. Espere o envio terminar ou troque a mídia.'
});

/** The same code the edit answers, with a message that also covers a cover that was removed from the folder. */
export const mediaNotComplete = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_MEDIA_INCOMPLETE',
  message: 'A mídia ou a capa do conteúdo não está completa para este formato: falta mídia, ou a mídia ou a capa foi removida da pasta.'
});

export const publishedOnInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_PUBLISHED_ON_INVALID',
  message: 'A data real da publicação não pode ser futura (dia de São Paulo).'
});

export const reasonInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_REASON_INVALID',
  message: 'Informe o motivo da aprovação, com até 5000 bytes.'
});

export const approvalDueInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_APPROVAL_DUE_INVALID',
  message: 'O prazo de aprovação vai de hoje até 90 dias à frente, no dia de São Paulo.'
});

export const approvalNoteInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_APPROVAL_NOTE_INVALID',
  message: 'O recado ao cliente tem até 500 caracteres e não pode ser só espaços. Deixe em branco para enviar sem recado.'
});

export const batchInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_BATCH_INVALID',
  message: 'O envio em lote é de 1 a 30 conteúdos, cada um uma vez.'
});

export const batchMixedClients = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_BATCH_MIXED_CLIENTS',
  message: 'Os conteúdos de um envio em lote são de um cliente só.'
});

/**
 * What the database answers to a transition, by name, so none of its refusals is a 500. `A0065` is the generic answer: the route
 * first reads the media to tell one still uploading apart. A refusal of the row-level policy (42501) is not here, because
 * it can be a client archived in the meantime.
 */
export const translateTransitionError = (error: unknown, action: TransitionAction): HttpError | undefined => {
  switch (databaseErrorCode(error)) {
    case 'A0062': return contentState(action);
    case 'A0063': return revisionChanged();
    case 'A0064': return unpublishExpired();
    case 'A0065': return mediaNotComplete();
    case 'A0066': return tasksNotApproved();
    case 'A0067': return publishedOnInvalid();
    // The same code is the reason of an approval outside the platform and the note of a round: the move says which.
    case 'A0068': return action === 'submit' ? approvalNoteInvalid() : reasonInvalid();
    case 'A0120': return approvalDueInvalid();
    case 'A0121': return batchInvalid();
    case 'A0122': return batchMixedClients();
    default: return translateDatabaseError(error, { movesFolder: false });
  }
};
