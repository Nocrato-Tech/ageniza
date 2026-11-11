import { MessageCircle } from 'lucide-react';

import type { ClientMember } from '@ageniza/contracts';
import { ButtonLink } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { CopyPortalAccessButton } from './copy-invitation-link.js';

/** The sign-in address of the portal: no token and no secret, it gives no access by itself (decision 2026-11-10). */
export const portalEntryAddress = (): string => `${window.location.origin}/entrar`;

/** The ready message, written in the agency's name; a person who never entered has no name to greet (the list never says who has an account). */
export const portalShareMessage = (input: { agencyName: string; clientName: string; personName: string | null; address: string }): string => {
  const first = input.personName?.trim().split(/\s+/)[0] ?? '';
  const greeting = first === '' ? 'Olá!' : `Olá, ${first}!`;
  return `${greeting} Aqui é ${input.agencyName}. Este é o seu acesso ao portal de aprovação de ${input.clientName}, onde você aprova os conteúdos. Entre com o seu e-mail: ${input.address}`;
};

export const whatsappShareUrl = (message: string): string => `https://wa.me/?text=${encodeURIComponent(message)}`;

/** "Copiar link" and "Enviar pelo WhatsApp" for one person of the portal; both share the same address and message. */
export function PortalAccessShare({ member, clientName }: { member: ClientMember; clientName: string }) {
  const agency = useAgencyContext();
  const address = portalEntryAddress();
  const message = portalShareMessage({ agencyName: agency.agencyName, clientName, personName: member.name, address });
  return <>
    <CopyPortalAccessButton message={message} address={address} subject={member.email} />
    <ButtonLink
      size="sm"
      variant="secondary"
      leadingIcon={<MessageCircle />}
      href={whatsappShareUrl(message)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Enviar pelo WhatsApp para ${member.email} (abre em nova aba)`}
    >Enviar pelo WhatsApp</ButtonLink>
  </>;
}
