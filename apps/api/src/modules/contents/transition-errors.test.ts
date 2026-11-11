import { describe, expect, it } from 'vitest';

import { translateTransitionError, type TransitionAction } from './transition-errors.js';

const failure = (code: string, constraint?: string): Error => Object.assign(new Error('database detail that never leaves'), { code, constraint });

const answer = (code: string, action: TransitionAction = 'submit') => {
  const translated = translateTransitionError(failure(code), action);
  return translated === undefined ? undefined : { status: translated.statusCode, code: translated.code };
};

describe('the refusals of the database a transition answers by name (issue #256)', () => {
  it.each([
    ['A0060', 404, 'NOT_FOUND'],
    ['A0061', 409, 'CLIENT_ARCHIVED'],
    ['A0020', 409, 'CLIENT_ARCHIVED'],
    ['A0062', 409, 'CONTENT_STATE'],
    ['A0063', 409, 'CONTENT_REVISION_CHANGED'],
    ['A0064', 409, 'CONTENT_UNPUBLISH_EXPIRED'],
    ['A0065', 409, 'CONTENT_MEDIA_INCOMPLETE'],
    ['A0066', 409, 'CONTENT_TASKS_NOT_APPROVED'],
    ['A0067', 400, 'CONTENT_PUBLISHED_ON_INVALID'],
    ['A0068', 400, 'CONTENT_APPROVAL_NOTE_INVALID'],
    ['A0120', 400, 'CONTENT_APPROVAL_DUE_INVALID'],
    ['A0121', 400, 'CONTENT_BATCH_INVALID'],
    ['A0122', 400, 'CONTENT_BATCH_MIXED_CLIENTS'],
    ['A0074', 403, 'FORBIDDEN'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ])('answers %s with %i %s', (code, status, name) => {
    expect(answer(code)).toEqual({ status, code: name });
  });

  it('reads A0068 as the reason of the approval outside the platform for that move, and as the note of the round for the send', () => {
    expect(answer('A0068', 'approve-by-agency')).toEqual({ status: 400, code: 'CONTENT_REASON_INVALID' });
    expect(answer('A0068', 'submit')).toEqual({ status: 400, code: 'CONTENT_APPROVAL_NOTE_INVALID' });
  });

  it('says what each action needs when the state is wrong, and a different thing for each', () => {
    const messages = (['submit', 'approve-by-agency', 'publish', 'unpublish', 'cancel', 'reschedule'] as const)
      .map((action) => translateTransitionError(failure('A0062'), action)?.message);
    expect(new Set(messages).size).toBe(6);
    expect(messages).toEqual([
      'Só um conteúdo em produção ou em ajuste é enviado para aprovação. Um conteúdo que já aguarda aprovação não muda de prazo nem de recado.',
      'Só um conteúdo aguardando aprovação é aprovado.',
      'Só um conteúdo aprovado é marcado como publicado.',
      'Só um conteúdo publicado volta a aprovado.',
      'Um conteúdo publicado não é cancelado.',
      'Só um conteúdo cancelado é reagendado.'
    ]);
  });

  it('leaves a row-level refusal and any failure it does not know to the caller', () => {
    expect(answer('42501')).toBeUndefined();
    expect(answer('XX000')).toBeUndefined();
    expect(translateTransitionError(new Error('no code at all'), 'submit')).toBeUndefined();
    expect(translateTransitionError(undefined, 'submit')).toBeUndefined();
  });

  it('never carries the detail of the database into the answer', () => {
    for (const code of ['A0060', 'A0061', 'A0062', 'A0063', 'A0064', 'A0065', 'A0066', 'A0067', 'A0068', 'A0074', 'A0120', 'A0121', 'A0122', '40P01']) {
      const translated = translateTransitionError(failure(code), 'publish');
      expect(JSON.stringify({ message: translated?.message, details: translated?.details })).not.toContain('database detail');
    }
  });
});
