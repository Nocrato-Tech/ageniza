import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AuthLogoutResponseSchema } from '@ageniza/contracts';
import { Button, LiveStatus } from '@ageniza/ui';
import { useQueryClient } from '@tanstack/react-query';

import { useAuthSession, useAuthSessionStore } from './auth.js';
import { AuthPanel } from './auth-layout.js';
import { useDocumentTitle } from './document-title.js';
import { ResendVerification } from './email-verification.js';
import { useApiClient } from './http.js';

/**
 * `/confirme-seu-email`: where the account of a copied invitation link waits (decision 2026-10-27). Its session opens
 * nothing until the e-mail is confirmed, so every area sends it here. The link in the e-mail confirms with one click
 * while this browser keeps the session, and then the same session opens the agency of the invitation.
 */
export function EmailPendingPage() {
  const httpClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const store = useAuthSessionStore();
  const session = useAuthSession(store);
  const [leaving, setLeaving] = useState(false);
  useDocumentTitle('Confirme seu e-mail — Ageniza');

  if (session.status === 'loading') return <AuthPanel titleId="email-pending-title" title="Confirme seu e-mail para entrar"><LiveStatus>Carregando…</LiveStatus></AuthPanel>;
  if (!session.isAuthenticated) return <Navigate to="/entrar" replace />;
  if (session.emailUnconfirmed !== true) return <Navigate to="/contextos" replace />;

  const leave = async (): Promise<void> => {
    setLeaving(true);
    try { await httpClient.request({ path: '/auth/logout', method: 'POST', response: AuthLogoutResponseSchema }); } catch { /* best effort */ }
    store.end();
    queryClient.clear();
    navigate('/entrar', { replace: true });
  };

  return <AuthPanel
    titleId="email-pending-title"
    title="Confirme seu e-mail para entrar"
    lead={`Enviamos um link para ${session.user?.email ?? 'o seu e-mail'}. Abra o e-mail e clique no link para entrar na agência. Ele vale por 24 horas.`}
  >
    <ResendVerification email={session.user?.email} idPrefix="pending" lead="Não chegou? Peça um novo link. O anterior deixa de valer." />
    <Button variant="secondary" className="auth-submit" onClick={() => { void leave(); }} loading={leaving}>Sair</Button>
  </AuthPanel>;
}
