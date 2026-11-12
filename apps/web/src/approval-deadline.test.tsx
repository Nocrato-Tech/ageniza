// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AwaitingState, ApprovalRound, deadlineWording, dueDayLabel, waitingWording } from './approval-deadline.js';

afterEach(cleanup);

// The wording reads only the day and the note; the hour, the sending date and the sender are not its concern.
const round = (dueOn: string | null, note: string | null) => ({ dueAt: null, dueOn, note, sentAt: null, sentBy: null });

describe('the words of an approval deadline (telas-melhorias S8)', () => {
  it.each([
    [0, 'vence hoje'],
    [1, 'vence amanhã'],
    [2, 'vence em 2 dias'],
    [90, 'vence em 90 dias'],
    [-1, 'venceu há 1 dia'],
    [-2, 'venceu há 2 dias']
  ])('words %i days to the deadline as "%s"', (daysToDue, wording) => {
    expect(deadlineWording(daysToDue)).toBe(wording);
  });

  it('never uses the words of the publication day', () => {
    for (let n = -5; n <= 5; n += 1) expect(deadlineWording(n)).not.toMatch(/atrasad|prazo em/i);
  });

  it.each([[0, 'enviado hoje'], [1, 'enviado há 1 dia'], [4, 'enviado há 4 dias']])('words %i days waiting as "%s"', (days, wording) => {
    expect(waitingWording(days)).toBe(wording);
  });

  it('writes the day as the client reads it, from the text', () => {
    expect(dueDayLabel('2026-11-14')).toBe('sáb, 14/11');
  });

  it('says the deadline of a content that has one, the wait of one that has none, and nothing for one with neither', () => {
    const { container, rerender } = render(<AwaitingState daysToDue={-2} daysWaiting={5} />);
    expect(container.textContent).toBe('venceu há 2 dias');
    expect(container.querySelector('.approval-state--expired')).not.toBeNull();
    rerender(<AwaitingState daysToDue={3} daysWaiting={5} />);
    expect(container.textContent).toBe('vence em 3 dias');
    expect(container.querySelector('.approval-state--expired')).toBeNull();
    rerender(<AwaitingState daysToDue={null} daysWaiting={5} />);
    expect(container.textContent).toBe('enviado há 5 dias');
    rerender(<AwaitingState daysToDue={null} daysWaiting={null} />);
    expect(container.textContent).toBe('');
  });

  it('draws nothing for a round with no usable deadline and no note, and ignores a deadline that is not a day', () => {
    const { container, rerender } = render(<ApprovalRound approval={round(null, null)} today="2026-10-11" />);
    expect(container.textContent).toBe('');
    rerender(<ApprovalRound approval={round('14/10/2026', null)} today="2026-10-11" />);
    expect(container.textContent).toBe('');
    rerender(<ApprovalRound approval={round('14/10/2026', 'Oi')} agencyName="Agência Um" today="2026-10-11" />);
    expect(screen.queryByText(/Aprovar até/)).toBeNull();
    expect(screen.getByText('Recado de Agência Um')).toBeTruthy();
  });

  it('signs the note as the agency when no name is given, and hides it where it is not shown', () => {
    const { container, rerender } = render(<ApprovalRound approval={round(null, 'Oi')} today="2026-10-11" />);
    expect(screen.getByText('Recado da agência')).toBeTruthy();
    rerender(<ApprovalRound approval={round(null, 'Oi')} showNote={false} today="2026-10-11" />);
    expect(container.textContent).toBe('');
  });
});
