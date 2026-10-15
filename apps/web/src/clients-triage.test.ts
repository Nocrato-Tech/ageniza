import type { ClientListItem } from '@ageniza/contracts';
import { describe, expect, it } from 'vitest';

import { nextAction, triageSealOf, triageSentence } from './clients-triage.js';

const READER = { contents: true, invitations: true } as const;
const NO_CONTENTS = { contents: false, invitations: true } as const;
const NO_INVITATIONS = { contents: true, invitations: false } as const;

const indicators = (overrides: Partial<Record<'pending' | 'inReview' | 'overdue' | 'adjusting' | 'dueSoon', number>> = {}) =>
  ({ pending: 0, inReview: 0, overdue: 0, adjusting: 0, dueSoon: 0, ...overrides });

let sequence = 0;
const client = (name: string, overrides: Partial<ClientListItem> = {}): ClientListItem => ({
  id: `7a7a7a7a-7777-4777-8777-${String(++sequence).padStart(12, '0')}`,
  name, photoUrl: null, instagramHandle: null, status: 'active', closingDate: null, threadsAwaitingAgency: 0,
  ...overrides
});

describe('triageSealOf', () => {
  it('puts late before due soon before a pending invitation', () => {
    const everything = client('A', { contentIndicators: indicators({ overdue: 1, dueSoon: 2 }), pendingInvitations: 1 });
    expect(triageSealOf(everything, READER)).toBe('overdue');
    expect(triageSealOf(client('B', { contentIndicators: indicators({ dueSoon: 2 }), pendingInvitations: 1 }), READER)).toBe('dueSoon');
    expect(triageSealOf(client('C', { contentIndicators: indicators(), pendingInvitations: 1 }), READER)).toBe('invitation');
    expect(triageSealOf(client('D', { contentIndicators: indicators() }), READER)).toBeNull();
  });

  it('counts only what the caller may read, even when the response carried it', () => {
    const everything = client('A', { contentIndicators: indicators({ overdue: 1, dueSoon: 2 }), pendingInvitations: 1 });
    expect(triageSealOf(everything, NO_CONTENTS)).toBe('invitation');
    expect(triageSealOf(everything, NO_INVITATIONS)).toBe('overdue');
    expect(triageSealOf(client('B', { contentIndicators: indicators({ overdue: 1 }), pendingInvitations: 1 }), { contents: false, invitations: false })).toBeNull();
  });

  it('never gives an archived client a seal', () => {
    expect(triageSealOf(client('A', { status: 'archived', contentIndicators: indicators({ overdue: 3 }), pendingInvitations: 1 }), READER)).toBeNull();
  });
});

describe('nextAction', () => {
  it('follows the triage: late, due soon, suggestions, invitation, and otherwise open the client', () => {
    expect(nextAction(client('A', { contentIndicators: indicators({ overdue: 2, dueSoon: 1 }), threadsAwaitingAgency: 3, pendingInvitations: 1 }), READER))
      .toEqual({ label: 'Resolver atraso', tab: 'conteudos', figure: { value: 2, caption: 'posts atrasados' } });
    expect(nextAction(client('B', { contentIndicators: indicators({ dueSoon: 1 }), threadsAwaitingAgency: 3 }), READER))
      .toEqual({ label: 'Ver prazos', tab: 'conteudos', figure: { value: 1, caption: 'post com prazo em até 2 dias' } });
    expect(nextAction(client('C', { threadsAwaitingAgency: 3, pendingInvitations: 1 }), READER))
      .toEqual({ label: 'Ver sugestões', tab: 'estudo-de-marca', figure: { value: 3, caption: 'sugestões para responder' } });
    expect(nextAction(client('D', { pendingInvitations: 1 }), READER))
      .toEqual({ label: 'Ver convites', tab: 'acessos', figure: { value: 1, caption: 'convite em aberto' } });
    expect(nextAction(client('E'), READER)).toEqual({ label: 'Abrir cliente', tab: 'geral', figure: null });
  });

  it('never sends who cannot read contents or invitations to a tab of them', () => {
    const loaded = client('A', { contentIndicators: indicators({ overdue: 2 }), pendingInvitations: 1 });
    expect(nextAction(loaded, NO_CONTENTS)?.tab).toBe('acessos');
    expect(nextAction(loaded, { contents: false, invitations: false })).toEqual({ label: 'Abrir cliente', tab: 'geral', figure: null });
  });

  it('gives an archived client no action', () => {
    expect(nextAction(client('A', { status: 'archived', threadsAwaitingAgency: 2 }), READER)).toBeNull();
  });
});

describe('triageSentence', () => {
  const text = (parts: ReturnType<typeof triageSentence>): string => parts.map((part) => `${part.lead}${part.rest}`).join(' ');

  it('names the late client first and then the one with a deadline, in the plural and the singular', () => {
    const rows = [
      client('Padaria', { contentIndicators: indicators({ overdue: 1 }) }),
      client('Clínica', { contentIndicators: indicators({ dueSoon: 2 }) })
    ];
    expect(text(triageSentence(rows, READER))).toBe('Comece por Padaria: 1 post atrasado. Depois, Clínica: 2 posts com prazo em até 2 dias.');
  });

  it('falls back to the first suggestion and stops at two clients', () => {
    const rows = [
      client('A', { contentIndicators: indicators({ overdue: 2 }) }),
      client('B', { contentIndicators: indicators({ dueSoon: 1 }) }),
      client('C', { threadsAwaitingAgency: 4 })
    ];
    expect(text(triageSentence(rows, READER))).toBe('Comece por A: 2 posts atrasados. Depois, B: 1 post com prazo em até 2 dias.');
    expect(text(triageSentence(rows.slice(2), READER))).toBe('Comece por C: 4 sugestões aguardando resposta.');
  });

  it('does not repeat a client that is both late and due soon', () => {
    const rows = [client('A', { contentIndicators: indicators({ overdue: 1, dueSoon: 1 }) })];
    expect(text(triageSentence(rows, READER))).toBe('Comece por A: 1 post atrasado.');
  });

  it('ignores contents it may not read and archived clients', () => {
    const rows = [
      client('Arquivado', { status: 'archived', threadsAwaitingAgency: 5, contentIndicators: indicators({ overdue: 9 }) }),
      client('A', { contentIndicators: indicators({ overdue: 2 }), threadsAwaitingAgency: 1 })
    ];
    expect(text(triageSentence(rows, NO_CONTENTS))).toBe('Comece por A: 1 sugestão aguardando resposta.');
  });

  it('says nothing is urgent, in words that match what the caller can see', () => {
    expect(text(triageSentence([client('A', { contentIndicators: indicators({ pending: 3 }) })], READER)))
      .toBe('Nada urgente nesta lista: nenhum cliente com atraso, prazo próximo ou sugestão aguardando.');
    expect(text(triageSentence([client('A')], NO_CONTENTS))).toBe('Nenhuma sugestão aguardando nesta lista.');
  });
});
