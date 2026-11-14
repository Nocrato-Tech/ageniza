import type { ClientMember } from '@ageniza/contracts';

const ZONE = 'America/Sao_Paulo';
const dayFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ZONE });
const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE });

/** The day and the time of an instant in the agency's zone, never the browser's: 01:30Z is still the evening before in São Paulo. */
const dayOf = (value: string): string => dayFormatter.format(new Date(value));
const timeOf = (value: string): string => timeFormatter.format(new Date(value));

/**
 * What the agency reads of a person's last access (decision 2026-11-10, "quem só abriu o link ... ainda não entrou com a conta"):
 * the account entered, or only the approval link was opened, or nothing happened yet.
 */
export const lastAccessLabel = (member: Pick<ClientMember, 'entered' | 'lastEnteredAt'>): string => {
  const at = member.lastEnteredAt;
  if (!member.entered) return at === null ? 'Nunca entrou' : `Ainda não entrou com a conta · abriu o link em ${dayOf(at)}`;
  return at === null ? 'Já entrou com a conta' : `Último acesso ${dayOf(at)} às ${timeOf(at)}`;
};
