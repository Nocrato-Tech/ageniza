import { useParams } from 'react-router-dom';

import { HelpMenu } from './help-menu.js';
import { NotificationsBell } from './notifications-panel.js';
import { usePhone } from './use-phone.js';

/** The top bar of the wide shells. The search has its own subtask, so its place is kept with no control; the bell is the agency's (the portal has none). */
export function ShellTopbar({ onReviewTour }: { onReviewTour?: () => void }) {
  const { agenciaId } = useParams();
  // On a phone Ajuda lives in the shell's own top bar.
  if (usePhone()) return null;
  return <div className="shell-topbar">
    <span className="shell-topbar__search-slot" aria-hidden="true" />
    {agenciaId === undefined ? <span className="shell-topbar__bell-slot" aria-hidden="true" /> : <NotificationsBell agencyId={agenciaId} />}
    <HelpMenu onReviewTour={onReviewTour} />
  </div>;
}
