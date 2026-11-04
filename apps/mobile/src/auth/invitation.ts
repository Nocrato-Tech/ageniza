import { AuthLoginRequestSchema, InvitationAcceptNewAccountRequestSchema } from '@ageniza/contracts';
import type { AuthLoginResponse, InvitationAcceptResponse, InvitationContext, InvitationPreviewResponse } from '@ageniza/contracts';
import type { ApiClient } from '../api/client';

export async function acceptInvitation(api: ApiClient, token: string, preview: InvitationPreviewResponse, input: { name: string; password: string; confirmation: string; accepted: boolean }): Promise<InvitationContext> {
  const root = `/invitations/${encodeURIComponent(token)}`;
  if (preview.accountExists) {
    const parsed = AuthLoginRequestSchema.safeParse({ email: preview.email, password: input.password, inviteToken: token });
    if (!parsed.success) throw new Error('Informe a senha da conta convidada.');
    const login = await api.request<AuthLoginResponse>('/auth/login', { method: 'POST', body: parsed.data });
    if (login.user.email.toLowerCase() !== preview.email.toLowerCase()) throw new Error('Entre com o e-mail que recebeu o convite.');
    return (await api.request<InvitationAcceptResponse>(`${root}/accept`, { method: 'POST' })).context;
  }
  if (input.password !== input.confirmation) throw new Error('As senhas precisam ser iguais.');
  const parsed = InvitationAcceptNewAccountRequestSchema.safeParse({ name: input.name, password: input.password, acceptTerms: input.accepted });
  if (!parsed.success) throw new Error('Informe seu nome, uma senha de 10 a 128 caracteres e aceite os documentos.');
  return (await api.request<InvitationAcceptResponse>(`${root}/accept-new-account`, { method: 'POST', body: parsed.data })).context;
}

export const invitationPreferredContext = (context: InvitationContext) => context.clientId ? `client:${context.clientId}` : `agency:${context.agencyId}`;
