// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Context } from '@ageniza/contracts';

const prepare = vi.hoisted(() => vi.fn());
const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock('./portal-access', () => ({ prepareDemoPortalAccess: prepare }));
vi.mock('./config', () => ({ get demoWorkspaceEnabled() { return gate.enabled; }, demoAgencyName: 'Agência Horizonte · Demonstração' }));
vi.mock('../api/runtime', () => ({ api: {} }));
vi.mock('../product/ui', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Txt: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  ErrorText: ({ text }: { text: string }) => <p role="alert">{text}</p>,
  Info: ({ title, text }: { title: string; text: string }) => <p>{title} {text}</p>,
  Action: ({ label, onPress, busy, disabled }: { label: string; onPress(): void; busy?: boolean; disabled?: boolean }) => <button disabled={busy || disabled} onClick={onPress}>{label}</button>,
}));
import { DemoPortalAccess } from './DemoPortalAccess';
const agency: Extract<Context, { type: 'agency' }> = { type: 'agency', agencyId: 'agency-one', agencyName: 'Agência Horizonte · Demonstração', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
const portal: Extract<Context, { type: 'client' }> = { type: 'client', clientId: 'client-one', clientName: 'Clínica Vida · Exemplo', agencyId: agency.agencyId, agencyName: agency.agencyName, onboardingPending: true };
afterEach(() => { cleanup(); prepare.mockReset(); gate.enabled = true; });

it('requires an explicit preparation and a resolved server context before entering the portal', async () => {
  const enter = vi.fn();
  let resolve!: (context: typeof portal) => void;
  prepare.mockReturnValue(new Promise<typeof portal>((done) => { resolve = done; }));
  render(<DemoPortalAccess agency={agency} onEnter={enter} />);
  expect(prepare).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Entrar no portal de exemplo' })).toBeNull();
  const button = screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(enter).not.toHaveBeenCalled();
  await act(async () => { resolve(portal); });
  expect(enter).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Entrar no portal de exemplo' })); });
  expect(enter).toHaveBeenCalledExactlyOnceWith(portal);
});

it('aborts preparation on unmount without entering from a late response', async () => {
  const enter = vi.fn();
  let resolve!: (context: typeof portal) => void;
  prepare.mockReturnValue(new Promise<typeof portal>((done) => { resolve = done; }));
  const view = render(<DemoPortalAccess agency={agency} onEnter={enter} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  const signal = prepare.mock.calls[0]?.[2] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(portal); });
  expect(enter).not.toHaveBeenCalled();
});

it.each([
  { ...agency, isOwner: false },
  { ...agency, agencyName: 'Real agency' },
])('does not offer preparation for an ineligible agency: %j', (selected) => {
  const { container } = render(<DemoPortalAccess agency={selected} onEnter={vi.fn()} />);
  expect(container.textContent).toBe('');
  expect(prepare).not.toHaveBeenCalled();
});

it('hides the whole portal action with the demo gate off', () => {
  gate.enabled = false;
  const { container } = render(<DemoPortalAccess agency={agency} onEnter={vi.fn()} />);
  expect(container.textContent).toBe('');
  expect(prepare).not.toHaveBeenCalled();
});

it('keeps a failed preparation retryable without exposing an enter action', async () => {
  prepare.mockRejectedValueOnce(new Error('Seu acesso foi removido')).mockResolvedValueOnce(portal);
  render(<DemoPortalAccess agency={agency} onEnter={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Seu acesso foi removido');
  expect(screen.queryByRole('button', { name: 'Entrar no portal de exemplo' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  await screen.findByRole('button', { name: 'Entrar no portal de exemplo' });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('discards a late response when the selected agency changes', async () => {
  const enter = vi.fn();
  let resolve!: (context: typeof portal) => void;
  prepare.mockReturnValue(new Promise<typeof portal>((done) => { resolve = done; }));
  const view = render(<DemoPortalAccess agency={agency} onEnter={enter} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  const signal = prepare.mock.calls[0]?.[2] as AbortSignal;
  view.rerender(<DemoPortalAccess agency={{ ...agency, agencyId: 'agency-two' }} onEnter={enter} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(portal); });
  expect(screen.queryByRole('button', { name: 'Entrar no portal de exemplo' })).toBeNull();
  expect(enter).not.toHaveBeenCalled();
});

it('blocks duplicate entry while selection is pending and reports selection errors', async () => {
  prepare.mockResolvedValue(portal);
  let reject!: (error: Error) => void;
  const enter = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  render(<DemoPortalAccess agency={agency} onEnter={enter} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  const button = await screen.findByRole('button', { name: 'Entrar no portal de exemplo' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(enter).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('Acesso indisponível')); });
  expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Acesso indisponível');
});

it('waits while the parent is preparing example data', () => {
  render(<DemoPortalAccess agency={agency} onEnter={vi.fn()} disabled />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  expect(prepare).not.toHaveBeenCalled();
});
