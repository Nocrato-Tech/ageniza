import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { View } from 'react-native';
import { Action, Card, Heading, Info, Txt, colors, ui } from '../product/ui';
import { plans } from './billing';
import type { BillingEvent, BillingState, PlanId } from './billing';

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export function BillingPanel({ state, dispatch }: { state: BillingState; dispatch: Dispatch<BillingEvent> }) {
  const [selected, setSelected] = useState<PlanId>('essencial');
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const plan = plans.find((item) => item.id === selected)!;
  const active = plans.find((item) => item.id === state.active);
  function pay(outcome: 'approved' | 'declined') {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    timer.current = setTimeout(() => {
      dispatch({ type: 'payment', planId: selected, outcome, now: new Date().toISOString() });
      pending.current = false; setBusy(false); setReviewing(false);
    }, 600);
  }
  return <><Heading title="Um plano para cada fase" subtitle="Contratação e recibos de demonstração" />
    <Card><Txt kind="section">{active ? `Plano atual: ${active.name}` : 'Nenhum plano simulado ativo'}</Txt><Txt>{active ? state.cancelAtEnd ? 'Cancelamento simulado agendado para o fim do ciclo.' : 'Assinatura demonstrativa ativa.' : 'Escolha um plano para experimentar a contratação.'}</Txt>
      {active && (state.cancelAtEnd ? <Action soft label="Reativar assinatura simulada" onPress={() => dispatch({ type: 'reactivate' })} /> : cancelConfirm ? <><Info warning title="Confirmar cancelamento simulado?" text="O plano fictício permanece até o fim do ciclo demonstrativo. Nenhuma assinatura real será alterada." /><Action label="Confirmar cancelamento simulado" onPress={() => { dispatch({ type: 'cancel' }); setCancelConfirm(false); }} /><Action plain label="Manter plano simulado" onPress={() => setCancelConfirm(false)} /></> : <Action plain label="Cancelar assinatura simulada" onPress={() => setCancelConfirm(true)} />)}
    </Card>
    {!reviewing ? <>{plans.map((item) => <Card key={item.id}><View style={[ui.row, { justifyContent: 'space-between' }]}><Txt kind="section">{item.name}</Txt><Txt kind="section" color={colors.indigo}>{money(item.cents)}</Txt></View><Txt color={colors.muted}>{item.clients} clientes · {item.storage} GB · por mês</Txt><Action soft={selected !== item.id} label={`Escolher ${item.name}`} onPress={() => { setSelected(item.id); setReviewing(true); }} /></Card>)}</> : <Card><Txt kind="section">Confira sua simulação</Txt><Txt>Plano: {plan.name}</Txt><Txt>Total demonstrativo: {money(plan.cents)}/mês</Txt><Txt kind="small" color={colors.muted}>Não informe cartão ou dados bancários. Escolha o resultado que deseja apresentar.</Txt><Action label="Simular pagamento aprovado" busy={busy} onPress={() => pay('approved')} /><Action soft label="Simular pagamento recusado" busy={busy} onPress={() => pay('declined')} /><Action plain label="Voltar aos planos" disabled={busy} onPress={() => setReviewing(false)} /></Card>}
    {state.receipts.length > 0 && <><Txt kind="section">Comprovantes demonstrativos</Txt>{state.receipts.map((receipt) => <Card key={receipt.id}><Txt kind="strong">{receipt.id} · {receipt.status === 'approved' ? 'Aprovado' : 'Recusado'}</Txt><Txt>{plans.find((item) => item.id === receipt.planId)?.name} · {money(receipt.cents)}</Txt><Txt kind="small" color={colors.muted}>{new Date(receipt.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</Txt><Txt kind="small">{receipt.status === 'approved' ? 'Plano fictício ativado. Nenhum valor foi cobrado.' : 'Simulação recusada. Seu plano anterior foi mantido.'}</Txt></Card>)}</>}
  </>;
}
