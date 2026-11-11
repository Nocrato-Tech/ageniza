import { CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

import { Button } from './button.js';
import { IconSlot } from './icon.js';
import { Mascot, type MascotVariant } from './mascot.js';

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
  /** The repeat is in flight: the retry button turns busy (`aria-busy`, keeps its focus) and ignores clicks until the answer arrives. */
  retrying?: boolean;
  /** What is missing, as a sentence ("Cadastre o primeiro cliente"). */
  title: string;
  /** Why it matters or what comes next. */
  description?: ReactNode;
  /** The one way forward, usually a `Button`; a "no results" state offers "Limpar filtros" here. */
  action?: ReactNode;
  /**
   * The owl beside the text. `true` is the friendly one, only for a first visit with an action (a search with no results has none);
   * on a `failure` it is the serious one, centred above the text, which then drops the alert icon. A pose can also be named.
   */
  mascot?: boolean | MascotVariant;
  /** A failure's reference for the support to find it ("Código 503 · 11 nov, 10h42"): small, under the actions. */
  code?: string;
  /** A second way out of a failure ("Avisar o suporte"), after the others, usually a `ghost` `Button`. */
  secondaryAction?: ReactNode;
  /** The level of the title, so it nests under the heading of the screen. */
  headingLevel?: 2 | 3 | 4;
};

/** What a list, calendar or search shows when there is nothing to show yet: what is missing, and the way to fix it. */
export function EmptyState({ kind = 'first-use', onRetry, retrying = false, title, description, action, mascot = false, code, secondaryAction, headingLevel = 2, className, ...props }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const failure = kind === 'failure';
  const retry = failure && onRetry !== undefined;
  const pose: MascotVariant | null = mascot === false ? null : mascot === true ? (failure ? 'serious' : 'friendly') : mascot;
  const serious = pose === 'serious';
  const actions = retry || action !== undefined || secondaryAction !== undefined;
  return (
    <div
      className={['ui-empty-state', kind !== 'first-use' && `ui-empty-state--${kind}`, pose === 'friendly' && 'ui-empty-state--mascot', serious && 'ui-empty-state--serious', className].filter(Boolean).join(' ')}
      role={failure ? 'alert' : undefined}
      {...props}
    >
      {pose !== null && <Mascot variant={pose} height={serious ? 128 : 200} />}
      <div className="ui-empty-state__body">
        {kind !== 'first-use' && !serious && <span className="ui-empty-state__icon"><IconSlot>{kind === 'good-news' ? <CircleCheck /> : <CircleAlert />}</IconSlot></span>}
        <Heading className="ui-empty-state__title">{title}</Heading>
        {description !== undefined && <p className="ui-empty-state__description">{description}</p>}
        {actions && <div className="ui-empty-state__action">
          {retry && <Button variant={serious ? 'primary' : 'secondary'} leadingIcon={serious ? <RefreshCw /> : undefined} loading={retrying} onClick={onRetry}>Tentar de novo</Button>}
          {action}
          {secondaryAction}
        </div>}
        {code !== undefined && <p className="ui-empty-state__code">{code}</p>}
      </div>
    </div>
  );
}
