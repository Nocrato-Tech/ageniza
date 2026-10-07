import { useDocumentTitle } from './document-title.js';
import { InvitationNotice } from './invitation-notice.js';

/**
 * Placeholder for the client portal shell (specs/clientes.md section 7). The destination after
 * login is already `/portal/:clienteId` (issue #181); the portal screens themselves belong to the
 * Clientes module (#134-#140), so this route only reserves the address without faking content.
 * The one-time `already_member` notice lives here: the portal is one of the two invitation
 * destinations (specs/auth.md section 7, decisions 2026-10-07).
 */
export function PortalHomePage() {
  useDocumentTitle('Portal do cliente — Ageniza');
  return <>
    <InvitationNotice />
    <section aria-labelledby="portal-home-title">
      <h1 id="portal-home-title">Portal do cliente</h1>
      <p>Esta área recebe as telas do portal nas próximas entregas.</p>
    </section>
  </>;
}
