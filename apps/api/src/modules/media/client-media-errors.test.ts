import { describe, expect, it } from 'vitest';

import { translateClientMediaError } from './client-media-errors.js';

const failure = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error('boom'), { code, ...extra });

const answer = (error: unknown): { statusCode: number | undefined; code: string | undefined; message: string | undefined } => {
  const translated = translateClientMediaError(error);
  return { statusCode: translated?.statusCode, code: translated?.code, message: translated?.message };
};

describe('what the writes of the client media library answer when the database refuses (#253)', () => {
  it('answers each code of the media functions and of the archive with its own status and code', () => {
    expect(answer(failure('A0080'))).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'Folder not found.' });
    expect(answer(failure('A0081'))).toEqual({ statusCode: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    expect(answer(failure('A0020'))).toEqual({ statusCode: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    expect(answer(failure('A0082')).code).toBe('MEDIA_IN_USE');
    expect(answer(failure('A0082')).statusCode).toBe(409);
  });

  it('answers a deadlock and a serialization failure as "try again", never as a 500', () => {
    for (const raised of ['40P01', '40001']) {
      expect({ raised, ...answer(failure(raised)) })
        .toEqual({ raised, statusCode: 409, code: 'TRY_AGAIN', message: 'Houve um conflito momentâneo. Tente de novo.' });
    }
  });

  it('answers a parent that is not a first-level folder as a validation error on parentId', () => {
    const translated = translateClientMediaError(failure('23503', { constraint: 'media_folders_parent_fk' }));

    expect(translated?.statusCode).toBe(400);
    expect(translated?.details).toEqual({ issues: [{ path: 'parentId', code: 'custom', message: 'parentId must be a first-level folder of this client.' }] });
  });

  it('leaves the refusal of the policy and every unknown error to the route, which knows what it read', () => {
    for (const code of ['42501', '23503', '23505', 'A0060', 'A0021']) expect({ code, translated: translateClientMediaError(failure(code)) }).toEqual({ code, translated: undefined });
    expect(translateClientMediaError(new Error('no code'))).toBeUndefined();
  });
});
