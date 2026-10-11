import { describe, expect, it } from 'vitest';

import { taskAssigneeInvalid, taskCommentInvalid, taskLimitReached, taskNotFound, taskState, translateTaskError, type TaskAction } from './task-errors.js';

const databaseError = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`database ${code}`), { code, ...extra });

const ACTIONS: readonly TaskAction[] = ['create', 'update', 'deliver', 'approve', 'return'];

describe('what a refusal of the database becomes in a subtask route (issue #255)', () => {
  it.each(ACTIONS)('turns A0071 into 409 CONTENT_TASK_STATE, with the message of %s', (action) => {
    const translated = translateTaskError(databaseError('A0071'), action);

    expect(translated).toMatchObject({ statusCode: 409, code: 'CONTENT_TASK_STATE', message: taskState(action).message });
    expect(new Set(ACTIONS.map((candidate) => taskState(candidate).message)).size).toBe(ACTIONS.length);
  });

  it('turns A0070 into the 404 of a task, and A0060 into the 404 of a content', () => {
    expect(translateTaskError(databaseError('A0070'), 'approve')).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: taskNotFound().message });
    expect(translateTaskError(databaseError('A0060'), 'approve')).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'Content not found.' });
  });

  it('turns A0074, who may not do this to a task they read, into 403 FORBIDDEN', () => {
    expect(translateTaskError(databaseError('A0074'), 'deliver')).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(translateTaskError(databaseError('A0074'), 'approve')).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('turns A0073 and the foreign key of the person in charge into the one 400 that does not say why', () => {
    const answer = { statusCode: 400, code: 'CONTENT_TASK_ASSIGNEE_INVALID', message: taskAssigneeInvalid().message };

    expect(translateTaskError(databaseError('A0073'), 'create')).toMatchObject(answer);
    expect(translateTaskError(databaseError('23503', { constraint: 'content_tasks_assignee_user_id_fkey' }), 'update')).toMatchObject(answer);
  });

  it('tells the limit of 50 subtasks in one word of its own: 409 CONTENT_TASK_LIMIT', () => {
    expect(taskLimitReached()).toMatchObject({ statusCode: 409, code: 'CONTENT_TASK_LIMIT', message: 'Um conteúdo tem até 50 subtarefas.' });
  });

  it('turns A0068 into the 400 of the comment of a return', () => {
    expect(translateTaskError(databaseError('A0068'), 'return')).toMatchObject({ statusCode: 400, code: 'CONTENT_TASK_COMMENT_INVALID', message: taskCommentInvalid().message });
  });

  it.each(['A0020', 'A0061'])('turns %s, the client archived, into 409 CLIENT_ARCHIVED', (code) => {
    expect(translateTaskError(databaseError(code), 'update')).toMatchObject({ statusCode: 409, code: 'CLIENT_ARCHIVED' });
  });

  it.each(['40P01', '40001'])('turns %s, a conflict that goes away by trying again, into 409 TRY_AGAIN', (code) => {
    expect(translateTaskError(databaseError(code), 'create')).toMatchObject({ statusCode: 409, code: 'TRY_AGAIN' });
  });

  it('leaves what it does not know to the caller: 42501 may be a client archived in the meantime, and a foreign key of another table is a bug', () => {
    expect(translateTaskError(databaseError('42501'), 'update')).toBeUndefined();
    expect(translateTaskError(databaseError('23503', { constraint: 'content_tasks_content_fk' }), 'create')).toBeUndefined();
    expect(translateTaskError(new Error('boom'), 'create')).toBeUndefined();
  });

  it('never carries a detail of the database in what it answers', () => {
    for (const code of ['A0020', 'A0060', 'A0061', 'A0068', 'A0070', 'A0071', 'A0073', 'A0074', '40P01']) {
      for (const action of ACTIONS) {
        const translated = translateTaskError(databaseError(code), action);
        expect(JSON.stringify(translated?.message)).not.toMatch(/A00\d\d|40P01|42501|pg_|relation|constraint/i);
      }
    }
  });
});
