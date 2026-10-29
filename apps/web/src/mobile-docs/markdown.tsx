import { Children, isValidElement, useMemo, type ComponentProps, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';

import { guideFiles, type GuidePage } from './content.js';
import { MermaidDiagram } from './diagram.js';
import { remarkHeadingIds } from './headings.js';
import { resolveDocLink } from './links.js';

const REMARK_PLUGINS = [remarkGfm, remarkHeadingIds] as unknown as ComponentProps<typeof Markdown>['remarkPlugins'];

const textOf = (node: ReactNode): string => Children.toArray(node).map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : '')).join('');

function componentsFor(page: GuidePage): Components {
  return {
    a({ href, children }) {
      if (href === undefined) return <>{children}</>;
      const link = resolveDocLink(href, page.file, guideFiles);
      if (link.kind === 'page') return <Link to={link.to}>{children}</Link>;
      return <a href={link.href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    pre({ children }) {
      const [child] = Children.toArray(children);
      if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(' ').includes('language-mermaid')) {
        return <MermaidDiagram source={textOf(child.props.children).replace(/\n$/, '')} />;
      }
      return <pre>{children}</pre>;
    },
    // A wide table scrolls inside its own box; it never widens the page.
    table({ children }) {
      return <div className="mdocs-table"><table>{children}</table></div>;
    }
  };
}

/** One file of `docs/mobile/` as the reader sees it: GitHub-flavoured Markdown, links that stay inside the page and diagrams drawn. */
export function GuideMarkdown({ page }: { page: GuidePage }) {
  const components = useMemo(() => componentsFor(page), [page]);
  return <article className="mdocs-prose"><Markdown remarkPlugins={REMARK_PLUGINS} components={components}>{page.source}</Markdown></article>;
}

/** Short text with `code` and links, such as the description of a route; it has no diagrams and no page links. */
export function InlineMarkdown({ source }: { source: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>;
}
