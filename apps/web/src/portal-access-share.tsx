import { Info, MessageCircle } from 'lucide-react';

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
export function PortalAccessShare({ member, clientName, primary = false }: { member: ClientMember; clientName: string; primary?: boolean }) {
  const agency = useAgencyContext();
  const address = portalEntryAddress();
  const message = portalShareMessage({ agencyName: agency.agencyName, clientName, personName: member.name, address });
  return <>
    <ButtonLink
      size="sm"
      variant={primary ? 'primary' : 'secondary'}
      leadingIcon={<MessageCircle />}
      href={whatsappShareUrl(message)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Enviar pelo WhatsApp para ${member.email} (abre em nova aba)`}
    >Enviar pelo WhatsApp</ButtonLink>
    <CopyPortalAccessButton message={message} address={address} subject={member.email} />
  </>;
}

/** The message ready for one person, as the agency will send it, and how the link works; the one primary of the side block. */
export function PortalSharePanel({ member, clientName }: { member: ClientMember; clientName: string }) {
  const agency = useAgencyContext();
  const address = portalEntryAddress();
  const message = portalShareMessage({ agencyName: agency.agencyName, clientName, personName: member.name, address });
  return <aside className="portal-access__side" aria-label="Mensagem pronta">
    <div className="portal-access__share">
      <p className="portal-access__eyebrow">Mensagem pronta para o WhatsApp</p>
      <q>{message}</q>
      <ButtonLink
        variant="primary"
        leadingIcon={<MessageCircle />}
        href={whatsappShareUrl(message)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Enviar pelo WhatsApp para ${member.email} (abre em nova aba) com a mensagem pronta`}
      >Enviar pelo WhatsApp</ButtonLink>
    </div>
    <div className="portal-access__note">
      <Info aria-hidden="true" />
      <p>O link é o mesmo para todos: abre a tela de entrada, sem token. A pessoa passa a ter acesso na hora e recebe um e-mail de boas-vindas. Sem nome, a saudação é “Olá!”.</p>
    </div>
  </aside>;
}
