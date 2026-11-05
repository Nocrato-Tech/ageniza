import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Action, Card, Info, Txt } from '../product/ui';
import type { Post } from '../product/types';
import { flowModel } from './model';

export function contentSignals(post: Post, today: string) {
  const delta = Math.round((Date.parse(`${post.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  return { days: Math.max(0, Math.min(14, delta)), pending: Math.min(10, post.tasks.filter((task) => task.status !== 'approved').length), revisions: Math.min(5, Math.max(0, post.revision - 1)) };
}

export function ContentLearning({ post }: { post: Post }) {
  const trained = useMemo(flowModel, []);
  const [details, setDetails] = useState(false);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-');
  const signals = contentSignals(post, today);
  const result = trained.model.predict(signals);
  return <Card><Txt kind="section">Inteligência do fluxo</Txt><Info warning={result.late} title={result.late ? 'Risco elevado de atraso' : 'Risco reduzido de atraso'} text={`${result.lateVotes} de 5 históricos semelhantes indicam atraso.`} /><Txt>Previsão calculada com o prazo, as tarefas pendentes e a versão deste conteúdo. Atualize a produção para acompanhar a classificação.</Txt><Txt kind="small">Modelo k-NN treinado com dados sintéticos para demonstração. Não representa uma previsão validada para sua agência.</Txt><Action plain label={details ? 'Ocultar análise do conteúdo' : 'Entender análise do conteúdo'} onPress={() => setDetails(!details)} />{details && <View style={{ gap: 8 }}><Txt>{signals.days} dias até a publicação (limite 14) · {signals.pending} tarefas pendentes (limite 10) · {signals.revisions} revisões (limite 5).</Txt><Txt>72 exemplos de treino e 24 separados para teste: {trained.correct} acertos. Avaliação apenas sintética.</Txt>{result.neighbors.map((sample) => <Txt key={sample.id} kind="small">Exemplo {sample.id}: {sample.late ? 'atraso' : 'em dia'} · distância {sample.distance.toFixed(3)}</Txt>)}</View>}</Card>;
}
