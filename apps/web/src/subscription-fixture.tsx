import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

export const AGENCY = '11111111-1111-4111-8111-111111111111';
const GIB = 1024 ** 3;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

const PLANS = [
  { key: 'essencial', name: 'Essencial', clientLimit: 10, storageBytes: 20 * GIB, monthlyCents: 9700 },
  { key: 'profissional', name: 'Profissional', clientLimit: 30, storageBytes: 100 * GIB, monthlyCents: 19700 },
  { key: 'agencia', name: 'Agência', clientLimit: 60, storageBytes: 300 * GIB, monthlyCents: 39700 }
];

export interface SubscriptionWorld {
  /** `null`: the agency is in trial. */
  subscription: null | { planKey: string; extraClients: number; extraStorageGib: number; cancelAtPeriodEnd?: boolean; graceEndsOn?: string | null; provider?: string; periodEnd?: string; usedClients?: number };
  provider: 'simulado' | null;
  permissions: string[];
  plan: Record<string, unknown>;
  /** What the simulated provider answers; defaults to following the requested outcome. */
  paymentStatus?: 'confirmed' | 'declined' | 'error';
  /** What the next payments answer, one per payment, before `paymentStatus` (or the requested outcome) takes over. */
  paymentSequence?: Array<'confirmed' | 'declined' | 'error'>;
  quoteError?: boolean;
  /** The test card: absent is an environment without one (404, as in production); `null` is "no card saved yet". */
  testCard?: TestCardWorld | null;
  /** What the PUT of the test card answers instead of saving: an HTTP status and code. */
  testCardRefusal?: { status: number; code: string };
  /** Every invoice, newest first; the fake pages them by 20. */
  invoices?: InvoiceWorld[];
}

export interface TestCardWorld { last4: string; expMonth: number; expYear: number; brand: 'test' }
export interface InvoiceWorld { id: string; date: string; description: string; amountCents: number; status: 'paid' | 'declined' | 'open' | 'expired' }

export interface Recorded { method: string; path: string; body: unknown; query: string; headers: Headers }

export const ownerWorld = (over: Partial<SubscriptionWorld> = {}): SubscriptionWorld => ({
  subscription: { planKey: 'essencial', extraClients: 0, extraStorageGib: 0 },
  provider: 'simulado',
  permissions: ['cliente.visualizar', 'colaborador.visualizar', 'assinatura.gerenciar'],
  plan: { kind: 'ativo', trialEndsAt: null, readOnly: false },
  ...over
});

const DAY = 86_400_000;

/** An agency in the free trial with `days` whole days left; `0` is a trial that ended, read-only. */
export const trialWorld = (days: number, over: Partial<SubscriptionWorld> = {}): SubscriptionWorld => ownerWorld({
  subscription: null,
  plan: days > 0
    ? { kind: 'trial', trialEndsAt: new Date(Date.now() + days * DAY - 3_600_000).toISOString(), readOnly: false }
    : { kind: 'trial', trialEndsAt: new Date(Date.now() - DAY).toISOString(), readOnly: true },
  ...over
});

const overview = (world: SubscriptionWorld) => {
  const current = world.subscription;
  if (current === null) return { subscription: null, paymentProvider: world.provider };
  const plan = PLANS.find((entry) => entry.key === current.planKey)!;
  const monthly = plan.monthlyCents + current.extraClients * 600 + current.extraStorageGib * 40;
  return {
    subscription: {
      planKey: current.planKey,
      extraClients: current.extraClients,
      extraStorageGib: current.extraStorageGib,
      provider: current.provider ?? 'simulado',
      currentPeriodEnd: current.periodEnd ?? '2026-12-01T01:30:00.000Z',
      cancelAtPeriodEnd: current.cancelAtPeriodEnd ?? false,
      pending: null,
      monthlyCents: monthly,
      nextMonthlyCents: current.cancelAtPeriodEnd === true ? null : monthly,
      clientLimit: plan.clientLimit + current.extraClients,
      storageBytes: (plan.storageBytes / GIB + current.extraStorageGib) * GIB,
      usedClients: current.usedClients ?? 4,
      usedBytes: GIB,
      graceEndsOn: current.graceEndsOn ?? null
    },
    paymentProvider: world.provider
  };
};

/** The real server's arithmetic, kept here so the screen can only show what a "server" answered. */
const quoteOf = (world: SubscriptionWorld, body: { planKey: string; extraClients: number; extraStorageGib: number }) => {
  const plan = PLANS.find((entry) => entry.key === body.planKey)!;
  const monthly = plan.monthlyCents + body.extraClients * 600 + body.extraStorageGib * 40;
  const current = world.subscription;
  const currentMonthly = current === null ? 0 : overview(world).subscription!.monthlyCents;
  const effect = current === null ? 'subscribe' : monthly >= currentMonthly ? 'upgrade' : 'downgrade';
  const lines = [
    { kind: 'plan', quantity: 1, unitCents: plan.monthlyCents, totalCents: plan.monthlyCents },
    ...(body.extraClients > 0 ? [{ kind: 'extra_clients', quantity: body.extraClients, unitCents: 600, totalCents: body.extraClients * 600 }] : []),
    ...(body.extraStorageGib > 0 ? [{ kind: 'extra_storage_gib', quantity: body.extraStorageGib, unitCents: 40, totalCents: body.extraStorageGib * 40 }] : [])
  ];
  const prorated = effect === 'upgrade';
  return {
    effect, monthlyCents: monthly, amountCents: effect === 'downgrade' ? 0 : prorated ? Math.round(((monthly - currentMonthly) * 20) / 30) : monthly - currentMonthly, effectiveAt: '2026-11-10T01:30:00.000Z',
    daysLeft: prorated ? 20 : null, periodDays: prorated ? 30 : null, lines
  };
};

