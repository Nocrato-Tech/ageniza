import { ScreenMotion } from './motion';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { ContentFormat } from '@ageniza/contracts';
import { Action, Card, Field, Heading, Info, InstagramPreview, Selector, Txt, ui, colors } from './ui';
import { validateInput } from './validation';
import type { Data, Post, PostInput, Repository } from './types';
import { monthPeriod } from '../contents/period';

export function ContentEditor({ data, repository, clientId, existing, busy, onSave, onError, onRefresh }: { data: Data; repository: Repository; clientId: string; existing?: Post; busy: boolean; onSave(input: PostInput, id?: string, onCreated?: (id: string) => void): Promise<void>; onError(message: string): void; onRefresh(): Promise<void> }) {
  const [step, setStep] = useState(0);
  const [createdId, setCreatedId] = useState<string>();
  const [input, setInput] = useState<PostInput>(() => existing ? { ...existing } : { clientId: clientId || data.clients[0]?.id || '', title: '', caption: '', format: 'reels', date: monthPeriod().from, time: '18:00', ownerId: data.people[0]?.id ?? '', folderId: data.folders.find((folder) => folder.clientId === (clientId || data.clients[0]?.id))?.id ?? '', mediaIds: [], coverId: null });
  const update = <K extends keyof PostInput>(key: K, value: PostInput[K]) => setInput((current) => ({ ...current, [key]: value }));
  const client = data.clients.find((item) => item.id === input.clientId);
  const [library, setLibrary] = useState({ folders: data.folders, assets: data.assets });
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryRetry, setLibraryRetry] = useState(0);
  useEffect(() => { if (!input.clientId) return; let active = true; setLibraryLoading(true); void repository.library(input.clientId).then((value) => { if (active) { setLibrary(value); setInput((current) => current.folderId ? current : { ...current, folderId: value.folders[0]?.id ?? '' }); } }).catch((cause: unknown) => { if (active) onError(cause instanceof Error ? cause.message : 'Não foi possível abrir a biblioteca.'); }).finally(() => { if (active) setLibraryLoading(false); }); return () => { active = false; }; }, [input.clientId, repository, libraryRetry]);
  const folderAssets = library.assets.filter((asset) => asset.clientId === input.clientId && asset.folderId === input.folderId);
  const preview: Post = { ...input, id: existing?.id ?? 'preview', status: existing?.status ?? 'in_production', revision: existing?.revision ?? 1, tasks: existing?.tasks ?? [], comments: existing?.comments ?? [] };
  const [picking, setPicking] = useState(false);
  async function upload() { setPicking(true); try { const picked = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'video/*'], copyToCacheDirectory: true }); if (picked.canceled) return; const file = picked.assets[0]; const asset = await repository.upload(input.clientId, input.folderId, { uri: file.uri, name: file.name, mimeType: file.mimeType ?? 'application/octet-stream', size: file.size ?? 0, file: file.file }); update('mediaIds', [...input.mediaIds, asset.id]); if (!input.coverId && asset.kind === 'image') update('coverId', asset.id); setLibrary(await repository.library(input.clientId)); await onRefresh(); } catch (error) { onError(error instanceof Error ? error.message : 'Não foi possível enviar a mídia.'); } finally { setPicking(false); } }
  function next() { try { validateInput(input); onError(''); setStep(step + 1); } catch { onError('Confira o cliente, título, pasta e a data (AAAA-MM-DD) antes de continuar.'); } }
  return <>
    <ScreenMotion identity={String(step)} fill><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={ui.body}>
      <View style={{ flexDirection: 'row', gap: 8 }}>{['Formato', 'Conteúdo', 'Revisão'].map((label, index) => <View key={label} style={{ flex: 1, gap: 6 }}><View style={{ height: 4, borderRadius: 4, backgroundColor: index <= step ? colors.indigo : colors.border }} /><Txt kind="micro" color={index <= step ? colors.indigo : colors.muted}>{index + 1}. {label}</Txt></View>)}</View>
      {libraryLoading && <Info title="Carregando biblioteca…" />}
      {!libraryLoading && !library.folders.some((folder) => folder.clientId === input.clientId) && <Action plain label="Recarregar biblioteca" onPress={() => setLibraryRetry((value) => value + 1)} />}
      {step === 0 && <>
        <Heading title="Dê forma à próxima ideia" subtitle="Escolha o cliente e o formato." />
        {existing || createdId ? <Info title="Cliente do conteúdo" text={client?.name} /> : <Selector label="Cliente *" value={input.clientId} options={data.clients.map((item) => ({ id: item.id, label: item.name }))} onChange={(id) => setInput((current) => ({ ...current, clientId: id, folderId: '', mediaIds: [], coverId: null }))} />}
        <Field label="Título interno *" placeholder="Como vamos chamar este conteúdo?" value={input.title} onChangeText={(value) => update('title', value)} maxLength={120} />
        <Txt kind="small" color={colors.muted}>Esse título organiza o trabalho da agência.</Txt>
        <Selector label="Formato da publicação" options={[{ id: 'image', label: 'Post com imagem' }, { id: 'carousel', label: 'Carrossel' }, { id: 'reels', label: 'Reel' }, { id: 'long_video', label: 'Vídeo longo' }, { id: 'vsl', label: 'VSL' }]} value={input.format} onChange={(id) => update('format', id as ContentFormat)} />
        <Selector label="Responsável" value={input.ownerId} options={data.people.map((person) => ({ id: person.id, label: person.name }))} onChange={(id) => update('ownerId', id)} />
        <Selector label="Pasta das mídias *" value={input.folderId} options={library.folders.filter((folder) => folder.clientId === input.clientId).map((folder) => ({ id: folder.id, label: folder.name }))} onChange={(id) => setInput((current) => ({ ...current, folderId: id, mediaIds: [], coverId: null }))} />
        {!input.folderId && <Info title="Cadastre uma pasta primeiro" text="Abra a biblioteca de mídias deste cliente e crie uma pasta." />}
        <Info title="Sua publicação ganha vida" text="Adicione mídia, escolha a capa e confira a prévia no Instagram." />
      </>}
      {step === 1 && <>
        <Heading title="O que vamos publicar?" subtitle={`${client?.name ?? ''} · ${input.format === 'reels' ? 'Reel' : input.format === 'carousel' ? 'Carrossel' : 'Post'}`} />
        <Card><Txt kind="strong">Mídias da publicação</Txt><Txt kind="small" color={colors.muted}>Selecione na biblioteca ou envie um arquivo. A ordem da seleção define o carrossel.</Txt><View style={{ gap: 8 }}>{folderAssets.map((asset) => <Action key={asset.id} soft={!input.mediaIds.includes(asset.id)} label={`${input.mediaIds.includes(asset.id) ? `${input.mediaIds.indexOf(asset.id) + 1}. ` : ''}${asset.name}`} onPress={() => { update('mediaIds', input.mediaIds.includes(asset.id) ? input.mediaIds.filter((id) => id !== asset.id) : [...input.mediaIds, asset.id]); }} />)}</View><Action label="Enviar imagem ou vídeo" soft busy={picking} onPress={() => void upload()} /></Card>
        <Selector label="Capa da publicação" value={input.coverId ?? ''} options={[{ id: '', label: 'Primeira mídia' }, ...folderAssets.filter((asset) => asset.kind === 'image' || asset.sample).map((asset) => ({ id: asset.id, label: asset.name }))]} onChange={(id) => update('coverId', id || null)} />
        <Field label="Legenda da publicação" placeholder="O que sua marca vai dizer?" value={input.caption} onChangeText={(value) => update('caption', value)} multiline maxLength={2200} style={{ minHeight: 160, textAlignVertical: 'top' }} /><Txt kind="micro" color={colors.muted}>{input.caption.length} / 2.200 caracteres</Txt>
        <Field label="Data proposta (AAAA-MM-DD) *" value={input.date} onChangeText={(value) => update('date', value)} placeholder="2026-11-24" />
        <Field label="Horário (HH:MM)" value={input.time} onChangeText={(value) => update('time', value)} placeholder="18:00" />
        <Info title="Tudo pronto para conferir" text="Você poderá salvar em produção e enviar para aprovação depois de concluir as tarefas." />
      </>}
      {createdId && <Info title="Conteúdo já criado" text="Se o envio das mídias ou a atualização falhar, salve novamente para completar este mesmo conteúdo." />}
      {step === 2 && <><Heading title="Prévia no Instagram" subtitle="Confira a mídia, a legenda e a data." />{client && <InstagramPreview post={preview} client={client} assets={library.assets} repository={repository} />}<Info title="A aprovação vem antes da publicação" text="Salvar mantém o conteúdo em produção. O envio para aprovação fica no detalhe do conteúdo." /></>}
    </ScrollView></ScreenMotion>
    <View style={{ padding: 20, gap: 4, backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border }}><Action label={step < 2 ? step === 0 ? 'Continuar para conteúdo' : 'Conferir prévia' : existing || createdId ? 'Salvar alterações' : 'Criar conteúdo'} busy={busy || picking || libraryLoading} onPress={() => step < 2 ? next() : void onSave(input, existing?.id ?? createdId, setCreatedId)} />{step > 0 && <Action plain label="Voltar uma etapa" onPress={() => setStep(step - 1)} />}</View>
  </>;
}
