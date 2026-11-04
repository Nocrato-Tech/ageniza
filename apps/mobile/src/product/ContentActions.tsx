import { useState } from 'react';
import { View } from 'react-native';
import { Action, Field, Info } from './ui';
import type { Data, Move, Post } from './types';

export function ContentActions({ post, data, busy, onMove }: { post: Post; data: Data; busy: boolean; onMove(action: Move, comment?: string, date?: string): Promise<void> }) {
  const [mode, setMode] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(post.date);
  const can = (key: string) => !data.readOnly && (data.permissions.includes('*') || data.permissions.includes(key));
  return <View style={{ gap: 12 }}>
    {post.status === 'awaiting_approval' && can('conteudo.aprovar_pela_agencia') && <Action soft label="Registrar aprovação fora da plataforma" onPress={() => { setMode('approveByAgency'); setReason(''); }} />}
    {post.status === 'approved' && can('conteudo.publicar') && <Action soft label="Informar data real da publicação" onPress={() => setMode('publish')} />}
    {post.status === 'published' && can('conteudo.publicar') && <><Info title="Desfazer publicação" text="O servidor permite desfazer apenas no mesmo dia da publicação." /><Action soft busy={busy} label="Desfazer publicação de hoje" onPress={() => void onMove('unpublish')} /></>}
    {post.status === 'cancelled' && can('conteudo.operar') && <><Field label="Nova data proposta (AAAA-MM-DD)" value={date} onChangeText={setDate} /><Action label="Reagendar e voltar à produção" busy={busy} onPress={() => void onMove('reschedule', undefined, date)} /></>}
    {!['published', 'cancelled'].includes(post.status) && can('conteudo.cancelar') && <Action plain label="Cancelar conteúdo" onPress={() => setMode('cancel')} />}
    {mode && <>
      <Info warning={mode === 'cancel'} title={mode === 'cancel' ? 'Cancelar este conteúdo?' : mode === 'publish' ? 'Quando a publicação aconteceu?' : 'Aprovação recebida por outro canal'} text={mode === 'cancel' ? 'O conteúdo e o histórico serão preservados. Ele poderá ser reagendado depois.' : mode === 'publish' ? 'Informe a data real. Datas futuras não são permitidas.' : 'Registre quem aprovou e por qual canal. A aprovação fica vinculada à versão que você está lendo.'} />
      {mode === 'approveByAgency' && <Field label="Motivo e origem da aprovação" value={reason} multiline onChangeText={setReason} />}
      {mode === 'publish' && <Field label="Data real (AAAA-MM-DD)" value={date} onChangeText={setDate} />}
      <Action label={mode === 'cancel' ? 'Confirmar cancelamento' : mode === 'publish' ? 'Registrar publicação' : 'Confirmar aprovação registrada'} busy={busy} disabled={mode === 'approveByAgency' && !reason.trim()} onPress={() => void onMove(mode as Move, mode === 'approveByAgency' ? reason : undefined, mode === 'publish' ? date : undefined)} /><Action plain label="Voltar sem alterar" onPress={() => setMode('')} />
    </>}
  </View>;
}
