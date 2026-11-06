import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  AuthNoContentResponseSchema,
  SubscriptionChargeResponseSchema,
  SubscriptionOverviewResponseSchema,
  SubscriptionPlansResponseSchema,
  SubscriptionQuoteResponseSchema,
  type SubscriptionChangeRequest,
  type SubscriptionPlansResponse
} from '@ageniza/contracts';
import { Button, ChoiceCard, EmptyState, Field, FieldMessage, LiveStatus, Skeleton, TextInput } from '@ageniza/ui';

import { useAgencyContext } from './agency.js';
import { apiPath } from './api-path.js';
import { useDocumentTitle } from './document-title.js';
import { HttpClientError, useApiClient } from './http.js';
import { CancelSubscriptionDialog } from './subscription-cancel.js';
import { formatBrl, formatDay, formatGb, formatInstant, totalLine } from './subscription-format.js';
import { SimulatedCardStep, type PaymentResult } from './subscription-payment.js';

type Plan = SubscriptionPlansResponse['plans'][number];

const PAYMENT_UNAVAILABLE = 'O pagamento ainda não está disponível neste ambiente.';
const LOAD_FAILED = 'Não foi possível abrir a assinatura. Tente de novo.';
const CHANGE_FAILED = 'Não foi possível pedir a mudança. Tente de novo.';
const EXTRA_INVALID = 'Informe um número inteiro, de 0 a 10000.';

