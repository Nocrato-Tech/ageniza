import { useDocumentTitle } from './document-title.js';

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
