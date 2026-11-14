import { HttpError } from '@ageniza/core';
import { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

import { tryAgain } from '../../plugins/infra/conflict.js';

const conflict = (code: string, message: string): HttpError => new HttpError({ statusCode: 409, code, message });

export const chargeNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Charge not found.' });

export const chargeNotOpen = (): HttpError => conflict('CHARGE_NOT_OPEN', 'Esta cobrança não está mais aberta. Peça uma nova.');

export const paymentProviderFailed = (): HttpError => new HttpError({
  statusCode: 502,
  code: 'PAYMENT_PROVIDER_FAILED',
  message: 'O provedor de pagamento não respondeu como esperado. Tente de novo.'
});

/**
 * What the database refuses a billing operation with (migrations 20261029000100 to 20261029000400, 20261112000300 and 20261112000301): each code has one public answer,
 * and the lost race is the same `TRY_AGAIN` as everywhere. Anything else is not ours to translate.
 */
export const translateSubscriptionError = (error: unknown): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  switch (databaseErrorCode(error)) {
    case 'A0110': return conflict('SUBSCRIPTION_NOT_AVAILABLE', 'Esta operação não está disponível para a assinatura da agência neste momento.');
    case 'A0111': return conflict('SUBSCRIPTION_BELOW_CLIENTS', 'O novo plano comporta menos clientes do que os ativos. Arquive clientes antes de reduzir.');
    case 'A0117': return conflict('SUBSCRIPTION_BELOW_STORAGE', 'O novo plano comporta menos armazenamento do que o usado. Remova arquivos antes de reduzir.');
    case 'A0112': return conflict('SUBSCRIPTION_MIXED_CHANGE', 'Aumentar um limite e reduzir outro não podem ir juntos. Faça uma mudança de cada vez.');
    case 'A0113': return conflict('SUBSCRIPTION_UNCHANGED', 'A assinatura já tem estas condições.');
    case 'A0114': return chargeNotOpen();
    case 'A0125': return chargeNotOpen();
    case 'A0124': return new HttpError({ statusCode: 400, code: 'TEST_CARD_INVALID', message: 'Só o cartão de teste é aceito: os quatro últimos dígitos, a validade e a marca de teste.' });
    case 'A0116': return new HttpError({ statusCode: 400, code: 'SUBSCRIPTION_INVALID', message: 'O plano ou a quantidade de extras informados não valem.' });
    case '42501': return new HttpError({ statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
    default: return undefined;
  }
};

const FIELDS_ACCEPTED = 'Só last4, expMonth, expYear e brand são aceitos.';

const CONTRACT_FIELDS: ReadonlySet<string> = new Set(['last4', 'expMonth', 'expYear', 'brand']);

const contractFieldOf = (path: unknown): string => {
  const first = typeof path === 'string' ? path.split('.', 1)[0] : '';
  return CONTRACT_FIELDS.has(first) ? first : '';
};

/**
 * The generic validation answer names an unknown field, and on the test card the name of a field can be the number of the card. It
 * shows up in the message of an unknown key and, through the ceiling on lists that runs before the schema, in the path. Only this route
 * swaps the message for a fixed one and cuts every path down to the contract field it starts with, or to nothing when it starts with
 * anything else; the rest of the answer (code, other issues) stays as the plugin built it.
 */
export const withoutFieldNames = <TResult>(parse: () => TResult): TResult => {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'VALIDATION_ERROR') throw error;
    const issues = (error.details as { issues?: unknown } | undefined)?.issues;
    if (!Array.isArray(issues)) throw error;
    throw new HttpError({
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: {
        issues: issues.map((issue: { code?: unknown; path?: unknown }) => ({
          ...issue,
          path: contractFieldOf(issue.path),
          ...(issue.code === 'unrecognized_keys' ? { message: FIELDS_ACCEPTED } : {})
        }))
      }
    });
  }
};