const parseExtra = (value: string, max: number): number | undefined => {
  if (!/^\d{1,5}$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed <= max ? parsed : undefined;
};

const gbOf = (plan: Plan): string => formatGb(plan.storageBytes);

type Notice = { tone: 'status' | 'alert'; text: string };
type Step = { kind: 'pick' } | { kind: 'card'; chargeId: string; amountCents: number };

const RESULT_NOTICES: Record<PaymentResult, Notice> = {
  approved: { tone: 'status', text: 'Pagamento aprovado. A sua assinatura já vale.' },
  declined: { tone: 'alert', text: 'Pagamento recusado. Nada foi cobrado e o plano continua o mesmo. Escolha de novo para tentar outra vez.' },
  failed: { tone: 'alert', text: 'Não foi possível concluir o pagamento. Confira a assinatura abaixo e, se preciso, tente de novo.' }
};

/** A POST with no body and no answer (reactivate, advance): the server decides, the screen only asks. */
function useAgencyAction(template: string, onDone: () => void) {
  const agency = useAgencyContext();
  const httpClient = useApiClient();
  return useMutation({
    mutationFn: () => httpClient.request({ path: apiPath(template, { agenciaId: agency.agencyId }), method: 'POST', response: AuthNoContentResponseSchema }),
    onSuccess: onDone
  });
}

/**
 * `/agencia/:agenciaId/assinatura` (issue #773): plans, extras, upgrade, downgrade, cancel and the simulated card, for the Owner.
 * The screen never writes a plan or a price: it asks the server to quote and to open a charge, and the plan changes only when the
 * provider confirms it. What it sends about a change is the action and the terms asked for, never an amount.
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
  const overviewQuery = useQuery({
    queryKey: [...agencyKey, 'subscription'],
    queryFn: () => httpClient.request({ path: apiPath('/agencies/:agenciaId/subscription', { agenciaId: agency.agencyId }), response: SubscriptionOverviewResponseSchema })
  });

  const [choice, setChoice] = useState<{ planKey: string; clients: string; gib: string } | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [notice, setNotice] = useState<Notice | undefined>();
  const [canceling, setCanceling] = useState(false);
  const requesting = useRef(false);

  const plans = plansQuery.data;
  const subscription = overviewQuery.data?.subscription ?? null;
  const provider = overviewQuery.data?.paymentProvider ?? null;
  const simulated = provider === 'simulado';

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: [...agencyKey, 'subscription'] });
    void queryClient.invalidateQueries({ queryKey: [...agencyKey, 'me'] });
  };

  const current = choice ?? {
    planKey: subscription?.planKey ?? '',
    clients: String(subscription?.extraClients ?? 0),
    gib: String(subscription?.extraStorageGib ?? 0)
  };
  const maxExtra = plans?.maxExtra ?? 0;
  const extraClients = parseExtra(current.clients, maxExtra);
  const extraGib = parseExtra(current.gib, maxExtra);
  const chosenPlan = plans?.plans.find((plan) => plan.key === current.planKey);
  const valid = chosenPlan !== undefined && extraClients !== undefined && extraGib !== undefined;
  const unchanged = subscription !== null && subscription.planKey === current.planKey
    && subscription.extraClients === extraClients && subscription.extraStorageGib === extraGib;

  const terms: SubscriptionChangeRequest | undefined = valid ? { planKey: chosenPlan.key, extraClients, extraStorageGib: extraGib } : undefined;
  const quoteQuery = useQuery({
    queryKey: [...agencyKey, 'subscription-quote', terms],
    enabled: terms !== undefined && !unchanged && step.kind === 'pick',
    retry: false,
    queryFn: () => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/quote', { agenciaId: agency.agencyId }),
      method: 'POST',
      body: terms,
      response: SubscriptionQuoteResponseSchema
    })
  });
  const quote = terms === undefined || unchanged ? undefined : quoteQuery.data;

  const request = useMutation({
    mutationFn: (body: SubscriptionChangeRequest) => httpClient.request({
      path: apiPath('/agencies/:agenciaId/subscription/charges', { agenciaId: agency.agencyId }),
      method: 'POST',
      body,
      response: SubscriptionChargeResponseSchema
    }),
    onSuccess: (charge) => {
      if (charge.chargeId !== null && simulated) { setNotice(undefined); setStep({ kind: 'card', chargeId: charge.chargeId, amountCents: charge.amountCents }); return; }
      setChoice(null);
      refresh();
      setNotice({ tone: 'status', text: charge.effect === 'downgrade' ? `Mudança agendada para ${formatInstant(charge.effectiveAt)}.` : 'Mudança feita. A sua assinatura já vale.' });
    },
    onError: (error: unknown) => { setNotice({ tone: 'alert', text: error instanceof HttpClientError && error.status === 409 ? error.message : CHANGE_FAILED }); }
  });

  const reactivate = useAgencyAction('/agencies/:agenciaId/subscription/reactivate', refresh);
  const advance = useAgencyAction('/agencies/:agenciaId/subscription/simulated-period-advance', refresh);

  const finish = (result: PaymentResult): void => {
    setStep({ kind: 'pick' });
    setChoice(null);
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
  const extrasCents = (clients: number, gib: number): number => clients * plans.extraClientCents + gib * plans.extraStorageGibCents;
  const courtesy = subscription?.provider === 'cortesia';
  const needsPayment = quote !== undefined && quote.amountCents > 0;
  const blockedReason = needsPayment && !simulated ? PAYMENT_UNAVAILABLE : undefined;
  const actionLabel = quote === undefined ? 'Escolha um plano' : quote.effect === 'subscribe' ? 'Assinar' : quote.effect === 'upgrade' ? 'Subir o plano' : 'Descer o plano';

  const header = <>
    <h1 id="subscription-title">Assinatura</h1>
    {notice !== undefined && (notice.tone === 'alert' ? <p className="subscription__notice subscription__notice--alert" role="alert">{notice.text}</p> : <LiveStatus className="subscription__notice">{notice.text}</LiveStatus>)}
  </>;

  if (step.kind === 'card') {
    return <section aria-labelledby="subscription-title" className="subscription">
      {header}
      <SimulatedCardStep
        agencyId={agency.agencyId}
        chargeId={step.chargeId}
        amountCents={step.amountCents}
        onFinish={finish}
        onLeave={() => { setStep({ kind: 'pick' }); setNotice({ tone: 'status', text: 'Você saiu sem pagar. Nada foi cobrado e o plano continua o mesmo.' }); }}
      />
    </section>;
  }

  return <section aria-labelledby="subscription-title" className="subscription">
    {header}

    <section className="subscription__block" aria-labelledby="subscription-current">
      <h2 id="subscription-current">Seu plano</h2>
      {subscription === null
        ? <p>{agency.plan.readOnly
          ? 'O período de teste acabou e a agência está somente leitura. Escolha um plano para voltar a editar.'
          : 'A agência está no período de teste. Escolha um plano para continuar depois dele.'}</p>
        : courtesy
          ? <p>A agência tem um plano de cortesia, sem cobrança.</p>
          : <>
            <p className="subscription__plan"><strong>{planName(subscription.planKey)}</strong>, {totalLine(
              plans.plans.find((plan) => plan.key === subscription.planKey)?.monthlyCents ?? subscription.monthlyCents,
              extrasCents(subscription.extraClients, subscription.extraStorageGib),
              subscription.monthlyCents
            )}</p>
            <ul className="subscription__facts">
              <li>Clientes: {subscription.usedClients} de {subscription.clientLimit}</li>
              <li>Armazenamento: {formatGb(subscription.usedBytes)} de {formatGb(subscription.storageBytes)}</li>
              {subscription.currentPeriodEnd !== null && <li>{subscription.cancelAtPeriodEnd ? 'Acesso até' : 'Próxima renovação em'} {formatInstant(subscription.currentPeriodEnd)}</li>}
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
          </>}
    </section>

    {!courtesy && <section className="subscription__block" aria-labelledby="subscription-pick">
      <h2 id="subscription-pick">{subscription === null ? 'Escolha o plano' : 'Mudar de plano'}</h2>
      <div className="subscription__plans" role="group" aria-label="Planos">
        {plans.plans.map((plan) => <ChoiceCard
          key={plan.key}
          title={plan.name}
          description={`${plan.clientLimit} clientes, ${gbOf(plan)} · ${formatBrl(plan.monthlyCents)}/mês`}
          badge={subscription?.planKey === plan.key ? 'Plano atual' : undefined}
          aria-pressed={current.planKey === plan.key}
          highlighted={current.planKey === plan.key}
          onClick={() => { setNotice(undefined); setChoice({ ...current, planKey: plan.key }); }}
        />)}
      </div>
      <div className="subscription__extras">
        <Field label="Clientes extras" hint={`${formatBrl(plans.extraClientCents)} por cliente, por mês`} error={extraClients === undefined ? EXTRA_INVALID : undefined}>
          {(control) => <TextInput {...control} inputMode="numeric" value={current.clients} onChange={(event) => { setNotice(undefined); setChoice({ ...current, clients: event.target.value }); }} />}
        </Field>
        <Field label="Armazenamento extra, em GB" hint={`${formatBrl(plans.extraStorageGibCents)} por GB, por mês`} error={extraGib === undefined ? EXTRA_INVALID : undefined}>
          {(control) => <TextInput {...control} inputMode="numeric" value={current.gib} onChange={(event) => { setNotice(undefined); setChoice({ ...current, gib: event.target.value }); }} />}
        </Field>
      </div>

      <div className="subscription__summary" aria-live="polite">
        {unchanged
          ? <p>Estas já são as condições da sua assinatura.</p>
          : terms === undefined
            ? <p>{chosenPlan === undefined ? 'Escolha um plano para ver o total.' : 'Corrija os extras para ver o total.'}</p>
            : quoteQuery.isError
              ? <p role="alert">{quoteQuery.error instanceof HttpClientError && quoteQuery.error.status === 409 ? quoteQuery.error.message : 'Não foi possível calcular o total. Tente de novo.'}</p>
              : quote === undefined
                ? <p>Calculando o total…</p>
                : <>
                  <p className="subscription__total">{totalLine(chosenPlan?.monthlyCents ?? quote.monthlyCents, extrasCents(terms.extraClients, terms.extraStorageGib), quote.monthlyCents)}</p>
                  <p>{quote.effect === 'downgrade'
                    ? `Nada é cobrado agora. A mudança vale a partir de ${formatInstant(quote.effectiveAt)}.`
                    : quote.amountCents === 0
                      ? 'Nada é cobrado agora. A mudança vale na hora.'
                      : `Cobrança agora: ${formatBrl(quote.amountCents)}${quote.effect === 'upgrade' ? ' (o restante do período atual)' : ''}.`}</p>
                </>}
        {blockedReason !== undefined && <p>{blockedReason}</p>}
      </div>
      <div className="subscription__actions">
        <Button
          loading={request.isPending}
          disabled={quote === undefined}
          blockedReason={blockedReason}
          onClick={() => {
            // A synchronous guard: `isPending` only changes on the next render, and two clicks in one tick would both pass it.
            if (terms === undefined || requesting.current) return;
            requesting.current = true;
            request.mutate(terms, { onSettled: () => { requesting.current = false; } });
          }}
        >{actionLabel}</Button>
      </div>
    </section>}

    {subscription !== null && !courtesy && <section className="subscription__block" aria-labelledby="subscription-lifecycle">
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
    </section>}

    {simulated && <section className="subscription__block" aria-labelledby="subscription-dev">
      <h2 id="subscription-dev">Só para testes</h2>
      <p>Disponível apenas com o pagamento simulado. Leva a assinatura ao fim do período, para testar a renovação e a tolerância.</p>
      <div className="subscription__actions">
        <Button variant="secondary" loading={advance.isPending} onClick={() => { advance.mutate(undefined, { onSuccess: () => { setNotice({ tone: 'status', text: 'O período foi levado ao fim.' }); } }); }}>Avançar para o fim do período</Button>
      </div>
      {advance.isError && <FieldMessage role="alert">Não foi possível avançar o período.</FieldMessage>}
    </section>}

    {canceling && subscription !== null && <CancelSubscriptionDialog
      agencyId={agency.agencyId}
      subscription={subscription}
      onClose={() => { setCanceling(false); }}
      onCanceled={() => { setCanceling(false); refresh(); setNotice({ tone: 'status', text: 'Assinatura cancelada. O acesso continua até o fim do período.' }); }}
    />}
  </section>;
}
