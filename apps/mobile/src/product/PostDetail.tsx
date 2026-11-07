import { ScreenMotion } from './motion';
import { Disclosure } from './Disclosure';
import { FlowList } from './FlowList';
import { ContentLearning } from '../demo/ContentLearning';
import { demoWorkspaceEnabled } from '../demo/config';
import { ContentTasks } from './ContentTasks';
import { ContentActions } from './ContentActions';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { MessageCircle } from './icons';
import { Action, Avatar, Card, Field, Heading, Info, InstagramPreview, Status, Tabs, Txt, ui, colors } from './ui';
import type { Data, Move, Post, Repository, Side } from './types';
import { displayDay, formatNames } from '../contents/period';

export function PostDetail({ post, data, side, repository, busy, onMove, onUpdate, onEdit, onError }: { post: Post; data: Data; side: Side; repository: Repository; busy: boolean; onMove(action: Move, comment?: string, date?: string): Promise<void>; onUpdate(action: () => Promise<Post>, successMessage?: string): Promise<boolean>; onEdit(): void; onError(message: string): void }) {
  const [tab, setTab] = useState('summary');
  const [changes, setChanges] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [comment, setComment] = useState('');
  const client = data.clients.find((item) => item.id === post.clientId)!;
  const owner = data.people.find((person) => person.id === post.ownerId);
  const can = (permission: string) => !data.readOnly && (data.permissions.includes('*') || data.permissions.includes(permission));
  const hidden = side === 'client' && post.status === 'in_production';
  const canEdit = side === 'agency' && can('conteudo.operar') && !['cancelled', 'published'].includes(post.status);
  async function sendComment() { if (!comment.trim()) { onError('Escreva o comentário antes de enviar.'); return; } if (await onUpdate(() => repository.comment(post, comment), 'Comentário enviado nesta publicação.')) setComment(''); }
  return <>
    <ScreenMotion identity={`${tab}:${changes}:${withdrawing}`} variant="peer" fill><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={ui.body}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}><Status status={post.status} client={side === 'client'} /><Txt kind="small" color={colors.muted}>Versão {post.revision || 1}</Txt></View>
      <Heading title={changes ? 'Vamos ajustar juntos' : post.title} subtitle={changes ? `${post.title} · versão ${post.revision}` : `${client.name} · ${formatNames[post.format]} · ${displayDay(post.date)} ${post.time}`} />
      {hidden ? <Info title="Conteúdo em produção" text="A agência está preparando este conteúdo. A legenda e as mídias estarão disponíveis quando ele for enviado para aprovação." /> : changes ? <><Field label="O que precisa mudar? *" value={comment} onChangeText={setComment} placeholder="Descreva o que a agência precisa ajustar." multiline maxLength={4000} style={{ minHeight: 160, textAlignVertical: 'top' }} /><Info title="A agência recebe seu comentário" text="O pedido fica vinculado à versão que você está revisando." /></> : <>
        {side === 'agency' && <Tabs value={tab} options={[{ id: 'summary', label: 'Conteúdo' }, { id: 'preview', label: 'Instagram' }, { id: 'conversation', label: 'Conversa' }]} onChange={setTab} />}
        {(tab === 'preview' || side === 'client') && <InstagramPreview key={post.id} post={post} client={client} assets={data.assets} repository={repository} />}
        {side === 'agency' && tab === 'summary' && <>
          <Card><Txt kind="strong">Publicação</Txt><Txt>{post.caption || 'Nenhuma legenda adicionada.'}</Txt><Txt kind="small" color={colors.muted}>{post.mediaIds.length} mídia(s) vinculada(s)</Txt><Action soft label="Prévia do Instagram" onPress={() => setTab('preview')} /></Card>
          <Card><View style={ui.row}><Avatar name={owner?.name ?? data.profile.name} size={32} accent /><View><Txt kind="strong">{owner?.name ?? data.profile.name}</Txt><Txt kind="small" color={colors.muted}>Responsável pela produção</Txt></View></View><View style={ui.line} /><Txt kind="small" color={colors.muted}>Publicação proposta · {displayDay(post.date)} · {post.time || 'Sem horário'}</Txt></Card>
          {demoWorkspaceEnabled && !['published', 'cancelled'].includes(post.status) && <ContentLearning post={post} />}
          <ContentTasks post={post} data={data} repository={repository} busy={busy} onUpdate={onUpdate} />
          <ContentActions post={post} data={data} busy={busy} onMove={onMove} />
          {canEdit && <Action soft label="Editar conteúdo" onPress={onEdit} />}
        </>}
        {(tab === 'conversation' || side === 'client' || post.status === 'adjusting') && <Card><View style={ui.row}><MessageCircle size={20} color={colors.indigo} /><Txt kind="strong">Conversa sobre o conteúdo</Txt></View>{post.comments.length === 0 ? <Txt kind="small" color={colors.muted}>Nenhum comentário nesta publicação.</Txt> : <FlowList items={post.comments} renderItem={(item) => <View key={item.id} style={{ gap: 4, borderBottomWidth: 1, borderColor: colors.border, paddingBottom: 12 }}><Txt kind="label">{item.name} · {item.side === 'client' ? 'Cliente' : 'Agência'}</Txt><Txt>{item.body}</Txt></View>} />}{!data.readOnly && <><Field label="Seu comentário" multiline value={comment} onChangeText={setComment} style={{ minHeight: 90 }} /><Action soft busy={busy} label="Enviar comentário" disabled={!comment.trim()} onPress={() => void sendComment()} /></>}</Card>}
        {side === 'agency' && post.status === 'awaiting_approval' && <Info title="Aguardando o cliente" text="A pessoa com acesso ao portal poderá aprovar ou pedir ajustes nesta versão." />}
      </>}
    </ScrollView></ScreenMotion>
    {!hidden && <View style={{ padding: 20, gap: 8, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      {side === 'agency' && can('conteudo.operar') && ['in_production', 'adjusting'].includes(post.status) && <Action label="Enviar para aprovação" busy={busy} onPress={() => void onMove('submit')} />}
      {side === 'agency' && can('conteudo.publicar') && post.status === 'approved' && <Action label="Marcar como publicado" busy={busy} onPress={() => void onMove('publish')} />}
      {side === 'client' && !data.readOnly && post.status === 'awaiting_approval' && (changes ? <><Action label="Enviar solicitação de ajuste" busy={busy} onPress={() => { if (!comment.trim()) { onError('Descreva o ajuste antes de enviar.'); return; } void onMove('changes', comment); }} /><Action plain label="Cancelar solicitação" onPress={() => setChanges(false)} /></> : <><Action label="Aprovar publicação" busy={busy} onPress={() => void onMove('approve')} /><Action plain label="Solicitar ajustes" onPress={() => { setChanges(true); setComment(''); }} /></>)}
      {side === 'client' && post.status === 'approved' && <><Info title="Conteúdo aprovado" text="A agência já pode seguir com a publicação." />{!data.readOnly && <><Disclosure open={withdrawing}>{withdrawing && <><Info warning title="Desfazer esta aprovação?" text="O conteúdo voltará para aguardando aprovação. A legenda e as mídias serão mantidas." /><Action label="Confirmar retirada da aprovação" busy={busy} onPress={() => void onMove('withdraw-approval')} /><Action plain label="Manter aprovado" disabled={busy} onPress={() => setWithdrawing(false)} /></>}</Disclosure>{!withdrawing && <Action plain label="Desfazer aprovação" disabled={busy} onPress={() => setWithdrawing(true)} />}</>}</>}
      {side === 'client' && post.status === 'adjusting' && <Info title="Ajustes enviados" text="A agência recebeu seu pedido. Uma nova versão será enviada para revisão." />}
    </View>}
  </>;
}
