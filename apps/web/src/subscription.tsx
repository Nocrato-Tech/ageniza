import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CalendarClock, Check, Receipt, Users } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import {
  AuthNoContentResponseSchema,
  SubscriptionChargeResponseSchema,
  SubscriptionPlansResponseSchema,
  SubscriptionQuoteResponseSchema,
  type SubscriptionChangeRequest,
  type SubscriptionQuoteLine,
  type SubscriptionQuoteResponse
} from '@ageniza/contracts';
import { Button, ButtonLink, EmptyState, Field, FieldMessage, LiveStatus, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { trialDaysLeft } from './plan-notice.js';
import { subscriptionOverviewQuery } from './subscription-queries.js';
import { CancelSubscriptionDialog } from './subscription-cancel.js';
import { daysLeftText, formatBrl, formatDay, formatGb, formatInstant, formatMoney, lineLabel } from './subscription-format.js';
import { PlanComparison, PlanProof } from './subscription-compare.js';
import { PlanLosses } from './subscription-loss.js';
import { CheckoutStep, type Purchase } from './subscription-payment.js';
import { MINUTES_PER_ROUND_TRIP, PHOTO_MB, PlanCards, PlanIncludes, PlanRecommendation, planSummary, POSTS_PER_CLIENT, recommend, type Plan } from './subscription-plans.js';
import { TestCardRow } from './subscription-test-card.js';
import { TrialPlan } from './subscription-trial.js';

const GIB = 1024 ** 3;
const PAYMENT_UNAVAILABLE = 'O pagamento ainda não está disponível neste ambiente.';
const LOAD_FAILED = 'Não foi possível abrir a assinatura. Tente de novo.';
const CHANGE_FAILED = 'Não foi possível pedir a mudança. Tente de novo.';
const PAYMENT_FAILED: Notice = { tone: 'alert', text: 'Não foi possível concluir o pagamento. Confira a assinatura abaixo e, se preciso, tente de novo.' };
const EXTRA_INVALID = 'Informe um número inteiro, de 0 a 10000.';

const parseExtra = (value: string, max: number): number | undefined => {
  if (!/^\d{1,5}$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed <= max ? parsed : undefined;
};

type Notice = { tone: 'status' | 'alert'; text: string };
type Checkout = { chargeId: string; amountCents: number; purchase: Purchase; body: SubscriptionChangeRequest };
type ChangeRequest = { body: SubscriptionChangeRequest; quote: SubscriptionQuoteResponse | undefined };

const refusal = (error: unknown, fallback: string): string => (error instanceof HttpClientError && error.status === 409 ? error.message : fallback);

/** A POST with no body and no answer (reactivate, advance): the server decides, the screen only asks. */
function useAgencyAction(template: string, onDone: () => void) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  return useMutation({
    mutationFn: () => httpClient.request({ path: apiPath(template, { agenciaId: agency.agencyId }), method: 'POST', response: AuthNoContentResponseSchema }),
    onSuccess: onDone
  });
}

/** The quote of a change as the server computed it, line by line, and what is charged now; the screen adds nothing of its own. */
function QuoteSummary({ terms, unchanged, query, quote, planName, blockedReason }: {
  terms: SubscriptionChangeRequest | undefined;
  unchanged: boolean;
  query: UseQueryResult<SubscriptionQuoteResponse>;
  quote: SubscriptionQuoteResponse | undefined;
  planName: string;
  blockedReason: string | undefined;
}) {
  return <div className="subscription__summary" aria-live="polite">
    {unchanged
      ? <p>Estas já são as condições da sua assinatura.</p>
      : terms === undefined
        ? <p>Corrija os valores para ver o total.</p>
        : query.isError
          ? <p role="alert">{refusal(query.error, 'Não foi possível calcular o total. Tente de novo.')}</p>
          : quote === undefined
            ? <p>Calculando o total…</p>
            : <>
              <ul className="subscription__sum">
                {quote.lines.map((line: SubscriptionQuoteLine) => <li key={line.kind}><span>{lineLabel(line, planName)}</span><span>{formatMoney(line.totalCents)}</span></li>)}
                <li className="subscription__sum-total"><span>Total por mês</span><span>{formatMoney(quote.monthlyCents)}</span></li>
              </ul>
              <p>{quote.effect === 'downgrade'
                ? `Nada é cobrado agora. A mudança vale a partir de ${formatInstant(quote.effectiveAt)}.`
                : quote.amountCents === 0
                  ? 'Nada é cobrado agora. A mudança vale na hora.'
                  : `Cobrança agora: ${formatMoney(quote.amountCents)}${quote.daysLeft !== null ? ` (${daysLeftText(quote.daysLeft)})` : ''}.${quote.effect === 'upgrade' ? ' Subir vale na hora.' : ''}`}</p>
            </>}
    {blockedReason !== undefined && <p>{blockedReason}</p>}
  </div>;
}

/**
 * `/agencia/:agenciaId/assinatura` (issue #773), for the Owner. Without a paid plan it is only the price table; with one it is
 * "Seu plano", the plans side by side, the extras and the cancellation (decision 2026-11-06). The screen never writes a plan or a
 * price: it asks the server to quote and to open a charge, and the plan changes only when the provider confirms it.
 */
export function SubscriptionPage() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  const location = useLocation();
  useDocumentTitle('Assinatura — Ageniza');

  const agencyKey = ['agency', agency.agencyId] as const;
  const plansQuery = useQuery({
    queryKey: [...agencyKey, 'subscription-plans'],
    queryFn: () => httpClient.request({ path: apiPath('/agencies/:agenciaId/subscription/plans', { agenciaId: agency.agencyId }), response: SubscriptionPlansResponseSchema })
  });
  const overviewQuery = useQuery(subscriptionOverviewQuery(httpClient, agency.agencyId));

  const [target, setTarget] = useState<string | null>(null);
  const [extras, setExtras] = useState<{ clients: string; gib: string } | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [canceling, setCanceling] = useState(false);
  const requesting = useRef(false);

  const plans = plansQuery.data;
  const subscription = overviewQuery.data?.subscription ?? null;
  const provider = overviewQuery.data?.paymentProvider ?? null;
  const simulated = provider === 'simulado';
  const courtesy = subscription?.provider === 'cortesia';
  const paid = subscription !== null && !courtesy;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: [...agencyKey, 'subscription'] });
    void queryClient.invalidateQueries({ queryKey: [...agencyKey, 'subscription-invoices'] });
    void queryClient.invalidateQueries({ queryKey: [...agencyKey, 'me'] });
  };
  const reset = (): void => { setTarget(null); setExtras(null); setCheckout(null); };

  const maxExtra = plans?.maxExtra ?? 0;
  const clientsText = extras?.clients ?? String(subscription?.extraClients ?? 0);
  const gibText = extras?.gib ?? String(subscription?.extraStorageGib ?? 0);
  const extraClients = parseExtra(clientsText, maxExtra);
  const extraGib = parseExtra(gibText, maxExtra);

  // Changing the plan keeps the extras the agency has; changing the extras keeps the plan.
  const planTerms: SubscriptionChangeRequest | undefined = !paid || plans === undefined || target === null ? undefined
    : { planKey: target, extraClients: subscription.extraClients, extraStorageGib: subscription.extraStorageGib };
  const extraTerms: SubscriptionChangeRequest | undefined = !paid || plans === undefined || extraClients === undefined || extraGib === undefined || !plans.plans.some((plan) => plan.key === subscription.planKey)
    ? undefined
    : { planKey: subscription.planKey, extraClients, extraStorageGib: extraGib };
  const extrasUnchanged = paid && extraTerms !== undefined && extraTerms.extraClients === subscription.extraClients && extraTerms.extraStorageGib === subscription.extraStorageGib;

  const quoteOf = (terms: SubscriptionChangeRequest | undefined, enabled: boolean) => ({
    queryKey: [...agencyKey, 'subscription-quote', terms],
    enabled: terms !== undefined && enabled && checkout === null,
    retry: false,
    queryFn: () => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/quote', { agenciaId: agency.agencyId }),
      method: 'POST' as const,
      body: terms,
      response: SubscriptionQuoteResponseSchema
    })
  });
  const planQuoteQuery = useQuery(quoteOf(planTerms, true));
  const extraQuoteQuery = useQuery(quoteOf(extraTerms, !extrasUnchanged));
  const planQuote = planTerms === undefined ? undefined : planQuoteQuery.data;
  const extraQuote = extraTerms === undefined || extrasUnchanged ? undefined : extraQuoteQuery.data;

  const openCharge = (body: SubscriptionChangeRequest) => httpClient.request({
    path: apiPath('/agencies/:agenciaId/subscription/charges', { agenciaId: agency.agencyId }),
    method: 'POST',
    body,
    response: SubscriptionChargeResponseSchema
  });

  // What the purchase screen shows is what the server quoted for these terms; with no quote it falls back to the plan alone.
  const purchaseOf = (body: SubscriptionChangeRequest, quote: SubscriptionQuoteResponse | undefined, monthlyCents: number): Purchase | undefined => {
    if (plans === undefined) return undefined;
    const plan = plans.plans.find((entry) => entry.key === body.planKey);
    if (plan === undefined) return undefined;
    const kind: Purchase['kind'] = subscription === null ? 'subscribe' : body.planKey === subscription.planKey ? 'extras' : 'plan';
    const summary = planSummary(plan, plans.plans);
    const addedClients = subscription === null ? 0 : body.extraClients - subscription.extraClients;
    const addedGib = subscription === null ? 0 : body.extraStorageGib - subscription.extraStorageGib;
    const gain = kind === 'extras'
      ? [
        ...(addedClients > 0 && subscription !== null ? [`${addedClients} clientes a mais: de ${subscription.clientLimit} para ${subscription.clientLimit + addedClients} vagas`] : []),
        ...(addedGib > 0 && subscription !== null ? [`${addedGib} GB a mais: de ${Math.round(subscription.storageBytes / GIB)} para ${Math.round(subscription.storageBytes / GIB) + addedGib} GB`] : []),
        'Para diminuir depois, vale no próximo período'
      ]
      : summary.unlocks;
    return {
      kind,
      planName: plan.name,
      tagline: kind === 'extras' ? 'Mais vagas e mais mídia sem trocar de plano.' : summary.tagline,
      gain,
      lines: quote?.lines ?? [{ kind: 'plan', quantity: 1, unitCents: plan.monthlyCents, totalCents: plan.monthlyCents }],
      monthlyCents,
      currentMonthlyCents: subscription?.monthlyCents,
      daysLeft: quote?.daysLeft ?? null,
      periodDays: quote?.periodDays ?? null,
      periodEnd: kind === 'subscribe' ? undefined : subscription?.currentPeriodEnd ?? undefined,
      ceilings: { clients: plan.clientLimit + body.extraClients, gib: Math.round(plan.storageBytes / GIB) + body.extraStorageGib }
    };
  };

  const request = useMutation({
    mutationFn: ({ body }: ChangeRequest) => openCharge(body),
    onSuccess: (charge, { body, quote }) => {
      const purchase = charge.chargeId !== null && simulated ? purchaseOf(body, quote, charge.monthlyCents) : undefined;
      if (charge.chargeId !== null && purchase !== undefined) {
        setNotice(undefined);
        setCheckout({ chargeId: charge.chargeId, amountCents: charge.amountCents, purchase, body });
        return;
      }
      reset();
      refresh();
      setNotice({ tone: 'status', text: charge.effect === 'downgrade' ? `Mudança agendada para ${formatInstant(charge.effectiveAt)}.` : 'Mudança feita. A sua assinatura já vale.' });
    },
    onError: (error: unknown) => { setNotice({ tone: 'alert', text: refusal(error, CHANGE_FAILED) }); }
  });

  // The first subscription never carries extras: they exist only after a plan (decision 2026-11-06). The quote comes first so a
  // refusal shows before any charge is opened.
  const subscribe = useMutation({
    mutationFn: async (planKey: string) => {
      const body: SubscriptionChangeRequest = { planKey, extraClients: 0, extraStorageGib: 0 };
      const quote = await httpClient.request({
        path: apiPath('/agencies/:agenciaId/subscription/quote', { agenciaId: agency.agencyId }),
        method: 'POST',
        body,
        response: SubscriptionQuoteResponseSchema
      });
      return { charge: await openCharge(body), body, quote };
    },
    onSuccess: ({ charge, body, quote }) => {
      if (charge.chargeId === null) { refresh(); return; }
      const purchase = purchaseOf(body, quote, charge.monthlyCents);
      if (purchase === undefined) { refresh(); return; }
      setNotice(undefined);
      setCheckout({ chargeId: charge.chargeId, amountCents: charge.amountCents, purchase, body });
    },
    onError: (error: unknown) => { setNotice({ tone: 'alert', text: refusal(error, CHANGE_FAILED) }); }
  });

  const reactivate = useAgencyAction('/agencies/:agenciaId/subscription/reactivate', refresh);
  const advance = useAgencyAction('/agencies/:agenciaId/subscription/simulated-period-advance', refresh);

  // A retry keeps the failure and its busy button (and the focus) in place: only the first read is a skeleton.
  const failed = [plansQuery, overviewQuery].some((query) => query.isError || (query.isPending && query.errorUpdateCount > 0));
  if (failed) {
    return <section aria-labelledby="subscription-title" className="subscription">
      <h1 id="subscription-title">Assinatura</h1>
      <EmptyState kind="failure" title={LOAD_FAILED} description="Nada foi alterado." retrying={plansQuery.isFetching || overviewQuery.isFetching} onRetry={() => { void plansQuery.refetch(); void overviewQuery.refetch(); }} />
    </section>;
  }
  if (plans === undefined || overviewQuery.data === undefined) {
    return <section aria-labelledby="subscription-title" className="subscription" aria-busy="true">
      <h1 id="subscription-title">Assinatura</h1><Skeleton /><Skeleton />
    </section>;
  }

  if (checkout !== null) {
    return <CheckoutStep
      agencyId={agency.agencyId}
      chargeId={checkout.chargeId}
      amountCents={checkout.amountCents}
      purchase={checkout.purchase}
      reopen={async () => {
        const charge = await openCharge(checkout.body);
        if (charge.chargeId === null) throw new Error('A new charge has no id');
        return charge.chargeId;
      }}
      onApproved={refresh}
      onFinish={() => { reset(); setNotice(PAYMENT_FAILED); refresh(); }}
      onLeave={() => { reset(); setNotice({ tone: 'status', text: 'Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.' }); }}
      onDone={() => { reset(); setNotice(undefined); }}
    />;
  }

  const planName = (key: string): string => plans.plans.find((plan) => plan.key === key)?.name ?? key;
  const blockedFor = (quote: SubscriptionQuoteResponse | undefined): string | undefined => (quote !== undefined && quote.amountCents > 0 && !simulated ? PAYMENT_UNAVAILABLE : undefined);

  const canChangePlan = paid && !subscription.cancelAtPeriodEnd;
  const illustrationNote = <p className="subscription__muted subscription__note">Os exemplos de ganho usam contas simples ({POSTS_PER_CLIENT} posts por cliente por mês, {MINUTES_PER_ROUND_TRIP} minutos por ida e volta no WhatsApp, foto de {PHOTO_MB} MB). São ilustrações para você medir a escala, não medições da sua agência.</p>;
  const goToPlans = (): void => {
    const section = document.getElementById('planos');
    section?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    document.getElementById('planos-title')?.focus();
  };
  const goToLosses = (): void => {
    document.getElementById('perdas')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    document.getElementById('perdas-t')?.focus();
  };

  const header = <>
    <header className="subscription__head subscription__head--actions">
      <div className="subscription__head-text">
        <p className="subscription__eyebrow">Agência</p>
        <h1 id="subscription-title">Assinatura</h1>
        <p className="subscription__lead">Só quem criou a agência vê esta tela: a assinatura é capacidade da dona, não de um papel.{simulated ? ' Pagamento simulado: nenhum valor é cobrado.' : ''}</p>
      </div>
      {paid && <div className="subscription__actions">
        {canChangePlan && <Button onClick={goToPlans}>Trocar de plano</Button>}
        <ButtonLink as={Link} to={`/agencia/${agency.agencyId}/assinatura/faturas`} state={location.state} variant="secondary" leadingIcon={<Receipt aria-hidden="true" />}>Ver faturas</ButtonLink>
      </div>}
    </header>
    {notice !== undefined && (notice.tone === 'alert' ? <p className="subscription__notice subscription__notice--alert" role="alert">{notice.text}</p> : <LiveStatus className="subscription__notice">{notice.text}</LiveStatus>)}
  </>;

  const testTools = simulated && <details className="subscription__tools">
    <summary>Ferramentas de teste</summary>
    <p>Disponível apenas com o pagamento simulado. Leva a assinatura ao fim do período, para testar a renovação e a tolerância.</p>
    <div className="subscription__actions">
      <Button variant="secondary" loading={advance.isPending} onClick={() => { advance.mutate(undefined, { onSuccess: () => { setNotice({ tone: 'status', text: 'O período foi levado ao fim.' }); } }); }}>Avançar para o fim do período</Button>
    </div>
    {advance.isError && <FieldMessage role="alert">Não foi possível avançar o período.</FieldMessage>}
  </details>;

  if (!paid && !courtesy) {
    const plan = agency.plan;
    const days = plan.kind === 'trial' && plan.trialEndsAt !== null ? trialDaysLeft(plan.trialEndsAt) : null;
    const ended = plan.readOnly || days === 0;
    const state = ended
      ? 'O teste acabou. A agência está somente leitura; escolha um plano para voltar a editar.'
      : days === null
        ? 'Escolha um plano para continuar.'
        : `Você está no teste grátis: ${days === 1 ? 'falta 1 dia' : `faltam ${days} dias`}. Escolha o plano para continuar depois dele.`;
    return <section aria-labelledby="subscription-title" className="subscription subscription--pricing">
      {header}
      <p className="subscription__state">{state}</p>
      {!simulated && <p className="subscription__notice">{PAYMENT_UNAVAILABLE}</p>}
      <TrialPlan trialEndsAt={plan.trialEndsAt} daysLeft={days} ended={ended} />
      <section className="subscription__plans" aria-labelledby="planos-title" id="planos">
        <div className="subscription__section-head">
          <h2 id="planos-title" tabIndex={-1}>O que cada plano coloca na sua mão</h2>
          <p className="subscription__muted">Todos têm o mesmo produto completo. O que muda é quantos clientes você atende e quanta mídia guarda.</p>
        </div>
        <PlanCards
          plans={plans.plans}
          extraClientCents={plans.extraClientCents}
          verb="Assinar"
          blockedReason={simulated ? undefined : PAYMENT_UNAVAILABLE}
          busyKey={subscribe.isPending ? subscribe.variables : undefined}
          onChoose={(chosen: Plan) => {
            // A synchronous guard: `isPending` only changes on the next render, and two clicks in one tick would both pass it.
            if (requesting.current) return;
            requesting.current = true;
            setNotice(undefined);
            subscribe.mutate(chosen.key, { onSettled: () => { requesting.current = false; } });
          }}
        />
        {illustrationNote}
      </section>
      <section className="subscription__plans" aria-labelledby="cmp-title">
        <div className="subscription__section-head">
          <h2 id="cmp-title">Comparação direta</h2>
          <p className="subscription__muted">A coluna marcada é a que recomendamos.</p>
        </div>
        <PlanComparison plans={plans.plans} />
      </section>
      <PlanLosses plans={plans.plans} extraClientCents={plans.extraClientCents} subscription={null} trial={{ trialEndsAt: plan.trialEndsAt, ended }} />
      <PlanProof />
      <PlanIncludes />
      {testTools}
    </section>;
  }

  if (courtesy) {
    return <section aria-labelledby="subscription-title" className="subscription">
      {header}
      <section className="subscription__block subscription__block--card" aria-labelledby="subscription-current">
        <h2 id="subscription-current">Seu plano</h2>
        <p>A agência tem um plano de cortesia, sem cobrança.</p>
      </section>
      {testTools}
    </section>;
  }

  const upToDate = subscription.graceEndsOn === null && !subscription.cancelAtPeriodEnd;
  const recommendation = canChangePlan ? recommend(plans.plans, subscription) : undefined;
  const extraParts = [
    subscription.extraClients > 0 ? `${subscription.extraClients} ${subscription.extraClients === 1 ? 'cliente extra' : 'clientes extras'}` : undefined,
    subscription.extraStorageGib > 0 ? `${subscription.extraStorageGib} GB extras` : undefined
  ].filter((part): part is string => part !== undefined);

  const current = <section className="subscription__block subscription__block--card" aria-labelledby="subscription-current">
    <div className="subscription__current-head">
      <div>
        <h2 id="subscription-current">Seu plano</h2>
        <p className="subscription__muted">{planName(subscription.planKey)}, cobrado todo mês.</p>
      </div>
      {upToDate && <span className="subscription__chip"><Check aria-hidden="true" />Em dia</span>}
    </div>
    <p className="subscription__price"><span className="subscription__stat">{formatBrl(subscription.monthlyCents)}</span><span className="subscription__muted">/mês · {extraParts.length === 0 ? 'sem extras' : `com ${extraParts.join(' e ')}`}</span></p>
    <ul className="subscription__facts">
      <li className="subscription__meter">
        Clientes: {subscription.usedClients} de {subscription.clientLimit}
        <progress value={subscription.usedClients} max={subscription.clientLimit} aria-label="Clientes ativos em uso" />
      </li>
      <li className="subscription__meter subscription__meter--storage">
        Armazenamento: {formatGb(subscription.usedBytes)} de {formatGb(subscription.storageBytes)}
        <progress value={subscription.usedBytes} max={subscription.storageBytes} aria-label="Armazenamento em uso" />
      </li>
      {subscription.currentPeriodEnd !== null && <li className="subscription__fact"><CalendarClock aria-hidden="true" />{subscription.cancelAtPeriodEnd ? `Acesso até ${formatInstant(subscription.currentPeriodEnd)}` : `Próxima cobrança em ${formatInstant(subscription.currentPeriodEnd)}${subscription.nextMonthlyCents === null ? '' : `: ${formatMoney(subscription.nextMonthlyCents)}`}.`}</li>}
      {subscription.pending !== null && subscription.currentPeriodEnd !== null && <li>
        Em {formatInstant(subscription.currentPeriodEnd)} o plano passa para {planName(subscription.pending.planKey)}
        {subscription.nextMonthlyCents !== null && <>, {formatBrl(subscription.nextMonthlyCents)}/mês</>}.
      </li>}
      <li className="subscription__fact"><Users aria-hidden="true" />Colaboradores e acessos ao portal: sem limite em todos os planos.</li>
    </ul>
    {subscription.graceEndsOn !== null && <p className="subscription__notice subscription__notice--alert" role="alert">
      O pagamento da renovação não passou. A agência continua editando até {formatDay(subscription.graceEndsOn)}; depois disso fica somente leitura.
    </p>}
    {subscription.cancelAtPeriodEnd && <p>
      A assinatura está cancelada. Depois de {subscription.currentPeriodEnd === null ? 'o período' : formatInstant(subscription.currentPeriodEnd)}, a agência fica somente leitura.
    </p>}
  </section>;

  const billing = <section className="subscription__block subscription__block--card" aria-labelledby="subscription-billing">
    <h2 id="subscription-billing">Cartão e cobranças</h2>
    <TestCardRow agencyId={agency.agencyId} onSaved={(text) => { setNotice({ tone: 'status', text }); }} />
    <div className="subscription-test-card">
      <span className="subscription-test-card__icon" aria-hidden="true"><Receipt /></span>
      <span className="subscription-test-card__main"><strong>Faturas</strong><span>Uma por cobrança, com plano e extras</span></span>
      <ButtonLink as={Link} to={`/agencia/${agency.agencyId}/assinatura/faturas`} state={location.state} variant="ghost" size="sm">Ver faturas</ButtonLink>
    </div>
  </section>;

  const plansSection = canChangePlan && <section className="subscription__plans" aria-labelledby="planos-title" id="planos">
    <div className="subscription__section-head">
      <h2 id="planos-title" tabIndex={-1}>O que cada plano coloca na sua mão</h2>
      <p className="subscription__muted">Todos têm o mesmo produto completo. O que muda é quantos clientes você atende e quanta mídia guarda.</p>
    </div>
    <div className="subscription--pricing">
      <PlanCards
        plans={plans.plans}
        extraClientCents={plans.extraClientCents}
        currentKey={subscription.planKey}
        recommendedKey={recommendation?.key}
        usage={{ clients: subscription.usedClients, bytes: subscription.usedBytes, extraClients: subscription.extraClients }}
        verb="Escolher"
        onChoose={(chosen: Plan) => { setNotice(undefined); setTarget(chosen.key); }}
      />
    </div>
    {illustrationNote}
    {planTerms !== undefined && <section className="subscription__block subscription__block--card" aria-labelledby="subscription-target">
      <h3 id="subscription-target" className="subscription__target">Mudar para {planName(planTerms.planKey)}</h3>
      <QuoteSummary terms={planTerms} unchanged={false} query={planQuoteQuery} quote={planQuote} planName={planName(planTerms.planKey)} blockedReason={blockedFor(planQuote)} />
      <ConfirmAction label={planQuote?.effect === 'upgrade' ? 'Subir o plano' : 'Descer o plano'} disabled={planQuote === undefined} blockedReason={blockedFor(planQuote)} loading={request.isPending}
        onConfirm={() => {
          if (requesting.current) return;
          requesting.current = true;
          request.mutate({ body: planTerms, quote: planQuote }, { onSettled: () => { requesting.current = false; } });
        }} />
      <div className="subscription__actions">
        <Button variant="ghost" onClick={() => { setTarget(null); }}>Não mudar de plano</Button>
      </div>
    </section>}
  </section>;

  const extrasSection = <div className="subscription__split">
    <section className="subscription__block subscription__block--card" aria-labelledby="subscription-extras-info">
      <h2 id="subscription-extras-info">Vai crescer um pouco, mas não o bastante para trocar de plano?</h2>
      <p className="subscription__muted">Os extras somam ao teto do plano, na quantidade que você escolher. É a saída mais barata quando faltam poucas vagas.</p>
      <ul className="subscription__benefits">
        <li><Check aria-hidden="true" />Libera na hora e cobra só os dias que faltam do período</li>
        <li><Check aria-hidden="true" />Para diminuir depois, vale no próximo período</li>
        <li><Check aria-hidden="true" />Máximo de {maxExtra.toLocaleString('pt-BR')} clientes e {maxExtra.toLocaleString('pt-BR')} GB de extra por assinatura</li>
      </ul>
    </section>
    <section className="subscription__block subscription__block--card" aria-labelledby="subscription-extras">
      <div>
        <h2 id="subscription-extras">Adicionar extras</h2>
        <p className="subscription__muted">Some ao teto do plano.</p>
      </div>
      <div className="subscription__extras">
        <Field label="Clientes extras" hint={`${formatBrl(plans.extraClientCents)} por cliente, por mês`} error={extraClients === undefined ? EXTRA_INVALID : undefined}>
          {(control) => <TextInput {...control} inputMode="numeric" value={clientsText} onChange={(event) => { setNotice(undefined); setExtras({ clients: event.target.value, gib: gibText }); }} />}
        </Field>
        <Field label="Armazenamento extra, em GB" hint={`${formatMoney(plans.extraStorageGibCents)} por GB, por mês`} error={extraGib === undefined ? EXTRA_INVALID : undefined}>
          {(control) => <TextInput {...control} inputMode="numeric" value={gibText} onChange={(event) => { setNotice(undefined); setExtras({ clients: clientsText, gib: event.target.value }); }} />}
        </Field>
      </div>
      <QuoteSummary terms={extraTerms} unchanged={extrasUnchanged} query={extraQuoteQuery} quote={extraQuote} planName={planName(subscription.planKey)} blockedReason={blockedFor(extraQuote)} />
      <ConfirmAction label={extraQuote === undefined ? 'Escolha as quantidades' : extraQuote.effect === 'upgrade' ? 'Confirmar e pagar' : 'Agendar a mudança'} disabled={extraQuote === undefined} blockedReason={blockedFor(extraQuote)} loading={request.isPending}
        onConfirm={() => {
          // Same synchronous guard as the first subscription.
          if (extraTerms === undefined || requesting.current) return;
          requesting.current = true;
          request.mutate({ body: extraTerms, quote: extraQuote }, { onSettled: () => { requesting.current = false; } });
        }} />
    </section>
  </div>;

  const lifecycle = <section className="subscription__block subscription__block--card" aria-labelledby="subscription-lifecycle">
    <h2 id="subscription-lifecycle">Cancelamento</h2>
    {subscription.cancelAtPeriodEnd
      ? <>
        <p>Você pode manter a assinatura até o fim do período.</p>
        <div className="subscription__actions">
          <Button variant="secondary" loading={reactivate.isPending} onClick={() => { reactivate.mutate(undefined, { onSuccess: () => { setNotice({ tone: 'status', text: 'A assinatura foi mantida.' }); } }); }}>Manter a assinatura</Button>
        </div>
        {reactivate.isError && <FieldMessage role="alert">Não foi possível manter a assinatura. Tente de novo.</FieldMessage>}
      </>
      : <>
        <p>Cancelar mantém o acesso até o fim do período pago. Antes de confirmar, mostramos o que isso significa.</p>
        <div className="subscription__actions">
          <Button variant="ghost" className="subscription__cancel" onClick={() => { setCanceling(true); }}>Cancelar a assinatura</Button>
        </div>
      </>}
  </section>;

  return <section aria-labelledby="subscription-title" className="subscription">
    {header}
    {recommendation !== undefined && <PlanRecommendation recommendation={recommendation} onSeePlans={goToPlans} onSeeLosses={goToLosses} />}
    <div className="subscription__split">{current}{billing}</div>
    {plansSection}
    {canChangePlan && <section className="subscription__plans" aria-labelledby="cmp-title">
      <div className="subscription__section-head">
        <h2 id="cmp-title">Comparação direta</h2>
        <p className="subscription__muted">A coluna marcada é a que recomendamos para o seu uso agora.</p>
      </div>
      <PlanComparison plans={plans.plans} recommendedKey={recommendation?.key} />
    </section>}
    {extrasSection}
    {canChangePlan && <PlanLosses plans={plans.plans} extraClientCents={plans.extraClientCents} subscription={subscription} trial={{ trialEndsAt: null, ended: false }} />}
    <PlanProof />
    {lifecycle}
    {testTools}

    {canceling && <CancelSubscriptionDialog
      agencyId={agency.agencyId}
      subscription={subscription}
      onClose={() => { setCanceling(false); }}
      onCanceled={() => { setCanceling(false); refresh(); setNotice({ tone: 'status', text: 'Assinatura cancelada. O acesso continua até o fim do período.' }); }}
    />}
  </section>;
}

function ConfirmAction({ label, disabled, blockedReason, loading, onConfirm }: {
  label: string;
  disabled: boolean;
  blockedReason: string | undefined;
  loading: boolean;
  onConfirm: () => void;
}) {
  return <div className="subscription__actions">
    <Button loading={loading} disabled={disabled} blockedReason={blockedReason} onClick={onConfirm}>{label}</Button>
  </div>;
}
