import { PutLastContextResponseSchema, type Context } from '@ageniza/contracts';

import type { HttpClient } from './http.js';

/**
 * Where a context lives in the browser (docs/business/decisions.md, 2026-09-29): the agency area
 * under `/agencia/:agenciaId/...`, the client portal under `/portal/:clienteId/inicio`. `/app` is no
 * longer a destination. Takes the two tenant identifiers, so a fresh invitation acceptance — whose
 * response carries only the ids — uses the same mapping as a resolved context. The portal goes
 * straight to its Início: an index redirect would change the path under the one-time
 * `already_member` notice, which reads that as navigating away and hides itself.
 */
export const contextDestination = (context: ContextTarget): string =>
  context.type === 'agency' ? `/agencia/${context.agencyId}` : `/portal/${context.clientId}/inicio`;

/** The two tenant identifiers a destination and `PUT /me/last-context` need. */
export type ContextTarget =
  | { readonly type: 'agency'; readonly agencyId: string }
  | { readonly type: 'client'; readonly clientId: string };

export const contextTarget = (context: Context): ContextTarget =>
  context.type === 'agency'
    ? { type: 'agency', agencyId: context.agencyId }
    : { type: 'client', clientId: context.clientId };

/**
 * The context a saved destination (issue #71) points at, when it is an agency or portal address.
 * Any other address has no context to record.
 */
export const targetFromDestination = (path: string): ContextTarget | null => {
  const match = /^\/(agencia|portal)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i.exec(path);
  if (match === null) return null;
  return match[1]!.toLowerCase() === 'agencia'
    ? { type: 'agency', agencyId: match[2]! }
    : { type: 'client', clientId: match[2]! };
};

/**
 * Records the context being entered as the person's last one. Best effort on purpose: the
 * preference is what the next login uses, and a failure here must never block entering a context
 * that `resolve` has already validated.
 */
export const rememberContext = async (httpClient: HttpClient, target: ContextTarget): Promise<void> => {
  try {
    await httpClient.request({
      path: '/me/last-context',
      method: 'PUT',
      body: target.type === 'agency'
        ? { type: 'agency' as const, agencyId: target.agencyId }
        : { type: 'client' as const, clientId: target.clientId },
      response: PutLastContextResponseSchema
    });
  } catch {
    // Ignored: the destination does not depend on the preference.
  }
};
