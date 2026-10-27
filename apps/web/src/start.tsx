import { Button } from '@ageniza/ui';

import { useDocumentTitle } from './document-title.js';
import { StatusPanel } from './status-panel.js';

/**
 * `/comecar`: the confirmed account with no context lands here, with its session (specs/auth.md
 * section 13), instead of `/sem-acesso`. Creating an agency is issue #709; until its route exists the
 * button holds its place, disabled.
 */
export function StartPage() {
  useDocumentTitle('Começar — Ageniza');

  return <StatusPanel
    as="section"
    titleId="start-title"
    title="Sua conta está pronta"
    action={<>
      <Button size="lg" disabled aria-describedby="start-create-agency-note">Criar agência</Button>
      <p id="start-create-agency-note" className="auth-note">A criação de agência pelo Ageniza chega em breve.</p>
    </>}
  >
    Crie a sua agência para começar. Convites para participar de uma agência e acessos ao portal de um cliente aparecem aqui quando chegarem.
  </StatusPanel>;
}
