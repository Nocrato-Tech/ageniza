import { Logo, Pill } from '@ageniza/ui';
import { useEffect } from 'react';
import { Link, NavLink, useLocation, useParams } from 'react-router-dom';

import { useDocumentTitle } from '../document-title.js';
import { ApiReference } from './api-reference.js';
import { guide } from './content.js';
import { GuideMarkdown } from './markdown.js';
import { API_REFERENCE_KEY, MOBILE_BASE, pagePath } from './links.js';
import { NotFoundPage } from '../status-pages.js';
import './mobile-docs.css';

export const MOBILE_DOCS_MARKER = 'ageniza-mobile-docs-page';

/** Brings the target of the address (`#anchor`) into view, or the top of the page when there is none. */
function useScrollToHash(key: string): void {
  const { hash } = useLocation();
  useEffect(() => {
    const target = hash === '' ? null : document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target !== null) target.scrollIntoView?.({ block: 'start' });
    else window.scrollTo?.(0, 0);
  }, [key, hash]);
}

function Guide({ pageKey }: { pageKey: string }) {
  const index = guide.findIndex((page) => page.key === pageKey);
  const page = guide[index];
  useDocumentTitle(page === undefined ? 'Página não encontrada — Ageniza' : `${page.title} — Ageniza para o time mobile`);
  useScrollToHash(pageKey);
  if (page === undefined) return <main id="mdocs-main" className="mdocs-main"><NotFoundPage as="section" /></main>;

  const previous = guide[index - 1];
  const next = guide[index + 1];
  return (
    <>
      <aside className="mdocs-side" aria-label="Páginas do guia">
        <ul>
          {guide.map((entry) => (
            <li key={entry.file}><NavLink to={pagePath(entry.key)} end>{entry.title}</NavLink></li>
          ))}
        </ul>
      </aside>
      <main id="mdocs-main" className="mdocs-main" tabIndex={-1}>
        <GuideMarkdown page={page} />
        <nav className="mdocs-pager" aria-label="Página anterior e seguinte">
          {previous !== undefined ? <Link to={pagePath(previous.key)} rel="prev"><span>Anterior</span>{previous.title}</Link> : <span />}
          {next !== undefined && <Link to={pagePath(next.key)} rel="next"><span>Seguinte</span>{next.title}</Link>}
        </nav>
      </main>
    </>
  );
}

function ApiTab() {
  useDocumentTitle('Referência da API — Ageniza para o time mobile');
  useScrollToHash(API_REFERENCE_KEY);
  return <ApiReference />;
}

/**
 * `/mobile`: what the backend does today, for the team that builds the app. It is a development page (see `routes.tsx`):
 * it is not part of the production build, so nothing here is reachable on the real product.
 */
export default function MobileDocsPage() {
  const key = (useParams()['*'] ?? '').replace(/\/+$/, '');
  const inApiTab = key === API_REFERENCE_KEY;

  return (
    <div className="mdocs" data-testid={MOBILE_DOCS_MARKER}>
      <a className="skip-link" href="#mdocs-main">Pular para o conteúdo</a>
      <header className="mdocs-header">
        <div className="mdocs-header__inner">
          <Link to={MOBILE_BASE} className="mdocs-brand" aria-label="Ageniza para o time mobile, início"><Logo variant="on-light" height={28} /><span>Time mobile</span></Link>
          <Pill>Só em dev</Pill>
          <nav className="mdocs-tabs" aria-label="Seções">
            <Link to={MOBILE_BASE} aria-current={inApiTab ? undefined : 'page'}>Guia</Link>
            <Link to={pagePath(API_REFERENCE_KEY)} aria-current={inApiTab ? 'page' : undefined}>Referência da API</Link>
          </nav>
        </div>
      </header>
      <div className="mdocs-layout">{inApiTab ? <ApiTab /> : <Guide pageKey={key} />}</div>
    </div>
  );
}
