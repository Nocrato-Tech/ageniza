// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuthActiveSession } from '@ageniza/contracts';

import { AccountPage } from './account-page.js';
import { lastUseLabel, sessionMeta, sessionName } from './account-sessions.js';
import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

const AGENCY = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-12T12:00:00.000Z';
const ID_NOW = '44444444-4444-4444-8444-444444444441';
const ID_PHONE = '44444444-4444-4444-8444-444444444442';
const ID_EDGE = '44444444-4444-4444-8444-444444444443';

const user = { id: AGENCY, name: 'Marina Bastos', email: 'marina@agenciahorizonte.com.br' };

const current: AuthActiveSession = { id: ID_NOW, current: true, browser: 'Chrome', os: 'Windows', city: 'São Paulo', lastUsedAt: NOW, createdAt: '2026-11-10T12:00:00.000Z' };
// 01:30Z is still the evening before in São Paulo: the day shown is the 11th, "ontem", not "hoje".
const phone: AuthActiveSession = { id: ID_PHONE, current: false, browser: 'Safari', os: 'iOS', city: 'Campinas', lastUsedAt: '2026-11-12T01:30:00.000Z', createdAt: '2026-11-09T12:00:00.000Z' };
const edge: AuthActiveSession = { id: ID_EDGE, current: false, browser: 'Edge', os: 'Windows', city: null, lastUsedAt: '2026-10-31T12:00:00.000Z', createdAt: '2026-10-30T12:00:00.000Z' };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { path: string; method: string }

