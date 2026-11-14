// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { makeSubscriptionApi, ownerWorld, renderSubscription, trialWorld } from './subscription-fixture.js';

afterEach(cleanup);

const table = (): HTMLElement => screen.getByRole('table', { name: 'Comparação dos planos' });
const rowOf = (name: string): HTMLElement => within(table()).getByRole('rowheader', { name }).parentElement!;
const cellsOf = (name: string): string[] => within(rowOf(name)).getAllByRole('cell').map((cell) => cell.textContent ?? '');
const headers = (): string[] => within(table()).getAllByRole('columnheader').slice(1).map((header) => header.textContent ?? '');
const lossCard = (title: string): HTMLElement => screen.getByRole('group', { name: title });

describe('the comparison table', () => {
  it('puts the trial and the three plans side by side, with what the server sent and the trial ceilings of the docs', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await screen.findByRole('table', { name: 'Comparação dos planos' });

    expect(headers()).toEqual(['Teste · 14 dias', 'Essencial', 'ProfissionalRecomendado', 'Agência']);
    expect(cellsOf('Preço por mês')).toEqual(['Grátis', 'R$ 97', 'R$ 197', 'R$ 397']);
    expect(cellsOf('Clientes ativos')).toEqual(['3', '10', '30', '60']);
    expect(cellsOf('Armazenamento')).toEqual(['2 GB', '20 GBcerca de 5 mil fotos', '100 GBcerca de 25 mil fotos', '300 GBcerca de 75 mil fotos']);
    expect(cellsOf('Custo por cliente, com o plano cheio')).toEqual(['—', 'R$ 9,70', 'R$ 6,57', 'R$ 6,62']);
    expect(cellsOf('Colaboradores')).toEqual(['3', 'Ilimitados', 'Ilimitados', 'Ilimitados']);
    expect(cellsOf('Extras (por cliente e por GB)')).toEqual(['—', '', '', '']);
    expect(cellsOf('Quando o período acaba')).toEqual(['Somente leitura', 'Renova todo mês', 'Renova todo mês', 'Renova todo mês']);
    expect(within(rowOf('Preço por mês')).getAllByRole('cell')[2]?.className).toContain('cmp__cell--rec');
  });

  it('marks the column the use recommends: near the ceiling it is the next plan, not the current one', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'profissional', extraClients: 0, extraStorageGib: 0, usedClients: 26 } }));
    renderSubscription(impl);
    await screen.findByRole('table', { name: 'Comparação dos planos' });

    expect(headers()).toEqual(['Teste · 14 dias', 'Essencial', 'Profissional', 'AgênciaRecomendado']);
  });
});

describe('"O que você perde, em números"', () => {
  it('a subscriber sees the numbers of the use and of the lower plan, and none the API does not send', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'profissional', extraClients: 0, extraStorageGib: 0, usedClients: 18 } }));
    renderSubscription(impl);
    await screen.findByRole('heading', { name: 'O que você perde, em números' });

    const down = within(lossCard('Baixar para o Essencial'));
    expect(down.getByText('Você tem 18 clientes ativos e o Essencial comporta 10: seria preciso arquivar 8 clientes antes.')).toBeTruthy();
    expect(down.getByText('Você guarda 1 GB e o Essencial comporta 20 GB: cabe.')).toBeTruthy();
    expect(down.getByText('Economia de R$ 100 por mês, contra 8 clientes fora da operação.')).toBeTruthy();
    expect(down.getByText(/A descida só vale no próximo período \((30 de novembro de 2026)\) e nunca abaixo do uso/)).toBeTruthy();

    const ceiling = within(lossCard('Chegar ao teto de 30'));
    expect(ceiling.getByText('No 31º cliente ativo, o cadastro é recusado até você subir de plano, comprar extra ou arquivar um cliente.')).toBeTruthy();
    expect(ceiling.getByText('Sobram 12 vagas hoje. Passando de 24, a recomendação muda para o Agência.')).toBeTruthy();
    expect(ceiling.getByText('Para 5 clientes a mais, o extra custa R$ 30 por mês. Para o Agência, R$ 200 a mais.')).toBeTruthy();

    const cancel = within(lossCard('Cancelar a assinatura'));
    expect(cancel.getByText('Em 30 de novembro de 2026 a agência entra no somente leitura: 18 clientes ativos ficam sem edição.')).toBeTruthy();
    expect(cancel.getByText('Os dados ficam guardados. Para voltar depois, basta assinar de novo.')).toBeTruthy();
    expect(within(screen.getByRole('heading', { name: 'O que você perde, em números' }).closest('section')!).queryByText(/posts/)).toBeNull();
  });

  it('the cheapest plan has no lower plan to go down to, and a canceled subscription shows none of the three', async () => {
    const cheapest = makeSubscriptionApi(ownerWorld());
    renderSubscription(cheapest.impl);
    await screen.findByRole('heading', { name: 'O que você perde, em números' });
    expect(screen.queryByRole('group', { name: /Baixar para/ })).toBeNull();
    expect(screen.getByRole('group', { name: 'Chegar ao teto de 10' })).toBeTruthy();
    cleanup();

    const canceled = makeSubscriptionApi(ownerWorld({ subscription: { planKey: 'essencial', extraClients: 0, extraStorageGib: 0, cancelAtPeriodEnd: true } }));
    renderSubscription(canceled.impl);
    await screen.findByRole('heading', { name: 'Sem letra miúda' });
    expect(screen.queryByRole('heading', { name: 'O que você perde, em números' })).toBeNull();
  });

  it('a trial sees what stops when it ends and what its ceilings keep out', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    await screen.findByRole('heading', { name: 'O que você perde, em números' });

    const ending = within(lossCard('Deixar o teste acabar'));
    expect(ending.getByText(/^Em .* a agência entra no somente leitura: ninguém cria nem edita conteúdo\.$/)).toBeTruthy();
    expect(ending.getByText('Nada é apagado: os dados ficam guardados e voltam a ser editáveis assim que você assinar.')).toBeTruthy();
    const limit = within(lossCard('Passar de 3 clientes'));
    expect(limit.getByText('O teste comporta 3 clientes ativos: o 4º cliente não entra.')).toBeTruthy();
    expect(limit.getByText('O teste guarda 2 GB de mídia.')).toBeTruthy();
    expect(limit.getByText('O Essencial abre 10 clientes e 20 GB por R$ 97 por mês.')).toBeTruthy();
  });

  it('an ended trial says so instead of announcing a date', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(0));
    renderSubscription(impl);
    await screen.findByRole('heading', { name: 'O que você perde, em números' });

    expect(within(lossCard('O teste acabou')).getByText('A agência está no somente leitura: ninguém cria nem edita conteúdo.')).toBeTruthy();
  });
});

