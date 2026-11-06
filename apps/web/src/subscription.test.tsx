// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

const posts = (recorded: Recorded[], suffix: string): Recorded[] => recorded.filter((entry) => entry.method === 'POST' && entry.path.endsWith(suffix));
const choosePlan = async (name: RegExp): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name })); };
const startPayment = async (name: RegExp): Promise<void> => {
  await choosePlan(name);
  fireEvent.click(await screen.findByRole('button', { name: 'Subir o plano' }));
  await screen.findByRole('heading', { name: /Pagamento simulado/ });
};
const CARD_VALUES = ['4111111111111111', '12/30', 'CVV-731', 'Fulana de Tal'];
const fillCard = (): void => {
  fireEvent.change(screen.getByLabelText('Número do cartão'), { target: { value: CARD_VALUES[0] } });
  fireEvent.change(screen.getByLabelText('Validade'), { target: { value: CARD_VALUES[1] } });
  fireEvent.change(screen.getByLabelText('CVV'), { target: { value: CARD_VALUES[2] } });
  fireEvent.change(screen.getByLabelText('Nome impresso no cartão'), { target: { value: CARD_VALUES[3] } });
};

describe('the plans and subscription screen (#773)', () => {
  it('lists the plans with their ceilings and prices, and the current subscription with its use', async () => {
    const world = ownerWorld();
    const { impl } = makeSubscriptionApi(world);
    renderSubscription(impl);

    expect(await screen.findByText('Clientes: 4 de 10')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Assinatura' })).toBeTruthy();
    expect(screen.getByText('Armazenamento: 1 GB de 20 GB')).toBeTruthy();
    expect(screen.getByText(/Próxima renovação em 30 de novembro de 2026/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Plano atual.*Essencial.*10 clientes, 20 GB · R\$ 97\/mês/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Profissional.*30 clientes, 100 GB · R\$ 197\/mês/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Agência.*60 clientes, 300 GB · R\$ 397\/mês/ })).toBeTruthy();
  });

  it('shows the total with the extras the moment they change, and what is charged now', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    await choosePlan(/Profissional/);
    fireEvent.change(screen.getByLabelText('Clientes extras'), { target: { value: '7' } });

    expect(await screen.findByText('R$ 197 + R$ 42 = R$ 239/mês')).toBeTruthy();
    expect(screen.getByText(/Cobrança agora: R\$ 142 \(o restante do período atual\)\./)).toBeTruthy();
    expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'profissional', extraClients: 7, extraStorageGib: 0 });
  });

  it('refuses a non-number in the extras and asks for no quote with it', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    await choosePlan(/Profissional/);
    await screen.findByText(/Cobrança agora/);
    const before = posts(recorded, '/quote').length;
    fireEvent.change(screen.getByLabelText('Armazenamento extra, em GB'), { target: { value: '12a' } });

    expect(await screen.findByText('Informe um número inteiro, de 0 a 10000.')).toBeTruthy();
    expect(screen.getByText('Corrija os extras para ver o total.')).toBeTruthy();
    expect(posts(recorded, '/quote')).toHaveLength(before);
    expect((screen.getByRole('button', { name: 'Escolha um plano' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server reason when a quote is refused, and keeps the action closed', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ quoteError: true }));
    renderSubscription(impl);
    await choosePlan(/Profissional/);

    expect(await screen.findByText(/Arquive clientes antes de reduzir/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Escolha um plano' }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe('the simulated card', () => {
    it('approves with any data, sends only the outcome, and the card values appear in no request at all', async () => {
      const world = ownerWorld();
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
      await startPayment(/Profissional/);

      expect(screen.getByText(/pagamento de teste: qualquer dado serve, nenhum dado de cartão sai do seu navegador/)).toBeTruthy();
      expect(screen.getByText(/Valor desta cobrança/).textContent).toContain('R$ 100');
      fillCard();
      fireEvent.click(screen.getByRole('button', { name: /^Pagar R\$ 100/ }));

      expect(await screen.findByText('Pagamento aprovado. A sua assinatura já vale.')).toBeTruthy();
      const payment = posts(recorded, '/simulated-payment');
      expect(payment).toHaveLength(1);
      expect(payment[0]?.body).toEqual({ outcome: 'approved' });
      expect(payment[0]?.path).toBe('/subscription/charges/00000000-0000-4000-8000-000000000001/simulated-payment');

      const everything = JSON.stringify(recorded.map(({ method, path, body, headers }) => [method, path, body, [...headers.entries()]]));
      for (const value of CARD_VALUES) expect(everything).not.toContain(value);
      // The change request carries the terms asked for and never an amount or a price.
      expect(posts(recorded, '/charges')[0]?.body).toEqual({ planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
      expect(Object.keys(posts(recorded, '/quote')[0]?.body as object).sort()).toEqual(['extraClients', 'extraStorageGib', 'planKey']);
      // The plan on screen is what the server then said, read again after the payment.
      expect(await screen.findByText('Clientes: 4 de 30')).toBeTruthy();
    });

    it('accepts an empty card too: nothing about it is validated', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      await startPayment(/Profissional/);
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));

      expect(await screen.findByText('Pagamento aprovado. A sua assinatura já vale.')).toBeTruthy();
      expect(posts(recorded, '/simulated-payment')[0]?.body).toEqual({ outcome: 'approved' });
    });

    it('simulates a decline: says so, charges nothing and leaves the plan; the next try opens a new charge', async () => {
      const world = ownerWorld();
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
      await startPayment(/Profissional/);
      fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

      expect(await screen.findByText(/Pagamento recusado\. Nada foi cobrado e o plano continua o mesmo/)).toBeTruthy();
      expect(posts(recorded, '/simulated-payment')[0]?.body).toEqual({ outcome: 'declined' });
      expect(screen.queryByRole('heading', { name: /Pagamento simulado/ })).toBeNull();
      expect(world.subscription?.planKey).toBe('essencial');

      await startPayment(/Profissional/);
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/charges')).toHaveLength(2);
      expect(posts(recorded, '/simulated-payment').map((entry) => entry.path)).toEqual([
        '/subscription/charges/00000000-0000-4000-8000-000000000001/simulated-payment',
        '/subscription/charges/00000000-0000-4000-8000-000000000002/simulated-payment'
      ]);
    });

    it('abandoning the card pays nothing, says so, and a later entry in the same tab opens a fresh charge', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      await startPayment(/Profissional/);
      fillCard();
      fireEvent.click(screen.getByRole('button', { name: 'Voltar sem pagar' }));

      expect(await screen.findByText('Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.')).toBeTruthy();
      expect(posts(recorded, '/simulated-payment')).toHaveLength(0);
      expect(screen.queryByLabelText('Número do cartão')).toBeNull();

      await startPayment(/Agência/);
      // The new card is empty: what was typed before is gone.
      expect((screen.getByLabelText('Número do cartão') as HTMLInputElement).value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/simulated-payment').map((entry) => entry.path)).toEqual(['/subscription/charges/00000000-0000-4000-8000-000000000002/simulated-payment']);
    });

    it('two quick clicks on Pagar send one payment', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      await startPayment(/Profissional/);
      const pay = screen.getByRole('button', { name: /^Pagar/ });
      fireEvent.click(pay);
      fireEvent.click(pay);
      fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
    });

    it('submitting the form again while the payment is in flight (Enter) sends nothing more', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      await startPayment(/Profissional/);
      const form = screen.getByRole('heading', { name: /Pagamento simulado/ }).closest('form')!;
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      fireEvent.submit(form);
      fireEvent.submit(form);

      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
    });

    it('trusts what the server answered, not what was asked: an approval the server declined reads as declined', async () => {
      const { impl } = makeSubscriptionApi(ownerWorld({ paymentStatus: 'declined' }));
      renderSubscription(impl);
      await startPayment(/Profissional/);
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));

      expect(await screen.findByText(/Pagamento recusado/)).toBeTruthy();
      expect(screen.queryByText('Pagamento aprovado. A sua assinatura já vale.')).toBeNull();
    });

    it('a failure of the payment request is announced as an alert and never as an approval', async () => {
      const { impl } = makeSubscriptionApi(ownerWorld({ paymentStatus: 'error' }));
      renderSubscription(impl);
      await startPayment(/Profissional/);
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Não foi possível concluir o pagamento');
      expect(screen.queryByText('Pagamento aprovado. A sua assinatura já vale.')).toBeNull();
    });

    it('does not exist where the API does not expose the simulated provider: no card, no way to open a charge, no test control', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld({ provider: null }));
      renderSubscription(impl);
      await choosePlan(/Profissional/);
      await screen.findByText(/Cobrança agora/);

      expect(screen.getAllByText('O pagamento ainda não está disponível neste ambiente.').length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('button', { name: 'Subir o plano' }));
      expect(posts(recorded, '/charges')).toHaveLength(0);
      expect(screen.queryByText('Pagamento simulado')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Avançar para o fim do período' })).toBeNull();
    });
  });

  it('starts a subscription from the trial, and tells an expired trial it is read-only', async () => {
    const world = ownerWorld({ subscription: null, plan: { kind: 'trial', trialEndsAt: '2026-11-01T00:00:00.000Z', readOnly: true } });
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl);

    expect(await screen.findByText('O período de teste acabou e a agência está somente leitura. Escolha um plano para voltar a editar.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancelar a assinatura' })).toBeNull();
    await choosePlan(/Essencial/);
    fireEvent.click(await screen.findByRole('button', { name: 'Assinar' }));
    await screen.findByRole('heading', { name: /Pagamento simulado/ });
    fireEvent.click(screen.getByRole('button', { name: /^Pagar R\$ 97/ }));

    await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
    expect(posts(recorded, '/charges')[0]?.body).toEqual({ planKey: 'essencial', extraClients: 0, extraStorageGib: 0 });
    // The shell asks who the agency is again, so the read-only notices follow the new plan.
    await waitFor(() => expect(recorded.filter((entry) => entry.path === '/me').length).toBeGreaterThan(1));
  });

  it('a downgrade is scheduled without a card', async () => {
    const world = ownerWorld({ subscription: { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 } });
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl);
    await choosePlan(/Essencial/);

    expect(await screen.findByText(/Nada é cobrado agora\. A mudança vale a partir de 9 de novembro de 2026\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Descer o plano' }));

    expect(await screen.findByText('Mudança agendada para 9 de novembro de 2026.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Pagamento simulado/ })).toBeNull();
    expect(posts(recorded, '/simulated-payment')).toHaveLength(0);
  });

  it('two clicks in the same tick on the action open one charge', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    await choosePlan(/Profissional/);
    const action = await screen.findByRole('button', { name: 'Subir o plano' });
    act(() => { fireEvent.click(action); fireEvent.click(action); });

    await screen.findByRole('heading', { name: /Pagamento simulado/ });
    expect(posts(recorded, '/charges')).toHaveLength(1);
  });

  it('says the conditions are already the subscription’s and offers no action', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);

    expect(await screen.findByText('Estas já são as condições da sua assinatura.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Escolha um plano' }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe('cancelling', () => {
    it('shows what the agency has and what happens before the confirmation, and cancels with one click after it', async () => {
      const world = ownerWorld();
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar a assinatura' }));

      const dialog = await screen.findByRole('dialog', { name: 'Cancelar a assinatura?' });
      expect(within(dialog).getByText('4 clientes ativos')).toBeTruthy();
      expect(within(dialog).getByText('1 GB de mídia guardada')).toBeTruthy();
      expect(within(dialog).getByText(/O acesso continua até 30 de novembro de 2026, sem nova cobrança\. Depois, a agência fica somente leitura\./)).toBeTruthy();
      expect(within(dialog).getByText('Os dados continuam guardados e visíveis.')).toBeTruthy();
      expect(posts(recorded, '/cancel')).toHaveLength(0);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar a assinatura' }));
      expect(await screen.findByText('Assinatura cancelada. O acesso continua até o fim do período.')).toBeTruthy();
      expect(posts(recorded, '/cancel')).toHaveLength(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await screen.findByRole('button', { name: 'Manter a assinatura' })).toBeTruthy();
    });

    it('two clicks in the same tick on the confirmation cancel once', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar a assinatura' }));
      const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar a assinatura' });
      act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });

      await screen.findByText('Assinatura cancelada. O acesso continua até o fim do período.');
      expect(posts(recorded, '/cancel')).toHaveLength(1);
    });

    it('keeping the subscription closes the dialog and cancels nothing', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar a assinatura' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Manter a assinatura' }));

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(posts(recorded, '/cancel')).toHaveLength(0);
    });

    it('during the grace period the dialog says the agency turns read-only at once', async () => {
      const world = ownerWorld({ subscription: { planKey: 'essencial', extraClients: 0, extraStorageGib: 0, graceEndsOn: '2026-12-04' } });
      const { impl } = makeSubscriptionApi(world);
      renderSubscription(impl);

      expect(await screen.findByText(/continua editando até 04\/12\/2026; depois disso fica somente leitura/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar a assinatura' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('O pagamento está atrasado: a agência fica somente leitura assim que você confirmar.')).toBeTruthy();
      expect(within(dialog).queryByText(/O acesso continua até/)).toBeNull();
    });

    it('a canceled subscription shows the end date and can be kept again', async () => {
      const world = ownerWorld({ subscription: { planKey: 'essencial', extraClients: 0, extraStorageGib: 0, cancelAtPeriodEnd: true } });
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);

      expect(await screen.findByText(/A assinatura está cancelada\. Depois de 30 de novembro de 2026, a agência fica somente leitura\./)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancelar a assinatura' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Manter a assinatura' }));

      expect(await screen.findByText('A assinatura foi mantida.')).toBeTruthy();
      expect(posts(recorded, '/reactivate')).toHaveLength(1);
      expect(await screen.findByRole('button', { name: 'Cancelar a assinatura' })).toBeTruthy();
    });
  });

  it('the control to jump to the end of the period exists only with the simulated provider and acts once', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    fireEvent.click(await screen.findByRole('button', { name: 'Avançar para o fim do período' }));

    expect(await screen.findByText('O período foi levado ao fim.')).toBeTruthy();
    expect(posts(recorded, '/simulated-period-advance')).toHaveLength(1);
  });

  describe('who sees it', () => {
    it('the Owner has Assinatura in the menu and it leads to the screen', async () => {
      const { impl } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl, `/agencia/11111111-1111-4111-8111-111111111111`);
      const link = await screen.findByRole('link', { name: 'Assinatura' });
      expect(link.getAttribute('href')).toBe('/agencia/11111111-1111-4111-8111-111111111111/assinatura');
      fireEvent.click(link);
      expect(await screen.findByRole('heading', { level: 1, name: 'Assinatura' })).toBeTruthy();
    });

    it('an Admin has no item in the menu, and the typed address is the ordinary not found, with no billing request', async () => {
      const world = ownerWorld({ permissions: ['cliente.visualizar', 'colaborador.visualizar'] });
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);

      expect(await screen.findByRole('heading', { name: /não encontrad/i })).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Assinatura' })).toBeNull();
      expect(recorded.filter((entry) => entry.path.startsWith('/subscription'))).toHaveLength(0);
    });
  });
});
