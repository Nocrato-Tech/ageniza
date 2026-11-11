// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeSubscriptionApi, ownerWorld, renderSubscription, trialWorld, type Recorded } from './subscription-fixture.js';

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
const planCard = (name: string): HTMLElement => screen.getByRole('article', { name });
const CARD_HEADING = /Pagamento simulado/;

/** From the price table (agency without a paid plan): one click on the card's own button opens the simulated card. */
const subscribeTo = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: `Assinar ${name}` }));
  await screen.findByRole('heading', { name: CARD_HEADING });
};

/** From "Seu plano" (Essencial): change to another plan through the same table and confirm the raise. */
const changeTo = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));
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

describe('when the subscription cannot be read (empty-state rule)', () => {
  it.each(['/subscription/plans', '/subscription'])('shows the failure with "Tentar de novo" when %s does not answer, never the price table or "Seu plano", and the retry reads it again', async (failing) => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    let healthy = false;
    const reads: string[] = [];
    const flaky: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^.*\/agencies\/[^/]+/, '');
      if (path === failing) {
        reads.push(path);
        if (!healthy) return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return impl(input, init);
    };
    renderSubscription(flaky);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível abrir a assinatura. Tente de novo.');
    expect(alert.textContent).toContain('Nada foi alterado.');
    expect(alert.textContent).not.toContain('private diagnostic');
    expect(alert.classList.contains('ui-empty-state--failure')).toBe(true);
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Seu plano' })).toBeNull();

    healthy = true;
    const readsBeforeRetry = reads.length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('button', { name: 'Assinar Essencial' })).toBeTruthy();
    expect(reads.length).toBeGreaterThan(readsBeforeRetry);
  });
});

