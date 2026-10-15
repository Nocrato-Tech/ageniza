import { Link } from 'react-router-dom';
import { ButtonLink } from '@ageniza/ui';

import { useDocumentTitle } from './document-title.js';
import { StatusPanel } from './status-panel.js';

/**
 * `/sem-acesso` is shown to someone whose credentials were correct but who has no context at all
 * (specs/auth.md section 7). It must never suggest a password problem -- the person got the password
 * right. The session is ended by whoever sends the person here, on the server, before navigating;
 * someone who arrives with a live session is redirected instead (the route guard).
 */
export function NoAccessPage() {
  useDocumentTitle('Sem acesso — Ageniza');

  return <StatusPanel as="section" titleId="no-access-title" title="Sua conta não tem acesso a nenhum espaço de trabalho" action={<ButtonLink as={Link} size="lg" to="/entrar">Voltar para entrar</ButtonLink>}>
    Isso acontece quando o vínculo com a agência foi encerrado. Fale com quem administra a agência para receber um novo convite.
  </StatusPanel>;
}
