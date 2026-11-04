import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { CommentBodySchema } from '@ageniza/contracts';
import type { CommentListResponse, ConversationSubject, ThreadListResponse } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Field, Info, Txt, colors } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';

export function Conversations({ root, subject, canWrite, canResolve }: { root: string; subject: ConversationSubject; canWrite: boolean; canResolve: boolean }) {
  const query = 'sectionKey' in subject ? `sectionKey=${subject.sectionKey}` : 'personaId' in subject ? `personaId=${subject.personaId}` : `contentId=${subject.contentId}`;
  const [page, setPage] = useState(1);
  const [threadId, setThreadId] = useState('');
  const [body, setBody] = useState('');
  const load = useCallback(async (signal: AbortSignal) => {
    const threads = await api.request<ThreadListResponse>(`${root}/threads?${query}&page=${page}&pageSize=20`, { signal });
    const comments = threadId ? await api.request<CommentListResponse>(`${root}/threads/${threadId}/comments?page=${page}&pageSize=20`, { signal }) : undefined;
    return { threads, comments };
  }, [root, query, page, threadId]);
  const { data, error, notice, busy, run } = useRemoteResource(load);
  return <View style={{ gap: 12 }}>{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}
    {threadId ? <>{data?.comments?.data.map((comment) => <View key={comment.id} style={{ gap: 4 }}><Txt kind="label">{comment.author?.name ?? 'Agência'} · {comment.side === 'client' ? 'Cliente' : 'Agência'}</Txt><Txt>{comment.body}</Txt><Txt kind="micro" color={colors.muted}>{new Date(comment.createdAt).toLocaleString('pt-BR')}</Txt></View>)}<Action plain label="Voltar às conversas" onPress={() => { setThreadId(''); setPage(1); }} /></> : data?.threads.data.map((thread) => <Card key={thread.id}><Txt kind="label">{thread.state === 'resolved' ? 'Resolvida' : 'Em aberto'} · {thread.commentCount} comentário(s)</Txt><Txt>{thread.lastComment.excerpt}</Txt><Action soft label="Ler conversa" onPress={() => { setThreadId(thread.id); setPage(1); }} />{canResolve && thread.state !== 'resolved' && <Action plain label="Resolver conversa" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/threads/${thread.id}/resolve`, { method: 'POST' }); }, 'Conversa resolvida.')} />}</Card>)}
    {canWrite && <><Field label={threadId ? 'Responder conversa' : 'Abrir conversa'} multiline value={body} onChangeText={setBody} style={{ minHeight: 90 }} /><Action soft label="Enviar mensagem" busy={busy} disabled={!body.trim()} onPress={() => void run(async () => { const parsed = CommentBodySchema.safeParse(body); if (!parsed.success) throw new Error('Escreva uma mensagem válida com até 5.000 bytes.'); await api.request(`${root}/threads${threadId ? `/${threadId}/comments` : ''}`, { method: 'POST', body: threadId ? { body: parsed.data } : { subject, body: parsed.data } }); setBody(''); }, 'Mensagem enviada.')} /></>}
    <Action plain label="Comentários anteriores" disabled={page <= 1 || busy} onPress={() => setPage(page - 1)} /><Action plain label="Mais comentários ou conversas" disabled={!data || page >= (threadId ? data.comments?.meta.totalPages ?? 1 : data.threads.meta.totalPages) || busy} onPress={() => setPage(page + 1)} />
  </View>;
}
