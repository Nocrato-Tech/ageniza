import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { SubscriptionChangeRequestSchema } from '@ageniza/contracts';
import type { AgencyMeResponse, Context, SimulatedPaymentResponse, SubscriptionChargeResponse, SubscriptionChangeRequest, SubscriptionOverviewResponse, SubscriptionPlansResponse, SubscriptionQuoteResponse } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Field, Heading, Info, Selector, Txt } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export function SubscriptionScreen({ context }: { context: Extract<Context, { type: 'agency' }> }) {
  const root = `/agencies/${context.agencyId}`;
  const load = useCallback(async (signal: AbortSignal) => {
    const [me, overview, plans] = await Promise.all([api.request<AgencyMeResponse>(`${root}/me`, { signal }), api.request<SubscriptionOverviewResponse>(`${root}/subscription`, { signal }), api.request<SubscriptionPlansResponse>(`${root}/subscription/plans`, { signal })]);
    return { me, overview, plans };
  }, [root]);
  const { data, busy, error, notice, run } = useRemoteResource(load);
  const [planKey, setPlanKey] = useState('');
  const [extraClients, setExtraClients] = useState('0');
  const [extraStorage, setExtraStorage] = useState('0');
  const [quote, setQuote] = useState<SubscriptionQuoteResponse>();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [review, setReview] = useState<{ input: SubscriptionChangeRequest; quote: SubscriptionQuoteResponse }>();
  const [charge, setCharge] = useState<SubscriptionChargeResponse>();
  const invalidate = () => { setQuote(undefined); setReview(undefined); };
  const input = () => {
    if (!/^\d+$/.test(extraClients) || !/^\d+$/.test(extraStorage)) throw new Error('Informe quantidades inteiras e não negativas.');
    const parsed = SubscriptionChangeRequestSchema.safeParse({ planKey, extraClients: Number(extraClients), extraStorageGib: Number(extraStorage) });
    if (!parsed.success) throw new Error('Escolha um plano e confira os extras.');
    return parsed.data;
  };
  return <View style={{ gap: 16 }}><Heading title="Plano e assinatura" subtitle="Somente o proprietário gerencia a assinatura da agência." />{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}
    {data && <><Card><Txt kind="section">{data.overview.subscription?.planKey ?? (data.me.plan.kind === 'trial' ? 'Teste grátis' : 'Sem assinatura')}</Txt><Txt>{data.me.plan.readOnly ? 'Somente leitura' : 'Operação liberada'}</Txt>{data.me.plan.trialEndsAt && <Txt>Teste até {new Date(data.me.plan.trialEndsAt).toLocaleDateString('pt-BR')}</Txt>}{data.overview.subscription && <><Txt>Mensalidade: {money(data.overview.subscription.monthlyCents)}</Txt><Txt>{data.overview.subscription.usedClients} clientes em uso</Txt><Txt>{(data.overview.subscription.usedBytes / 1024 ** 3).toFixed(2)} GB utilizados</Txt><Txt>{data.overview.subscription.cancelAtPeriodEnd ? 'Cancelada ao fim do período' : 'Assinatura ativa'}</Txt></>}</Card>
      {data.plans.plans.map((plan) => <Card key={plan.key}><Txt kind="section">{plan.name}</Txt><Txt>{money(plan.monthlyCents)}/mês</Txt><Txt>{plan.clientLimit} clientes · {Math.round(plan.storageBytes / 1024 ** 3)} GB</Txt></Card>)}
      {!charge && <><Selector label="Plano desejado" value={planKey} options={data.plans.plans.map((plan) => ({ id: plan.key, label: plan.name }))} onChange={(value) => { setPlanKey(value); invalidate(); }} /><Field label="Clientes extras" value={extraClients} keyboardType="number-pad" onChangeText={(value) => { setExtraClients(value); invalidate(); }} /><Field label="GB extras" value={extraStorage} keyboardType="number-pad" onChangeText={(value) => { setExtraStorage(value); invalidate(); }} /><Action soft label="Calcular alteração sem cobrar" busy={busy} onPress={() => void run(async () => { const request = input(); const result = await api.request<SubscriptionQuoteResponse>(`${root}/subscription/quote`, { method: 'POST', body: request }); setQuote(result); setReview({ input: request, quote: result }); }, 'Cotação calculada. Nenhuma cobrança foi criada.')} /></>}
      {quote && <Info title={`Agora: ${money(quote.amountCents)} · Mensal: ${money(quote.monthlyCents)}`} text={`Efeito: ${quote.effect === 'downgrade' ? 'redução no próximo período' : quote.effect === 'upgrade' ? 'aumento de limites' : 'início de assinatura'}. Vigência: ${new Date(quote.effectiveAt).toLocaleDateString('pt-BR')}.`} />}
      <Info warning title={data.overview.paymentProvider === 'simulado' ? 'Ambiente com pagamento simulado' : 'Pagamento no aplicativo ainda não liberado'} text={data.overview.paymentProvider === 'simulado' ? 'Nenhum dinheiro é movimentado. O servidor registra a alteração e só libera o plano após confirmar o pagamento simulado.' : 'A consulta e a cotação usam a API. Este ambiente não oferece pagamento pelo aplicativo.'} />
      {data.overview.paymentProvider === 'simulado' && <>
        {review && !charge && <Card><Txt kind="strong">Confira antes de confirmar</Txt><Txt>Plano: {data.plans.plans.find((plan) => plan.key === review.input.planKey)?.name ?? review.input.planKey} · {review.input.extraClients} clientes extras · {review.input.extraStorageGib} GB extras.</Txt><Txt>Agora: {money(review.quote.amountCents)} · Mensalidade: {money(review.quote.monthlyCents)}</Txt><Txt>A simulação poderá alterar os limites desta agência no servidor.</Txt><Action label="Confirmar alteração no ambiente simulado" busy={busy} onPress={() => void run(async () => { const result = await api.request<SubscriptionChargeResponse>(`${root}/subscription/charges`, { method: 'POST', body: review.input }); setReview(undefined); setQuote(undefined); if (result.chargeId) setCharge(result); }, 'Solicitação registrada no servidor.')} /><Action plain disabled={busy} label="Voltar à escolha do plano" onPress={() => setReview(undefined)} /></Card>}
        {charge?.chargeId && <Card><Txt kind="strong">Pagamento simulado pendente</Txt><Txt>Valor confirmado pelo servidor: {money(charge.amountCents)}.</Txt><Txt kind="small">Referência: {charge.chargeId}</Txt><Action label="Simular pagamento aprovado na API" busy={busy} onPress={() => void run(async () => { const result = await api.request<SimulatedPaymentResponse>(`${root}/subscription/charges/${charge.chargeId}/simulated-payment`, { method: 'POST', body: { outcome: 'approved' } }); if (result.status !== 'confirmed') throw new Error('O servidor não confirmou o pagamento. O plano não foi ativado.'); setCharge(undefined); }, 'Pagamento simulado confirmado pelo servidor.')} /><Action soft label="Simular pagamento recusado na API" busy={busy} onPress={() => void run(async () => { const result = await api.request<SimulatedPaymentResponse>(`${root}/subscription/charges/${charge.chargeId}/simulated-payment`, { method: 'POST', body: { outcome: 'declined' } }); if (result.status !== 'declined') throw new Error('O servidor retornou outro resultado. Atualize a assinatura antes de continuar.'); setCharge(undefined); }, 'Pagamento simulado recusado. Nenhum plano foi ativado por esta tentativa.')} /></Card>}
      </>}
      {data.overview.subscription && !data.overview.subscription.cancelAtPeriodEnd && <>{confirmCancel ? <><Info warning title="Confirmar cancelamento?" text="O acesso é mantido até o fim do período pago. Durante a tolerância de pagamento, cancelar coloca a agência em modo leitura." /><Action label="Confirmar cancelamento da assinatura" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/subscription/cancel`, { method: 'POST' }); setConfirmCancel(false); }, 'Cancelamento registrado.')} /><Action plain label="Manter assinatura" onPress={() => setConfirmCancel(false)} /></> : <Action plain label="Cancelar assinatura" onPress={() => setConfirmCancel(true)} />}</>}
      {data.overview.subscription?.cancelAtPeriodEnd && <Action soft label="Reativar assinatura no período atual" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/subscription/reactivate`, { method: 'POST' }); }, 'Assinatura reativada.')} />}
    </>}
  </View>;
}
