import { HelpMenu } from './help-menu.js';
import { usePhone } from './use-phone.js';

/** The top bar of the wide shells. The search and the bell have their own subtasks: their place is kept, with no control in it. */
export function ShellTopbar({ onReviewTour }: { onReviewTour?: () => void }) {
  // On a phone Ajuda lives in the shell's own top bar.
  if (usePhone()) return null;
  return <div className="shell-topbar">
    <span className="shell-topbar__search-slot" aria-hidden="true" />
    <span className="shell-topbar__bell-slot" aria-hidden="true" />
    <HelpMenu onReviewTour={onReviewTour} />
  </div>;
}