/** What opening a charge answers: the quote without the days and the lines, which only the quote carries. */
const chargeOf = (world: SubscriptionWorld, body: { planKey: string; extraClients: number; extraStorageGib: number }) => {
  const { effect, monthlyCents, amountCents, effectiveAt } = quoteOf(world, body);
  return { effect, monthlyCents, amountCents, effectiveAt };
};

export const makeSubscriptionApi = (world: SubscriptionWorld) => {
  const recorded: Recorded[] = [];
  let chargeCounter = 0;
  const declinedCharges = new Set<string>();
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    // Answers in a later macrotask, like a network: races between two clicks are real.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (url.pathname.endsWith('/auth/session')) return json({ user: { id: AGENCY, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } });
    if (url.pathname.endsWith('/me/last-context')) return new Response(null, { status: 204 });
    recorded.push({ method, path: url.pathname.replace(`/agencies/${AGENCY}`, ''), body, query: url.search, headers: new Headers(init?.headers) });
    const path = url.pathname.replace(`/agencies/${AGENCY}`, '');
    if (path === '/me') {
      return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: world.permissions.includes('assinatura.gerenciar'), membershipId: null, role: { key: 'admin', name: 'Admin' }, permissions: world.permissions, plan: world.plan });
    }
    if (path === '/subscription/plans') return json({ plans: PLANS, extraClientCents: 600, extraStorageGibCents: 40, maxExtra: 10000 });
    if (path === '/subscription') return json(overview(world));
    if (path === '/subscription/quote') {
      if (world.quoteError === true) return apiError(409, 'SUBSCRIPTION_BELOW_CLIENTS', 'O novo plano comporta menos clientes do que os ativos. Arquive clientes antes de reduzir.');
      return json(quoteOf(world, body as never));
    }
    if (path === '/subscription/charges') {
      const quote = chargeOf(world, body as never);
      if (quote.effect === 'downgrade') return json({ ...quote, chargeId: null }, 201);
      chargeCounter += 1;
      return json({ ...quote, chargeId: `00000000-0000-4000-8000-00000000000${chargeCounter}` }, 201);
    }
    if (path === '/subscription/test-card') {
      if (world.testCard === undefined) return apiError(404, 'NOT_FOUND', 'Recurso não encontrado.');
      if (method === 'PUT') {
        if (world.testCardRefusal !== undefined) return apiError(world.testCardRefusal.status, world.testCardRefusal.code, 'private diagnostic');
        world.testCard = body as TestCardWorld;
      }
      return json({ card: world.testCard });
    }
    if (path.startsWith('/subscription/invoices')) {
      const all = world.invoices ?? [];
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      return json({ data: all.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, totalItems: all.length, totalPages: Math.ceil(all.length / pageSize) } });
    }
    if (/^\/subscription\/charges\/[^/]+\/simulated-payment$/.test(path)) {
      const chargeId = path.split('/')[3]!;
      // A refused charge is closed for good: paying it again is the 409 of the real API, and a retry has to open another one.
      if (declinedCharges.has(chargeId)) return apiError(409, 'CHARGE_NOT_OPEN', 'A cobrança não está aberta.');
      const sequenced = world.paymentSequence?.shift();
      if ((sequenced ?? world.paymentStatus) === 'error') return apiError(500, 'INTERNAL_ERROR', 'x');
      const outcome = (body as { outcome: string }).outcome;
      const status = sequenced ?? world.paymentStatus ?? (outcome === 'approved' ? 'confirmed' : 'declined');
      if (status === 'declined') declinedCharges.add(chargeId);
      if (status === 'confirmed') {
        const charge = recorded.filter((entry) => entry.path === '/subscription/charges').at(-1)!.body as { planKey: string; extraClients: number; extraStorageGib: number };
        world.subscription = { planKey: charge.planKey, extraClients: charge.extraClients, extraStorageGib: charge.extraStorageGib };
        world.plan = { kind: 'ativo', trialEndsAt: null, readOnly: false };
      }
      return json({ status });
    }
    if (path === '/subscription/cancel') { world.subscription = { ...world.subscription!, cancelAtPeriodEnd: true }; return new Response(null, { status: 204 }); }
    if (path === '/subscription/reactivate') { world.subscription = { ...world.subscription!, cancelAtPeriodEnd: false }; return new Response(null, { status: 204 }); }
    if (path === '/subscription/simulated-period-advance') return new Response(null, { status: 204 });
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return { impl, recorded };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

export const renderSubscription = (impl: typeof fetch, entry = `/agencia/${AGENCY}/assinatura`): void => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const store = createAuthSessionStore(client);
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};
