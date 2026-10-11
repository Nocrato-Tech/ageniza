import { describe, expect, it } from 'vitest';

import { translatePortalError, type PortalContentAction } from './portal-errors.js';

const failure = (code: string): Error => Object.assign(new Error('database detail that never leaves'), { code });

const answer = (code: string, action: PortalContentAction = 'approve') => {
  const translated = translatePortalError(failure(code), action);
  return translated === undefined ? undefined : { status: translated.statusCode, code: translated.code };
};

describe('the refusals of the database the portal answers by name (issue #257)', () => {
  it.each([
    ['A0060', 404, 'NOT_FOUND'],
    ['A0061', 404, 'NOT_FOUND'],
    ['A0020', 404, 'NOT_FOUND'],
    ['A0062', 409, 'CONTENT_NOT_AWAITING_APPROVAL'],
    ['A0063', 409, 'CONTENT_REVISION_CHANGED'],
    ['A0068', 400, 'CONTENT_COMMENT_INVALID'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ])('answers %s with %i %s', (code, status, name) => {
    expect(answer(code)).toEqual({ status, code: name });
  });

  it('never tells the portal that a client is archived: the archive wins the race as the same 404 a missing client is', () => {
    const archived = translatePortalError(failure('A0020'), 'approve');
    const missing = translatePortalError(failure('A0060'), 'approve');
    expect(archived?.statusCode).toBe(404);
    expect(archived?.message).not.toMatch(/arquiv|archiv/i);
    expect(missing?.message).not.toMatch(/arquiv|archiv/i);
  });

  it('says what each move needs when the state is wrong, and a different thing for each', () => {
    const messages = (['approve', 'request-changes'] as const).map((action) => translatePortalError(failure('A0062'), action)?.message);
    expect(messages).toEqual([
      'Só um conteúdo aguardando aprovação é aprovado.',
      'Só um conteúdo aguardando aprovação recebe um pedido de ajuste.'
    ]);
  });

  it('leaves what the route reads again to the route: the refusal of the policy and anything unknown', () => {
    expect(answer('42501')).toBeUndefined();
    expect(answer('XX000')).toBeUndefined();
    expect(answer('23505')).toBeUndefined();
  });

  it('never carries the detail of the database', () => {
    for (const code of ['A0060', 'A0061', 'A0020', 'A0062', 'A0063', 'A0068', '40P01', '40001']) {
      expect(JSON.stringify(translatePortalError(failure(code), 'approve'))).not.toMatch(/database detail/);
      expect(translatePortalError(failure(code), 'approve')?.message).not.toMatch(/A00\d\d|40P01|40001|database/);
    }
  });
});
