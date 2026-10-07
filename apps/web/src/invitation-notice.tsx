import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@ageniza/ui';

/** Navigation state that carries the one-time `already_member` notice to the destination. */
export interface InvitationNoticeState {
  readonly invitationNotice: { readonly agencyName: string };
}

export const invitationNoticeState = (agencyName: string): InvitationNoticeState => ({
  invitationNotice: { agencyName }
});

const readAgencyName = (state: unknown): string | null => {
  if (typeof state !== 'object' || state === null || !('invitationNotice' in state)) return null;
  const notice = (state as { invitationNotice: unknown }).invitationNotice;
  if (typeof notice !== 'object' || notice === null) return null;
  const { agencyName } = notice as { agencyName?: unknown };
  return typeof agencyName === 'string' && agencyName.length > 0 ? agencyName : null;
};

/**
 * `already_member` acceptance tells the person at the destination that nothing changed
 * (specs/auth.md section 7). The notice travels in the navigation state and is consumed on the
 * first render: closing it or navigating away ends it for good, and back/forward never brings it
 * back because the state is stripped from the entry right away.
 */
export function InvitationNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [agencyName] = useState(() => readAgencyName(location.state));
  const [startPathname] = useState(location.pathname);
  const [visible, setVisible] = useState(agencyName !== null);

  useEffect(() => {
    if (agencyName === null) return;
    navigate(`${location.pathname}${location.search}`, { replace: true });
  }, [agencyName, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (location.pathname !== startPathname) setVisible(false);
  }, [location.pathname, startPathname]);

  if (!visible || agencyName === null) return null;

  return <>
    <p role="status">Você já fazia parte de {agencyName}. Nada mudou no seu acesso.</p>
    <Button variant="ghost" size="sm" onClick={() => setVisible(false)}>Fechar</Button>
  </>;
}
