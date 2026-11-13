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
/** The purchase screen: the summary only exists there. */
const CARD_HEADING = 'Resumo';
const payButton = (amount: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^(Assinar e pagar|Pagar) ${amount}`) });
const dueNow = (): string => screen.getByText('Você paga agora').parentElement!.textContent ?? '';

/** From the price table (agency without a paid plan): one click on the card's own button opens the simulated card. */
const subscribeTo = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: `Assinar ${name}` }));
  await screen.findByRole('heading', { name: CARD_HEADING });
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
    expect(essential.getByText('Aprovação por link para até 10 clientes')).toBeTruthy();
    expect(essential.getByText('R$ 9,70 por cliente com o plano cheio')).toBeTruthy();
    expect(essential.getByText('Para quem é')).toBeTruthy();
    expect(essential.getByText('Autônomo ou agência de 1 a 3 pessoas, com até 10 clientes ativos.')).toBeTruthy();
    expect(essential.getByText('O que destrava')).toBeTruthy();
    expect(essential.getByText('10 clientes ativos')).toBeTruthy();
    expect(essential.getByText('20 GB: cerca de 5 mil fotos de 4 MB')).toBeTruthy();
    expect(essential.getByText('Colaboradores ilimitados')).toBeTruthy();
    expect(essential.getByText('Cerca de 13 horas por mês de volta')).toBeTruthy();
    expect(essential.getByText('Exemplo ilustrativo.')).toBeTruthy();
    expect(essential.getByRole('button', { name: 'Assinar Essencial' })).toBeTruthy();

    const professional = within(planCard('Profissional'));
    expect(professional.getByText('R$ 197')).toBeTruthy();
    expect(professional.getByText('R$ 6,57 por cliente com o plano cheio')).toBeTruthy();
    expect(professional.getByText('30 clientes ativos: 20 vagas a mais')).toBeTruthy();
    expect(professional.getByText('100 GB: cerca de 25 mil fotos de 4 MB')).toBeTruthy();
    expect(professional.getByText('Tudo do Essencial')).toBeTruthy();
    expect(professional.getByText('240 posts por mês, a R$ 6,57 por cliente')).toBeTruthy();

    const agency = within(planCard('Agência'));
    expect(agency.getByText('R$ 397')).toBeTruthy();
    expect(agency.getByText('Para atender de 31 a 60 clientes sem comprar extra')).toBeTruthy();
    expect(agency.getByText('60 clientes ativos: 30 vagas a mais')).toBeTruthy();
    expect(agency.getByText('300 GB: cerca de 75 mil fotos de 4 MB')).toBeTruthy();
    expect(agency.getByText('200 GB a mais por R$ 20 a mais')).toBeTruthy();
    expect(agency.getByText('Atender 60 clientes no Profissional custaria R$ 197 + 30 extras × R$ 6 = R$ 377, com só 100 GB. No Agência são R$ 397 e 300 GB.')).toBeTruthy();
  });

  it('says what it knows of the use only for a subscriber: a trial has no recommendation block and no "Não cabe"', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await screen.findByRole('button', { name: 'Assinar Essencial' });

    expect(screen.queryByText('Recomendação para a sua agência')).toBeNull();
    expect(screen.queryByText(/Não cabe/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ver faturas' })).toBeNull();
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
    expect(screen.queryByRole('heading', { name: /extras/i })).toBeNull();
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
    expect(screen.getByRole('heading', { level: 1, name: 'Assinar o Essencial' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Plano Essencial' })).toBeTruthy();
    expect(dueNow()).toContain('R$ 97,00');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar sem pagar' }));

    await subscribeTo('Agência');
    expect(screen.getByRole('heading', { level: 1, name: 'Assinar o Agência' })).toBeTruthy();
    expect(dueNow()).toContain('R$ 397,00');

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
    fireEvent.click(payButton('R\\$ 97'));

    expect(await screen.findByText('Plano Essencial ativo')).toBeTruthy();
    expect(screen.getByText('Os novos tetos já valem: 10 clientes ativos e 20 GB. A cobrança de R$ 97,00 foi confirmada.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a assinatura' }));
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
    expect(screen.getByText('Essencial, cobrado todo mês.')).toBeTruthy();
    expect(screen.getByText('R$ 97', { selector: '.subscription__stat' })).toBeTruthy();
    expect(screen.getByText('/mês · sem extras')).toBeTruthy();
    expect(screen.getByText('Próxima cobrança em 30 de novembro de 2026: R$ 97,00.')).toBeTruthy();
    expect(screen.getByText('Clientes: 4 de 10')).toBeTruthy();
    expect(screen.getByText('Armazenamento: 1 GB de 20 GB')).toBeTruthy();
    expect(screen.getByText('Colaboradores e acessos ao portal: sem limite em todos os planos.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Assinar / })).toBeNull();
  });

  it('has one primary in the header, "Trocar de plano", which takes to the plans of the page, and "Ver faturas" beside it', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    const change = await screen.findByRole('button', { name: 'Trocar de plano' });

    expect(change.className).toContain('ui-button--primary');
    expect(screen.getAllByRole('button', { name: 'Trocar de plano' })).toHaveLength(1);
    fireEvent.click(change);
    expect(document.activeElement?.id).toBe('planos-title');
    expect(screen.getByRole('heading', { name: 'O que cada plano coloca na sua mão' })).toBeTruthy();
    const invoices = screen.getAllByRole('link', { name: 'Ver faturas' });
    expect(invoices.length).toBeGreaterThan(0);
    for (const link of invoices) expect(link.getAttribute('href')).toBe('/agencia/11111111-1111-4111-8111-111111111111/assinatura/faturas');
  });

  it('shows the extras of the plan next to its price when there are some', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'essencial', extraClients: 5, extraStorageGib: 30 } }));
    renderSubscription(impl);

    expect(await screen.findByText('R$ 139', { selector: '.subscription__stat' })).toBeTruthy();
    expect(screen.getByText('/mês · com 5 clientes extras e 30 GB extras')).toBeTruthy();
  });

  it('shows the extras here, and the total follows what is typed, as the server quoted it', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '7' } });

    // The sum line by line, as the server quoted it, and what is charged now with the days of the period.
    const sum = within((await screen.findByText('Total por mês')).closest('ul')!);
    expect(sum.getByText('Plano Essencial')).toBeTruthy();
    expect(sum.getByText('7 clientes extras')).toBeTruthy();
    expect(sum.getByText('R$ 42,00')).toBeTruthy();
    expect(sum.getByText('R$ 139,00')).toBeTruthy();
    expect(screen.getByText('Cobrança agora: R$ 28,00 (20 dias que faltam do período atual). Subir vale na hora.')).toBeTruthy();
    expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'essencial', extraClients: 7, extraStorageGib: 0 });

    fireEvent.change(screen.getByLabelText('Armazenamento extra, em GB'), { target: { value: '10' } });
    expect(await screen.findByText('10 GB extras')).toBeTruthy();
    expect(screen.getByText('R$ 143,00')).toBeTruthy();
    expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'essencial', extraClients: 7, extraStorageGib: 10 });
  });

  it('shows the board texts of the extras card: the subtitle, the hints and the confirmation', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld());
    renderSubscription(impl);
    await screen.findByLabelText('Clientes extras');

    expect(screen.getByText('Some ao teto do plano.')).toBeTruthy();
    expect(screen.getByText('R$ 6 por cliente, por mês')).toBeTruthy();
    expect(screen.getByText('R$ 0,40 por GB, por mês')).toBeTruthy();
    expect(screen.getByText('Vai crescer um pouco, mas não o bastante para trocar de plano?')).toBeTruthy();
  });

  it('a reduction of the extras shows no days: the API sends none, and the screen does not make them up', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'essencial', extraClients: 7, extraStorageGib: 0 } }));
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '2' } });

    expect(await screen.findByText(/Nada é cobrado agora\. A mudança vale a partir de/)).toBeTruthy();
    expect(screen.queryByText(/\d+ dias? que falt/)).toBeNull();
    expect(screen.queryByText(/Cobrança agora/)).toBeNull();
  });

  it('buys extras through the simulated card, sending the terms and never an amount', async () => {
    const world = ownerWorld();
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl);
    fireEvent.change(await screen.findByLabelText('Clientes extras'), { target: { value: '7' } });
    await screen.findByText(/Cobrança agora/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e pagar' }));
    await screen.findByRole('heading', { name: CARD_HEADING });
    // The purchase screen: the plan, the lines of the sum, the days and what is paid now.
    expect(screen.getByRole('heading', { level: 1, name: 'Comprar extras' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Extras no Essencial' })).toBeTruthy();
    expect(screen.getByText('7 clientes a mais: de 10 para 17 vagas')).toBeTruthy();
    expect(screen.getByText('Período atual até 30 de novembro de 2026 (20 dias que faltam).')).toBeTruthy();
    expect(screen.getByText('7 clientes extras')).toBeTruthy();
    expect(screen.getByText('Total por mês')).toBeTruthy();
    expect(dueNow()).toContain('R$ 28,00');
    expect(screen.getByText('Depois, R$ 139,00 por mês a partir de 30 de novembro de 2026.')).toBeTruthy();
    fireEvent.click(payButton('R\\$ 28,00'));

    expect(await screen.findByText('Extras ativos')).toBeTruthy();
    expect(screen.getByText('Seu teto agora é de 17 clientes e 20 GB. A cobrança de R$ 28,00 foi confirmada.')).toBeTruthy();
    expect(posts(recorded, '/charges')[0]?.body).toEqual({ planKey: 'essencial', extraClients: 7, extraStorageGib: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a assinatura' }));
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

      expect(within(await screen.findByRole('article', { name: 'Agência' })).getByText('Seu plano')).toBeTruthy();
      expect(within(planCard('Essencial')).queryByText('Seu plano')).toBeNull();
    });

    it('shows the server total of the chosen plan and what is charged now', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Profissional' }));

      expect(await screen.findByText('Mudar para Profissional')).toBeTruthy();
      const sum = within((await screen.findByText('Total por mês')).closest('ul')!);
      expect(sum.getByText('Plano Profissional')).toBeTruthy();
      expect(sum.getAllByText('R$ 197,00')).toHaveLength(2);
      expect(screen.getByText('Cobrança agora: R$ 66,67 (20 dias que faltam do período atual). Subir vale na hora.')).toBeTruthy();
      expect(posts(recorded, '/quote').at(-1)?.body).toEqual({ planKey: 'profissional', extraClients: 0, extraStorageGib: 0 });
    });

    it('a plan that cannot hold the active clients is closed with "Não cabe: N clientes ativos" and says why on its card', async () => {
      const world = ownerWorld({ subscription: { planKey: 'profissional', extraClients: 0, extraStorageGib: 0, usedClients: 18 } });
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);

      const closed = await screen.findByRole('button', { name: 'Não cabe: 18 clientes ativos' }) as HTMLButtonElement;
      expect(closed.disabled).toBe(true);
      expect(within(planCard('Essencial')).getByText(/Não cabe hoje: você tem 18 clientes ativos e 1 GB\./)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Escolher Essencial' })).toBeNull();
      expect(within(planCard('Profissional')).getByRole('button', { name: 'Plano atual' })).toBeTruthy();
      fireEvent.click(closed);
      expect(posts(recorded, '/quote')).toHaveLength(0);
      // Agência fits and is the one the screen points to once the clients pass 80% of the ceiling (24 of 30).
      expect(within(planCard('Agência')).getByRole('button', { name: 'Escolher Agência' })).toBeTruthy();
    });

    it('the choice acts on the plan clicked: with two plans to pick from, the quote and the charge are for the second', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Profissional' }));
      await screen.findByText('Mudar para Profissional');
      fireEvent.click(screen.getByRole('button', { name: 'Escolher Agência' }));
      expect(await screen.findByText('Mudar para Agência')).toBeTruthy();
      await waitFor(() => expect(screen.getByText(/Cobrança agora: R\$ 200,00/)).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Subir o plano' }));

      await screen.findByRole('heading', { name: CARD_HEADING });
      expect(posts(recorded, '/charges').map((entry) => entry.body)).toEqual([{ planKey: 'agencia', extraClients: 0, extraStorageGib: 0 }]);
    });

    it('says what the use asks of the plan: stay while there is room, look at the next one near the ceiling', async () => {
      const room = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'profissional', extraClients: 0, extraStorageGib: 0, usedClients: 18 } }));
      renderSubscription(room.impl);
      expect(await screen.findByText('Fique no Profissional: ele cobre a sua carteira com folga')).toBeTruthy();
      expect(screen.getByText(/Você usa 18 de 30 clientes \(60%\) e 1 GB de 100 GB\. Hoje cada cliente ativo sai a R\$ 10,94 por mês; com a carteira cheia, o Profissional sai a R\$ 6,57 por cliente e é o plano de menor custo por cliente do catálogo\. Quando você passar de 24 clientes, 80% do teto, a recomendação muda para o Agência\./)).toBeTruthy();
      expect(screen.getByText('Agência vale ao passar de 24')).toBeTruthy();
      expect(within(planCard('Profissional')).getByText('Recomendado')).toBeTruthy();
      expect(within(planCard('Agência')).getByText('Passa a valer ao passar de 24 clientes.')).toBeTruthy();
      cleanup();

      const near = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'profissional', extraClients: 0, extraStorageGib: 0, usedClients: 26 } }));
      renderSubscription(near.impl);
      expect(await screen.findByText('Passe para o Agência: o Profissional está perto do teto')).toBeTruthy();
      expect(within(planCard('Agência')).getByText('Recomendado')).toBeTruthy();
      expect(within(planCard('Profissional')).queryByText('Recomendado')).toBeNull();
    });

    it('a downgrade is scheduled without a card', async () => {
      const world = ownerWorld({ subscription: { planKey: 'agencia', extraClients: 0, extraStorageGib: 0 } });
      const { impl, recorded } = makeSubscriptionApi(world);
      renderSubscription(impl);
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
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Profissional' }));
      const action = await screen.findByRole('button', { name: 'Subir o plano' });
      act(() => { fireEvent.click(action); fireEvent.click(action); });

      await screen.findByRole('heading', { name: CARD_HEADING });
      expect(posts(recorded, '/charges')).toHaveLength(1);
    });

    it('not changing the plan closes the panel and sends no charge', async () => {
      const { impl, recorded } = makeSubscriptionApi(ownerWorld());
      renderSubscription(impl);
      fireEvent.click(await screen.findByRole('button', { name: 'Escolher Profissional' }));
      await screen.findByText('Mudar para Profissional');
      fireEvent.click(screen.getByRole('button', { name: 'Não mudar de plano' }));

      expect(screen.queryByText('Mudar para Profissional')).toBeNull();
      expect(await screen.findByLabelText('Clientes extras')).toBeTruthy();
      expect(posts(recorded, '/charges')).toHaveLength(0);
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
