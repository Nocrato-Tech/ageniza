import { CircleAlert, CircleCheck } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

import { Button } from './button.js';
import { IconSlot } from './icon.js';
import { Mascot } from './mascot.js';

/** First use invites to the first action; good news says nothing is waiting; failure says the query did not answer. */
export type EmptyStateKind = 'first-use' | 'good-news' | 'failure';

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /**
   * Which of the three empty states this is (default `first-use`, the plain one). `good-news` is only for a query that
   * answered and covers every pending state; when it did not answer, use `failure`, which never claims there is nothing.
   */
  kind?: EmptyStateKind;
  /** The way forward of a failure: shows a "Tentar de novo" button that runs this. */
  onRetry?: () => void;
  /** What is missing, as a sentence ("Cadastre o primeiro cliente"). */
  title: string;
  /** Why it matters or what comes next. */
  description?: ReactNode;
  /** The one way forward, usually a `Button`; a "no results" state offers "Limpar filtros" here. */
  action?: ReactNode;
  /** The friendly owl beside the text. Only for a first visit with an action; a search with no results has none. */
  mascot?: boolean;
  /** The level of the title, so it nests under the heading of the screen. */
  headingLevel?: 2 | 3 | 4;
};

/** What a list, calendar or search shows when there is nothing to show yet: what is missing, and the way to fix it. */
export function EmptyState({ kind = 'first-use', onRetry, title, description, action, mascot = false, headingLevel = 2, className, ...props }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const retry = kind === 'failure' && onRetry !== undefined;
  return (
    <div
      className={['ui-empty-state', kind !== 'first-use' && `ui-empty-state--${kind}`, mascot && 'ui-empty-state--mascot', className].filter(Boolean).join(' ')}
      role={kind === 'failure' ? 'alert' : undefined}
      {...props}
    >
      {mascot && <Mascot variant="friendly" height={200} />}
      <div className="ui-empty-state__body">
        {kind !== 'first-use' && <span className="ui-empty-state__icon"><IconSlot>{kind === 'good-news' ? <CircleCheck /> : <CircleAlert />}</IconSlot></span>}
        <Heading className="ui-empty-state__title">{title}</Heading>
        {description !== undefined && <p className="ui-empty-state__description">{description}</p>}
        {(action !== undefined || retry) && <div className="ui-empty-state__action">
          {retry && <Button variant="secondary" onClick={onRetry}>Tentar de novo</Button>}
          {action}
        </div>}
      </div>
    </div>
  );
}
