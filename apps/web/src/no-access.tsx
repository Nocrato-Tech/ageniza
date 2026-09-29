import { useEffect } from 'react';
import { Link } from 'react-router-dom';

import { useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';

/**
 * `/sem-acesso` is shown to someone whose credentials were correct but who has no context at all
 * (specs/auth.md section 7). It must never suggest a password problem -- the person got the password
 * right -- and no session may be alive while it is displayed, so it ends any remaining one.
 */
export function NoAccessPage() {
  const authStore = useAuthSessionStore();
  useDocumentTitle('Sem acesso — Ageniza');

  useEffect(() => {
    authStore.end();
  }, [authStore]);

  return <section className="form-panel" aria-labelledby="no-access-title">
    <h1 id="no-access-title">Sua conta não tem acesso a nenhum espaço de trabalho</h1>
    <p>Isso acontece quando o vínculo com a agência foi encerrado. Fale com quem administra a agência para receber um novo convite.</p>
    <Link to="/entrar">Voltar para entrar</Link>
  </section>;
}
