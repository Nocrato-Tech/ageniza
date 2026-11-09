// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MilestoneCelebration } from './milestone-celebration.js';
import { MILESTONE_MESSAGES, takeMilestone, type MilestoneFacts } from './milestones.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const nothing: MilestoneFacts = { client: false, content: false, sent: false, approved: false, published: false };

const setReducedMotion = (reduced: boolean): void => {
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
};

beforeEach(() => { window.localStorage.clear(); setReducedMotion(false); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('takeMilestone', () => {
  it('only records what is already done on the first look, and celebrates nothing', () => {
    expect(takeMilestone(AGENCY, { ...nothing, client: true, content: true, approved: true })).toBeNull();
    // What was done before is never celebrated later.
    expect(takeMilestone(AGENCY, { ...nothing, client: true, content: true, approved: true })).toBeNull();
  });

  it.each([
    ['client', { client: true }],
    ['content', { client: true, content: true }],
    ['sent', { client: true, content: true, sent: true }],
    ['approved', { client: true, content: true, sent: true, approved: true }],
    ['published', { client: true, content: true, sent: true, approved: true, published: true }]
  ] as const)('celebrates the first %s once and does not repeat', (milestone, done) => {
    const before = { ...nothing, ...done, [milestone]: false };
    // `published` after `approved`: the earlier ones are already known.
    takeMilestone(AGENCY, before);
    const after = { ...nothing, ...done };
    expect(takeMilestone(AGENCY, after)).toBe(milestone);
    expect(takeMilestone(AGENCY, after)).toBeNull();
  });

  it('celebrates only the biggest of several new ones, and the others are not celebrated later', () => {
    takeMilestone(AGENCY, nothing);
    const facts = { ...nothing, client: true, content: true, sent: true, approved: true };
    expect(takeMilestone(AGENCY, facts)).toBe('approved');
    expect(takeMilestone(AGENCY, facts)).toBeNull();
  });

  it('keeps one record per agency', () => {
    takeMilestone(AGENCY, nothing);
    expect(takeMilestone(OTHER, { ...nothing, client: true })).toBeNull();
    expect(takeMilestone(AGENCY, { ...nothing, client: true })).toBe('client');
  });

  it('celebrates nothing when the storage cannot remember', () => {
    const broken = (): Storage => { throw new Error('blocked'); };
    expect(takeMilestone(AGENCY, { ...nothing, client: true }, broken)).toBeNull();
    const readOnly = { getItem: () => '[]', setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(takeMilestone(AGENCY, { ...nothing, client: true }, () => readOnly)).toBeNull();
  });
});

describe('MilestoneCelebration', () => {
  const mount = (facts: MilestoneFacts | undefined) => render(<MilestoneCelebration agencyId={AGENCY} facts={facts} />);

  it('says nothing while the facts are unknown or on the first look', () => {
    mount(undefined);
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    mount({ ...nothing, client: true });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByTestId('confetti')).toBeNull();
  });

  it('congratulates the first approval with a message and confetti that block nothing, then the confetti goes away by itself', () => {
    vi.useFakeTimers();
    takeMilestone(AGENCY, nothing);
    mount({ ...nothing, client: true, content: true, sent: true, approved: true });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(MILESTONE_MESSAGES.approved.title);
    expect(status.textContent).toContain('Um cliente aprovou um conteúdo seu. É assim que o trabalho da agência passa a render.');
    expect(status.getAttribute('data-milestone')).toBe('approved');
    const confetti = screen.getByTestId('confetti');
    expect(confetti.getAttribute('aria-hidden')).toBe('true');
    expect(confetti.querySelectorAll('.confetti__piece').length).toBeGreaterThan(50);
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByTestId('confetti')).toBeNull();
    // The message stays until it is closed.
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    ['client', 'Primeiro cliente cadastrado!', 'A carteira da agência começou. Parabéns!'],
    ['content', 'Primeiro conteúdo criado!', 'O calendário começou a ganhar forma. Parabéns!'],
    ['sent', 'Primeiro conteúdo enviado para aprovação!', 'Agora é com o cliente. Parabéns pelo passo!'],
    ['published', 'Primeiro conteúdo postado!', 'Seu primeiro post foi para o ar. Parabéns!']
  ] as const)('celebrates the first %s with a light toast and a short confetti', (milestone, title, text) => {
    vi.useFakeTimers();
    takeMilestone(AGENCY, nothing);
    mount({ ...nothing, [milestone]: true });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(title);
    expect(status.textContent).toContain(text);
    expect(status.className).toContain('milestone--toast');
    expect(screen.getByTestId('confetti').querySelectorAll('.confetti__piece').length).toBeLessThan(40);
    act(() => { vi.advanceTimersByTime(2600); });
    expect(screen.queryByTestId('confetti')).toBeNull();
    act(() => { vi.advanceTimersByTime(3500); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not repeat on a new visit, nor for what was done before', () => {
    takeMilestone(AGENCY, nothing);
    const facts = { ...nothing, client: true };
    mount(facts);
    expect(screen.getByRole('status')).toBeTruthy();
    cleanup();
    mount(facts);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows only the message, with no confetti, when the person asks for reduced motion', () => {
    setReducedMotion(true);
    takeMilestone(AGENCY, nothing);
    mount({ ...nothing, client: true, content: true, sent: true, approved: true });
    expect(screen.getByRole('status').textContent).toContain(MILESTONE_MESSAGES.approved.title);
    expect(screen.queryByTestId('confetti')).toBeNull();
  });
});
