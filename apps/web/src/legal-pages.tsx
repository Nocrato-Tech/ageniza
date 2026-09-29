import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@ageniza/ui';

import { useDocumentTitle } from './document-title.js';
import type { LegalDocument } from './legal/document.js';

/**
 * The public reading page for one legal document (`/termos`, `/privacidade`). The content is part
 * of the bundle -- no API route is consulted -- and the version is visible because it is what the
 * API records on acceptance (specs/auth.md section 7). Blocks are rendered in document order, so a
 * list stays attached to the paragraph that introduces it.
 */
export function LegalDocumentPage({ document, sibling }: {
  document: LegalDocument;
  sibling: { title: string; to: string };
}) {
  const navigate = useNavigate();
  const location = useLocation();
  useDocumentTitle(`${document.title} — Ageniza`);

  // Opened directly by URL or in a new tab, there is no in-app history to return to; `default` is
  // the key React Router gives the first location of a session, so fall back to the home page.
  const goBack = (): void => {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  return <article className="legal-document" aria-labelledby="legal-title">
    <h1 id="legal-title">{document.title}</h1>
    <p className="legal-version">Versão {document.version}</p>
    {document.draftNotice !== undefined && <p className="legal-draft" role="note">{document.draftNotice}</p>}
    {document.sections.map((section, index) => (
      <section key={section.heading}>
        <h2>{index + 1}. {section.heading}</h2>
        {section.blocks.map((block) => block.type === 'paragraph'
          ? <p key={block.text}>{block.text}</p>
          : <ul key={block.items.join('|')}>
            {block.items.map((item) => <li key={item}>{item}</li>)}
          </ul>)}
      </section>
    ))}
    <footer className="legal-footer">
      <Link to={sibling.to}>{sibling.title}</Link>
      <Button variant="ghost" onClick={goBack}>Voltar</Button>
    </footer>
  </article>;
}
