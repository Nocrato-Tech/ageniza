import { describe, expect, it } from 'vitest';

import { translateSubscriptionError } from './errors.js';

const refusal = (code: string): Error & { code: string } => Object.assign(new Error(`database detail ${code}: secret-detail`), { code });

describe('what the database refuses billing with', () => {
  it.each([
    ['A0110', 409, 'SUBSCRIPTION_NOT_AVAILABLE'],
    ['A0111', 409, 'SUBSCRIPTION_BELOW_CLIENTS'],
    ['A0112', 409, 'SUBSCRIPTION_MIXED_CHANGE'],
    ['A0113', 409, 'SUBSCRIPTION_UNCHANGED'],
    ['A0114', 409, 'CHARGE_NOT_OPEN'],
    ['A0116', 400, 'SUBSCRIPTION_INVALID'],
    ['A0117', 409, 'SUBSCRIPTION_BELOW_STORAGE'],
    ['A0124', 400, 'TEST_CARD_INVALID'],
    ['A0125', 409, 'CHARGE_NOT_OPEN'],
    ['42501', 403, 'FORBIDDEN'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN']
  ])('answers %s with %i %s, in Portuguese or the shared codes, and never with the detail of the database', (code, status, publicCode) => {
    const translated = translateSubscriptionError(refusal(code));
    expect(translated).toMatchObject({ statusCode: status, code: publicCode });
    expect(JSON.stringify([translated?.message, translated?.details])).not.toMatch(/secret-detail|database detail/);
  });

  it('leaves what is not its own to the general handler', () => {
    expect(translateSubscriptionError(refusal('XX000'))).toBeUndefined();
    expect(translateSubscriptionError(new Error('boom'))).toBeUndefined();
  });

  it('tells the test card refusal in Portuguese', () => {
    expect(translateSubscriptionError(refusal('A0124'))?.message).toMatch(/cartão de teste/);
  });
});
