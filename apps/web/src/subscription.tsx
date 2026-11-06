import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  AuthNoContentResponseSchema,
  SubscriptionChargeResponseSchema,
  SubscriptionPlansResponseSchema,
  SubscriptionQuoteResponseSchema,
  type SubscriptionChangeRequest,
  type SubscriptionQuoteResponse
} from '@ageniza/contracts';
import { Button, EmptyState, Field, FieldMessage, LiveStatus, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { trialDaysLeft } from './plan-notice.js';
import { subscriptionOverviewQuery } from './subscription-queries.js';
import { CancelSubscriptionDialog } from './subscription-cancel.js';
import { formatBrl, formatDay, formatGb, formatInstant, totalLine } from './subscription-format.js';
import { SimulatedCardStep, type PaymentResult } from './subscription-payment.js';
import { PlanCards, PlanIncludes, type Plan } from './subscription-plans.js';

const PAYMENT_UNAVAILABLE = 'O pagamento ainda não está disponível neste ambiente.';
const LOAD_FAILED = 'Não foi possível abrir a assinatura. Tente de novo.';
const CHANGE_FAILED = 'Não foi possível pedir a mudança. Tente de novo.';
const EXTRA_INVALID = 'Informe um número inteiro, de 0 a 10000.';

const parseExtra = (value: string, max: number): number | undefined => {
  if (!/^\d{1,5}$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed <= max ? parsed : undefined;
};

type Notice = { tone: 'status' | 'alert'; text: string };
type View = 'overview' | 'plans';
type CardStep = { chargeId: string; amountCents: number; planName: string; monthlyCents: number };

const RESULT_NOTICES: Record<PaymentResult, Notice> = {
  approved: { tone: 'status', text: 'Pagamento aprovado. A sua assinatura já vale.' },
  declined: { tone: 'alert', text: 'Pagamento recusado. Nada foi cobrado e o plano continua o mesmo. Escolha de novo para tentar outra vez.' },
  failed: { tone: 'alert', text: 'Não foi possível concluir o pagamento. Confira a assinatura abaixo e, se preciso, tente de novo.' }
};

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

/** The quote of a change as the server computed it, and what is charged now; the screen adds nothing of its own. */
function QuoteSummary({ terms, unchanged, query, quote, planCents, extrasCents, blockedReason }: {
  terms: SubscriptionChangeRequest | undefined;
  unchanged: boolean;
  query: UseQueryResult<SubscriptionQuoteResponse>;
  quote: SubscriptionQuoteResponse | undefined;
  planCents: number | undefined;
  extrasCents: number;
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
              <p className="subscription__total">{totalLine(planCents ?? quote.monthlyCents, extrasCents, quote.monthlyCents)}</p>
              <p>{quote.effect === 'downgrade'
                ? `Nada é cobrado agora. A mudança vale a partir de ${formatInstant(quote.effectiveAt)}.`
                : quote.amountCents === 0
                  ? 'Nada é cobrado agora. A mudança vale na hora.'
                  : `Cobrança agora: ${formatBrl(quote.amountCents)}${quote.effect === 'upgrade' ? ' (o restante do período atual)' : ''}.`}</p>
            </>}
    {blockedReason !== undefined && <p>{blockedReason}</p>}
  </div>;
}

/**
 * `/agencia/:agenciaId/assinatura` (issue #773), for the Owner. Without a paid plan it is only the price table; with one it is
 * "Seu plano", and only there the extras, the change of plan and the cancellation (decision 2026-11-06). The screen never writes
 * a plan or a price: it asks the server to quote and to open a charge, and the plan changes only when the provider confirms it.
 */
export function SubscriptionPage() {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  const queryClient = useQueryClient();
  useDocumentTitle('Assinatura — Ageniza');

  const agencyKey = ['agency', agency.agencyId] as const;
  const plansQuery = useQuery({
    queryKey: [...agencyKey, 'subscription-plans'],
    queryFn: () => httpClient.request({ path: apiPath('/agencies/:agenciaId/subscription/plans', { agenciaId: agency.agencyId }), response: SubscriptionPlansResponseSchema })
  });
  const overviewQuery = useQuery(subscriptionOverviewQuery(httpClient, agency.agencyId));

  const [view, setView] = useState<View>('overview');
  const [target, setTarget] = useState<string | null>(null);
  const [extras, setExtras] = useState<{ clients: string; gib: string } | null>(null);
  const [card, setCard] = useState<CardStep | null>(null);
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
    void queryClient.invalidateQueries({ queryKey: [...agencyKey, 'me'] });
  };
  const reset = (): void => { setView('overview'); setTarget(null); setExtras(null); setCard(null); };

  const maxExtra = plans?.maxExtra ?? 0;
  const clientsText = extras?.clients ?? String(subscription?.extraClients ?? 0);
  const gibText = extras?.gib ?? String(subscription?.extraStorageGib ?? 0);
  const extraClients = parseExtra(clientsText, maxExtra);
  const extraGib = parseExtra(gibText, maxExtra);

  // Changing the plan keeps the extras the agency has; changing the extras keeps the plan.
  const terms: SubscriptionChangeRequest | undefined = !paid || plans === undefined ? undefined
    : view === 'plans'
      ? (target === null ? undefined : { planKey: target, extraClients: subscription.extraClients, extraStorageGib: subscription.extraStorageGib })
      : (extraClients === undefined || extraGib === undefined || !plans.plans.some((plan) => plan.key === subscription.planKey)
        ? undefined
        : { planKey: subscription.planKey, extraClients, extraStorageGib: extraGib });
  const unchanged = paid && terms !== undefined && terms.planKey === subscription.planKey
    && terms.extraClients === subscription.extraClients && terms.extraStorageGib === subscription.extraStorageGib;

  const quoteQuery = useQuery({
    queryKey: [...agencyKey, 'subscription-quote', terms],
    enabled: terms !== undefined && !unchanged && card === null,
    retry: false,
    queryFn: () => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/quote', { agenciaId: agency.agencyId }),
      method: 'POST',
      body: terms,
      response: SubscriptionQuoteResponseSchema
    })
  });
  const quote = terms === undefined || unchanged ? undefined : quoteQuery.data;

  const openCharge = (body: SubscriptionChangeRequest) => httpClient.request({
    path: apiPath('/agencies/:agenciaId/subscription/charges', { agenciaId: agency.agencyId }),
    method: 'POST',
    body,
    response: SubscriptionChargeResponseSchema
  });

  const request = useMutation({
    mutationFn: (body: SubscriptionChangeRequest) => openCharge(body),
    onSuccess: (charge, body) => {
      if (charge.chargeId !== null && simulated) {
        setNotice(undefined);
        setCard({ chargeId: charge.chargeId, amountCents: charge.amountCents, planName: plans?.plans.find((plan) => plan.key === body.planKey)?.name ?? body.planKey, monthlyCents: charge.monthlyCents });
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
      await httpClient.request({
        path: apiPath('/agencies/:agenciaId/subscription/quote', { agenciaId: agency.agencyId }),
        method: 'POST',
        body,
        response: SubscriptionQuoteResponseSchema
      });
      return { charge: await openCharge(body), planKey };
    },
    onSuccess: ({ charge, planKey }) => {
      if (charge.chargeId === null) { refresh(); return; }
      setNotice(undefined);
      setCard({ chargeId: charge.chargeId, amountCents: charge.amountCents, planName: plans?.plans.find((plan) => plan.key === planKey)?.name ?? planKey, monthlyCents: charge.monthlyCents });
    },
    onError: (error: unknown) => { setNotice({ tone: 'alert', text: refusal(error, CHANGE_FAILED) }); }
  });

  const reactivate = useAgencyAction('/agencies/:agenciaId/subscription/reactivate', refresh);
  const advance = useAgencyAction('/agencies/:agenciaId/subscription/simulated-period-advance', refresh);

  const finish = (result: PaymentResult): void => {
    reset();
    setNotice(RESULT_NOTICES[result]);
    refresh();
  };

  if (plansQuery.isError || overviewQuery.isError) {
    return <section aria-labelledby="subscription-title" className="subscription">
      <h1 id="subscription-title">Assinatura</h1>
      <EmptyState title={LOAD_FAILED} description="Nada foi alterado." action={<Button onClick={() => { void plansQuery.refetch(); void overviewQuery.refetch(); }}>Tentar de novo</Button>} />
    </section>;
  }
  if (plans === undefined || overviewQuery.data === undefined) {
    return <section aria-labelledby="subscription-title" className="subscription" aria-busy="true">
      <h1 id="subscription-title">Assinatura</h1><Skeleton /><Skeleton />
    </section>;
  }

  const planName = (key: string): string => plans.plans.find((plan) => plan.key === key)?.name ?? key;
  const planCentsOf = (key: string): number | undefined => plans.plans.find((plan) => plan.key === key)?.monthlyCents;
  const extrasCents = (clients: number, gib: number): number => clients * plans.extraClientCents + gib * plans.extraStorageGibCents;
  const needsPayment = quote !== undefined && quote.amountCents > 0;
  const blockedReason = needsPayment && !simulated ? PAYMENT_UNAVAILABLE : undefined;
  const actionLabel = quote === undefined ? 'Escolha as quantidades' : quote.effect === 'upgrade' ? 'Confirmar e pagar' : 'Agendar a mudança';

  const header = <>
    <h1 id="subscription-title">Assinatura</h1>
    {notice !== undefined && (notice.tone === 'alert' ? <p className="subscription__notice subscription__notice--alert" role="alert">{notice.text}</p> : <LiveStatus className="subscription__notice">{notice.text}</LiveStatus>)}
  </>;

  if (card !== null) {
    return <section aria-labelledby="subscription-title" className="subscription">
      {header}
      <SimulatedCardStep
        agencyId={agency.agencyId}
        chargeId={card.chargeId}
        amountCents={card.amountCents}
        summary={{ planName: card.planName, monthlyCents: card.monthlyCents }}
        onFinish={finish}
        onLeave={() => { reset(); setNotice({ tone: 'status', text: 'Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.' }); }}
      />
    </section>;
  }

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
      <p className="subscription__state">{state}</p>      {!simulated && <p className="subscription__notice">{PAYMENT_UNAVAILABLE}</p>}
      <PlanCards
        plans={plans.plans}
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
      <PlanIncludes />
      {testTools}
    </section>;
  }

  if (courtesy) {
    return <section aria-labelledby="subscription-title" className="subscription">
      {header}
      <section className="subscription__block" aria-labelledby="subscription-current">
        <h2 id="subscription-current">Seu plano</h2>
        <p>A agência tem um plano de cortesia, sem cobrança.</p>
      </section>
      {testTools}
    </section>;
  }

  const currentPlan = plans.plans.find((entry) => entry.key === subscription.planKey);

  return <section aria-labelledby="subscription-title" className="subscription">
    {header}

    <section className="subscription__block" aria-labelledby="subscription-current">
      <h2 id="subscription-current">Seu plano</h2>
      <p className="subscription__plan"><strong>{planName(subscription.planKey)}</strong>, {totalLine(
        currentPlan?.monthlyCents ?? subscription.monthlyCents,
        extrasCents(subscription.extraClients, subscription.extraStorageGib),
        subscription.monthlyCents
      )}</p>
      <ul className="subscription__facts">
        <li>Clientes: {subscription.usedClients} de {subscription.clientLimit}</li>
        <li>Armazenamento: {formatGb(subscription.usedBytes)} de {formatGb(subscription.storageBytes)}</li>
        {subscription.currentPeriodEnd !== null && <li>{subscription.cancelAtPeriodEnd ? 'Acesso até' : 'Próxima cobrança em'} {formatInstant(subscription.currentPeriodEnd)}</li>}
        {subscription.pending !== null && subscription.currentPeriodEnd !== null && <li>
          Em {formatInstant(subscription.currentPeriodEnd)} o plano passa para {planName(subscription.pending.planKey)}
          {subscription.nextMonthlyCents !== null && <>, {formatBrl(subscription.nextMonthlyCents)}/mês</>}.
        </li>}
      </ul>
      {subscription.graceEndsOn !== null && <p className="subscription__notice subscription__notice--alert" role="alert">
        O pagamento da renovação não passou. A agência continua editando até {formatDay(subscription.graceEndsOn)}; depois disso fica somente leitura.
      </p>}
      {subscription.cancelAtPeriodEnd && <p>
        A assinatura está cancelada. Depois de {subscription.currentPeriodEnd === null ? 'o período' : formatInstant(subscription.currentPeriodEnd)}, a agência fica somente leitura.
      </p>}
    </section>

    {view === 'overview'
      ? <>
        <section className="subscription__block" aria-labelledby="subscription-extras">
          <h2 id="subscription-extras">Adicionar extras</h2>
          <div className="subscription__extras">
            <Field label="Clientes extras" hint={`${formatBrl(plans.extraClientCents)} por cliente, por mês`} error={extraClients === undefined ? EXTRA_INVALID : undefined}>
              {(control) => <TextInput {...control} inputMode="numeric" value={clientsText} onChange={(event) => { setNotice(undefined); setExtras({ clients: event.target.value, gib: gibText }); }} />}
            </Field>
            <Field label="Armazenamento extra, em GB" hint={`${formatBrl(plans.extraStorageGibCents)} por GB, por mês`} error={extraGib === undefined ? EXTRA_INVALID : undefined}>
              {(control) => <TextInput {...control} inputMode="numeric" value={gibText} onChange={(event) => { setNotice(undefined); setExtras({ clients: clientsText, gib: event.target.value }); }} />}
            </Field>
          </div>
          <QuoteSummary
            terms={terms}
            unchanged={unchanged}
            query={quoteQuery}
            quote={quote}
            planCents={planCentsOf(subscription.planKey)}
            extrasCents={terms === undefined ? 0 : extrasCents(terms.extraClients, terms.extraStorageGib)}
            blockedReason={blockedReason}
          />
          <ConfirmAction label={actionLabel} disabled={quote === undefined} blockedReason={blockedReason} loading={request.isPending}
            onConfirm={() => {
              // Same synchronous guard as the first subscription.
              if (terms === undefined || requesting.current) return;
              requesting.current = true;
              request.mutate(terms, { onSettled: () => { requesting.current = false; } });
            }} />
        </section>

        {!subscription.cancelAtPeriodEnd && <section className="subscription__block" aria-labelledby="subscription-change">
          <h2 id="subscription-change">Trocar de plano</h2>
          <p>Veja os planos lado a lado. Subir vale na hora; descer vale no próximo ciclo.</p>
          <div className="subscription__actions">
            <Button variant="secondary" onClick={() => { setNotice(undefined); setExtras(null); setView('plans'); }}>Trocar de plano</Button>
          </div>
        </section>}
      </>
      : <section className="subscription__block subscription--pricing" aria-labelledby="subscription-change">
        <h2 id="subscription-change">Trocar de plano</h2>
        <PlanCards
          plans={plans.plans}
          currentKey={subscription.planKey}
          verb="Escolher"
          onChoose={(chosen: Plan) => { setNotice(undefined); setTarget(chosen.key); }}
        />
        {terms !== undefined && <>
          <h3 className="subscription__target">Mudar para {planName(terms.planKey)}</h3>
          <QuoteSummary
            terms={terms}
            unchanged={unchanged}
            query={quoteQuery}
            quote={quote}
            planCents={planCentsOf(terms.planKey)}
            extrasCents={extrasCents(terms.extraClients, terms.extraStorageGib)}
            blockedReason={blockedReason}
          />
          <ConfirmAction label={quote?.effect === 'upgrade' ? 'Subir o plano' : 'Descer o plano'} disabled={quote === undefined} blockedReason={blockedReason} loading={request.isPending}
            onConfirm={() => {
              if (requesting.current) return;
              requesting.current = true;
              request.mutate(terms, { onSettled: () => { requesting.current = false; } });
            }} />
        </>}
        <div className="subscription__actions">
          <Button variant="ghost" onClick={() => { setView('overview'); setTarget(null); }}>Voltar ao meu plano</Button>
        </div>
      </section>}

    <section className="subscription__block" aria-labelledby="subscription-lifecycle">
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
            <Button variant="secondary" onClick={() => { setCanceling(true); }}>Cancelar a assinatura</Button>
          </div>
        </>}
    </section>

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
