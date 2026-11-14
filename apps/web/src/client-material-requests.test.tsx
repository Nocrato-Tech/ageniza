// @vitest-environment jsdom

import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ClientDetailResponse } from '@ageniza/contracts';

import { ClientMaterialRequests } from './client-material-requests.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { NotificationsBell } from './notifications-panel.js';
import { createQueryClient } from './query.js';

vi.mock('./agency.js', () => ({
  useAgencyContext: () => ({ agencyId: '11111111-1111-4111-8111-111111111111', permissions: [], plan: { readOnly: false } }),
  useCan: () => true,
  useWriteBlocked: () => undefined
}));

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
afterEach(cleanup);

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const FIRST = 'cccccccc-1111-4111-8111-111111111111';
const SECOND = 'cccccccc-2222-4222-8222-222222222222';
const NOTIFICATION = 'dddddddd-1111-4111-8111-111111111111';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 } });

const thread = (id: string, title: string) => ({
  id,
  subject: { materialRequest: true },
  state: 'open',
  openedBy: { name: 'Marina Bastos', side: 'agency' },
  lastComment: { side: 'agency', at: '2026-11-10T01:30:00.000Z', excerpt: `Envie ${title}` },
  commentCount: 1,
  resolvedBy: null,
  resolvedAt: null,
  dueOn: '2099-12-31',
  title
});

const commentReads: string[] = [];
const client = new HttpClient('http://127.0.0.1:3001', async (input) => {
  const url = new URL(String(input));
  if (url.pathname === `/agencies/${AGENCY}/notifications/unread-count`) return json({ data: { count: 1 } });
  if (url.pathname === `/agencies/${AGENCY}/notifications/${NOTIFICATION}/read`) return new Response(null, { status: 204 });
  if (url.pathname === `/agencies/${AGENCY}/notifications`) {
    return json({
      data: [{
        id: NOTIFICATION,
        kind: 'material_request_answered',
        summary: 'Rosana respondeu "Forno novo"',
        createdAt: new Date().toISOString(),
        readAt: null,
        destination: { type: 'material-request', clientId: CLIENT, threadId: SECOND }
      }],
      meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 }
    });
  }
  if (url.pathname === `/agencies/${AGENCY}/clients/${CLIENT}/threads`) {
    return json(page(url.searchParams.get('state') === 'open' ? [thread(FIRST, 'Fotos da equipe'), thread(SECOND, 'Forno novo')] : []));
  }
  const comments = /\/threads\/([^/]+)\/comments$/.exec(url.pathname);
  if (comments !== null) { commentReads.push(comments[1]!); return json({ data: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 } }); }
  return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const renderAt = (entry: string) => render(
  <QueryClientProvider client={createQueryClient()}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <NotificationsBell agencyId={AGENCY} />
        <Routes>
          <Route path="/agencia/:agencyId/clientes/:clientId/geral" element={<ClientMaterialRequests client={{ id: CLIENT, status: 'active' } as ClientDetailResponse} />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>
);

const where = (): string => screen.getByTestId('where').textContent ?? '';

describe('the request a notification points at', () => {
  it('opens that request, reading its own comments and not the other row, and drops the parameter when it is closed', async () => {
    commentReads.length = 0;
    renderAt(`/agencia/${AGENCY}/clientes/${CLIENT}/geral?pedido=${SECOND}`);
    const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
    expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeTruthy();
    await waitFor(() => expect(commentReads).toEqual([SECOND]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar conversa' }));
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/geral`));
  });

  it('is reached by clicking the notification of the bell: the address carries the request and the right one opens', async () => {
    commentReads.length = 0;
    renderAt(`/agencia/${AGENCY}/clientes/${CLIENT}/geral`);
    await screen.findByText('Fotos da equipe');
    fireEvent.click(await screen.findByRole('button', { name: /^Notificações/ }));
    const panel = await screen.findByRole('dialog', { name: 'Notificações' });
    fireEvent.click(await within(panel).findByRole('link', { name: /Rosana respondeu "Forno novo"/ }));
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/clientes/${CLIENT}/geral?pedido=${SECOND}`));
    const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
    expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeTruthy();
    await waitFor(() => expect(commentReads).toEqual([SECOND]));
  });
});
