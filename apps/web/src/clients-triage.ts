import type { ClientListItem } from '@ageniza/contracts';

/** What the caller may read of a client: the API omits both fields for who cannot, and the screen checks the permission again. */
export interface TriageVisibility {
  readonly contents: boolean;
  readonly invitations: boolean;
}

export type TriageSeal = 'overdue' | 'dueSoon' | 'invitation';

const contentIndicators = (client: ClientListItem, visible: TriageVisibility) => visible.contents ? client.contentIndicators : undefined;
const pendingInvitations = (client: ClientListItem, visible: TriageVisibility): number => visible.invitations ? client.pendingInvitations ?? 0 : 0;

/** The one seal a card wears: late, then due soon, then a pending invitation (specs/clientes.md section 7). An archived card wears none. */
export const triageSealOf = (client: ClientListItem, visible: TriageVisibility): TriageSeal | null => {
  if (client.status === 'archived') return null;
  const indicators = contentIndicators(client, visible);
  if (indicators !== undefined && indicators.overdue > 0) return 'overdue';
  if (indicators !== undefined && indicators.dueSoon > 0) return 'dueSoon';
  if (pendingInvitations(client, visible) > 0) return 'invitation';
  return null;
};

const plural = (count: number, one: string, many: string): string => count === 1 ? one : many;

export type ClientTabSlug = 'geral' | 'conteudos' | 'estudo-de-marca' | 'acessos';

export interface NextAction {
  readonly label: string;
  /** The tab of the detail that holds what the action is about. */
  readonly tab: ClientTabSlug;
  /** The short number behind the action, when there is one. */
  readonly figure: { readonly value: number; readonly caption: string } | null;
}

/** What to do next with a client, in the order of the triage: late, due soon, suggestions awaiting, invitation, and otherwise just open it. */
export const nextAction = (client: ClientListItem, visible: TriageVisibility): NextAction | null => {
  if (client.status === 'archived') return null;
  const indicators = contentIndicators(client, visible);
  if (indicators !== undefined && indicators.overdue > 0) {
    return { label: 'Resolver atraso', tab: 'conteudos', figure: { value: indicators.overdue, caption: plural(indicators.overdue, 'post atrasado', 'posts atrasados') } };
  }
  if (indicators !== undefined && indicators.dueSoon > 0) {
    return { label: 'Ver prazos', tab: 'conteudos', figure: { value: indicators.dueSoon, caption: plural(indicators.dueSoon, 'post com prazo em até 2 dias', 'posts com prazo em até 2 dias') } };
  }
  if (client.threadsAwaitingAgency > 0) {
    return { label: 'Ver sugestões', tab: 'estudo-de-marca', figure: { value: client.threadsAwaitingAgency, caption: plural(client.threadsAwaitingAgency, 'sugestão para responder', 'sugestões para responder') } };
  }
  const invitations = pendingInvitations(client, visible);
  if (invitations > 0) {
    return { label: 'Ver convites', tab: 'acessos', figure: { value: invitations, caption: plural(invitations, 'convite em aberto', 'convites em aberto') } };
  }
  return { label: 'Abrir cliente', tab: 'geral', figure: null };
};

export interface TriageSentencePart {
  /** The words in bold: who to look at. */
  readonly lead: string;
  readonly rest: string;
}

/**
 * The triage panel's sentence, from the rows on screen: who is late, then who has a deadline in two days, then who has suggestions
 * waiting, at most two of them. The roster arrives ordered by the server, so on its first page this is the top of the queue.
 * The client's name always shares its bold run with the words that introduce it, so it never stands alone as text.
 */
export const triageSentence = (clients: readonly ClientListItem[], visible: TriageVisibility): readonly TriageSentencePart[] => {
  const active = clients.filter((client) => client.status === 'active');
  const late = active.find((client) => (contentIndicators(client, visible)?.overdue ?? 0) > 0);
  const due = active.find((client) => client !== late && (contentIndicators(client, visible)?.dueSoon ?? 0) > 0);
  const suggestions = active.find((client) => client !== late && client !== due && client.threadsAwaitingAgency > 0);
  const reasons: Array<{ client: ClientListItem; rest: string }> = [];
  if (late !== undefined) {
    const count = contentIndicators(late, visible)?.overdue ?? 0;
    reasons.push({ client: late, rest: `: ${count} ${plural(count, 'post atrasado', 'posts atrasados')}.` });
  }
  if (due !== undefined) {
    const count = contentIndicators(due, visible)?.dueSoon ?? 0;
    reasons.push({ client: due, rest: `: ${count} ${plural(count, 'post com prazo', 'posts com prazo')} em até 2 dias.` });
  }
  if (suggestions !== undefined) {
    const count = suggestions.threadsAwaitingAgency;
    reasons.push({ client: suggestions, rest: `: ${count} ${plural(count, 'sugestão aguardando', 'sugestões aguardando')} resposta.` });
  }
  if (reasons.length === 0) {
    return [{
      lead: visible.contents ? 'Nada urgente nesta lista' : 'Nenhuma sugestão aguardando nesta lista',
      rest: visible.contents ? ': nenhum cliente com atraso, prazo próximo ou sugestão aguardando.' : '.'
    }];
  }
  return reasons.slice(0, 2).map(({ client, rest }, index) => ({ lead: `${index === 0 ? 'Comece por' : 'Depois,'} ${client.name}`, rest }));
};
