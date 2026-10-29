/** The provider names the database accepts in `confirm_subscription_charge` and `renew_subscription`. */
export type PaymentProviderName = 'simulado' | 'asaas';

export interface ChargeRequest {
  /** Same key, same outcome: a retry never charges twice. The API sends the `charge_id`. */
  readonly idempotencyKey: string;
  readonly amountCents: number;
  /** What ties the payment back to the charge at the provider (`externalReference` at Asaas): the `charge_id`. */
  readonly reference: string;
  /** Read only by the simulated provider, to let a screen simulate a declined card. A real provider ignores it. */
  readonly testOutcome?: 'approved' | 'declined';
}

export type ChargeResult =
  | { readonly status: 'approved'; readonly providerRef: string; readonly paidCents: number }
  | { readonly status: 'declined'; readonly reason: string };

export interface RefundRequest {
  /** Same key, same outcome: a retry never refunds twice. */
  readonly idempotencyKey: string;
  /** The reference the provider answered when it approved the charge. */
  readonly providerRef: string;
  /** What the provider took, back in full: a partial refund is not something the product does. */
  readonly amountCents: number;
}

export type RefundResult =
  | { readonly status: 'refunded' }
  | { readonly status: 'failed'; readonly reason: string };

/** The only door to a payment provider: application code depends on this, never on an adapter or a vendor SDK. */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  /** Gives back a charge the product could not honor, such as a renewal whose amount changed while it was being charged. */
  refund(request: RefundRequest): Promise<RefundResult>;
}

export interface PaymentProviderOptions {
  /** The deployment is the real production: `APP_ENV=production` and not the shared dev environment (`runsAsProduction` of @ageniza/config). */
  readonly production: boolean;
  /** `PAYMENTS_PROVIDER`; absent means nobody can pay. */
  readonly provider: 'simulado' | undefined;
}

export class PaymentProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderUnavailableError';
  }
}

/**
 * Fails closed: the simulated provider is built only when asked for by name and outside production, and its code
 * is loaded here and nowhere else, so an image built without it (see apps/api/Dockerfile) cannot run it.
 */
export const createPaymentProvider = async (options: PaymentProviderOptions): Promise<PaymentProvider | undefined> => {
  if (options.provider === undefined) return undefined;
  if (options.production) throw new PaymentProviderUnavailableError('The simulated payment provider must not run in production.');
  try {
    const { createSimulatedPaymentProvider } = await import('./simulated/index.js');
    return createSimulatedPaymentProvider();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') throw new PaymentProviderUnavailableError('The simulated payment provider is not part of this build.');
    throw error;
  }
};
