import { Button, EmptyState } from '@ageniza/ui';

/**
 * A portal list whose read did not answer: it says so and offers to repeat, and never claims there is nothing. The retry is a
 * `Button` of its own (not `EmptyState`'s `onRetry`) so it can stay busy and keep the focus while the repeat is in flight.
 */
export function PortalFailure({ title, fetching, onRetry, headingLevel = 3 }: {
  title: string;
  fetching: boolean;
  onRetry: () => void;
  headingLevel?: 2 | 3 | 4;
}) {
  return <EmptyState
    kind="failure"
    className="portal-empty"
    headingLevel={headingLevel}
    title={title}
    action={<Button variant="secondary" loading={fetching} onClick={onRetry}>Tentar de novo</Button>}
  />;
}
