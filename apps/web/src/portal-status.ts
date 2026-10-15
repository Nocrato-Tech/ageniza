import type { PortalContentListItem } from '@ageniza/contracts';
import type { StatusTagStatus } from '@ageniza/ui';

export type PortalStatus = PortalContentListItem['status'];

/** The client's words (specs/conteudo.md section 7): "aprovado" is "Aprovado" here, and "Pronto para publicar" only in the agency. */
export const PORTAL_STATUS_LABELS: Readonly<Record<PortalStatus, string>> = {
  in_production: 'Em produção',
  awaiting_approval: 'Aguardando aprovação',
  adjusting: 'Em ajuste',
  approved: 'Aprovado',
  published: 'Publicado'
};

/** The shape of each state in `StatusTag`, so two states are told apart by form and the colour only follows (docs/design-system.md section 25.1). */
export const PORTAL_STATUS_TAGS: Readonly<Record<PortalStatus, StatusTagStatus>> = {
  in_production: 'production',
  awaiting_approval: 'waiting',
  adjusting: 'adjust',
  approved: 'ready',
  published: 'published'
};

/** The post in full screen (issue #600): the title of a card is the link, and the card is the area of the tap. */
export const portalPostAddress = (clientId: string, contentId: string): string => `/portal/${encodeURIComponent(clientId)}/conteudos/${encodeURIComponent(contentId)}`;