describe('without a paid plan: only the price table (#773)', () => {
  it('says the trial state and shows three plan cards, each with its price, audience, limits and own button', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);

    expect(await screen.findByText(/Você está no teste grátis: faltam 5 dias\./)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Assinatura' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(3);

    const essential = within(planCard('Essencial'));
    expect(essential.getByText('R$ 97')).toBeTruthy();
    expect(essential.getByText('/mês')).toBeTruthy();
    expect(essential.getByText('Para quem está começando, com poucos clientes.')).toBeTruthy();
    expect(essential.getByText('10 clientes ativos')).toBeTruthy();
    expect(essential.getByText('20 GB de armazenamento')).toBeTruthy();
    expect(essential.getByRole('button', { name: 'Assinar Essencial' })).toBeTruthy();

    const professional = within(planCard('Profissional'));
    expect(professional.getByText('R$ 197')).toBeTruthy();
    expect(professional.getByText('30 clientes ativos')).toBeTruthy();
    expect(professional.getByText('100 GB de armazenamento')).toBeTruthy();

    const agency = within(planCard('Agência'));
    expect(agency.getByText('R$ 397')).toBeTruthy();
    expect(agency.getByText('60 clientes ativos')).toBeTruthy();
    expect(agency.getByText('300 GB de armazenamento')).toBeTruthy();
  });

  it('highlights only the middle plan as recommended, with the primary button; the others are secondary; no claim without data', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await screen.findByRole('button', { name: 'Assinar Profissional' });

    expect(screen.getAllByText('Recomendado')).toHaveLength(1);
    expect(within(planCard('Profissional')).getByText('Recomendado')).toBeTruthy();
    expect(planCard('Profissional').className).toContain('plan-card--recommended');
    expect(screen.getByRole('button', { name: 'Assinar Profissional' }).className).toContain('ui-button--primary');
    expect(screen.getByRole('button', { name: 'Assinar Essencial' }).className).toContain('ui-button--secondary');
    expect(screen.getByRole('button', { name: 'Assinar Agência' }).className).toContain('ui-button--secondary');
    expect(screen.queryByText(/mais escolhido/i)).toBeNull();
  });

  it('lists what every plan includes below the cards', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);

    const strip = within((await screen.findByRole('heading', { name: 'Todos os planos incluem' })).closest('section')!);
    for (const item of ['Calendário editorial', 'Portal de aprovação do cliente', 'App mobile', 'Colaboradores ilimitados']) expect(strip.getByText(item)).toBeTruthy();
  });

  it('offers no extras, no plan change and no cancellation: extras exist only after a plan is subscribed', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await screen.findByRole('button', { name: 'Assinar Essencial' });

    expect(screen.queryByLabelText('Clientes extras')).toBeNull();
    expect(screen.queryByLabelText(/Armazenamento extra/)).toBeNull();
    expect(screen.queryByText(/extras/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trocar de plano' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancelar a assinatura' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Seu plano' })).toBeNull();
  });

  it('says a trial of one day has one day left, and an ended trial is read-only', async () => {
    const one = makeSubscriptionApi(trialWorld(1));
    renderSubscription(one.impl);
    expect(await screen.findByText(/Você está no teste grátis: falta 1 dia\./)).toBeTruthy();
    cleanup();

    const ended = makeSubscriptionApi(trialWorld(0));
    renderSubscription(ended.impl);
    expect(await screen.findByText('O teste acabou. A agência está somente leitura; escolha um plano para voltar a editar.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Assinar / })).toHaveLength(3);
  });

  it('each Assinar button leads to the card of its own plan, with the server quote, and opens that plan alone with no extras', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);

    await subscribeTo('Essencial');
    expect(screen.getByText(/Plano/, { selector: '.subscription-card__plan' }).textContent).toBe('Plano Essencial, R$ 97/mês');
    expect(screen.getByText(/Valor desta cobrança/).textContent).toContain('R$ 97');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar sem pagar' }));

    await subscribeTo('Agência');
    expect(screen.getByText(/Plano/, { selector: '.subscription-card__plan' }).textContent).toBe('Plano Agência, R$ 397/mês');
    expect(screen.getByText(/Valor desta cobrança/).textContent).toContain('R$ 397');

    expect(posts(recorded, '/quote').map((entry) => entry.body)).toEqual([
      { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 },
      { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 }
    ]);
    expect(posts(recorded, '/charges').map((entry) => entry.body)).toEqual([
      { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 },
      { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 }
    ]);
  });

  it('two clicks in the same tick on a card open one charge', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    const button = await screen.findByRole('button', { name: 'Assinar Profissional' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });

    await screen.findByRole('heading', { name: CARD_HEADING });
    expect(posts(recorded, '/charges')).toHaveLength(1);
  });

  it('paying turns the screen into "Seu plano" with the extras that did not exist before', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await subscribeTo('Essencial');
    fireEvent.click(screen.getByRole('button', { name: /^Pagar R\$ 97/ }));

    expect(await screen.findByText('Pagamento aprovado. A sua assinatura já vale.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Seu plano' })).toBeTruthy();
    expect(await screen.findByLabelText('Clientes extras')).toBeTruthy();
    // The shell asks who the agency is again, so the read-only notices follow the new plan.
    await waitFor(() => expect(recorded.filter((entry) => entry.path === '/me').length).toBeGreaterThan(1));
  });

  it('where the API does not expose the simulated provider the buttons are closed, no charge is opened and no test tool exists', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5, { provider: null }));
    renderSubscription(impl);
    const button = await screen.findByRole('button', { name: 'Assinar Profissional' });

    expect(screen.getAllByText('O pagamento ainda não está disponível neste ambiente.').length).toBeGreaterThan(0);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(posts(recorded, '/charges')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: CARD_HEADING })).toBeNull();
    expect(screen.queryByText('Ferramentas de teste')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Avançar para o fim do período' })).toBeNull();
  });

  it('shows the server reason when the quote of a plan is refused, and opens no charge', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5, { quoteError: true }));
    renderSubscription(impl);
    fireEvent.click(await screen.findByRole('button', { name: 'Assinar Essencial' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Arquive clientes antes de reduzir');
    expect(posts(recorded, '/charges')).toHaveLength(0);
  });

  it('keeps the test tools in a closed block at the bottom, only with the simulated provider', async () => {
    const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    const summary = await screen.findByText('Ferramentas de teste');
    const details = summary.closest('details')!;

    expect(details.open).toBe(false);
    expect(screen.getByRole('heading', { name: 'Todos os planos incluem' }).compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: 'Avançar para o fim do período', hidden: true }));
    expect(await screen.findByText('O período foi levado ao fim.')).toBeTruthy();
    expect(posts(recorded, '/simulated-period-advance')).toHaveLength(1);
  });
});

