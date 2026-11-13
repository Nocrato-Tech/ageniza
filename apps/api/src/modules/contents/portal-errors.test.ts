import { describe, expect, it } from 'vitest';

import { translatePortalError, type PortalContentAction } from './portal-errors.js';

const failure = (code: string): Error => Object.assign(new Error('database detail that never leaves'), { code });

const answer = (code: string, action: PortalContentAction = 'approve', options: { withNote?: boolean } = { withNote: true }) => {
  const translated = translatePortalError(failure(code), action, options);
  return translated === undefined ? undefined : { status: translated.statusCode, code: translated.code };
};

describe('the refusals of the database the portal answers by name (issue #257)', () => {
  it.each([
    ['A0060', 404, 'NOT_FOUND'],
    ['A0061', 404, 'NOT_FOUND'],
    ['A0020', 404, 'NOT_FOUND'],
    ['A0062', 409, 'CONTENT_NOT_AWAITING_APPROVAL'],
    ['A0063', 409, 'CONTENT_REVISION_CHANGED'],
    ['A0068', 400, 'CONTENT_APPROVAL_NOTE_INVALID'],
    ['A0123', 409, 'CONTENT_ALREADY_APPROVED'],
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
      'Este conteúdo não aceita mais pedido de ajuste: ele vale até a véspera da publicação.'
    ]);
  });

  it('leaves what the route reads again to the route: the refusal of the policy and anything unknown', () => {
    expect(answer('42501')).toBeUndefined();
    expect(answer('XX000')).toBeUndefined();
    expect(answer('23505')).toBeUndefined();
  });

  it('never carries the detail of the database', () => {
    for (const code of ['A0060', 'A0061', 'A0020', 'A0062', 'A0063', 'A0068', 'A0123', '40P01', '40001']) {
      expect(JSON.stringify(translatePortalError(failure(code), 'approve'))).not.toMatch(/database detail/);
      expect(translatePortalError(failure(code), 'approve')?.message).not.toMatch(/A0\d{3}|40P01|40001|database/);
    }
  });

  it('tells the person that the note of an approval was not sent when the content was already approved', () => {
    expect(translatePortalError(failure('A0123'), 'approve', { withNote: true })?.message).toBe('Este conteúdo já foi aprovado. Seu recado não foi enviado.');
  });

  it('tells the note of an approval apart from the comment of a request for changes: the same database code, two answers', () => {
    expect(answer('A0068', 'approve')).toEqual({ status: 400, code: 'CONTENT_APPROVAL_NOTE_INVALID' });
    expect(answer('A0068', 'request-changes')).toEqual({ status: 400, code: 'CONTENT_COMMENT_INVALID' });
    expect(answer('A0068', 'withdraw-approval')).toEqual({ status: 400, code: 'CONTENT_COMMENT_INVALID' });
    expect(translatePortalError(failure('A0068'), 'approve', { withNote: true })?.message).toMatch(/500 caracteres/);
  });

  it('keeps the answer of the approval link, which takes no note: A0068 is the comment there, on both decisions', () => {
    expect(answer('A0068', 'approve', {})).toEqual({ status: 400, code: 'CONTENT_COMMENT_INVALID' });
    expect(translatePortalError(failure('A0068'), 'approve')?.code).toBe('CONTENT_COMMENT_INVALID');
  });

  it('reports a withdrawal conflict separately from a decision awaiting approval', () => {
    expect(answer('A0062', 'withdraw-approval')).toEqual({ status: 409, code: 'CONTENT_APPROVAL_CANNOT_BE_WITHDRAWN' });
    expect(translatePortalError(failure('A0062'), 'withdraw-approval')?.message).toBe('Só é possível desfazer a aprovação antes da publicação.');
    expect(answer('A0063', 'withdraw-approval')).toEqual({ status: 409, code: 'CONTENT_REVISION_CHANGED' });
  });
});
