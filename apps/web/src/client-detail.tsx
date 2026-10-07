import { Link, useParams } from 'react-router-dom';

import { useDocumentTitle } from './document-title.js';

/**
 * Minimal destination for the detail route (issue #135): a `201` navigates here, so the route has
 * to exist before its own task (#136) builds the header and the six tabs. It carries nothing but
 * the way back and the statement that the screen is still to come — no fake data, no dead control
 * (docs/design-system.md section 23).
 */
export function ClientDetailPage() {
  const { agenciaId = '' } = useParams();
  useDocumentTitle('Cliente — Ageniza');
  return <section aria-labelledby="client-detail-title" className="client-detail">
    <p><Link className="client-detail__back" to={`/agencia/${agenciaId}/clientes`}>← Clientes</Link></p>
    <h1 id="client-detail-title">Cliente</h1>
    <p>Esta área recebe o detalhe do cliente — cadastro, abas e resumo — na próxima entrega.</p>
  </section>;
}
