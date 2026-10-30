// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { StartPage } from './start.js';

afterEach(cleanup);

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  // jsdom has no top layer; these stubs only model opening and closing.
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
const agencyContext = { type: 'agency', agencyId: AGENCY, agencyName: 'Agência Nova', roleKey: 'admin', roleName: 'Admin', isOwner: true };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const renderStart = (fetchImpl: typeof fetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={['/comecar']}>
          <Routes>
            <Route path="/comecar" element={<StartPage />} />
            <Route path="/agencia/:agencyId" element={<h1>Dentro da agência</h1>} />
          </Routes>
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  );
};

describe('StartPage (/comecar)', () => {
  it('welcomes the first entry and points an invited person to the e-mail link', () => {
    renderStart(async () => json({}));
    expect(screen.getByRole('heading', { name: 'Bem-vindo ao Ageniza' })).toBeTruthy();
    expect(screen.getByText(/Você tem 14 dias grátis para testar\./)).toBeTruthy();
    expect(screen.getByText('Foi convidado por uma agência? Entre pelo link do e-mail de convite.')).toBeTruthy();
    expect(screen.queryByText(/chega em breve/)).toBeNull();
    expect(screen.queryByText(/aparecem aqui/)).toBeNull();
  });

  it('has an enabled "Criar agência" that opens the dialog', async () => {
    renderStart(async () => json({}));
    const button = screen.getByRole('button', { name: 'Criar agência' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(button);
    expect((await screen.findByRole('dialog', { name: 'Criar agência' })).textContent).toContain('14 dias de teste');
  });

  it('creates the agency and enters it', async () => {
    const posted: unknown[] = [];
    const puts: unknown[] = [];
    renderStart(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/agencies') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return json({ context: agencyContext }, 201);
      }
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Criar agência' }));
    const dialog = await screen.findByRole('dialog', { name: 'Criar agência' });
    fireEvent.change(dialog.querySelector('input[name="name"]')!, { target: { value: 'Agência Nova' } });
    fireEvent.submit(dialog.querySelector('form')!);

    expect(await screen.findByRole('heading', { name: 'Dentro da agência' })).toBeTruthy();
    expect(posted).toEqual([{ name: 'Agência Nova' }]);
    await waitFor(() => expect(puts).toEqual([{ type: 'agency', agencyId: AGENCY }]));
  });
});