describe('with a paid plan: "Seu plano" (#773)', () => {
  it('shows the current plan, the monthly value, the next charge and the use', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);

    expect(await screen.findByRole('heading', { name: 'Seu plano' })).toBeTruthy();
    expect(screen.getByText('Essencial', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText(/R\$ 97\/mês/)).toBeTruthy();
    expect(screen.getByText(/Próxima cobrança em 30 de novembro de 2026/)).toBeTruthy();
    expect(screen.getByText('Clientes: 4 de 10')).toBeTruthy();
    expect(screen.getByText('Armazenamento: 1 GB de 20 GB')).toBeTruthy();
    expect(screen.queryByText('Recomendado')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Assinar / })).toBeNull();
  });

  it('shows the extras here, and the total follows what is typed, as the server quoted it', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '7' } });

    expect(await screen.findByText('R$ 97 + R$ 42 = R$ 139/mês')).toBeTruthy();
    expect(screen.getByText(/Cobrança agora: R\$ 42 \(o restante do período atual\)\./)).toBeTruthy();
    expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'essencial', extraClients: 7, extraStorageGib: 0 });

    fireEvent.change(screen.getByLabelText('Armazenamento extra, em GB'), { target: { value: '10' } });
    expect(await screen.findByText('R$ 97 + R$ 46 = R$ 143/mês')).toBeTruthy();
    expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'essencial', extraClients: 7, extraStorageGib: 10 });
  });

  it('buys extras through the simulated card, sending the terms and never an amount', async () => {
    const world = ownerWorld();
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '7' } });
    await screen.findByText(/Cobrança agora/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e pagar' }));
    await screen.findByRole('heading', { name: CARD_HEADING });
    fireEvent.click(screen.getByRole('button', { name: /^Pagar R\$ 42/ }));

    expect(await screen.findByText('Pagamento aprovado. A sua assinatura já vale.')).toBeTruthy();
    expect(posts(recorded, '/charges')[0]?.body).toEqual({ planKey: 'essencial', extraClients: 7, extraStorageGib: 0 });
    expect(await screen.findByText('Clientes: 4 de 17')).toBeTruthy();
  });

  it('refuses a non-number in the extras and asks for no quote with it', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '3' } });
    await screen.findByText(/Cobrança agora/);
    const before = posts(recorded, '/quote').length;
    fireEvent.change(screen.getByLabelText('Armazenamento extra, em GB'), { target: { value: '12a' } });

    expect(await screen.findByText('Informe um número inteiro, de 0 a 10000.')).toBeTruthy();
    expect(screen.getByText('Corrija os valores para ver o total.')).toBeTruthy();
    expect(posts(recorded, '/quote')).toHaveLength(before);
    expect((screen.getByRole('button', { name: 'Escolha as quantidades' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server reason when a quote is refused, and keeps the action closed', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ quoteError: true }));
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '2' } });

    expect(await screen.findByText(/Arquive clientes antes de reduzir/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Escolha as quantidades' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the conditions are already the subscription’s and offers no action', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);

    expect(await screen.findByText('Estas já são as condições da sua assinatura.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Escolha as quantidades' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('without the simulated provider the paid raise is closed and opens no charge', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ provider: null }));
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '7' } });
    await screen.findByText(/Cobrança agora/);

    expect(screen.getAllByText('O pagamento ainda não está disponível neste ambiente.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e pagar' }));
    expect(posts(recorded, '/charges')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: CARD_HEADING })).toBeNull();
    expect(screen.queryByText('Ferramentas de teste')).toBeNull();
  });

  describe('changing the plan', () => {
    it('opens the same table with the current plan marked "Seu plano" and not offered again', async () => {
      const { impl } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));

      const current = within(await screen.findByRole('article', { name: 'Essencial' }));
      expect(current.getByText('Seu plano')).toBeTruthy();
      const keep = current.getByRole('button', { name: 'Plano atual' }) as HTMLButtonElement;
      expect(keep.disabled).toBe(true);
      expect(screen.getAllByText('Seu plano').filter((node) => node.tagName === 'SPAN')).toHaveLength(1);
      expect(within(planCard('Profissional')).queryByText('Seu plano')).toBeNull();
      expect((screen.getByRole('button', { name: 'Escolher Profissional' }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole('button', { name: 'Escolher Agência' })).toBeTruthy();
    });

    it('marks the plan that is current, whichever it is', async () => {
      const { impl } = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 } }));
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));

      expect(within(await screen.findByRole('article', { name: 'Agência' })).getByText('Seu plano')).toBeTruthy();
      expect(within(planCard('Essencial')).queryByText('Seu plano')).toBeNull();
    });

    it('shows the server total of the chosen plan and what is charged now', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Profissional' }));

      expect(await screen.findByText('R$ 197/mês', { selector: '.subscription__total' })).toBeTruthy();
      expect(screen.getByText(/Cobrança agora: R\$ 100 \(o restante do período atual\)\./)).toBeTruthy();
      expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    });

    it('a downgrade is scheduled without a card', async () => {
      const world = ownerWorld({ subscription: { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 } });
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Essencial' }));

      expect(await screen.findByText(/Nada é cobrado agora\. A mudança vale a partir de 9 de novembro de 2026\./)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Descer o plano' }));

      expect(await screen.findByText('Mudança agendada para 9 de novembro de 2026.')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: CARD_HEADING })).toBeNull();
      expect(posts(recorded, '/simulated-payment')).toHaveLength(0);
    });

    it('two clicks in the same tick on the confirmation open one charge', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Profissional' }));
      const action = await screen.findByRole('button', { name: 'Subir o plano' });
      act(() => { fireEvent.click(action); fireEvent.click(action); });

      await screen.findByRole('heading', { name: CARD_HEADING });
      expect(posts(recorded, '/charges')).toHaveLength(1);
    });

    it('going back returns to "Seu plano" and sends nothing', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Trocar de plano' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Voltar ao meu plano' }));

      expect(await screen.findByLabelText('Clientes extras')).toBeTruthy();
      expect(posts(recorded, '/charges')).toHaveLength(0);
    });
  });

  describe('the simulated card', () => {
    it('approves with any data, sends only the outcome, and the card values appear in no request at all', async () => {
      const world = ownerWorld();
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
      await changeTo('Profissional');

      expect(screen.getByText(/pagamento de teste: qualquer dado serve, nenhum dado de cartão sai do seu navegador/)).toBeTruthy();
      expect(screen.getByText(/Valor desta cobrança/).textContent).toContain('R$ 100');
      expect(screen.getByText(/Plano/, { selector: '.subscription-card__plan' }).textContent).toBe('Plano Profissional, R$ 197/mês');
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
      expect(Object.keys(posts(recorded, '/charges')[0]?.body as object).sort()).toEqual(['extraClients', 'extraStorageGib', 'planKey']);
      // The plan on screen is what the server then said, read again after the payment.
      expect(await screen.findByText('Clientes: 4 de 30')).toBeTruthy();
    });

    it('accepts an empty card too: nothing about it is validated', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      await changeTo('Profissional');
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));

      expect(await screen.findByText('Pagamento aprovado. A sua assinatura já vale.')).toBeTruthy();
      expect(posts(recorded, '/simulated-payment')[0]?.body).toEqual({ outcome: 'approved' });
    });

    it('simulates a decline: says so, charges nothing and leaves the plan; the next try opens a new charge', async () => {
      const world = ownerWorld();
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
      await changeTo('Profissional');
      fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

      expect(await screen.findByText(/Pagamento recusado\. Nada foi cobrado e o plano continua o mesmo/)).toBeTruthy();
      expect(posts(recorded, '/simulated-payment')[0]?.body).toEqual({ outcome: 'declined' });
      expect(screen.queryByRole('heading', { name: CARD_HEADING })).toBeNull();
      expect(world.subscription?.planKey).toBe('essencial');

      await changeTo('Profissional');
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/charges')).toHaveLength(2);
      expect(posts(recorded, '/simulated-payment').map((entry) => entry.path)).toEqual([
        '/subscription/charges/00000000-0000-4000-8000-000000000001/simulated-payment',
        '/subscription/charges/00000000-0000-4000-8000-000000000002/simulated-payment'
      ]);
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
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/simulated-payment').map((entry) => entry.path)).toEqual(['/subscription/charges/00000000-0000-4000-8000-000000000002/simulated-payment']);
    });

    it('leaving is closed while the payment is in flight: Voltar sem pagar does not say nothing was charged, and the approval is what shows', async () => {
      const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
      renderSubscription(impl);
      await subscribeTo('Profissional');
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      const leave = screen.getByRole('button', { name: 'Voltar sem pagar' }) as HTMLButtonElement;
      expect(leave.disabled).toBe(true);
      fireEvent.click(leave);

      expect(await screen.findByText('Pagamento aprovado. A sua assinatura já vale.')).toBeTruthy();
      expect(screen.queryByText(/Você saiu sem pagar/)).toBeNull();
      expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
    });

    it('two quick clicks on Pagar send one payment', async () => {
      const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
      renderSubscription(impl);
      await subscribeTo('Profissional');
      const pay = screen.getByRole('button', { name: /^Pagar/ });
      fireEvent.click(pay);
      fireEvent.click(pay);
      fireEvent.click(screen.getByRole('button', { name: 'Simular recusa' }));

      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
    });

    it('submitting the form again while the payment is in flight (Enter) sends nothing more', async () => {
      const { impl, recorded } = makeSubscriptionApi(trialWorld(5));
      renderSubscription(impl);
      await subscribeTo('Profissional');
      const form = screen.getByRole('heading', { name: CARD_HEADING }).closest('form')!;
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));
      fireEvent.submit(form);
      fireEvent.submit(form);

      await screen.findByText('Pagamento aprovado. A sua assinatura já vale.');
      expect(posts(recorded, '/simulated-payment')).toHaveLength(1);
    });

    it('trusts what the server answered, not what was asked: an approval the server declined reads as declined', async () => {
      const { impl } = makeSubscriptionApi(trialWorld(5, { paymentStatus: 'declined' }));
      renderSubscription(impl);
      await subscribeTo('Profissional');
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));

      expect(await screen.findByText(/Pagamento recusado/)).toBeTruthy();
      expect(screen.queryByText('Pagamento aprovado. A sua assinatura já vale.')).toBeNull();
    });

    it('a failure of the payment request is announced as an alert and never as an approval', async () => {
      const { impl } = makeSubscriptionApi(trialWorld(5, { paymentStatus: 'error' }));
      renderSubscription(impl);
      await subscribeTo('Profissional');
      fireEvent.click(screen.getByRole('button', { name: /^Pagar/ }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Não foi possível concluir o pagamento');
      expect(screen.queryByText('Pagamento aprovado. A sua assinatura já vale.')).toBeNull();
    });
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

  it('the control to jump to the end of the period sits in the closed test tools at the bottom and acts once', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    const details = (await screen.findByText('Ferramentas de teste')).closest('details')!;

    expect(details.open).toBe(false);
    expect(screen.getByRole('heading', { name: 'Cancelamento' }).compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: 'Avançar para o fim do período', hidden: true }));

    expect(await screen.findByText('O período foi levado ao fim.')).toBeTruthy();
    expect(posts(recorded, '/simulated-period-advance')).toHaveLength(1);
  });
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
