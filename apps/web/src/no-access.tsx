import { Link } from 'react-router-dom';

import { useDocumentTitle } from './document-title.js';

/**
 * `/sem-acesso` is shown to someone whose credentials were correct but who has no context at all
 * (specs/auth.md section 7). It must never suggest a password problem -- the person got the password
 * right. The session is ended by whoever sends the person here, on the server, before navigating;
 * someone who arrives with a live session is redirected instead (the route guard).
 */
export function NoAccessPage() {
  useDocumentTitle('Sem acesso — Ageniza');

  return <section className="form-panel" aria-labelledby="no-access-title">
    <h1 id="no-access-title">Sua conta não tem acesso a nenhum espaço de trabalho</h1>
    <p>Isso acontece quando o vínculo com a agência foi encerrado. Fale com quem administra a agência para receber um novo convite.</p>
    <Link to="/entrar">Voltar para entrar</Link>
  </section>;
}
