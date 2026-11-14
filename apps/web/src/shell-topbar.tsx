import { useParams } from 'react-router-dom';

import { AgencySearch } from './agency-search.js';
import { HelpMenu } from './help-menu.js';
import { NotificationsBell } from './notifications-panel.js';
import { PortalSearch } from './portal-search.js';
import { usePhone } from './use-phone.js';

/** The top bar of the wide shells: the search of each area, then the bell (the agency's; the portal has none) and Ajuda. */
export function ShellTopbar({ onReviewTour }: { onReviewTour?: () => void }) {
  const { agenciaId, clienteId } = useParams();
  // On a phone the shell's own top bar (agency-nav) holds the search, the bell and Ajuda.
  if (usePhone()) return null;
  return <div className="shell-topbar">
    <div className="shell-topbar__search">
      {agenciaId !== undefined ? <AgencySearch agencyId={agenciaId} /> : clienteId !== undefined && <PortalSearch clientId={clienteId} />}
    </div>
    {agenciaId === undefined ? <span className="shell-topbar__bell-slot" aria-hidden="true" /> : <NotificationsBell agencyId={agenciaId} />}
    <HelpMenu onReviewTour={onReviewTour} />
  </div>;
}
