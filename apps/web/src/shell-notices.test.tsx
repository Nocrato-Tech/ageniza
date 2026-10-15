// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { InvitationNotice, invitationNoticeState } from './invitation-notice.js';

afterEach(cleanup);

describe('the invitation notice in the Pauta look (#639)', () => {
  it('reads as one strip: an icon that is only decoration, the sentence as the status, and the way to close it', () => {
    render(<MemoryRouter initialEntries={[{ pathname: '/agencia/x', state: invitationNoticeState('Agência Um') }]}><InvitationNotice /></MemoryRouter>);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Você já fazia parte de Agência Um. Nada mudou no seu acesso.');
    const strip = status.parentElement!;
    expect(strip.classList.contains('shell-notice')).toBe(true);
    expect(strip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