describe('"Sem letra miúda"', () => {
  it.each([['trial', trialWorld(5)], ['subscriber', ownerWorld()]])('lists the six promises of the board for a %s', async (_name, world) => {
    const { impl } = makeSubscriptionApi(world);
    renderSubscription(impl);
    const section = within((await screen.findByRole('heading', { name: 'Sem letra miúda' })).closest('section')!);

    for (const title of ['Cancele quando quiser, sem multa', 'Subir vale na hora', 'Descer não cobra nada', '3 dias de tolerância', 'Seus dados ficam guardados', 'Só a dona vê e muda a assinatura']) {
      expect(section.getByText(title)).toBeTruthy();
    }
    expect(section.getAllByRole('listitem')).toHaveLength(6);
  });
});

describe('"Seu plano" in the trial', () => {
  it('says the day of the trial, the days left, what it holds, and that nothing is charged by itself; it has no use to show', async () => {
    const { impl } = makeSubscriptionApi(trialWorld(5));
    renderSubscription(impl);
    const card = within((await screen.findByRole('heading', { name: 'Seu plano' })).closest('section')!);

    expect(card.getByText('Teste gratuito de 14 dias, no dia 9.')).toBeTruthy();
    expect(card.getByText('5 dias restantes')).toBeTruthy();
    expect(card.getByText('Grátis')).toBeTruthy();
    expect(card.getByText(/^até .* · 3 clientes · 2 GB$/)).toBeTruthy();
    expect(card.getByText('Nada é cobrado sozinho: você só paga quando assinar.')).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);

    const billing = within(screen.getByRole('heading', { name: 'Cartão e cobranças' }).closest('section')!);
    expect(billing.getByText('Nenhum cartão ainda')).toBeTruthy();
    expect(billing.getByText('Você cadastra na hora de assinar')).toBeTruthy();
    expect(billing.getByText('Aparecem depois da primeira cobrança')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Ver faturas' })).toBeNull();
  });

  it('a trial of one day says one day, and an ended one says it is read-only', async () => {
    const one = makeSubscriptionApi(trialWorld(1));
    renderSubscription(one.impl);
    expect(await screen.findByText('1 dia restante')).toBeTruthy();
    cleanup();

    const ended = makeSubscriptionApi(trialWorld(0));
    renderSubscription(ended.impl);
    expect(await screen.findByText('O teste gratuito acabou.')).toBeTruthy();
    expect(within(screen.getByRole('heading', { name: 'Seu plano' }).closest('section')!).getByText('Somente leitura')).toBeTruthy();
    expect(screen.getByText(/^acabou em .* · 3 clientes · 2 GB$/)).toBeTruthy();
  });
});
