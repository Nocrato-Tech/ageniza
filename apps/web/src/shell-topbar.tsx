import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';

import { AgencySearch, AgencySearchPhone } from './agency-search.js';
import { HelpMenu } from './help-menu.js';
import { NotificationsBell } from './notifications-panel.js';
import { PortalSearch } from './portal-search.js';
import { usePhone } from './use-phone.js';

/** On a phone the top bar is the shell's own (`.agency-mbar`); the search icon is placed at its start, before the bell. */
function PhoneSearch({ agencyId }: { agencyId: string }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHost(document.querySelector('.agency-mbar__end')); }, []);
  return host === null ? null : createPortal(<AgencySearchPhone agencyId={agencyId} />, host);
}

/** The top bar of the wide shells: the search of each area, then the bell (the agency's; the portal has none) and Ajuda. */
export function ShellTopbar({ onReviewTour }: { onReviewTour?: () => void }) {
  const { agenciaId, clienteId } = useParams();
  // On a phone Ajuda lives in the shell's own top bar.
  if (usePhone()) return agenciaId === undefined ? null : <PhoneSearch agencyId={agenciaId} />;
  return <div className="shell-topbar">
    <div className="shell-topbar__search">
      {agenciaId !== undefined ? <AgencySearch agencyId={agenciaId} /> : clienteId !== undefined && <PortalSearch clientId={clienteId} />}
    </div>
    {agenciaId === undefined ? <span className="shell-topbar__bell-slot" aria-hidden="true" /> : <NotificationsBell agencyId={agenciaId} />}
    <HelpMenu onReviewTour={onReviewTour} />
  </div>;
}
