// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { makeSubscriptionApi, renderSubscription, trialWorld } from './subscription-fixture.js';

afterEach(cleanup);

const CARD = { last4: '4242', expMonth: 8, expYear: 2028, brand: 'test' as const };
const label = (): string => screen.getByText(/^Passo \d de 3/).textContent ?? '';
const sectionOf = (name: string): HTMLElement => screen.getByRole('heading', { name }).closest('section, aside') as HTMLElement;
const current = (): string[] => ['Plano Essencial', 'Como você quer pagar', 'Resumo'].filter((name) => sectionOf(name).getAttribute('data-current') === 'true');
const due = (): string => screen.getByText('Você paga agora').parentElement?.textContent ?? '';
const open = async (world = trialWorld(5)) => {
  const api = makeSubscriptionApi(world);
  renderSubscription(api.impl);
  fireEvent.click(await screen.findByRole('button', { name: 'Assinar Essencial' }));
  await screen.findByRole('heading', { name: 'Resumo' });
  return api;
};

describe('the purchase in three steps', () => {
  it('goes plan, payment, review: each step shows its own section, and the summary with what is due is in all of them', async () => {
    await open();

    expect(label()).toBe('Passo 1 de 3 · Seu plano');
    expect(current()).toEqual(['Plano Essencial']);
    expect(due()).toContain('R$ 97,00');

    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(label()).toBe('Passo 2 de 3 · Pagamento');
    expect(current()).toEqual(['Como você quer pagar']);
    expect(due()).toContain('R$ 97,00');

    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(label()).toBe('Passo 3 de 3 · Revisar e pagar');
    expect(current()).toEqual(['Resumo']);
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Assinar e pagar R$ 97,00' })).toBeTruthy();
  });

  it('goes back one step at a time, and the first step has no way back but leaving', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(label()).toBe('Passo 2 de 3 · Pagamento');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(label()).toBe('Passo 1 de 3 · Seu plano');
    expect(current()).toEqual(['Plano Essencial']);
  });

  it('"Cancelar" on the first step leaves without paying', async () => {
    const { recorded } = await open();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(await screen.findByText('Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.')).toBeTruthy();
    expect(recorded.filter((entry) => entry.path.endsWith('/simulated-payment'))).toHaveLength(0);
  });

  it('a refusal stays on the purchase, on the last step, and the next try is a new charge', async () => {
    const { recorded } = await open();

    fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

    expect(await screen.findByText('O cartão foi recusado.')).toBeTruthy();
    expect(label()).toBe('Passo 3 de 3 · Revisar e pagar');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Plano Essencial ativo')).toBeTruthy();
    expect(recorded.filter((entry) => entry.method === 'POST' && entry.path === '/subscription/charges')).toHaveLength(2);
  });
});

describe('the choice between the saved card and another one', () => {
  it('offers the saved test card first, without asking for any field, and pays with it sending only the outcome', async () => {
    const { recorded } = await open(trialWorld(5, { testCard: CARD }));
    await screen.findByRole('radio', { name: 'Cartão de teste final 4242' });

    expect((screen.getByRole('radio', { name: 'Cartão de teste final 4242' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Cartão salvo · vence 08/2028')).toBeTruthy();
    expect(screen.queryByLabelText('Número do cartão')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Assinar e pagar R$ 97,00' }));
    expect(await screen.findByText('Plano Essencial ativo')).toBeTruthy();
    const payment = recorded.filter((entry) => entry.path.endsWith('/simulated-payment'));
    expect(payment).toHaveLength(1);
    expect(payment[0]?.body).toEqual({ outcome: 'approved' });
    expect(recorded.filter((entry) => entry.method === 'PUT')).toHaveLength(0);
  });

  it('"Usar outro cartão" shows the fields and hides them again when the saved card is chosen back', async () => {
    await open(trialWorld(5, { testCard: CARD }));
    await screen.findByRole('radio', { name: 'Usar outro cartão' });

    fireEvent.click(screen.getByRole('radio', { name: 'Usar outro cartão' }));
    expect(screen.getByLabelText('Número do cartão')).toBeTruthy();
    expect(screen.getByLabelText('Nome impresso no cartão')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Cartão de teste final 4242' }));
    expect(screen.queryByLabelText('Número do cartão')).toBeNull();
  });

  it.each([['an environment with no test card', undefined], ['no card saved yet', null]])('with %s there is no choice: only the fields', async (_name, testCard) => {
    await open(trialWorld(5, { testCard }));
    await waitFor(() => { expect(screen.getByLabelText('Número do cartão')).toBeTruthy(); });

    expect(screen.queryByRole('radio')).toBeNull();
    expect(within(sectionOf('Como você quer pagar')).queryByRole('radiogroup')).toBeNull();
  });
});
