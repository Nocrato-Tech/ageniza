import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CircleHelp, Route } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Menu, MenuItem, StatusTag } from '@ageniza/ui';

import { getHealth } from './health.js';
import { useApiClient } from './http.js';

/** There is no help centre (decisions/2026-10-14): Ajuda is the tour, where there is one to review, and the service status. */
export function HelpMenu({ onReviewTour }: { onReviewTour?: () => void }) {
  const navigate = useNavigate();
  const httpClient = useApiClient();
  const [open, setOpen] = useState(false);
  // The same query as the /status page; it is read when the menu opens, and no label is shown until it has answered.
  const health = useQuery({ queryKey: ['health'], queryFn: () => getHealth(httpClient), enabled: open });
  return <div className="help-menu">
    <Menu label="Ajuda" triggerLabel="Ajuda" trigger={<CircleHelp aria-hidden="true" />} onOpenChange={setOpen}>
      {onReviewTour !== undefined && <MenuItem icon={<Route />} onClick={onReviewTour}>Rever o tour</MenuItem>}
      <MenuItem icon={<Activity />} onClick={() => { navigate('/status'); }}>
        Status do serviço
        {health.data?.status === 'ok' && <StatusTag status="ready" className="help-menu__status">Normal</StatusTag>}
      </MenuItem>
    </Menu>
  </div>;
}
