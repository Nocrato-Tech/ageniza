import { useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { Bell } from 'lucide-react-native';
import { Action, Card, ErrorText, Heading, Info, Tabs, Txt, colors, ui } from '../product/ui';
import { ScreenMotion } from '../product/motion';
import { presentationModel } from './model';
import type { Signals } from './model';
import { billingReducer, initialBilling } from './billing';
import { BillingPanel } from './BillingPanel';
import { sendPresentationNotification } from './notifications';
import Sora from '../../assets/fonts/Sora-SemiBold.ttf';
import Inter from '../../assets/fonts/Inter-Regular.ttf';
import InterSemi from '../../assets/fonts/Inter-SemiBold.ttf';
import owl from '../../assets/owl.png';

function SignalControl({ label, value, max, onChange }: { label: string; value: number; max: number; onChange(value: number): void }) {
  return <View style={[ui.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}><View style={{ flex: 1, minWidth: 120 }}><Txt kind="strong">{label}</Txt><Txt color={colors.muted}>{value}{label === 'Tarefas pendentes' ? ' de 10' : ''}</Txt></View><View style={ui.row}><Pressable accessibilityRole="button" accessibilityLabel={`Diminuir ${label.toLowerCase()}`} accessibilityState={{ disabled: value === 0 }} disabled={value === 0} onPress={() => onChange(value - 1)} style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.soft, justifyContent: 'center', alignItems: 'center', opacity: value === 0 ? 0.4 : 1 }}><Txt kind="section" color={colors.indigo}>−</Txt></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Aumentar ${label.toLowerCase()}`} accessibilityState={{ disabled: value === max }} disabled={value === max} onPress={() => onChange(value + 1)} style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.soft, justifyContent: 'center', alignItems: 'center', opacity: value === max ? 0.4 : 1 }}><Txt kind="section" color={colors.indigo}>+</Txt></Pressable></View></View>;
}

function LearningPanel() {
  const trained = useMemo(presentationModel, []);
  const [signals, setSignals] = useState<Signals>({ days: 2, pending: 8, revisions: 4 });
  const [details, setDetails] = useState(false);
  const prediction = trained.model.predict(signals);
  return <><Heading title="Antecipe os atrasos" subtitle="Machine learning supervisionado · k-NN" /><View accessibilityLiveRegion="polite"><Info warning={prediction.late} title={prediction.late ? 'Risco elevado de atraso' : 'Risco reduzido de atraso'} text={`${prediction.lateVotes} dos 5 históricos sintéticos mais semelhantes terminaram com atraso. Esta classificação é demonstrativa.`} /></View><Card><Txt kind="section">Conteúdo de exemplo</Txt><Txt color={colors.muted}>Altere os sinais para acompanhar uma nova classificação.</Txt>
    <SignalControl label="Dias até a publicação" value={signals.days} max={14} onChange={(days) => setSignals({ ...signals, days })} />
    <SignalControl label="Tarefas pendentes" value={signals.pending} max={10} onChange={(pending) => setSignals({ ...signals, pending })} />
    <SignalControl label="Revisões solicitadas" value={signals.revisions} max={5} onChange={(revisions) => setSignals({ ...signals, revisions })} />
    <Action soft label="Testar cenário organizado" onPress={() => setSignals({ days: 12, pending: 1, revisions: 0 })} /><Action plain label="Testar cenário de atenção" onPress={() => setSignals({ days: 1, pending: 9, revisions: 4 })} />
  </Card>
    <Card><Txt kind="section">Como o modelo chegou aqui</Txt><Txt>O algoritmo compara prazo, pendências e revisões com 72 exemplos de treino. Os cinco vizinhos mais próximos votam no resultado.</Txt><Txt>Teste separado: {trained.correct} acertos em {trained.heldOut.length} exemplos fictícios ({Math.round(trained.accuracy * 100)}%).</Txt><Txt kind="small" color={colors.muted}>Essa métrica mede apenas o conjunto sintético. Não comprova desempenho com dados da agência.</Txt><Action plain label={details ? 'Ocultar vizinhos do modelo' : 'Ver vizinhos do modelo'} onPress={() => setDetails(!details)} />{details && prediction.neighbors.map((sample) => <View key={sample.id} style={{ gap: 4 }}><Txt kind="strong">Exemplo #{sample.id} · {sample.late ? 'Atrasou' : 'Em dia'}</Txt><Txt kind="small" color={colors.muted}>{sample.days} dias · {sample.pending}/10 pendências · {sample.revisions} revisões · distância {sample.distance.toFixed(3)}</Txt></View>)}</Card></>;
}

function NotificationsPanel() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const sending = useRef(false);
  async function send() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await sendPresentationNotification();
      setNotice(result === 'sent' ? 'Notificação enviada ao navegador.' : result === 'denied' ? 'Permissão não concedida. Você pode liberar notificações nas configurações deste site.' : 'Este navegador não oferece notificações compatíveis nesta página. Experimente Chrome ou Edge no computador.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível enviar. Tente novamente.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <><Heading title="Os avisos chegam até você" subtitle="Notificações web de demonstração" /><Card><View style={ui.row}><Bell size={24} color={colors.indigo} /><Txt kind="section">Aprovação pendente</Txt></View><Txt>Um conteúdo de exemplo está pronto para revisão. Envie este aviso para a central de notificações do seu navegador.</Txt><Action label="Enviar notificação de teste" busy={busy} onPress={() => void send()} /><Txt kind="small" color={colors.muted}>A permissão só será solicitada após o clique. O sistema e o navegador podem limitar a exibição.</Txt></Card>{notice && <Info title={notice} />}{error && <ErrorText text={error} />}<Info title="Envio local para a apresentação" text="O aviso é disparado por este botão. Push remoto com a aplicação fechada fica para a integração de produção." /></>;
}

export default function PresentationApp() {
  const [fonts, fontError] = useFonts({ Sora, Inter, InterSemi });
  const [tab, setTab] = useState('ml');
  const [billing, dispatch] = useReducer(billingReducer, initialBilling);
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}><StatusBar style="dark" />{!fonts && !fontError ? <ActivityIndicator accessibilityLabel="Carregando apresentação" /> : <ScrollView contentContainerStyle={{ padding: 20, gap: 20, width: '100%', maxWidth: 760, alignSelf: 'center', paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
    <View style={[ui.row, { justifyContent: 'space-between' }]}><View style={ui.row}><Image source={owl} style={{ width: 36, height: 36 }} /><Txt kind="section">Ageniza</Txt></View><Txt kind="micro" color={colors.muted}>APRESENTAÇÃO ACADÊMICA</Txt></View>
    <Info title="Ambiente demonstrativo" text="O ML usa dados fictícios e a cobrança é simulada. Nenhum pagamento ou dado da agência será alterado." />
    <Tabs value={tab} options={[{ id: 'ml', label: 'Machine learning' }, { id: 'notifications', label: 'Avisos web' }, { id: 'billing', label: 'Planos' }]} onChange={setTab} />
    <ScreenMotion identity={tab}><View style={{ gap: 16 }}>{tab === 'ml' ? <LearningPanel /> : tab === 'notifications' ? <NotificationsPanel /> : <BillingPanel state={billing} dispatch={dispatch} />}</View></ScreenMotion>
    <Action plain label="Abrir o app com dados reais" onPress={() => void Linking.openURL('https://dev.ageniza.com.br/app-mobile/')} /><Txt kind="micro" color={colors.muted} center>Os cenários desta apresentação reiniciam ao recarregar a página.</Txt>
  </ScrollView>}</SafeAreaView></SafeAreaProvider>;
}
