// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { makeSubscriptionApi, ownerWorld, renderSubscription, trialWorld, type Recorded } from './subscription-fixture.js';

afterEach(cleanup);

const posts = (recorded: Recorded[], suffix: string): Recorded[] => recorded.filter((entry) => entry.method === 'POST' && entry.path.endsWith(suffix));
/** The purchase screen: the summary only exists there. */
const CARD_HEADING = 'Resumo';
const AGENCY_INVOICES = '/agencia/11111111-1111-4111-8111-111111111111/assinatura/faturas';
const payButton = (amount: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^(Assinar e pagar|Pagar) ${amount}`) });
const dueNow = (): string => screen.getByText('Você paga agora').parentElement!.textContent ?? '';

const subscribeTo = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: `Assinar ${name}` }));
  await screen.findByRole('heading', { name: CARD_HEADING });
};

const changeTo = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: `Escolher ${name}` }));
  fireEvent.click(await screen.findByRole('button', { name: 'Subir o plano' }));
  await screen.findByRole('heading', { name: CARD_HEADING });
};

const CARD_VALUES = ['4111111111111111', '12/30', 'CVV-731', 'Fulana de Tal'];
const fillCard = (): void => {
  fireEvent.change(screen.getByLabelText('Número do cartão'), { target: { value: CARD_VALUES[0] } });
  fireEvent.change(screen.getByLabelText('Validade'), { target: { value: CARD_VALUES[1] } });
  fireEvent.change(screen.getByLabelText('CVV'), { target: { value: CARD_VALUES[2] } });
  fireEvent.change(screen.getByLabelText('Nome impresso no cartão'), { target: { value: CARD_VALUES[3] } });
};

describe('the purchase screen and every way out of it', () => {
  it('approves with any data, sends only the outcome, and the card values appear in no request at all', async () => {
    const world = ownerWorld();
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl);
    await changeTo('Profissional');

    expect(screen.getByRole('heading', { level: 1, name: 'Subir para o Profissional' })).toBeTruthy();
    expect(screen.getByText(/Ambiente de teste: nenhum valor é cobrado\./)).toBeTruthy();
    expect(screen.getByText(/Isto é um pagamento de teste: qualquer dado serve e nenhum dado de cartão sai do seu navegador\./)).toBeTruthy();
    expect(dueNow()).toContain('R$ 66,67');
    expect(screen.getByText('Diferença de R$ 100,00 × 20 de 30 dias = R$ 66,67')).toBeTruthy();
    expect(screen.getByText('Período atual até 30 de novembro de 2026 (20 dias que faltam).')).toBeTruthy();
    expect(screen.getByText('Plano atual')).toBeTruthy();
    fillCard();
    fireEvent.click(payButton('R\\$ 66,67'));

    expect(await screen.findByText('Plano Profissional ativo')).toBeTruthy();
    expect(screen.getByText('Os novos tetos já valem: 30 clientes ativos e 100 GB. A cobrança de R$ 66,67 foi confirmada.')).toBeTruthy();
    const payment = posts(recorded, '/simulated-payment');
    expect(payment).toHaveLength(1);
    expect(payment[0]?.body).toEqual({ outcome: 'approved' });
    expect(payment[0]?.path).toBe('/subscription/charges/00000000-0000-4000-8000-000000000001/simulated-payment');

    const everything = JSON.stringify(recorded.map(({ method, path, body, headers }) => [method, path, body, [...headers.entries()]]));
    for (const value of CARD_VALUES) expect(everything).not.toContain(value);
    // The change request carries the terms asked for and never an amount or a price.
    expect(posts(recorded, '/charges')[0]?.body).toEqual({ planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    expect(Object.keys(posts(recorded, '/quote')[0]?.body as object).sort()).toEqual(['extraClients', 'extraStorageGib', 'planKey']);
    expect(Object.keys(posts(recorded, '/charges')[0]?.body as object).sort()).toEqual(['extraClients', 'extraStorageGib', 'planKey']);

    expect(screen.getByRole('link', { name: 'Ver a fatura' }).getAttribute('href')).toBe(AGENCY_INVOICES);
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a assinatura' }));
    // The plan on screen is what the server then said, read again after the payment.
    expect(await screen.findByText('Clientes: 4 de 30')).toBeTruthy();
  });

  it('accepts an empty card too: nothing about it is validated', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    await changeTo('Profissional');
    fireEvent.click(payButton('R\\$ 66,67'));

    expect(await screen.findByText('Plano Profissional ativo')).toBeTruthy();
    expect(posts(recorded, '/simulated-payment')[0]?.body).toEqual({ outcome: 'approved' });
  });

  it('a refusal stays on the purchase: nothing is charged, the plan stays, and "Tentar de novo" opens another charge and pays it', async () => {
    const world = ownerWorld();
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl);
    await changeTo('Profissional');
    fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('O cartão foi recusado.');
    expect(alert.textContent).toContain('Nenhum valor foi cobrado e seu plano continua o mesmo.');
    expect(posts(recorded, '/simulated-payment')[0]?.body).toEqual({ outcome: 'declined' });
    expect(screen.getByRole('heading', { name: CARD_HEADING })).toBeTruthy();
    expect(world.subscription?.planKey).toBe('essencial');
    expect(posts(recorded, '/charges')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Plano Profissional ativo')).toBeTruthy();
    expect(posts(recorded, '/charges').map((entry) => entry.body)).toEqual([
      { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 },
      { planKey: 'profissional', extraClients: 0, extraStorageGib: 0 }
    ]);
    expect(posts(recorded, '/simulated-payment').map((entry) => entry.path)).toEqual([
      '/subscription/charges/00000000-0000-4000-8000-000000000001/simulated-payment',
      '/subscription/charges/00000000-0000-4000-8000-000000000002/simulated-payment'
    ]);
  });

  it('a second refusal in a row is shown again and each retry is a new charge', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5, { paymentSequence: ['declined', 'declined', 'confirmed'] }));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    fireEvent.click(payButton('R\\$ 197,00'));
    await screen.findByText(/O cartão foi recusado\./);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(posts(recorded, '/simulated-payment')).toHaveLength(2));
    await screen.findByText(/O cartão foi recusado\./);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText('Plano Profissional ativo')).toBeTruthy();
    expect(posts(recorded, '/charges')).toHaveLength(3);
  });

  it('abandoning the card pays nothing, says so, and a later entry in the same tab opens a fresh charge', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    fillCard();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar sem pagar' }));

    expect(await screen.findByText('Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.')).toBeTruthy();
    expect(posts(recorded, '/simulated-payment')).toHaveLength(0);
    expect(screen.queryByLabelText('Número do cartão')).toBeNull();

    await subscribeTo('Agência');
    // The new card is empty: what was typed before is gone.
    expect((screen.getByLabelText('Número do cartão') as HTMLInputElement).value).toBe('');
    fireEvent.click(payButton('R\\$ 397,00'));
    await screen.findByText('Plano Agência ativo');
    expect(posts(recorded, '/simulated-payment').map((entry) => entry.path)).toEqual(['/subscription/charges/00000000-0000-4000-8000-000000000002/simulated-payment']);
  });

  it('the "Assinatura" crumb leaves the same way as "Voltar sem pagar"', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    fireEvent.click(screen.getByRole('button', { name: 'Assinatura' }));

    expect(await screen.findByText('Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.')).toBeTruthy();
    expect(posts(recorded, '/simulated-payment')).toHaveLength(0);
  });

  it('leaving is closed while the payment is in flight: Voltar sem pagar does not say nothing was charged, and the approval is what shows', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    fireEvent.click(payButton('R\\$ 197,00'));
    const leave = screen.getByRole('button', { name: 'Voltar sem pagar' }) as HTMLButtonElement;
    expect(leave.disabled).toBe(true);
    fireEvent.click(leave);

    expect(await screen.findByText('Plano Profissional ativo')).toBeTruthy();
    expect(screen.queryByText(/Você saiu sem pagar/)).toBeNull();
    expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
  });

  it('two quick clicks on Pagar send one payment', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    const pay = payButton('R\\$ 197,00');
    fireEvent.click(pay);
    fireEvent.click(pay);
    fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

    await screen.findByText('Plano Profissional ativo');
    expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
  });

  it('submitting the form again while the payment is in flight (Enter) sends nothing more', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    const form = screen.getByRole('heading', { name: 'Como você quer pagar' }).closest('form')!;
    act(() => { fireEvent.click(payButton('R\\$ 197,00')); fireEvent.submit(form); fireEvent.submit(form); });

    await screen.findByText('Plano Profissional ativo');
    expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
  });

  it('trusts what the server answered, not what was asked: an approval the server declined reads as declined', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5, { paymentStatus: 'declined' }));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    fireEvent.click(payButton('R\\$ 197,00'));

    expect((await screen.findByRole('alert')).textContent).toContain('O cartão foi recusado.');
    expect(screen.queryByText('Plano Profissional ativo')).toBeNull();
  });

  it('a failure of the provider is announced as an alert and never as an approval, and a new entry in the same tab works', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5, { paymentSequence: ['error'] }));
    renderSubscription(impl);
    await subscribeTo('Profissional');
    fireEvent.click(payButton('R\\$ 197,00'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível concluir o pagamento');
    expect(screen.queryByText('Plano Profissional ativo')).toBeNull();
    expect(screen.queryByRole('heading', { name: CARD_HEADING })).toBeNull();

    await subscribeTo('Profissional');
    fireEvent.click(payButton('R\\$ 197,00'));
    expect(await screen.findByText('Plano Profissional ativo')).toBeTruthy();
    expect(posts(recorded, '/charges')).toHaveLength(2);
  });

  it('the first subscription says what it opens: "Assinar e pagar", with no days and no period, since a first subscription prorates nothing', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Essencial');

    expect(screen.getByRole('button', { name: 'Assinar e pagar R$ 97,00' })).toBeTruthy();
    expect(screen.getByText('Começa hoje')).toBeTruthy();
    expect(screen.getByText('Depois, R$ 97,00 por mês.')).toBeTruthy();
    expect(screen.queryByText(/\d+ dias? que falt/)).toBeNull();
    expect(screen.getByText('10 clientes ativos')).toBeTruthy();
  });
});
