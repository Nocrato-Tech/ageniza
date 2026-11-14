import type { NotificationDestination } from '@ageniza/contracts';

import { contentsAddress } from './content-address.js';

/**
 * Where opening a notification goes (specs/notificacoes.md section 7): the content on the calendar of its client, the Visão geral of
 * the client for a request for material (which opens the request in `?pedido=`), or the Equipe.
 */
export const notificationPath = (agencyId: string, destination: NotificationDestination): string => {
  switch (destination.type) {
    case 'content': return `${contentsAddress(agencyId, destination.clientId)}/${destination.contentId}`;
    case 'material-request': return `/agencia/${agencyId}/clientes/${destination.clientId}/geral?pedido=${destination.threadId}`;
    case 'collaborators': return `/agencia/${agencyId}/colaboradores`;
  }
};
