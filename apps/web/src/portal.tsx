import { Outlet } from 'react-router-dom';

import { useDocumentTitle } from './document-title.js';
import { LegalNotice } from './legal-notice.js';

/** The portal area: every portal screen sits under the legal notice (issue #81). */
export function PortalAreaLayout() {
  return <>
    <LegalNotice />
    <Outlet />
  </>;
}

/**
 * Placeholder for the client portal shell (specs/clientes.md section 7). The destination after
 * login is already `/portal/:clienteId` (issue #181); the portal screens themselves belong to the
 * Clientes module (#134-#140), so this route only reserves the address without faking content.
 */
export function PortalHomePage() {
  useDocumentTitle('Portal do cliente — Ageniza');
  return <section aria-labelledby="portal-home-title">
    <h1 id="portal-home-title">Portal do cliente</h1>
    <p>Esta área recebe as telas do portal nas próximas entregas.</p>
  </section>;
}
