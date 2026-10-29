import type { ChargeRequest, ChargeResult, PaymentProvider, RefundRequest, RefundResult } from '../index.js';

/** Approves every charge unless the screen asked for a declined card. The card itself never gets here. */
export const createSimulatedPaymentProvider = (): PaymentProvider => ({
  name: 'simulado',
  charge: (request: ChargeRequest): Promise<ChargeResult> => {
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) return Promise.resolve({ status: 'declined', reason: 'invalid_amount' });
    if (request.testOutcome === 'declined') return Promise.resolve({ status: 'declined', reason: 'card_declined' });
    return Promise.resolve({ status: 'approved', providerRef: `sim:${request.idempotencyKey}`, paidCents: request.amountCents });
  },
  // Answers as a provider does for what it never took: a reference this provider did not issue, or a zero or fractional amount, is refused.
  refund: (request: RefundRequest): Promise<RefundResult> => {
    if (!request.providerRef.startsWith('sim:')) return Promise.resolve({ status: 'failed', reason: 'unknown_charge' });
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) return Promise.resolve({ status: 'failed', reason: 'invalid_amount' });
    return Promise.resolve({ status: 'refunded' });
  }
});
