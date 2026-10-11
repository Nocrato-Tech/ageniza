import { describe, expect, it } from 'vitest';

import { translateDatabaseError, type WriteContext } from './errors.js';

const quiet: WriteContext = { folderMoveKeepsCover: false };
const keepsCover: WriteContext = { folderMoveKeepsCover: true };
const failure = (code: string, constraint?: string): Error => Object.assign(new Error('database detail that never leaves'), { code, constraint });

const answer = (error: unknown, context: WriteContext = quiet) => {
  const translated = translateDatabaseError(error, context);
  return translated === undefined ? undefined : { status: translated.statusCode, code: translated.code };
};

describe('the refusals of the database a content route answers by name (issue #254)', () => {
  it.each([
    ['A0020', 409, 'CLIENT_ARCHIVED'],
    ['A0061', 409, 'CLIENT_ARCHIVED'],
    ['A0060', 404, 'NOT_FOUND'],
    ['A0062', 409, 'CONTENT_NOT_EDITABLE'],
    ['A0065', 409, 'CONTENT_MEDIA_INCOMPLETE'],
    ['A0069', 400, 'CONTENT_MEDIA_INVALID'],
    ['A0073', 400, 'CONTENT_OWNER_INVALID'],
    ['A0074', 403, 'FORBIDDEN'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ])('answers %s with %i %s', (code, status, name) => {
    expect(answer(failure(code))).toEqual({ status, code: name });
  });

  it.each([
    ['contents_folder_fk', quiet, 400, 'CONTENT_FOLDER_INVALID'],
    ['contents_cover_fk', quiet, 400, 'CONTENT_MEDIA_INVALID'],
    ['contents_cover_fk', keepsCover, 409, 'CONTENT_FOLDER_IN_USE'],
    ['content_media_content_fk', quiet, 409, 'CONTENT_FOLDER_IN_USE'],
    ['contents_owner_user_id_fkey', quiet, 400, 'CONTENT_OWNER_INVALID']
  ])('answers the foreign key %s by what it protects', (constraint, context, status, name) => {
    expect(answer(failure('23503', constraint), context)).toEqual({ status, code: name });
  });

  it('leaves a foreign key it does not know, a row-level refusal and any other failure to the caller', () => {
    expect(answer(failure('23503', 'some_other_fk'))).toBeUndefined();
    expect(answer(failure('42501'))).toBeUndefined();
    expect(answer(failure('XX000'))).toBeUndefined();
    expect(answer(new Error('no code at all'))).toBeUndefined();
    expect(answer(undefined)).toBeUndefined();
  });

  it('never carries the detail of the database into the answer', () => {
    for (const code of ['A0020', 'A0060', 'A0062', 'A0065', 'A0069', 'A0073', 'A0074', '40P01']) {
      const translated = translateDatabaseError(failure(code), quiet);
      expect(JSON.stringify({ message: translated?.message, details: translated?.details })).not.toContain('database detail');
    }
  });
});
