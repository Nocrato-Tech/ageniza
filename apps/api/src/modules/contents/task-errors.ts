import { CONTENT_TASKS_MAX_PER_CONTENT } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { databaseErrorCode } from '@ageniza/database';

import { translateDatabaseError } from './errors.js';

/** What a person does to a subtask (specs/conteudo.md sections 4 and 6). */
export type TaskAction = 'create' | 'update' | 'deliver' | 'approve' | 'return';

const STATE_MESSAGES: Record<TaskAction, string> = {
  create: 'Um conteúdo publicado ou cancelado não recebe subtarefas.',
  update: 'Uma subtarefa aprovada, ou de um conteúdo publicado ou cancelado, não é editada.',
  deliver: 'Só uma subtarefa pendente, de um conteúdo que não foi publicado nem cancelado, é entregue.',
  approve: 'Só uma subtarefa entregue, de um conteúdo que não foi publicado nem cancelado, é aprovada.',
  return: 'Só uma subtarefa entregue, de um conteúdo que não foi publicado nem cancelado, é devolvida.'
};

export const taskNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Task not found.' });

export const taskState = (action: TaskAction): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_TASK_STATE',
  message: STATE_MESSAGES[action]
});

/** One answer for every reason a link cannot be the person in charge: the response never says which one it was. */
export const taskAssigneeInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_TASK_ASSIGNEE_INVALID',
  message: 'O responsável precisa ser um colaborador ativo que vê Conteúdo.'
});

export const taskLimitReached = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CONTENT_TASK_LIMIT',
  message: `Um conteúdo tem até ${CONTENT_TASKS_MAX_PER_CONTENT} subtarefas.`
});

export const taskCommentInvalid = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'CONTENT_TASK_COMMENT_INVALID',
  message: 'Informe o comentário da devolução, com até 5000 bytes.'
});

/**
 * What the database answers to a write of a subtask, by name, so none of its refusals is a 500. A refusal of the row-level policy
 * (42501) is not here: it can be a client archived in the meantime, and the route reads it back.
 */
export const translateTaskError = (error: unknown, action: TaskAction): HttpError | undefined => {
  switch (databaseErrorCode(error)) {
    case 'A0068': return taskCommentInvalid();
    case 'A0070': return taskNotFound();
    case 'A0071': return taskState(action);
    case 'A0073': return taskAssigneeInvalid();
    case '23503':
      return (error as { constraint?: unknown }).constraint === 'content_tasks_assignee_user_id_fkey'
        ? taskAssigneeInvalid()
        : translateDatabaseError(error, { folderMoveKeepsCover: false });
    default: return translateDatabaseError(error, { folderMoveKeepsCover: false });
  }
};
