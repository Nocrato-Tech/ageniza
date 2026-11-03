import type { AuthSessionResponse, Context, ContextResolveResponse, LegalAcceptancesResponse, MeContextsResponse } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';

export type Entry = { kind: 'contexts'; contexts: Context[] } | { kind: 'active'; context: Context } | { kind: 'empty' } | { kind: 'legal'; documents: LegalAcceptancesResponse['documents'] };
export async function selectContext(api: ApiClient, context: Context): Promise<Entry> {
  await api.request('/me/last-context', { method: 'PUT', body: context.type === 'agency'
    ? { type: 'agency', agencyId: context.agencyId } : { type: 'client', clientId: context.clientId } });
  return { kind: 'active', context };
}
export async function resolveEntry(api: ApiClient): Promise<Entry> {
  const session = await api.request<AuthSessionResponse>('/auth/session');
  if (session.emailVerified === false) throw new Error('Confirme seu e-mail antes de entrar. Abra o link recebido e tente de novo.');
  const legal = await api.request<LegalAcceptancesResponse>('/me/legal-acceptances');
  if (legal.required && legal.documents.some((document) => document.pending)) return { kind: 'legal', documents: legal.documents };
  const result = await api.request<ContextResolveResponse>('/me/contexts/resolve');
  if (result.decision === 'none') return { kind: 'empty' };
  if (result.decision === 'enter') return selectContext(api, result.context);
  return { kind: 'contexts', contexts: result.contexts };
}
export async function listContexts(api: ApiClient): Promise<Entry> {
  const result = await api.request<MeContextsResponse>('/me/contexts');
  return result.contexts.length ? { kind: 'contexts', contexts: result.contexts } : { kind: 'empty' };
}
