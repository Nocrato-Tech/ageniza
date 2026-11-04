import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { SubscriptionChangeRequestSchema } from '@ageniza/contracts';
import type { AgencyMeResponse, Context, SubscriptionOverviewResponse, SubscriptionPlansResponse, SubscriptionQuoteResponse } from '@ageniza/contracts';
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
  const input = () => {
    if (!/^\d+$/.test(extraClients) || !/^\d+$/.test(extraStorage)) throw new Error('Informe quantidades inteiras e não negativas.');
    const parsed = SubscriptionChangeRequestSchema.safeParse({ planKey, extraClients: Number(extraClients), extraStorageGib: Number(extraStorage) });
    if (!parsed.success) throw new Error('Escolha um plano e confira os extras.');
    return parsed.data;
  };
  return <View style={{ gap: 16 }}><Heading title="Plano e assinatura" subtitle="Somente o proprietário gerencia a assinatura da agência." />{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}
    {data && <><Card><Txt kind="section">{data.overview.subscription?.planKey ?? (data.me.plan.kind === 'trial' ? 'Teste grátis' : 'Sem assinatura')}</Txt><Txt>{data.me.plan.readOnly ? 'Somente leitura' : 'Operação liberada'}</Txt>{data.me.plan.trialEndsAt && <Txt>Teste até {new Date(data.me.plan.trialEndsAt).toLocaleDateString('pt-BR')}</Txt>}{data.overview.subscription && <><Txt>Mensalidade: {money(data.overview.subscription.monthlyCents)}</Txt><Txt>{data.overview.subscription.usedClients} clientes em uso</Txt><Txt>{(data.overview.subscription.usedBytes / 1024 ** 3).toFixed(2)} GB utilizados</Txt><Txt>{data.overview.subscription.cancelAtPeriodEnd ? 'Cancelada ao fim do período' : 'Assinatura ativa'}</Txt></>}</Card>
      {data.plans.plans.map((plan) => <Card key={plan.key}><Txt kind="section">{plan.name}</Txt><Txt>{money(plan.monthlyCents)}/mês</Txt><Txt>{plan.clientLimit} clientes · {Math.round(plan.storageBytes / 1024 ** 3)} GB</Txt></Card>)}
      <Selector label="Plano desejado" value={planKey} options={data.plans.plans.map((plan) => ({ id: plan.key, label: plan.name }))} onChange={(value) => { setPlanKey(value); setQuote(undefined); }} /><Field label="Clientes extras" value={extraClients} keyboardType="number-pad" onChangeText={(value) => { setExtraClients(value); setQuote(undefined); }} /><Field label="GB extras" value={extraStorage} keyboardType="number-pad" onChangeText={(value) => { setExtraStorage(value); setQuote(undefined); }} /><Action soft label="Calcular alteração sem cobrar" busy={busy} onPress={() => void run(async () => { setQuote(await api.request<SubscriptionQuoteResponse>(`${root}/subscription/quote`, { method: 'POST', body: input() })); }, 'Cotação calculada. Nenhuma cobrança foi criada.')} />
      {quote && <Info title={`Agora: ${money(quote.amountCents)} · Mensal: ${money(quote.monthlyCents)}`} text={`Efeito: ${quote.effect === 'downgrade' ? 'redução no próximo período' : quote.effect === 'upgrade' ? 'aumento de limites' : 'início de assinatura'}. Vigência: ${new Date(quote.effectiveAt).toLocaleDateString('pt-BR')}.`} />}
      <Info warning title={data.overview.paymentProvider === 'simulado' ? 'Ambiente com pagamento simulado' : 'Pagamento no aplicativo ainda não liberado'} text="A consulta mostra o plano e a cotação reais. A contratação depende da integração de pagamento de produção; esta tela não simula uma cobrança concluída." />
      {data.overview.subscription && !data.overview.subscription.cancelAtPeriodEnd && <>{confirmCancel ? <><Info warning title="Confirmar cancelamento?" text="O acesso é mantido até o fim do período pago. Durante a tolerância de pagamento, cancelar coloca a agência em modo leitura." /><Action label="Confirmar cancelamento da assinatura" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/subscription/cancel`, { method: 'POST' }); setConfirmCancel(false); }, 'Cancelamento registrado.')} /><Action plain label="Manter assinatura" onPress={() => setConfirmCancel(false)} /></> : <Action plain label="Cancelar assinatura" onPress={() => setConfirmCancel(true)} />}</>}
      {data.overview.subscription?.cancelAtPeriodEnd && <Action soft label="Reativar assinatura no período atual" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/subscription/reactivate`, { method: 'POST' }); }, 'Assinatura reativada.')} />}
    </>}
  </View>;
}
