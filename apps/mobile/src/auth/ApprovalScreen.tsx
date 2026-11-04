import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';
import { fetch as nativeFetch } from 'expo/fetch';
import { PortalApprovalApproveRequestSchema, PortalApprovalRequestChangesRequestSchema } from '@ageniza/contracts';
import type { PortalApprovalBatch, PortalApprovalContent } from '@ageniza/contracts';
import { createApprovalClient } from '../api/approval';
import { ApiError } from '../api/client';
import { webUrl } from '../api/runtime';
import { Action, Card, ErrorText, Field, Heading, Info, InstagramPreview, Status, Txt, colors, ui } from '../product/ui';
import type { Post } from '../product/types';

export function ApprovalScreen({ token, onClose }: { token: string; onClose(): void }) {
  const client = useMemo(() => createApprovalClient(process.env.EXPO_PUBLIC_API_URL ?? `${webUrl}/api`, Platform.OS !== 'web', Platform.OS === 'web' ? fetch : nativeFetch as typeof fetch), []);
  const [batch, setBatch] = useState<PortalApprovalBatch>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [comment, setComment] = useState('');
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const exchanged = useRef(false);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void (async () => {
      if (!exchanged.current) { await client.request('/portal-approval/session', { method: 'POST', body: { token } }); exchanged.current = true; }
      const result = await client.request<PortalApprovalBatch>('/portal-approval/batch');
      if (alive) setBatch(result);
    })().catch((cause: unknown) => { if (alive) { if (cause instanceof ApiError && cause.status === 404) { setBatch(undefined); exchanged.current = false; setError('Este link não está disponível. Peça um novo à agência.'); } else setError('Não foi possível carregar o lote. Confira a conexão e tente novamente.'); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, token, retry]);
  useEffect(() => () => { void client.clear(); }, [client]);
  async function decide(content: PortalApprovalContent, changes: boolean) {
    if (pending.current || !content.canDecide || !('revision' in content)) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const parsed = changes ? PortalApprovalRequestChangesRequestSchema.safeParse({ revision: content.revision, comment }) : PortalApprovalApproveRequestSchema.safeParse({ revision: content.revision });
      if (!parsed.success) throw new Error('Descreva o ajuste com um comentário válido antes de enviar.');
      const updated = await client.request<PortalApprovalContent>(`/portal-approval/contents/${content.id}/${changes ? 'request-changes' : 'approve'}`, { method: 'POST', body: parsed.data });
      setBatch((current) => current ? { ...current, contents: current.contents.map((item) => item.id === content.id ? updated : item) } : current);
      setSelected(''); setComment(''); setNotice(changes ? 'Pedido de ajuste enviado à agência.' : 'Aprovação registrada.');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) { setBatch(undefined); exchanged.current = false; setError('Este link não está disponível. Peça um novo à agência.'); }
      else if (cause instanceof ApiError && cause.status === 409) { setError('Este conteúdo mudou ou já foi revisado. Atualize o lote antes de decidir.'); setBatch(undefined); }
      else setError(cause instanceof Error ? cause.message : 'Não foi possível registrar sua decisão.');
    } finally { pending.current = false; setBusy(false); }
  }
  const media = useMemo(() => ({ assetUrl: async (_clientId: string, postId: string | undefined, assetId: string, variant: 'original' | 'thumbnail' = 'original') => (await client.request<{ url: string }>(`/portal-approval/contents/${postId}/media/${assetId}/url?variant=${variant}`)).url }), [client]);
  return <ScrollView contentContainerStyle={ui.body} keyboardShouldPersistTaps="handled"><Heading title={batch?.clientName ?? 'Conteúdos para aprovar'} subtitle={batch ? `Enviado por ${batch.agencyName}` : 'Revise o lote enviado pela sua agência.'} />
    {loading && <ActivityIndicator color={colors.indigo} />}{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}
    {batch?.contents.map((content) => {
      const post: Post = { id: content.id, clientId: '', title: content.title, date: content.publishOn, time: 'publishAtTime' in content ? content.publishAtTime ?? '' : '', format: content.format, status: content.status, caption: 'caption' in content ? content.caption ?? '' : '', revision: 'revision' in content ? content.revision : 0, mediaIds: 'media' in content ? content.media.map((item) => item.id) : [], mediaKinds: 'media' in content ? Object.fromEntries(content.media.map((item) => [item.id, item.kind])) : {}, folderId: '', ownerId: '', coverId: 'coverAssetId' in content ? content.coverAssetId : null, tasks: [], comments: [] };
      return <Card key={content.id}><Txt kind="section">{content.title}</Txt><Status status={content.status} client />{content.status === 'in_production' ? <Info title="Em produção" text="A agência está preparando este conteúdo." /> : <InstagramPreview post={post} client={{ id: '', name: batch.clientName, handle: '' }} assets={[]} repository={media} />}{content.canDecide && <>{selected === content.id ? <><Field label="O que precisa mudar?" value={comment} onChangeText={setComment} multiline /><Action label="Enviar pedido de ajuste" busy={busy} disabled={!comment.trim()} onPress={() => void decide(content, true)} /><Action plain label="Voltar à revisão" onPress={() => setSelected('')} /></> : <><Action label={`Aprovar ${content.title}`} busy={busy} onPress={() => void decide(content, false)} /><Action plain label={`Pedir ajuste em ${content.title}`} disabled={busy} onPress={() => { setSelected(content.id); setComment(''); }} /></>}</>}</Card>;
    })}
    {!loading && <Action soft label="Atualizar lote" disabled={busy} onPress={() => setRetry((value) => value + 1)} />}<View><Action plain label="Fechar lote" disabled={busy} onPress={() => { void client.clear().then(onClose); }} /></View>
  </ScrollView>;
}
