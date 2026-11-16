import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { SubscriptionChangeRequestSchema } from '@ageniza/contracts';
import type { AgencyMeResponse, Context, SimulatedPaymentResponse, SubscriptionChargeResponse, SubscriptionChangeRequest, SubscriptionOverviewResponse, SubscriptionPlansResponse, SubscriptionQuoteResponse } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Field, Heading, Info, Txt, useColors } from '../product/ui';
import { PlanComparison, money } from './PlanComparison';
import { useRemoteResource } from './useRemoteResource';

const date = (instant: string) => new Date(instant).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const day = (value: string) => value.split('-').reverse().join('/');
export function SubscriptionScreen({ context }: { context: Extract<Context, { type: 'agency' }> }) {
  const c = useColors();
  const root = `/agencies/${context.agencyId}`;
  const load = useCallback(async (signal: AbortSignal) => {
    const [me, overview, plans] = await Promise.all([api.request<AgencyMeResponse>(`${root}/me`, { signal }), api.request<SubscriptionOverviewResponse>(`${root}/subscription`, { signal }), api.request<SubscriptionPlansResponse>(`${root}/subscription/plans`, { signal })]);
    return { me, overview, plans };
  }, [root]);
  const { data, loading, busy, error, notice, run, refresh, setError } = useRemoteResource(load);
  const [planKey, setPlanKey] = useState('');
  const [extraClients, setExtraClients] = useState('0');
  const [extraStorage, setExtraStorage] = useState('0');
  const [quote, setQuote] = useState<SubscriptionQuoteResponse>();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const subscription = data?.overview.subscription;
  const selectedPlan = data?.plans.plans.find((plan) => plan.key === planKey);
  const estimate = selectedPlan && data && /^\d+$/.test(extraClients) && /^\d+$/.test(extraStorage)
    ? selectedPlan.monthlyCents + Number(extraClients) * data.plans.extraClientCents + Number(extraStorage) * data.plans.extraStorageGibCents : undefined;
  const planName = (key: string) => data?.plans.plans.find((plan) => plan.key === key)?.name ?? key;
  const [review, setReview] = useState<{ input: SubscriptionChangeRequest; quote: SubscriptionQuoteResponse }>();
  const [charge, setCharge] = useState<SubscriptionChargeResponse>();
  const invalidate = () => { setQuote(undefined); setReview(undefined); };
  const input = () => {
    if (!/^\d+$/.test(extraClients) || !/^\d+$/.test(extraStorage)) throw new Error('Informe quantidades inteiras e não negativas.');
    const parsed = SubscriptionChangeRequestSchema.safeParse({ planKey, extraClients: Number(extraClients), extraStorageGib: Number(extraStorage) });
    if (!parsed.success) throw new Error('Escolha um plano e confira os extras.');
    return parsed.data;
  };
  return <View style={{ gap: 16 }}><Heading title="Um plano para seu ritmo." subtitle="Compare os limites, ajuste os extras e confira o valor antes de confirmar." />{loading && !data && <Txt>Carregando assinatura…</Txt>}{!!error && <><ErrorText text={error} /><Action soft label="Atualizar assinatura" busy={loading || busy} onPress={() => { setError(''); void refresh().catch(() => {}); }} /></>}{!!notice && <Info tone="success" title={notice} />}
    {data && <><Card style={{ borderRadius: 14, gap: 8 }}><Txt kind="small" color={c.muted}>Sua assinatura</Txt><Txt kind="section">{subscription ? planName(subscription.planKey) : data.me.plan.kind === 'trial' ? 'Teste grátis' : 'Sem assinatura'}</Txt><Txt>{data.me.plan.readOnly ? 'Somente leitura' : 'Operação liberada'}</Txt>{data.me.plan.trialEndsAt && <Txt>Teste até {date(data.me.plan.trialEndsAt)}</Txt>}{subscription && <>
      <Txt>Mensalidade: {money(subscription.monthlyCents)}</Txt>
      <Txt>{subscription.usedClients} de {subscription.clientLimit} clientes em uso</Txt>
      <Txt>{(subscription.usedBytes / 1024 ** 3).toFixed(2)} de {(subscription.storageBytes / 1024 ** 3).toFixed(2)} GB utilizados</Txt>
      {subscription.currentPeriodEnd && <Txt>Fim do período: {date(subscription.currentPeriodEnd)}</Txt>}
      <Txt>{data.me.plan.readOnly ? 'Assinatura sem liberação para alterações' : subscription.cancelAtPeriodEnd ? 'Cancelada ao fim do período' : subscription.graceEndsOn ? 'Pagamento pendente' : subscription.provider === 'cortesia' ? 'Plano de cortesia' : 'Assinatura ativa'}</Txt>
      {subscription.nextMonthlyCents !== null && <Txt>Próxima mensalidade: {money(subscription.nextMonthlyCents)}</Txt>}
    </>}</Card>
      {subscription?.graceEndsOn && <Info warning title={`Pagamento pendente: atualize o pagamento até ${day(subscription.graceEndsOn)}`} text="A agência está no período de tolerância informado pelo servidor. Depois dele, as alterações ficam bloqueadas se o pagamento não for confirmado." />}
      {subscription?.pending && <Info title="Redução agendada para o próximo período" text={`${planName(subscription.pending.planKey)} · ${subscription.pending.extraClients} clientes extras · ${subscription.pending.extraStorageGib} GB extras. Os limites atuais continuam neste período.`} />}
      <Info warning title={data.overview.paymentProvider === 'simulado' ? 'Ambiente com pagamento simulado' : 'Pagamento no aplicativo ainda não liberado'} text={data.overview.paymentProvider === 'simulado' ? 'Nenhum dinheiro é movimentado. Você confere a cotação antes de criar e confirmar uma cobrança fictícia.' : 'Você pode consultar os planos e calcular uma alteração. A contratação pelo aplicativo ainda não está disponível neste ambiente.'} />
      {!charge && <>
        <PlanComparison plans={data.plans.plans} value={planKey} current={subscription?.planKey} disabled={busy || loading} onChange={(value) => { setPlanKey(value); invalidate(); }} />
        <View style={{ gap: 12 }}>
          <View style={{ gap: 4 }}><Txt kind="section">Ajuste os extras</Txt><Txt color={c.muted}>Adicione capacidade ao plano escolhido. Use zero para manter apenas o que está incluído.</Txt></View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 128 }}><Field label="Clientes extras" hint={data.plans.extraClientCents ? `${money(data.plans.extraClientCents)} por cliente/mês` : undefined} value={extraClients} editable={!busy && !loading} keyboardType="number-pad" onChangeText={(value) => { setExtraClients(value); invalidate(); }} /></View>
            <View style={{ flex: 1, minWidth: 128 }}><Field label="GB extras" hint={data.plans.extraStorageGibCents ? `${money(data.plans.extraStorageGibCents)} por GB/mês` : undefined} value={extraStorage} editable={!busy && !loading} keyboardType="number-pad" onChangeText={(value) => { setExtraStorage(value); invalidate(); }} /></View>
          </View>
        </View>
        <View style={{ gap: 8, paddingVertical: 16, borderTopWidth: 1, borderColor: c.border }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><Txt kind="strong">Mensalidade estimada</Txt><Txt kind="strong" color={c.indigo}>{estimate !== undefined && Number.isFinite(estimate) ? `${money(estimate)}/mês` : 'Selecione um plano'}</Txt></View>
          <Txt kind="small" color={c.muted}>O servidor confirma o valor, a cobrança proporcional e a data de vigência na cotação.</Txt>
          <Action label="Calcular alteração sem cobrar" disabled={!selectedPlan || loading} busy={busy} onPress={() => void run(async () => { const request = input(); const result = await api.request<SubscriptionQuoteResponse>(`${root}/subscription/quote`, { method: 'POST', body: request }); setQuote(result); setReview({ input: request, quote: result }); }, 'Cotação calculada. Nenhuma cobrança foi criada.')} />
        </View>
      </>}
      {quote && <Info title={`Agora: ${money(quote.amountCents)} · Mensal: ${money(quote.monthlyCents)}`} text={`Efeito: ${quote.effect === 'downgrade' ? 'redução no próximo período' : quote.effect === 'upgrade' ? 'aumento de limites' : 'início de assinatura'}. Vigência: ${date(quote.effectiveAt)}.`} />}
      {data.overview.paymentProvider === 'simulado' && <>
        {review && !charge && <Card><Txt kind="strong">Confira antes de confirmar</Txt><Txt>Plano: {data.plans.plans.find((plan) => plan.key === review.input.planKey)?.name ?? review.input.planKey} · {review.input.extraClients} clientes extras · {review.input.extraStorageGib} GB extras.</Txt><Txt>Agora: {money(review.quote.amountCents)} · Mensalidade: {money(review.quote.monthlyCents)}</Txt><Txt>A simulação poderá alterar os limites desta agência no servidor.</Txt><Action label="Confirmar alteração no ambiente simulado" busy={busy} onPress={() => void run(async () => { const result = await api.request<SubscriptionChargeResponse>(`${root}/subscription/charges`, { method: 'POST', body: review.input }); setReview(undefined); setQuote(undefined); if (result.chargeId) setCharge(result); }, 'Solicitação registrada no servidor.')} /><Action plain disabled={busy} label="Voltar à escolha do plano" onPress={() => setReview(undefined)} /></Card>}
        {charge?.chargeId && <Card><Txt kind="strong">Pagamento simulado pendente</Txt><Txt>Valor confirmado pelo servidor: {money(charge.amountCents)}.</Txt><Txt kind="small">Referência: {charge.chargeId}</Txt><Action label="Simular pagamento aprovado na API" busy={busy} onPress={() => void run(async () => { const result = await api.request<SimulatedPaymentResponse>(`${root}/subscription/charges/${charge.chargeId}/simulated-payment`, { method: 'POST', body: { outcome: 'approved' } }); if (result.status !== 'confirmed') throw new Error('O servidor não confirmou o pagamento. O plano não foi ativado.'); setCharge(undefined); }, 'Pagamento simulado confirmado pelo servidor.')} /><Action soft label="Simular pagamento recusado na API" busy={busy} onPress={() => void run(async () => { const result = await api.request<SimulatedPaymentResponse>(`${root}/subscription/charges/${charge.chargeId}/simulated-payment`, { method: 'POST', body: { outcome: 'declined' } }); if (result.status !== 'declined') throw new Error('O servidor retornou outro resultado. Atualize a assinatura antes de continuar.'); setCharge(undefined); }, 'Pagamento simulado recusado. Nenhum plano foi ativado por esta tentativa.')} /></Card>}
      </>}
      {data.overview.subscription && !data.overview.subscription.cancelAtPeriodEnd && <>{confirmCancel ? <><Info warning title="Confirmar cancelamento?" text="O acesso é mantido até o fim do período pago. Durante a tolerância de pagamento, cancelar coloca a agência em modo leitura." /><Action label="Confirmar cancelamento da assinatura" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/subscription/cancel`, { method: 'POST' }); setConfirmCancel(false); }, 'Cancelamento registrado.')} /><Action plain label="Manter assinatura" onPress={() => setConfirmCancel(false)} /></> : <Action plain label="Cancelar assinatura" onPress={() => setConfirmCancel(true)} />}</>}
      {data.overview.subscription?.cancelAtPeriodEnd && <Action soft label="Reativar assinatura no período atual" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/subscription/reactivate`, { method: 'POST' }); }, 'Assinatura reativada.')} />}
    </>}
  </View>;
}
