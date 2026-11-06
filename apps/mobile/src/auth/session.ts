import type { AuthSessionResponse, Context, ContextResolveResponse, LegalAcceptancesResponse, MeContextsResponse } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';

export type Entry = { kind: 'contexts'; contexts: Context[]; canCreateAgency?: boolean } | { kind: 'active'; context: Context } | { kind: 'empty'; canCreateAgency?: boolean } | { kind: 'unverified'; email: string } | { kind: 'legal'; documents: LegalAcceptancesResponse['documents'] };
export async function selectContext(api: ApiClient, context: Context): Promise<Entry> {
  await api.request('/me/last-context', { method: 'PUT', body: context.type === 'agency'
    ? { type: 'agency', agencyId: context.agencyId } : { type: 'client', clientId: context.clientId } });
  return { kind: 'active', context };
}
export async function resolveEntry(api: ApiClient, preferred?: string): Promise<Entry> {
  const session = await api.request<AuthSessionResponse>('/auth/session');
  if (session.emailVerified === false) return { kind: 'unverified', email: session.user.email };
  const legal = await api.request<LegalAcceptancesResponse>('/me/legal-acceptances');
  if (legal.required && legal.documents.some((document) => document.pending)) return { kind: 'legal', documents: legal.documents };
  const result = await api.request<ContextResolveResponse>(`/me/contexts/resolve${preferred ? `?preferred=${encodeURIComponent(preferred)}` : ''}`);
  if (result.decision === 'none') {
    const known = await api.request<MeContextsResponse>('/me/contexts').catch(() => undefined);
    return typeof known?.canCreateAgency === 'boolean' ? { kind: 'empty', canCreateAgency: known.canCreateAgency } : { kind: 'empty' };
  }
  if (result.decision === 'enter') return selectContext(api, result.context);
  return { kind: 'contexts', contexts: result.contexts, canCreateAgency: result.canCreateAgency };
}
export async function listContexts(api: ApiClient): Promise<Entry> {
  const result = await api.request<MeContextsResponse>('/me/contexts');
  return result.contexts.length ? { kind: 'contexts', contexts: result.contexts, canCreateAgency: result.canCreateAgency } : { kind: 'empty', canCreateAgency: result.canCreateAgency };
}
