import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MailCheck } from 'lucide-react';

import { Avatar, Button, Skeleton } from '@ageniza/ui';

import { AccountSessions } from './account-sessions.js';
import { useAuthSession, useAuthSessionStore } from './auth.js';
import { useDocumentTitle } from './document-title.js';
import { EmailChangeDialog } from './email-change.js';

/** "Conta e sessões" (specs/auth.md section 14): the same screen under the agency and under the portal. */
export function AccountPage() {
  const session = useAuthSession(useAuthSessionStore());
  const location = useLocation();
  const navigate = useNavigate();
  // Coming back from the Google confirmation of an e-mail change (`GoogleLandingPage`): the dialog reopens in its Google mode.
  const [reopenedViaGoogle, setReopenedViaGoogle] = useState(() => (location.state as { reopenEmailChange?: unknown } | null)?.reopenEmailChange === true);
  const [emailChangeOpen, setEmailChangeOpen] = useState(reopenedViaGoogle);
  const user = session.user;
  // The marker is spent on arrival, so a reload or a later visit to the same entry does not reopen the dialog.
  useEffect(() => {
    if (reopenedViaGoogle) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, []);
  useDocumentTitle('Conta e sessões — Ageniza');

  return <section className="account-page" aria-labelledby="account-title">
    <header className="account-page__head">
      <p className="account-page__eyebrow">Conta</p>
      <h1 id="account-title">Conta e sessões</h1>
      <p className="account-page__lead">Veja onde a sua conta está aberta e encerre o que não reconhece.</p>
    </header>

    <div className="account-page__body">
      <section className="account-card" aria-labelledby="account-identity-title">
        <h2 id="account-identity-title">Conta</h2>
        {user === null ? <Skeleton className="account-card__skeleton" /> : <div className="account-card__person">
          <Avatar name={user.name} size="lg" tone="violet" />
          <div className="account-card__text">
            <p className="account-card__name">{user.name}</p>
            <p className="account-card__email">{user.email}</p>
          </div>
        </div>}
        <Button className="account-card__action" variant="ghost" leadingIcon={<MailCheck />} disabled={user === null} onClick={() => { setEmailChangeOpen(true); }}>
          Pedir troca de e-mail
        </Button>
      </section>

      <AccountSessions />
    </div>

    {emailChangeOpen && <EmailChangeDialog viaGoogle={reopenedViaGoogle} returnTo={`${location.pathname}${location.search}`} onClose={() => { setEmailChangeOpen(false); setReopenedViaGoogle(false); }} />}
  </section>;
}
