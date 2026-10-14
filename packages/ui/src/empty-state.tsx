import type { HTMLAttributes, ReactNode } from 'react';

import { Mascot } from './mascot.js';

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
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
export function EmptyState({ title, description, action, mascot = false, headingLevel = 2, className, ...props }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={['ui-empty-state', mascot && 'ui-empty-state--mascot', className].filter(Boolean).join(' ')} {...props}>
      {mascot && <Mascot variant="friendly" height={200} />}
      <div className="ui-empty-state__body">
        <Heading className="ui-empty-state__title">{title}</Heading>
        {description !== undefined && <p className="ui-empty-state__description">{description}</p>}
        {action !== undefined && <div className="ui-empty-state__action">{action}</div>}
      </div>
    </div>
  );
}
