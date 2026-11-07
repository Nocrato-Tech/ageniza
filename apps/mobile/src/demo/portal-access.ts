import type { AuthSessionResponse, ClientListResponse, ClientMemberListResponse, Context, MeContextsResponse } from '@ageniza/contracts';
import { ClientMemberAddRequestSchema } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';
import { demoAgencyName, demoWorkspaceEnabled } from './config';

type Agency = Extract<Context, { type: 'agency' }>;
export type DemoPortal = Extract<Context, { type: 'client' }>;
const exampleClientName = 'Clínica Vida · Exemplo';

export async function prepareDemoPortalAccess(api: ApiClient, agency: Agency, signal?: AbortSignal): Promise<DemoPortal> {
  if (!demoWorkspaceEnabled || !agency.isOwner || agency.agencyName !== demoAgencyName) throw new Error('Este acesso só pode ser preparado na sua agência de demonstração.');
  function request<T>(path: string, options?: Parameters<ApiClient['request']>[1]): Promise<T> {
    signal?.throwIfAborted();
    return signal ? api.request<T>(path, { ...options, signal }) : options ? api.request<T>(path, options) : api.request<T>(path);
  }
  const session = await request<AuthSessionResponse>('/auth/session');
  if (session.emailVerified !== true) throw new Error('Confirme seu e-mail antes de preparar o acesso ao portal.');
  const contexts = await request<MeContextsResponse>('/me/contexts');
  if (!contexts.contexts.some((context) => context.type === 'agency' && context.agencyId === agency.agencyId && context.isOwner && context.agencyName === demoAgencyName)) throw new Error('Sua agência de demonstração não está disponível nesta conta.');
  const root = `/agencies/${agency.agencyId}`;
  let client: ClientListResponse['data'][number] | undefined;
  for (let page = 1, last = 1; page <= last; page += 1) {
    const response = await request<ClientListResponse>(`${root}/clients?page=${page}&pageSize=100`);
    client = response.data.find((item) => item.name === exampleClientName);
    if (client) break;
    last = response.meta.totalPages;
  }
  if (!client) throw new Error('Prepare os dados de exemplo antes de acessar o portal.');
  const clientId = client.id;
  const findPortal = (values: Context[]) => values.find((value): value is DemoPortal => value.type === 'client' && value.clientId === clientId && value.agencyId === agency.agencyId);
  const existing = findPortal(contexts.contexts);
  if (existing) return existing;
  const body = ClientMemberAddRequestSchema.parse({ email: session.user.email });
  let active = false;
  for (const status of ['active', 'removed'] as const) {
    for (let page = 1, last = 1; page <= last; page += 1) {
      const response = await request<ClientMemberListResponse>(`${root}/clients/${clientId}/members?status=${status}&page=${page}&pageSize=100`);
      const own = response.data.some((member) => member.email.trim().toLowerCase() === body.email.toLowerCase());
      if (own && status === 'removed') throw new Error('Seu acesso foi removido. Abra Clientes → Clínica Vida · Exemplo → Acessos → Removidos para conferir e reativar.');
      if (own) { active = true; break; }
      last = response.meta.totalPages;
    }
    if (active) break;
  }
  if (!active) await request(`${root}/clients/${clientId}/members`, { method: 'POST', body });
  const refreshed = await request<MeContextsResponse>('/me/contexts');
  const portal = findPortal(refreshed.contexts);
  if (!portal) throw new Error('O portal ainda não apareceu entre seus acessos. Tente novamente para conferir o vínculo existente.');
  return portal;
}
