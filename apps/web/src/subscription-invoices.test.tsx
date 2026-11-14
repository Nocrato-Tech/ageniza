// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENCY, makeSubscriptionApi, ownerWorld, renderSubscription, type InvoiceWorld } from './subscription-fixture.js';

afterEach(cleanup);

const INVOICES = `/agencia/${AGENCY}/assinatura/faturas`;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** `count` invoices, newest first, one per day at 01:30Z (still the evening before in São Paulo). */
const invoices = (count: number, status: InvoiceWorld['status'] = 'paid'): InvoiceWorld[] => Array.from({ length: count }, (_value, index) => ({
  id: id(index + 1),
  date: `2026-11-${String(30 - index).padStart(2, '0')}T01:30:00.000Z`,
  description: `Mensalidade ${index + 1}`,
  amountCents: 19700,
  status
}));

describe('Faturas', () => {
  it('lists each charge with the day of São Paulo, the description, the amount and the status; the first page has 20', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ invoices: invoices(25) }));
    renderSubscription(impl, INVOICES);

    expect(await screen.findByRole('heading', { level: 1, name: 'Faturas' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Faturas' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(20);
    // 2026-11-30T01:30Z is still the 29th in São Paulo.
    expect(within(rows[0]!).getByText('29/11/2026')).toBeTruthy();
    expect(within(rows[0]!).getByText('Mensalidade 1')).toBeTruthy();
    expect(within(rows[0]!).getByText('R$ 197,00')).toBeTruthy();
    expect(within(rows[0]!).getByText('Paga')).toBeTruthy();
    expect(screen.getByText('20 de 25 faturas')).toBeTruthy();
    expect(recorded.find((entry) => entry.path === '/subscription/invoices')?.query).toBe('?page=1&pageSize=20');
  });

  it('pages: the second page is another request and shows the rest, and "Página 1" goes back', async () => {
    const { impl, recorded } = makeSubscriptionApi(ownerWorld({ invoices: invoices(25) }));
    renderSubscription(impl, INVOICES);
    await screen.findByText('Mensalidade 1');

    fireEvent.click(screen.getByRole('button', { name: 'Página 2' }));
    expect(await screen.findByText('Mensalidade 21')).toBeTruthy();
    expect(screen.queryByText('Mensalidade 1')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Faturas' })).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('5 de 25 faturas')).toBeTruthy();
    expect(recorded.filter((entry) => entry.path === '/subscription/invoices').map((entry) => entry.query)).toContain('?page=2&pageSize=20');

    fireEvent.click(screen.getByRole('button', { name: 'Página 1' }));
    expect(await screen.findByText('Mensalidade 1')).toBeTruthy();
  });

  it('opens on the page the address asks for', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ invoices: invoices(25) }));
    renderSubscription(impl, `${INVOICES}?page=2`);

    expect(await screen.findByText('Mensalidade 21')).toBeTruthy();
    expect(screen.queryByText('Mensalidade 1')).toBeNull();
  });

  it('shows the four states by label: paga, recusada, aberta e vencida', async () => {
    const world = ownerWorld({
      invoices: [
        { ...invoices(1)[0]!, id: id(1), description: 'Subida para o Agência', status: 'open' },
        { ...invoices(1)[0]!, id: id(2), description: 'Mensalidade de novembro', status: 'paid' },
        { ...invoices(1)[0]!, id: id(3), description: 'Mensalidade de outubro', status: 'declined' },
        { ...invoices(1)[0]!, id: id(4), description: 'Mensalidade de setembro', status: 'expired' }
      ]
    });
    const { impl } = makeSubscriptionApi(world);
    renderSubscription(impl, INVOICES);
    await screen.findByText('Subida para o Agência');

    const row = (text: string): HTMLElement => screen.getByText(text).closest('li')!;
    expect(within(row('Subida para o Agência')).getByText('Aberta')).toBeTruthy();
    expect(within(row('Mensalidade de novembro')).getByText('Paga')).toBeTruthy();
    expect(within(row('Mensalidade de outubro')).getByText('Recusada')).toBeTruthy();
    expect(within(row('Mensalidade de setembro')).getByText('Vencida')).toBeTruthy();
    expect(within(row('Mensalidade de outubro')).queryByText('Paga')).toBeNull();
  });

  it('says there is no invoice yet', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ invoices: [] }));
    renderSubscription(impl, INVOICES);

    expect(await screen.findByText('Nenhuma fatura ainda')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Faturas' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed read is the failure state with "Tentar de novo", never "no invoices", and the retry reads again', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ invoices: invoices(2) }));
    let healthy = false;
    let reads = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/subscription/invoices')) {
        reads += 1;
        if (!healthy) return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return impl(input, init);
    };
    renderSubscription(flaky, INVOICES);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível abrir as faturas. Tente de novo.');
    expect(alert.textContent).not.toContain('private diagnostic');
    expect(screen.queryByText('Nenhuma fatura ainda')).toBeNull();

    healthy = true;
    const before = reads;
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Mensalidade 1')).toBeTruthy();
    expect(reads).toBeGreaterThan(before);
  });

  it('is reached from "Ver faturas" and goes back through the crumb to "Assinatura"', async () => {
    const { impl } = makeSubscriptionApi(ownerWorld({ invoices: invoices(1) }));
    renderSubscription(impl);
    fireEvent.click((await screen.findAllByRole('link', { name: 'Ver faturas' }))[0]!);

    expect(await screen.findByRole('heading', { level: 1, name: 'Faturas' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Você está em' });
    expect(within(crumbs).getByText('Faturas').getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(crumbs).getByRole('link', { name: 'Assinatura' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Assinatura' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Seu plano' })).toBeTruthy();
  });

  it('keeps the test card of the page: "Trocar" is here too, and absent where the API has none', async () => {
    const withCard = makeSubscriptionApi(ownerWorld({ invoices: invoices(1), testCard: { last4: '4242', expMonth: 8, expYear: 2028, brand: 'test' } }));
    renderSubscription(withCard.impl, INVOICES);
    expect(await screen.findByText('final 4242 · vence 08/2028')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trocar' })).toBeTruthy();
    cleanup();

    const without = makeSubscriptionApi(ownerWorld({ invoices: invoices(1) }));
    renderSubscription(without.impl, INVOICES);
    await screen.findByText('Mensalidade 1');
    await waitFor(() => expect(without.recorded.some((entry) => entry.path === '/subscription/test-card')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Trocar' })).toBeNull();
  });

  it('only the Owner reaches it: without assinatura.gerenciar it is the ordinary not found, with no billing request', async () => {
    const world = ownerWorld({ permissions: ['cliente.visualizar', 'colaborador.visualizar'], invoices: invoices(1) });
    const { impl, recorded } = makeSubscriptionApi(world);
    renderSubscription(impl, INVOICES);

    expect(await screen.findByRole('heading', { name: /não encontrad/i })).toBeTruthy();
    expect(recorded.filter((entry) => entry.path.startsWith('/subscription'))).toHaveLength(0);
  });
});
