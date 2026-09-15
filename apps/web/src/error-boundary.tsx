import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryState { error: Error | null; }

/** Last-resort UI boundary; operational details stay out of the browser response. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null };
  public static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  public componentDidCatch(error: Error, info: ErrorInfo): void {
    void error;
    void info;
    /* Reporting is intentionally configured outside this UI primitive. */
  }
  public render(): ReactNode {
    if (this.state.error !== null) return <main className="page-status"><h1>Something went wrong</h1><p>Please refresh the page and try again.</p></main>;
    return this.props.children;
  }
}
