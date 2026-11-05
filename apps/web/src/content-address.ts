import { useAgencyContext } from './agency.js';

/** Where the views of one client's contents live: the screen of Conteúdos of the client (`specs/conteudo.md` section 7). Every address the view builds (a card, the modal, the "+") goes through here. */
export const contentsAddress = (agencyId: string, clientId: string): string => `/agencia/${agencyId}/conteudos/${clientId}`;

export const useContentsAddress = (clientId: string): string => contentsAddress(useAgencyContext().agencyId, clientId);
