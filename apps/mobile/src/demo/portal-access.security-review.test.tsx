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
  // Deliberately ignore visual disabling to attack the synchronous operation guard.
  Action: ({ label, onPress }: { label: string; onPress(): void }) => <button onClick={onPress}>{label}</button>,
}));
import { DemoPortalAccess } from './DemoPortalAccess';

const agency: Extract<Context, { type: 'agency' }> = { type: 'agency', agencyId: 'agency-a', agencyName: 'Agência Horizonte · Demonstração', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
const portal: Extract<Context, { type: 'client' }> = { type: 'client', clientId: 'client-a', clientName: 'Clínica Vida · Exemplo', agencyId: agency.agencyId, agencyName: agency.agencyName, onboardingPending: true };
afterEach(() => { cleanup(); prepare.mockReset(); gate.enabled = true; });

it('does not reuse a late portal response after switching agency', async () => {
  let resolve!: (value: typeof portal) => void;
  prepare.mockReturnValue(new Promise<typeof portal>((done) => { resolve = done; }));
  const enter = vi.fn();
  const view = render(<DemoPortalAccess agency={agency} onEnter={enter} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  const signal = prepare.mock.calls[0]![2] as AbortSignal;
  view.rerender(<DemoPortalAccess agency={{ ...agency, agencyId: 'agency-b' }} onEnter={enter} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(portal); });
  expect(screen.queryByRole('button', { name: 'Entrar no portal de exemplo' })).toBeNull();
  expect(enter).not.toHaveBeenCalled();
});

it('serializes repeated portal entry even when visual disabling is bypassed and surfaces server refusal', async () => {
  prepare.mockResolvedValue(portal);
  let reject!: (error: Error) => void;
  const enter = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  render(<DemoPortalAccess agency={agency} onEnter={enter} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' })); });
  const button = screen.getByRole('button', { name: 'Entrar no portal de exemplo' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(enter).toHaveBeenCalledExactlyOnceWith(portal);
  await act(async () => { reject(new Error('Acesso removido')); });
  expect(screen.getByRole('alert').textContent).toBe('Acesso removido');
});

it('aborts pending preparation if the demo gate is withdrawn', async () => {
  prepare.mockReturnValue(new Promise(() => {}));
  const view = render(<DemoPortalAccess agency={agency} onEnter={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
  const signal = prepare.mock.calls[0]![2] as AbortSignal;
  gate.enabled = false;
  view.rerender(<DemoPortalAccess agency={agency} onEnter={() => {}} />);
  expect(signal.aborted).toBe(true);
  expect(view.container.textContent).toBe('');
});