function renderPage(options: {
  sessions?: () => Response | Promise<Response>;
  revokeOne?: (id: string) => Response;
  revokeOthers?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ path: url.pathname, method });
    if (url.pathname === '/auth/session') return json({ user, session: { expiresAt: '2027-01-01T00:00:00.000Z' } });
    if (url.pathname === '/auth/sessions' && method === 'GET') return (options.sessions ?? (() => json({ sessions: [current, phone, edge] })))();
    if (url.pathname.startsWith('/auth/sessions/') && method === 'DELETE') return (options.revokeOne ?? (() => new Response(null, { status: 204 })))(url.pathname.split('/').pop()!);
    if (url.pathname === '/auth/sessions/revoke-others' && method === 'POST') return (options.revokeOthers ?? (() => json({ revoked: 2 })))();
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const store = createAuthSessionStore(client);
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/agencia/${AGENCY}/conta`]}>
            <Routes><Route path="agencia/:agenciaId/conta" element={<AccountPage />} /></Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { calls };
}

const rowOf = (name: string): HTMLElement => screen.getByText(name, { selector: '.account-session__name' }).closest('li') as HTMLElement;

describe('the Conta page', () => {
  it('shows every text of the board: the identity, the sessions, the hint and the danger card', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Conta e sessões' })).toBeTruthy();
    expect(screen.getByText('Veja onde a sua conta está aberta e encerre o que não reconhece.')).toBeTruthy();
    expect(await screen.findByText('Marina Bastos')).toBeTruthy();
    expect(screen.getByText('marina@agenciahorizonte.com.br')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Conta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pedir troca de e-mail' })).toBeTruthy();

    expect(await screen.findByRole('heading', { level: 2, name: 'Sessões ativas' })).toBeTruthy();
    expect(screen.getByText('3 aparelhos com a conta aberta.')).toBeTruthy();
    expect(within(rowOf('Chrome no Windows')).getByText('Este aparelho')).toBeTruthy();
    expect(within(rowOf('Chrome no Windows')).getByText('São Paulo · usando agora')).toBeTruthy();
    expect(within(rowOf('Safari no iOS')).getByText('Campinas · último uso ontem')).toBeTruthy();
    expect(within(rowOf('Edge no Windows')).getByText('Último uso há 12 dias')).toBeTruthy();
    expect(screen.getByText('A cidade é aproximada e só aparece quando se sabe; quando não, a linha mostra só o último uso.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Encerrar as outras sessões' })).toBeTruthy();
    expect(screen.getByText('Mantém só este aparelho. As outras sessões precisam entrar de novo.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sair de todas as outras' })).toBeTruthy();
  });

  it('opens the e-mail change from the page', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Pedir troca de e-mail' }));
    expect(await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' })).toBeTruthy();
  });

  it('names the day in São Paulo, never the browser or UTC day, and never the hour', () => {
    const now = new Date('2026-11-12T12:00:00.000Z');
    expect(lastUseLabel('2026-11-12T01:30:00.000Z', now)).toBe('último uso ontem');
    expect(lastUseLabel('2026-11-12T03:30:00.000Z', now)).toBe('último uso hoje');
    expect(lastUseLabel('2026-11-10T01:30:00.000Z', now)).toBe('último uso há 3 dias');
  });

  it('shows the city when it comes and no place at all when it does not', () => {
    const now = new Date(NOW);
    expect(sessionMeta({ ...phone, city: 'Campinas' }, now)).toBe('Campinas · último uso ontem');
    expect(sessionMeta({ ...phone, city: null }, now)).toBe('Último uso ontem');
    expect(sessionMeta({ ...current, city: null }, now)).toBe('Usando agora');
  });

  it('names a device from what is known of it', () => {
    expect(sessionName({ browser: 'Chrome', os: null })).toBe('Chrome');
    expect(sessionName({ browser: null, os: 'macOS' })).toBe('Navegador no macOS');
    expect(sessionName({ browser: null, os: null })).toBe('Aparelho desconhecido');
  });

  it('leaves one session on the right row, after a confirmation, with the row name in the button', async () => {
    const { calls } = renderPage();
    await screen.findByText('3 aparelhos com a conta aberta.');
    expect(within(rowOf('Chrome no Windows')).queryByRole('button')).toBeNull();

    const edgeButton = within(rowOf('Edge no Windows')).getByRole('button', { name: 'Sair deste aparelho: Edge no Windows' });
    expect(edgeButton.textContent).toBe('Sair deste aparelho');
    fireEvent.click(edgeButton);
    const dialog = await screen.findByRole('dialog', { name: 'Sair de Edge no Windows?' });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(within(rowOf('Safari no iOS')).getByRole('button', { name: 'Sair deste aparelho: Safari no iOS' }));
    const second = await screen.findByRole('dialog', { name: 'Sair de Safari no iOS?' });
    fireEvent.click(within(second).getByRole('button', { name: 'Sair deste aparelho' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ path: `/auth/sessions/${ID_PHONE}`, method: 'DELETE' }]));
    expect((await screen.findByRole('status')).textContent).toBe('Você saiu de Safari no iOS.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sair de Safari no iOS?' })).toBeNull());
  });

  it('says so when leaving one session fails and keeps the list', async () => {
    renderPage({ revokeOne: () => json({ error: { code: 'INTERNAL_ERROR', message: 'Failure' } }, 500) });
    await screen.findByText('3 aparelhos com a conta aberta.');
    fireEvent.click(within(rowOf('Edge no Windows')).getByRole('button'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sair deste aparelho' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível sair desse aparelho. Tente de novo.');
    expect(rowOf('Edge no Windows')).toBeTruthy();
  });

  it('leaves all the others after a confirmation and tells how many ended, from the answer', async () => {
    const { calls } = renderPage({ revokeOthers: () => json({ revoked: 7 }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Sair de todas as outras' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sair de todas as outras sessões?' });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sair de todas as outras' }));
    await waitFor(() => expect(calls).toContainEqual({ path: '/auth/sessions/revoke-others', method: 'POST' }));
    expect((await screen.findByRole('status')).textContent).toBe('7 outras sessões foram encerradas.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sair de todas as outras sessões?' })).toBeNull());
  });

  it('refetches the list after leaving, and the card goes away with one session left', async () => {
    let list = [current, phone];
    renderPage({ sessions: () => json({ sessions: list }), revokeOthers: () => { list = [current]; return json({ revoked: 1 }); } });
    fireEvent.click(await screen.findByRole('button', { name: 'Sair de todas as outras' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sair de todas as outras' }));
    expect((await screen.findByRole('status')).textContent).toBe('1 outra sessão foi encerrada.');
    await screen.findByText('1 aparelho com a conta aberta.');
    expect(screen.queryByRole('button', { name: 'Sair de todas as outras' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Encerrar as outras sessões' })).toBeNull();
  });

  it('offers neither the danger card nor a way out of a row when there is only this session', async () => {
    renderPage({ sessions: () => json({ sessions: [current] }) });
    expect(await screen.findByText('1 aparelho com a conta aberta.')).toBeTruthy();
    expect(screen.getByText('Este aparelho')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sair/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Encerrar as outras sessões' })).toBeNull();
  });

  it('shows a skeleton while loading and a failure with the mascot and a retry', async () => {
    let attempts = 0;
    renderPage({ sessions: () => { attempts += 1; return attempts <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'Failure' } }, 500) : json({ sessions: [current] }); } });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText('Não foi possível carregar as suas sessões. Tente de novo.')).toBeTruthy();
    expect(document.querySelector('.ui-empty-state--serious')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('1 aparelho com a conta aberta.')).toBeTruthy();
  });
});
