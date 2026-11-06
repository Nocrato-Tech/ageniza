import { describe, expect, it } from 'vitest';
import { assessConfirmation, assessPassword } from './password-assessment';

describe('new-password guidance', () => {
  it('reports missing length, both boundaries and validity from the API policy', () => {
    expect(assessPassword('')).toMatchObject({ valid: false, missing: 10, excess: 0, score: 0 });
    expect(assessPassword('abc')).toMatchObject({ valid: false, missing: 7, excess: 0 });
    expect(assessPassword('a'.repeat(10))).toMatchObject({ valid: true, missing: 0, excess: 0 });
    expect(assessPassword('a'.repeat(128))).toMatchObject({ valid: true, excess: 0 });
    expect(assessPassword('a'.repeat(129))).toMatchObject({ valid: false, excess: 1 });
  });
  it('keeps the estimate independent from acceptance and penalizes predictable patterns', () => {
    for (const password of ['aaaaaaaaaa', 'Senha123456!', 'abcdabcdabcdabcd', '12345678901234567890']) {
      expect(assessPassword(password)).toMatchObject({ valid: true, score: 1 });
    }
    expect(assessPassword('abc')).toMatchObject({ valid: false, score: 1 });
    expect(assessPassword('ventoazulado')).toMatchObject({ valid: true, score: 2 });
    expect(assessPassword('vento de outono')).toMatchObject({ valid: true, score: 3 });
    expect(assessPassword('caderno nuvem oceano distante')).toMatchObject({ valid: true, score: 4 });
    expect(assessPassword('a'.repeat(129))).toMatchObject({ valid: false, score: 1 });
  });
  it('explains empty, incomplete, different and matching confirmation as either value changes', () => {
    expect(assessConfirmation('', '')).toBe('empty');
    expect(assessConfirmation('new-password', '')).toBe('empty');
    expect(assessConfirmation('new-password', 'new-')).toBe('incomplete');
    expect(assessConfirmation('new-password', 'old-')).toBe('different');
    expect(assessConfirmation('new-password', 'new-password')).toBe('match');
    expect(assessConfirmation('changed-password', 'new-password')).toBe('different');
    expect(assessConfirmation('', 'new-password')).toBe('different');
  });
});
