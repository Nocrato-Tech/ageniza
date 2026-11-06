// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENCY, makeSubscriptionApi, ownerWorld, renderSubscription } from './subscription-fixture.js';

afterEach(cleanup);

const DAY = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + days * DAY - 60_000).toISOString();
const HOME = `/agencia/${AGENCY}`;
const ADMIN_PERMISSIONS = ['cliente.visualizar', 'colaborador.visualizar'];
const trial = (days: number, over: Record<string, unknown> = {}) => ({ kind: 'trial', trialEndsAt: inDays(days), readOnly: false, ...over });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('the plan notices of the agency shell (#773)', () => {
  it('shows the days left of the trial with a button to subscribe, for the Owner, that leads to the screen', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: null, plan: trial(10) }));
    renderSubscription(impl, HOME);

    const notice = await screen.findByRole('region', { name: 'Período de teste' });
    expect(notice.textContent).toContain('faltam 10 dias');
    expect(notice.textContent).toContain('3 clientes ativos, 3 colaboradores e 2 GB');
    const link = within(notice).getByRole('link', { name: 'Assinar' });
    expect(link.getAttribute('href')).toBe(`${HOME}/assinatura`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Assinatura' })).toBeTruthy();
    expect(await screen.findByText(/Você está no teste grátis: faltam 10 dias\./)).toBeTruthy();
  });

  it('shows the same days to an Admin, without the button', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: null, permissions: ADMIN_PERMISSIONS, plan: trial(10) }));
    renderSubscription(impl, HOME);

    const notice = await screen.findByRole('region', { name: 'Período de teste' });
    expect(notice.textContent).toContain('faltam 10 dias');
    expect(within(notice).queryByRole('link')).toBeNull();
  });

  it('warns the Owner, highlighted, from 3 days before the end of the trial: what happens and the way to subscribe', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ subscription: null, plan: trial(3) }));
    renderSubscription(impl, HOME);

    const notice = await screen.findByRole('region', { name: 'Período de teste' });
    expect(notice.classList.contains('trial-notice--urgent')).toBe(true);
    expect(notice.textContent).toContain('faltam 3 dias');
    expect(notice.textContent).toContain('Quando acabar, a agência fica somente leitura: tudo continua visível, mas ninguém cria nem edita. Assine para continuar.');
    expect(within(notice).getByRole('link', { name: 'Assinar' }).getAttribute('href')).toBe(`${HOME}/assinatura`);
  });

  it('does not highlight 4 days before the end, and never highlights for an Admin', async () => {
    const four = makeSubscriptionApi(ownerWorld({ subscription: null, plan: trial(4) }));
    renderSubscription(four.impl, HOME);
    const early = await screen.findByRole('region', { name: 'Período de teste' });
    expect(early.classList.contains('trial-notice--urgent')).toBe(false);
    expect(early.textContent).not.toContain('Quando acabar');
    cleanup();

    const admin = makeSubscriptionApi(ownerWorld({ subscription: null, permissions: ADMIN_PERMISSIONS, plan: trial(1) }));
    renderSubscription(admin.impl, HOME);
    const last = await screen.findByRole('region', { name: 'Período de teste' });
    expect(last.classList.contains('trial-notice--urgent')).toBe(false);
    expect(last.textContent).toContain('falta 1 dia');
    expect(last.textContent).not.toContain('Quando acabar');
  });

  it('after the trial, the Owner gets the banner with the way to subscribe, and an Admin gets the contact instead', async () => {
    const ended = trial(-1, { readOnly: true, supportContactEmail: 'suporte@ageniza.test' });
    const owner = makeSubscriptionApi(ownerWorld({ subscription: null, plan: ended }));
    renderSubscription(owner.impl, HOME);
    const banner = await screen.findByRole('region', { name: 'Plano' });
    expect(banner.textContent).toContain('O seu plano precisa ser renovado para usar as opções bloqueadas. Os seus dados estão guardados.');
    expect(within(banner).getByRole('link', { name: 'Assinar' }).getAttribute('href')).toBe(`${HOME}/assinatura`);
    expect(within(banner).queryByRole('link', { name: 'suporte@ageniza.test' })).toBeNull();
    cleanup();

    const admin = makeSubscriptionApi(ownerWorld({ subscription: null, permissions: ADMIN_PERMISSIONS, plan: ended }));
    renderSubscription(admin.impl, HOME);
    const adminBanner = await screen.findByRole('region', { name: 'Plano' });
    expect(within(adminBanner).queryByRole('link', { name: 'Assinar' })).toBeNull();
    expect(within(adminBanner).getByRole('link', { name: 'suporte@ageniza.test' })).toBeTruthy();
  });

  describe('a canceled subscription about to end', () => {
    const canceled = { kind: 'ativo', trialEndsAt: null, readOnly: false, canceled: true };
    const world = (days: number, permissions?: string[]) => ownerWorld({
      subscription: { planKey: 'essencial', extraClients: 0, extraStorageGib: 0, cancelAtPeriodEnd: true, periodEnd: inDays(days) },
      plan: canceled,
      ...(permissions === undefined ? {} : { permissions })
    });

    it('warns the Owner in the last 3 days, with what happens and the way to keep it', async () => {
      const { impl } = makeSubscriptionApi(world(2));
      renderSubscription(impl, HOME);

      const notice = await screen.findByRole('region', { name: 'Fim da assinatura' });
      expect(notice.classList.contains('trial-notice--urgent')).toBe(true);
      expect(notice.textContent).toContain('A assinatura foi cancelada: faltam 2 dias');
      expect(notice.textContent).toContain('Depois disso, a agência fica somente leitura: tudo continua visível, mas ninguém cria nem edita. Para continuar, mantenha a assinatura.');
      expect(screen.getByRole('link', { name: 'Manter a assinatura' }).getAttribute('href')).toBe(`${HOME}/assinatura`);
    });

    it('says nothing 4 days before the end, and nothing to an Admin, who cannot read the subscription', async () => {
      const early = makeSubscriptionApi(world(4));
      renderSubscription(early.impl, HOME);
      await screen.findByRole('heading', { level: 1 });
      await settle();
      expect(early.recorded.some((entry) => entry.path === '/subscription')).toBe(true);
      expect(screen.queryByRole('region', { name: 'Fim da assinatura' })).toBeNull();
      cleanup();

      const admin = makeSubscriptionApi(world(1, ADMIN_PERMISSIONS));
      renderSubscription(admin.impl, HOME);
      await screen.findByRole('heading', { level: 1 });
      await settle();
      expect(screen.queryByRole('region', { name: 'Fim da assinatura' })).toBeNull();
      expect(admin.recorded.filter((entry) => entry.path.startsWith('/subscription'))).toHaveLength(0);
    });
  });

  it('after a canceled period ended (read-only, paid plan), the Owner sees the banner with the way to subscribe, an Admin does not', async () => {
    const plan = { kind: 'ativo', trialEndsAt: null, readOnly: true, canceled: true };
    const owner = makeSubscriptionApi(ownerWorld({ plan }));
    renderSubscription(owner.impl, HOME);
    const banner = await screen.findByRole('region', { name: 'Plano' });
    expect(within(banner).getByRole('link', { name: 'Assinar' }).getAttribute('href')).toBe(`${HOME}/assinatura`);
    cleanup();

    const admin = makeSubscriptionApi(ownerWorld({ plan, permissions: ADMIN_PERMISSIONS }));
    renderSubscription(admin.impl, HOME);
    const adminBanner = await screen.findByRole('region', { name: 'Plano' });
    expect(within(adminBanner).queryByRole('link')).toBeNull();
  });
});
