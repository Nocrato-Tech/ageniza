import { describe, expect, it } from 'vitest';
import { createPaymentProvider, PaymentProviderUnavailableError } from '../src/index.js';

const request = { idempotencyKey: '7d1f0c2e-3b8a-4c55-9f0e-0a1b2c3d4e5f', amountCents: 19_700, reference: '7d1f0c2e-3b8a-4c55-9f0e-0a1b2c3d4e5f' };

describe('payment provider factory', () => {
  it('builds nothing unless a provider is named, in any environment', async () => {
    for (const production of [false, true]) {
      await expect(createPaymentProvider({ production, provider: undefined })).resolves.toBeUndefined();
    }
  });

  it('builds the simulated provider outside production', async () => {
    const provider = await createPaymentProvider({ production: false, provider: 'simulado' });
    expect(provider?.name).toBe('simulado');
  });

  it('refuses the simulated provider in production', async () => {
    await expect(createPaymentProvider({ production: true, provider: 'simulado' })).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });
});

describe('simulated payment provider', () => {
  const simulated = async () => {
    const provider = await createPaymentProvider({ production: false, provider: 'simulado' });
    if (provider === undefined) throw new Error('expected the simulated provider');
    return provider;
  };

  it('approves the exact amount and answers the same reference for the same key, so a retry never charges twice', async () => {
    const provider = await simulated();
    const first = await provider.charge(request);
    expect(first).toEqual({ status: 'approved', providerRef: `sim:${request.idempotencyKey}`, paidCents: 19_700 });
    expect(await provider.charge(request)).toEqual(first);
    const other = await provider.charge({ ...request, idempotencyKey: 'other-key' });
    expect(other).toEqual({ status: 'approved', providerRef: 'sim:other-key', paidCents: 19_700 });
  });

  it('declines when the screen simulates a declined card, and approves when it says approved', async () => {
    const provider = await simulated();
    expect(await provider.charge({ ...request, testOutcome: 'declined' })).toEqual({ status: 'declined', reason: 'card_declined' });
    expect(await provider.charge({ ...request, testOutcome: 'approved' })).toMatchObject({ status: 'approved' });
  });

  it('declines an amount that is not a positive whole number of cents', async () => {
    const provider = await simulated();
    for (const amountCents of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await provider.charge({ ...request, amountCents })).toEqual({ status: 'declined', reason: 'invalid_amount' });
    }
  });

  it('refunds a charge it approved, whatever the number of times it is asked', async () => {
    const provider = await simulated();
    const charge = await provider.charge(request);
    if (charge.status !== 'approved') throw new Error('expected an approval');
    const refund = { idempotencyKey: `refund:${request.idempotencyKey}`, providerRef: charge.providerRef, amountCents: charge.paidCents };
    expect(await provider.refund(refund)).toEqual({ status: 'refunded' });
    expect(await provider.refund(refund)).toEqual({ status: 'refunded' });
  });

  it('refuses to refund what it never took: a reference of another provider, or an amount that is not a positive whole number of cents', async () => {
    const provider = await simulated();
    const refund = { idempotencyKey: 'refund-key', providerRef: 'sim:some-charge', amountCents: 19_700 };
    expect(await provider.refund({ ...refund, providerRef: 'asaas:pay_123' })).toEqual({ status: 'failed', reason: 'unknown_charge' });
    expect(await provider.refund({ ...refund, providerRef: '' })).toEqual({ status: 'failed', reason: 'unknown_charge' });
    for (const amountCents of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await provider.refund({ ...refund, amountCents })).toEqual({ status: 'failed', reason: 'invalid_amount' });
    }
  });

  it('keeps the provider reference inside the 200 bytes the database accepts for a charge id', async () => {
    const provider = await simulated();
    const result = await provider.charge(request);
    if (result.status !== 'approved') throw new Error('expected an approval');
    expect(Buffer.byteLength(result.providerRef, 'utf8')).toBeLessThanOrEqual(200);
  });
});
