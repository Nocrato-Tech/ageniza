import { describe, expect, it } from 'vitest';

import { translateDatabaseError } from './errors.js';

const failure = (code: string): Error => Object.assign(new Error('boom'), { code });

const answer = (code: string, side: 'agency' | 'portal', operation: 'edit' | 'send' | 'record') => {
  const translated = translateDatabaseError(failure(code), side, operation);
  return translated === undefined ? undefined : { statusCode: translated.statusCode, code: translated.code, message: translated.message };
};

describe('what the database raises inside the writes of the story scripts (#258)', () => {
  it('answers the codes of the functions and of the archive for the agency', () => {
    expect(answer('A0050', 'agency', 'send')).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'Story script not found.' });
    expect(answer('A0051', 'agency', 'send')).toEqual({ statusCode: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    expect(answer('A0020', 'agency', 'edit')).toEqual({ statusCode: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    expect(answer('A0052', 'agency', 'edit')).toEqual({ statusCode: 409, code: 'STORY_SCRIPT_STATE', message: 'Roteiro já enviado não é editado.' });
    expect(answer('A0052', 'agency', 'send')).toEqual({ statusCode: 409, code: 'STORY_SCRIPT_STATE', message: 'Só um roteiro em rascunho é enviado.' });
  });

  it('answers the portal that an archived client is "not found", never that it is archived', () => {
    for (const code of ['A0020', 'A0051']) {
      expect({ code, answer: answer(code, 'portal', 'record') }).toEqual({ code, answer: { statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' } });
    }
    expect(answer('A0050', 'portal', 'record')).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'Story script not found.' });
    expect(answer('A0052', 'portal', 'record')).toEqual({ statusCode: 409, code: 'STORY_SCRIPT_STATE', message: 'Só um roteiro enviado é marcado como gravado.' });
  });

  it('answers a deadlock and a serialization failure as "try again" on both sides', () => {
    for (const side of ['agency', 'portal'] as const) {
      for (const code of ['40P01', '40001']) {
        expect({ side, code, answer: answer(code, side, 'send') }).toEqual({ side, code, answer: { statusCode: 409, code: 'TRY_AGAIN', message: 'Houve um conflito momentâneo. Tente de novo.' } });
      }
    }
  });

  it('leaves the refusal of the policy and every unknown error to the route, which knows what it read', () => {
    for (const code of ['42501', '23505', '23503', 'A0060', 'A0021', 'XX000']) {
      expect({ code, answer: answer(code, 'agency', 'edit') }).toEqual({ code, answer: undefined });
    }
    expect(translateDatabaseError(new Error('no code'), 'agency', 'edit')).toBeUndefined();
  });
});
