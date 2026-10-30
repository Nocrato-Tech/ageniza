import { useState } from 'react';

import { Button } from '@ageniza/ui';

import { CREATE_AGENCY_LABEL, CreateAgencyDialog } from './create-agency.js';
import { useDocumentTitle } from './document-title.js';
import { StatusPanel } from './status-panel.js';

/**
 * `/comecar`: the confirmed account with no context lands here, with its session (specs/auth.md
 * section 13), instead of `/sem-acesso`. "Criar agência" opens the same dialog as the account menu and
 * the contexts screen (issue #714), which enters the new agency.
 */
export function StartPage() {
  useDocumentTitle('Começar — Ageniza');
  const [createOpen, setCreateOpen] = useState(false);

  return <StatusPanel
    as="section"
    titleId="start-title"
    title="Bem-vindo ao Ageniza"
    action={<>
      <Button size="lg" aria-describedby="start-invite-note" onClick={() => { setCreateOpen(true); }}>{CREATE_AGENCY_LABEL}</Button>
      <p id="start-invite-note" className="auth-note">Foi convidado por uma agência? Entre pelo link do e-mail de convite.</p>
      {createOpen && <CreateAgencyDialog onClose={() => { setCreateOpen(false); }} />}
    </>}
  >
    Crie a sua agência para organizar os conteúdos e as aprovações dos seus clientes. Você tem 14 dias grátis para testar.
  </StatusPanel>;
}
