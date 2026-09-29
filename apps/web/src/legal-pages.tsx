import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@ageniza/ui';

import type { LegalDocument } from './legal/document.js';

/**
 * The public reading page for one legal document (`/termos`, `/privacidade`). The content is part
 * of the bundle -- no API route is consulted -- and the version is visible because it is what the
 * API records on acceptance (specs/auth.md section 7).
 */
export function LegalDocumentPage({ document, sibling }: {
  document: LegalDocument;
  sibling: { title: string; to: string };
}) {
  const navigate = useNavigate();

  return <article className="legal-document" aria-labelledby="legal-title">
    <h1 id="legal-title">{document.title}</h1>
    <p className="legal-version">Versão {document.version}</p>
    {document.draftNotice !== undefined && <p className="legal-draft" role="note">{document.draftNotice}</p>}
    {document.sections.map((section, index) => (
      <section key={section.heading}>
        <h2>{index + 1}. {section.heading}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {section.items !== undefined && <ul>
          {section.items.map((item) => <li key={item}>{item}</li>)}
        </ul>}
      </section>
    ))}
    <footer className="legal-footer">
      <Link to={sibling.to}>{sibling.title}</Link>
      <Button variant="ghost" onClick={() => navigate(-1)}>Voltar</Button>
    </footer>
  </article>;
}
