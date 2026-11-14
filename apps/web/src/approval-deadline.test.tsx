// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovalDeadline,
  ApprovalRound,
  ApprovalSenderNote,
  AwaitingState,
  deadlineWording,
  dueDayLabel,
  hourLabel,
  spokenDayLabel,
  waitingWording,
  weekdayArticle
} from './approval-deadline.js';
import { ApiClientProvider, HttpClient } from './http.js';

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

describe('the answer panel of the post (redesign W6)', () => {
  const sent = { dueAt: '2026-11-13T01:30:00.000Z', dueOn: '2026-11-12', note: 'Oi, Rosana.', sentAt: '2026-11-10T01:30:00.000Z', sentBy: { name: 'João Pereira', photoUrl: null } };

  it.each([
    ['2026-11-12', 'quinta, 12 nov'], ['2026-11-13', 'sexta, 13 nov'], ['2026-11-14', 'sábado, 14 nov'], ['2026-11-15', 'domingo, 15 nov'], ['2026-11-16', 'segunda, 16 nov']
  ])('writes %s as "%s"', (day, text) => { expect(spokenDayLabel(day)).toBe(text); });

  it('takes "no" for the weekend and "na" for the other days', () => {
    expect(['2026-11-14', '2026-11-15'].map(weekdayArticle)).toEqual(['no', 'no']);
    expect(['2026-11-12', '2026-11-13', '2026-11-16'].map(weekdayArticle)).toEqual(['na', 'na', 'na']);
  });

  it.each([['12:00', '12h'], ['09:05', '9h05'], ['18:30', '18h30'], ['00:00', '0h']])('writes %s as "%s"', (time, text) => { expect(hourLabel(time)).toBe(text); });

  it('says the deadline with the hour of São Paulo (01:30Z is still the day before) and how long is left', () => {
    render(<ApprovalDeadline approval={sent} today="2026-11-11" />);
    expect(screen.getByText('Responda até', { exact: false }).textContent).toBe('Responda até quinta, 12 nov, 22h30');
    expect(screen.getByText('Falta 1 dia')).toBeTruthy();
  });

  it('says "Faltam N dias", "Vence hoje" and "Venceu há N dias"', () => {
    const { rerender } = render(<ApprovalDeadline approval={sent} today="2026-11-07" />);
    expect(screen.getByText('Faltam 5 dias')).toBeTruthy();
    rerender(<ApprovalDeadline approval={sent} today="2026-11-12" />);
    expect(screen.getByText('Vence hoje')).toBeTruthy();
    rerender(<ApprovalDeadline approval={sent} today="2026-11-14" />);
    expect(screen.getByText('Venceu há 2 dias')).toBeTruthy();
  });

  it('leaves the hour out when the round has only the day, and draws nothing without a day', () => {
    const { container, rerender } = render(<ApprovalDeadline approval={{ ...sent, dueAt: null }} today="2026-11-11" />);
    expect(screen.getByText('Responda até', { exact: false }).textContent).toBe('Responda até quinta, 12 nov');
    rerender(<ApprovalDeadline approval={{ ...sent, dueOn: null, dueAt: null }} today="2026-11-11" />);
    expect(container.textContent).toBe('');
    rerender(<ApprovalDeadline approval={null} today="2026-11-11" />);
    expect(container.textContent).toBe('');
  });

  const inClient = (node: ReactNode) => <ApiClientProvider client={new HttpClient('http://127.0.0.1:3001')}>{node}</ApiClientProvider>;

  it('signs the note with the sender, the agency and the day and hour it was sent', () => {
    render(inClient(<ApprovalSenderNote approval={sent} agencyName="Agência Horizonte" />));
    expect(screen.getByText('Recado de João Pereira, da Agência Horizonte')).toBeTruthy();
    expect(screen.getByText('Oi, Rosana.')).toBeTruthy();
    expect(screen.getByText('9 de novembro, 22h30')).toBeTruthy();
  });

  it('draws nothing without a note, and never uses a photo address that is not the portal route', () => {
    const { container, rerender } = render(inClient(<ApprovalSenderNote approval={{ ...sent, note: null }} agencyName="Agência Horizonte" />));
    expect(container.textContent).toBe('');
    const requested: string[] = [];
    vi.stubGlobal('Image', class { public onload: (() => void) | null = null; public set src(value: string) { requested.push(value); } });
    rerender(inClient(<ApprovalSenderNote approval={{ ...sent, sentBy: { name: 'João Pereira', photoUrl: 'https://storage.example/obj/key.png' } }} agencyName="Agência Horizonte" />));
    vi.unstubAllGlobals();
    expect(requested).toEqual([]);
    expect(document.querySelector('.ui-avatar__photo')).toBeNull();
  });
});
