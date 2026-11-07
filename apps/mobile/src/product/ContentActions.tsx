import { Disclosure } from './Disclosure';
import { ScreenMotion } from './motion';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ContentDaySchema, ContentReasonSchema } from '@ageniza/contracts';
import { Action, Field, Info } from './ui';
import { EditorDateTime } from './EditorDateTime';
import type { Data, Move, Post } from './types';

export function ContentActions({ post, data, busy, onMove }: { post: Post; data: Data; busy: boolean; onMove(action: Move, comment?: string, date?: string): Promise<void> }) {
  const [mode, setMode] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(post.date);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { setMode(''); setReason(''); setDate(post.date); setAttempted(false); }, [post.id]);
  const can = (key: string) => !data.readOnly && (data.permissions.includes('*') || data.permissions.includes(key));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dateError = !ContentDaySchema.safeParse(date).success ? 'Escolha uma data válida para continuar.' : mode === 'publish' && post.status === 'approved' && date > today ? 'A data real da publicação não pode ser futura.' : undefined;
  const reasonError = ContentReasonSchema.safeParse(reason).success ? undefined : 'Informe quem aprovou e por qual canal. Reduza o texto se estiver muito longo.';
  const allowedMode = mode === 'cancel' ? !['published', 'cancelled'].includes(post.status) && can('conteudo.cancelar') : mode === 'publish' ? post.status === 'approved' && can('conteudo.publicar') : mode === 'approveByAgency' && post.status === 'awaiting_approval' && can('conteudo.aprovar_pela_agencia');
  function open(next: string) { setMode(next); setAttempted(false); setReason(''); setDate(post.date); }
  function confirm(action: Move) {
    setAttempted(true);
    if (busy || (action === 'reschedule' ? post.status !== 'cancelled' || !can('conteudo.operar') : !allowedMode)) return;
    if ((action === 'publish' || action === 'reschedule') && dateError || action === 'approveByAgency' && reasonError) return;
    void onMove(action, action === 'approveByAgency' ? reason : undefined, action === 'publish' || action === 'reschedule' ? date : undefined);
  }
  return <View style={{ gap: 12 }}>
    {post.status === 'awaiting_approval' && can('conteudo.aprovar_pela_agencia') && <Action soft disabled={busy} label="Registrar aprovação fora da plataforma" onPress={() => open('approveByAgency')} />}
    {post.status === 'approved' && can('conteudo.publicar') && <Action soft disabled={busy} label="Informar data real da publicação" onPress={() => open('publish')} />}
    {post.status === 'published' && can('conteudo.publicar') && <><Info title="Desfazer publicação" text={`O servidor permite desfazer a publicação de “${post.title}” apenas no mesmo dia da publicação.`} /><Action soft busy={busy} label="Desfazer publicação de hoje" onPress={() => void onMove('unpublish')} /></>}
    {post.status === 'cancelled' && can('conteudo.operar') && <><EditorDateTime kind="date" label="Nova data proposta" error={attempted ? dateError : undefined} value={date} onChange={setDate} /><Action label="Reagendar e voltar à produção" busy={busy} onPress={() => confirm('reschedule')} /></>}
    {!['published', 'cancelled'].includes(post.status) && can('conteudo.cancelar') && <Action plain disabled={busy} label="Cancelar conteúdo" onPress={() => open('cancel')} />}
    <Disclosure open={!!mode && !!allowedMode}><ScreenMotion identity={mode} variant="step"><View style={{ gap: 12 }}>
      <Info warning={mode === 'cancel'} title={mode === 'cancel' ? `Cancelar “${post.title}”?` : mode === 'publish' ? 'Quando a publicação aconteceu?' : 'Aprovação recebida por outro canal'} text={mode === 'cancel' ? 'O conteúdo e o histórico serão preservados. Ele poderá ser reagendado depois.' : mode === 'publish' ? 'Informe a data real. Datas futuras não são permitidas.' : 'Registre quem aprovou e por qual canal. A aprovação fica vinculada à versão que você está lendo.'} />
      {mode === 'approveByAgency' && <Field label="Motivo e origem da aprovação" error={attempted ? reasonError : undefined} value={reason} multiline onChangeText={setReason} />}
      {mode === 'publish' && <EditorDateTime kind="date" label="Data real da publicação" error={attempted ? dateError : undefined} value={date} onChange={setDate} />}
      <Action label={mode === 'cancel' ? 'Confirmar cancelamento' : mode === 'publish' ? 'Registrar publicação' : 'Confirmar aprovação registrada'} busy={busy} onPress={() => confirm(mode as Move)} /><Action plain disabled={busy} label="Voltar sem alterar" onPress={() => { setMode(''); setAttempted(false); }} />
    </View></ScreenMotion></Disclosure>
  </View>;
}
