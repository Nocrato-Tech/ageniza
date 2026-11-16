import { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { Context } from '@ageniza/contracts';
import { Action, Card, Info, Tabs, Txt, colors } from '../product/ui';
import { Disclosure } from '../product/Disclosure';
import { formatNames } from '../contents/period';
import type { Post } from '../product/types';
import { demoAgencyName, demoWorkspaceEnabled } from './config';
import { predictProvisionalContent, type DemoScenario } from './provisional-model';

export function canUseProvisionalPredictions(context: Context | undefined, canRead: boolean, post?: Post) {
  if (!demoWorkspaceEnabled || !canRead || context?.agencyName !== demoAgencyName) return false;
  return context.type === 'agency' || (context.clientId === post?.clientId && ['Clínica Vida · Exemplo', 'Espaço Equilíbrio · Exemplo'].includes(context.clientName));
}
export function ProvisionalPredictions({ context, post, canRead }: { context: Context; post: Post; canRead: boolean }) {
  if (!canUseProvisionalPredictions(context, canRead, post)) return null;
  if (context.type === 'client') return <ClientPrediction post={post} />;
  return <ProvisionalContent key={`${context.agencyId}:${post.id}`} post={post} />;
}
function ClientPrediction({ post }: { post: Post }) {
  const result = predictProvisionalContent({ ...post, tasks: [], revision: 1 }, 'on_track', new Date());
  return <Card><Txt kind="section">Machine Learning · demonstração</Txt><Txt kind="small">Dados fictícios para apresentação. Não é uma previsão validada.</Txt><Info title="Cenário fictício de prontidão" text={`Prontidão simulada: ${date(result.flow.estimatedReadyAt)}`} /><Txt>Alcance fictício: {count(result.social.estimatedReach)} contas em sete dias.</Txt><Txt kind="small">Este cenário não altera a aprovação ou a publicação.</Txt></Card>;
}
const scenarios: { id: DemoScenario; label: string }[] = [{ id: 'content', label: 'Conteúdo atual' }, { id: 'early', label: 'Adiantamento' }, { id: 'on_track', label: 'No prazo' }, { id: 'late', label: 'Atraso' }];
const trends = { early: 'Adiantamento estimado', on_track: 'Dentro do planejamento', late: 'Atraso estimado' };
const socialTrends = { below: 'Abaixo da referência', typical: 'Próximo da referência', above: 'Acima da referência' };
const decimal = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value);
const count = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));

function ProvisionalContent({ post }: { post: Post }) {
  const [scenario, setScenario] = useState<DemoScenario>('content');
  const [history, setHistory] = useState(false);
  const [now] = useState(() => new Date());
  const result = useMemo(() => predictProvisionalContent(post, scenario, now), [post, scenario, now]);
  const samples = result.history.samples.slice(0, 5);
  return <View style={{ gap: 16 }}>
    <Txt kind="label" color={colors.muted}>Machine Learning · demonstração com dados fictícios</Txt>
    <Tabs value={scenario} options={scenarios} onChange={(id) => { if (scenarios.some((item) => item.id === id)) setScenario(id as DemoScenario); }} />
    <View accessibilityLiveRegion="polite" style={{ gap: 16 }}>
      <Card><Txt kind="section">Inteligência do fluxo</Txt>
        {result.simulatedPlanning ? <Txt kind="small" color={colors.muted}>Planejamento simulado: sete dias à frente · {date(result.planningAt)}</Txt> : <Txt kind="small" color={colors.muted}>Planejamento do conteúdo · {date(result.planningAt)}</Txt>}
        {result.flow.applicability === 'estimated' ? <><Info title={trends[result.flow.trend]} warning={result.flow.trend === 'late'} text={`Prontidão aproximada: ${date(result.flow.estimatedReadyAt)}`} /><Txt>Duração restante estimada: {decimal(result.flow.remainingDays)} dias</Txt></> : <Info title={result.flow.applicability === 'already_ready' ? 'Prontidão já confirmada' : 'Conteúdo cancelado'} text={result.flow.applicability === 'already_ready' ? 'A revisão já foi aprovada. Escolha um cenário para experimentar outro ritmo.' : 'Escolha um cenário para explorar o fluxo sem reabrir este conteúdo.'} />}
        <Txt kind="small">Fluxo global: produção da agência e decisão do cliente.</Txt>
        <Txt kind="small">Ritmos provisórios · agência: {decimal(result.assumptions.agencyPaceDays)} dias · cliente: {decimal(result.assumptions.clientPaceDays)} dias</Txt>
        <Txt kind="small">Tarefas pendentes no cenário: {result.flow.pendingTasks}</Txt>
      </Card>
      <Card><Txt kind="section">Desempenho relativo da conta</Txt><Txt kind="section">{decimal(result.social.relativeReach)}× a referência</Txt>
        <Txt>{socialTrends[result.social.trend]}</Txt>
        <Txt kind="small">Alcance provisório estimado: {count(result.social.estimatedReach)} contas</Txt>
        <Txt kind="small">Referência provisória: {count(result.social.referenceReach)} contas · mesma conta fictícia e formato</Txt>
        <Txt kind="small">Janela: {result.social.windowDays} dias · {formatNames[result.social.format]}</Txt>
      </Card>
    </View>
    <Txt kind="small" color={colors.muted}>Cenários locais: não alteram conteúdo, datas, aprovação ou publicação. Análise de {date(result.asOf)}.</Txt>
    <Action plain label={history ? 'Ocultar histórico provisório' : 'Ver histórico provisório'} onPress={() => setHistory((value) => !value)} />
    <Disclosure open={history}><View style={{ gap: 12 }}><Txt kind="strong">Histórico provisório</Txt><Txt kind="small">Treino: {result.history.trainingCount} exemplos · Teste: {result.history.testCount} exemplos</Txt><Txt kind="small" color={colors.muted}>Amostra de {samples.length} registros sintéticos usados na demonstração.</Txt>{samples.map((sample) => <View key={sample.id} style={{ gap: 4, borderBottomWidth: 1, borderColor: colors.border, paddingBottom: 12 }}><Txt kind="label">Exemplo {sample.id}</Txt><Txt kind="small">{sample.pendingTasks} tarefas pendentes · agência {decimal(sample.agencyDays)} dias · cliente {decimal(sample.clientDays)} dias</Txt><Txt kind="small">Prontidão em {decimal(sample.remainingDays)} dias · alcance {decimal(sample.relativeReach)}× a referência</Txt></View>)}</View></Disclosure>
  </View>;
}

