/** Held by ownership alone: no role carries it, so the Admin and every custom role are refused. */
export const SUBSCRIPTION_PERMISSION = 'assinatura.gerenciar';

/** What the database stores a provider reference as: not blank, at most 200 bytes (not characters). */
export const PROVIDER_REFERENCE_MAX_BYTES = 200;

export const isProviderReference = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && Buffer.byteLength(value, 'utf8') <= PROVIDER_REFERENCE_MAX_BYTES;
