import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@ageniza/ui';

import { captureBrowserException } from './sentry.js';
import { StatusPanel } from './status-panel.js';

interface ErrorBoundaryState { error: Error | null; }

/** Last-resort UI boundary; operational details stay out of the browser response. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null };
  public static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  public componentDidCatch(error: Error, info: ErrorInfo): void {
    captureBrowserException(error, { componentStack: info.componentStack ?? 'unknown' });
  }
  public render(): ReactNode {
    // Outside the router on purpose: the way out is a reload, which also drops whatever state broke the tree.
    if (this.state.error !== null) return <StatusPanel titleId="unexpected-error-title" title="Algo deu errado" action={<Button size="lg" onClick={() => { window.location.reload(); }}>Tentar de novo</Button>}>
      Não foi possível mostrar esta página. Carregue de novo para continuar.
    </StatusPanel>;
    return this.props.children;
  }
}
