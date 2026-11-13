// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeSubscriptionApi, ownerWorld, renderSubscription, type Recorded } from './subscription-fixture.js';

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

const saved = { last4: '4242', expMonth: 8, expYear: 2028, brand: 'test' } as const;
const puts = (recorded: Recorded[]): Recorded[] => recorded.filter((entry) => entry.method === 'PUT' && entry.path === '/subscription/test-card');
const open = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Trocar' }));
  return screen.findByRole('dialog', { name: 'Trocar o cartão' });
};
const fill = (dialog: HTMLElement, last4: string, expiry: string): void => {
  fireEvent.change(within(dialog).getByLabelText('4 últimos dígitos'), { target: { value: last4 } });
  fireEvent.change(within(dialog).getByLabelText('Validade'), { target: { value: expiry } });
};

describe('the test card of "Cartão e cobranças"', () => {
  it('shows "final 4242 · vence 08/2028" with "Trocar" when the API has the test card', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ testCard: saved }));
    renderSubscription(impl);

    expect(await screen.findByRole('heading', { name: 'Cartão e cobranças' })).toBeTruthy();
    expect(await screen.findByText('Cartão salvo')).toBeTruthy();
    expect(screen.getByText('final 4242 · vence 08/2028')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trocar' })).toBeTruthy();
    expect(screen.getByText('Uma por cobrança, com plano e extras')).toBeTruthy();
  });

  it('the whole card disappears where the API answers 404 (production), and the invoices stay', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);

    expect(await screen.findByRole('heading', { name: 'Cartão e cobranças' })).toBeTruthy();
    await waitFor(() => expect(recorded.some((entry) => entry.path === '/subscription/test-card')).toBe(true));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.queryByText('Cartão salvo')).toBeNull();
    expect(screen.queryByText(/final \d{4}/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trocar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cadastrar' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Ver faturas' }).length).toBeGreaterThan(0);
  });

  it('with no card saved it says so and offers "Cadastrar" with the same dialog', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ testCard: null }));
    renderSubscription(impl);

    expect(await screen.findByText('Nenhum cartão ainda')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByRole('dialog', { name: 'Cadastrar o cartão' })).toBeTruthy();
  });

  it('"Trocar" asks only for the last four digits, the expiry and the brand: never the number nor the code', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ testCard: saved }));
    renderSubscription(impl);
    const dialog = await open();

    expect(within(dialog).getByText('O novo cartão será usado a partir da próxima cobrança. O cartão atual é final 4242.')).toBeTruthy();
    expect(within(dialog).getByLabelText('4 últimos dígitos')).toBeTruthy();
    expect(within(dialog).getByLabelText('Validade')).toBeTruthy();
    expect(within(dialog).getByText('Marca: cartão de teste')).toBeTruthy();
    expect(within(dialog).queryByLabelText(/Número do cartão/)).toBeNull();
    expect(within(dialog).queryByLabelText(/CVV|segurança/i)).toBeNull();
    expect(within(dialog).queryByText('4242 4242 4242 4242')).toBeNull();
  });

  it('saves with exactly the four contract fields, closes the dialog and shows the new card', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ testCard: saved }));
    renderSubscription(impl);
    const dialog = await open();
    fill(dialog, '1111', '09/2030');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar o cartão' }));

    expect(await screen.findByText('final 1111 · vence 09/2030')).toBeTruthy();
    expect(puts(recorded)).toHaveLength(1);
    expect(puts(recorded)[0]?.body).toEqual({ last4: '1111', expMonth: 9, expYear: 2030, brand: 'test' });
    expect(Object.keys(puts(recorded)[0]?.body as object).sort()).toEqual(['brand', 'expMonth', 'expYear', 'last4']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Cartão salvo. Vale a partir da próxima cobrança.')).toBeTruthy();
  });

  it('maps the 400 of the API to a message, keeps the dialog open and does not erase what was typed', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ testCard: saved, testCardRefusal: { status: 400, code: 'TEST_CARD_INVALID' } }));
    renderSubscription(impl);
    const dialog = await open();
    fill(dialog, '1111', '09/2030');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar o cartão' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('O cartão foi recusado. Confira os 4 últimos dígitos e a validade: só cartões de teste são aceitos.');
    expect(alert.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('dialog', { name: 'Trocar o cartão' })).toBeTruthy();
    expect((within(dialog).getByLabelText('4 últimos dígitos') as HTMLInputElement).value).toBe('1111');
    expect((within(dialog).getByLabelText('Validade') as HTMLInputElement).value).toBe('09/2030');
    expect(puts(recorded)).toHaveLength(1);
    expect(screen.getByText('final 4242 · vence 08/2028')).toBeTruthy();
  });

  it('another failure says it could not save, with the typed values kept', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ testCard: saved, testCardRefusal: { status: 500, code: 'INTERNAL_ERROR' } }));
    renderSubscription(impl);
    const dialog = await open();
    fill(dialog, '1111', '09/2030');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar o cartão' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('Não foi possível salvar o cartão. Tente de novo.');
    expect((within(dialog).getByLabelText('4 últimos dígitos') as HTMLInputElement).value).toBe('1111');
  });

  it('refuses a value the contract does not take before sending anything', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ testCard: saved }));
    renderSubscription(impl);
    const dialog = await open();
    fill(dialog, '12a', '13/2030');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar o cartão' }));

    expect(await within(dialog).findByText('Informe os 4 últimos dígitos do cartão de teste.')).toBeTruthy();
    expect(within(dialog).getByText('Informe a validade como MM/AAAA, com o ano de 2000 a 2099.')).toBeTruthy();
    expect(puts(recorded)).toHaveLength(0);

    fill(dialog, '1234', '12/2100');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar o cartão' }));
    expect(await within(dialog).findByText('Informe a validade como MM/AAAA, com o ano de 2000 a 2099.')).toBeTruthy();
    expect(puts(recorded)).toHaveLength(0);
  });

  it('"Cancelar" closes the dialog and sends nothing; opening it again starts empty', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ testCard: saved }));
    renderSubscription(impl);
    const dialog = await open();
    fill(dialog, '1111', '09/2030');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts(recorded)).toHaveLength(0);
    const again = await open();
    expect((within(again).getByLabelText('4 últimos dígitos') as HTMLInputElement).value).toBe('');
  });
});
