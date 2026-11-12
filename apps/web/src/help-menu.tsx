import { Activity, CircleHelp, Route } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Menu, MenuItem } from '@ageniza/ui';

import { usePhone } from './use-phone.js';

/** There is no help centre (decisions/2026-10-14): Ajuda is the tour, where there is one to review, and the service status. */
export function HelpMenu({ onReviewTour }: { onReviewTour?: () => void }) {
  const navigate = useNavigate();
  return <div className="help-menu">
    <Menu label="Ajuda" triggerLabel="Ajuda" trigger={<CircleHelp aria-hidden="true" />}>
      {onReviewTour !== undefined && <MenuItem icon={<Route />} onClick={onReviewTour}>Rever o tour</MenuItem>}
      <MenuItem icon={<Activity />} onClick={() => { navigate('/status'); }}>Status do sistema</MenuItem>
    </Menu>
  </div>;
}

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
