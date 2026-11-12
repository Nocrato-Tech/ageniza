import type { PortalContentApproval } from '@ageniza/contracts';

/** What a test seeds of the round the agency opened: the day of the deadline and the note. */
export interface SeededApproval {
  dueOn: string | null;
  note: string | null;
}

/** The round as the portal answers it: the deadline at noon of São Paulo on that day, and the sending by a named person of the agency. */
export const portalApprovalOf = (round: SeededApproval | null): PortalContentApproval | null => (round === null
  ? null
  : {
    dueAt: round.dueOn === null ? null : `${round.dueOn}T15:00:00.000Z`,
    dueOn: round.dueOn,
    note: round.note,
    sentAt: '2026-10-09T15:00:00.000Z',
    sentBy: { name: 'João Pereira', photoUrl: null }
  });
