import { createContext, useContext } from 'react';

import { useAgencyContext } from './agency.js';

/**
 * Where the views of one client's contents live: the screen of Conteúdos (`/conteudos/:clienteId`, the default) or the
 * tab of the client's detail (`/clientes/:clienteId/conteudos`, `specs/conteudo.md` section 7). Both render the same
 * view, so every address it builds (a card, the modal, the "+") goes through here.
 */
export type ContentsHome = 'screen' | 'tab';

export const ContentsHomeContext = createContext<ContentsHome>('screen');

export const contentsAddress = (home: ContentsHome, agencyId: string, clientId: string): string =>
  home === 'tab' ? `/agencia/${agencyId}/clientes/${clientId}/conteudos` : `/agencia/${agencyId}/conteudos/${clientId}`;

export const useContentsAddress = (clientId: string): string =>
  contentsAddress(useContext(ContentsHomeContext), useAgencyContext().agencyId, clientId);
