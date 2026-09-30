import { PutLastContextResponseSchema, type Context } from '@ageniza/contracts';

import type { HttpClient } from './http.js';

/**
 * Where a context lives in the browser (docs/business/decisions.md, 2026-09-29): the agency area
 * under `/agencia/:agenciaId/...`, the client portal under `/portal/:clienteId`. `/app` is no
 * longer a destination.
 */
export const contextDestination = (context: Context): string =>
  context.type === 'agency' ? `/agencia/${context.agencyId}` : `/portal/${context.clientId}`;

/**
 * Records the context being entered as the person's last one. Best effort on purpose: the
 * preference is what the next login uses, and a failure here must never block entering a context
 * that `resolve` has already validated.
 */
export const rememberContext = async (httpClient: HttpClient, context: Context): Promise<void> => {
  try {
    await httpClient.request({
      path: '/me/last-context',
      method: 'PUT',
      body: context.type === 'agency'
        ? { type: 'agency' as const, agencyId: context.agencyId }
        : { type: 'client' as const, clientId: context.clientId },
      response: PutLastContextResponseSchema
    });
  } catch {
    // Ignored: the destination does not depend on the preference.
  }
};
