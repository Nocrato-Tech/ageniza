import { useEffect, useState } from 'react';
import type mermaidApi from 'mermaid';

type DiagramState = { status: 'loading' } | { status: 'ready'; svg: string } | { status: 'error' };

let diagramCount = 0;

/** One import for every diagram of the page; a failed import is forgotten so the next diagram tries again. */
let mermaidModule: Promise<{ default: typeof mermaidApi }> | undefined;
const loadMermaid = (): Promise<{ default: typeof mermaidApi }> =>
  (mermaidModule ??= import('mermaid').catch((error: unknown) => {
    mermaidModule = undefined;
    throw error;
  }));

/** The design tokens mermaid is themed with. Only plain colours: mermaid cannot parse `color-mix()` and the like. */
const THEME_TOKENS: Readonly<Record<string, string>> = {
  primaryColor: '--bg-surface',
  primaryTextColor: '--text-primary',
  primaryBorderColor: '--action-primary-bg',
  secondaryColor: '--bg-hover',
  tertiaryColor: '--bg-canvas',
  lineColor: '--text-secondary',
  textColor: '--text-primary',
  noteBkgColor: '--bg-hover',
  noteTextColor: '--text-primary',
  noteBorderColor: '--border-default',
  actorBkg: '--bg-surface',
  actorBorder: '--action-primary-bg',
  actorTextColor: '--text-primary',
  actorLineColor: '--text-muted',
  signalColor: '--text-secondary',
  signalTextColor: '--text-primary',
  labelBoxBkgColor: '--bg-hover',
  labelBoxBorderColor: '--border-default',
  labelTextColor: '--text-primary',
  loopTextColor: '--text-primary',
  transitionColor: '--text-secondary',
  stateBkg: '--bg-surface',
  stateLabelColor: '--text-primary',
  specialStateColor: '--text-secondary',
  fontFamily: '--font-ui'
};

export function themeVariables(read: (name: string) => string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [variable, token] of Object.entries(THEME_TOKENS)) {
    const value = read(token);
    if (value !== '') variables[variable] = value;
  }
  return variables;
}

const readToken = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * A mermaid block drawn in the page. The library is loaded only when a diagram appears, `securityLevel: 'strict'` keeps
 * the source from injecting markup, and if drawing fails the source stays visible so the reader still gets the flow.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const [state, setState] = useState<DiagramState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const { default: mermaid } = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: themeVariables(readToken)
        });
        diagramCount += 1;
        const { svg } = await mermaid.render(`mobile-docs-diagram-${diagramCount}`, source);
        if (current) setState({ status: 'ready', svg });
      } catch {
        if (current) setState({ status: 'error' });
      }
    })();
    return () => {
      current = false;
    };
  }, [source]);

  return (
    <figure className="mdocs-diagram" aria-label="Diagrama">
      {state.status === 'ready' ? (
        <div className="mdocs-diagram__canvas" role="img" aria-label="Diagrama do fluxo; o texto dele está logo abaixo" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <p className="mdocs-diagram__status" role="status">
          {state.status === 'loading' ? 'Desenhando o diagrama…' : 'Não foi possível desenhar o diagrama; o texto dele está logo abaixo.'}
        </p>
      )}
      <details className="mdocs-diagram__source" open={state.status === 'error'}>
        <summary>Texto do diagrama</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
