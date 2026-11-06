import { ScreenMotion } from './motion';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { ContentFormat } from '@ageniza/contracts';
import { Action, Card, Field, Heading, Info, InstagramPreview, ErrorText, Selector, Txt, ui, colors } from './ui';
import { editorErrors, type EditorDraft } from './editor-state';
import { EditorMedia } from './EditorMedia';
import { EditorDateTime } from './EditorDateTime';
import { useUploadTransfer } from './useUploadTransfer';
import { UploadStatus } from './UploadStatus';
export type { EditorDraft } from './editor-state';
import type { Data, Post, PostInput, Repository } from './types';
import { monthPeriod } from '../contents/period';

export function ContentEditor({ data, repository, clientId, existing, busy, onSave, onError, onRefresh, initialDraft, onDraftChange, onDirtyChange, onWorkingChange }: { onWorkingChange?(working: boolean): void; initialDraft?: EditorDraft; onDraftChange?(draft: EditorDraft | undefined): void; onDirtyChange?(dirty: boolean): void; data: Data; repository: Repository; clientId: string; existing?: Post; busy: boolean; onSave(input: PostInput, id?: string, onCreated?: (id: string) => void): Promise<void>; onError(message: string): void; onRefresh(): Promise<void> }) {
  const acceptedDraft = initialDraft && data.clients.some((client) => client.id === initialDraft.input.clientId) && (!existing || initialDraft.input.clientId === existing.clientId && initialDraft.revision === existing.revision) ? initialDraft : undefined;
  const [step, setStep] = useState(0);
  const [createdId, setCreatedId] = useState<string | undefined>(acceptedDraft?.createdId);
  const [input, setInput] = useState<PostInput>(() => acceptedDraft ? { ...acceptedDraft.input, mediaIds: [...acceptedDraft.input.mediaIds] } : existing ? { clientId: existing.clientId, title: existing.title, caption: existing.caption, format: existing.format, date: existing.date, time: existing.time, ownerId: existing.ownerId, folderId: existing.folderId, mediaIds: [...existing.mediaIds], coverId: existing.coverId } : { clientId: clientId || data.clients[0]?.id || '', title: '', caption: '', format: 'reels', date: monthPeriod().from, time: '18:00', ownerId: data.people[0]?.id ?? '', folderId: data.folders.find((folder) => folder.clientId === (clientId || data.clients[0]?.id))?.id ?? '', mediaIds: [], coverId: null });
  const restored = useRef(!!acceptedDraft);
  const currentInput = useRef(input); currentInput.current = input;
  const baseline = useRef(JSON.stringify(existing ? { clientId: existing.clientId, title: existing.title, caption: existing.caption, format: existing.format, date: existing.date, time: existing.time, ownerId: existing.ownerId, folderId: existing.folderId, mediaIds: existing.mediaIds, coverId: existing.coverId } : input));
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? editorErrors(input, step) : {};
  const draftCallback = useRef(onDraftChange); draftCallback.current = onDraftChange;
  const dirtyCallback = useRef(onDirtyChange); dirtyCallback.current = onDirtyChange;
  useEffect(() => { const dirty = JSON.stringify(input) !== baseline.current || restored.current; dirtyCallback.current?.(dirty); draftCallback.current?.(dirty ? { input, createdId, revision: existing?.revision } : undefined); }, [input, createdId, existing?.revision]);
  const update = <K extends keyof PostInput>(key: K, value: PostInput[K]) => setInput((current) => ({ ...current, [key]: value }));
  const client = data.clients.find((item) => item.id === input.clientId);
  const [library, setLibrary] = useState({ folders: data.folders, assets: data.assets });
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryRetry, setLibraryRetry] = useState(0);
  useEffect(() => { if (!input.clientId) return; let active = true; setLibraryLoading(true); void repository.library(input.clientId).then((value) => { if (active) { setLibrary(value); setInput((current) => { if (current.folderId) return current; const next = { ...current, folderId: value.folders[0]?.id ?? '' }; if (baseline.current === JSON.stringify(current)) baseline.current = JSON.stringify(next); return next; }); } }).catch((cause: unknown) => { if (active) onError(cause instanceof Error ? cause.message : 'Não foi possível abrir a biblioteca.'); }).finally(() => { if (active) setLibraryLoading(false); }); return () => { active = false; }; }, [input.clientId, repository, libraryRetry]);
  const folderAssets = library.assets.filter((asset) => asset.clientId === input.clientId && asset.folderId === input.folderId);
  const preview: Post = { ...input, id: existing?.id ?? 'preview', status: existing?.status ?? 'in_production', revision: existing?.revision ?? 1, tasks: existing?.tasks ?? [], comments: existing?.comments ?? [] };
  const [picking, setPicking] = useState(false);
  const [uploadNotice, setUploadNotice] = useState('');
  useEffect(() => { onWorkingChange?.(picking); return () => onWorkingChange?.(false); }, [picking, onWorkingChange]);
  const transfer = useUploadTransfer(repository);
  const uploadProgress = transfer.progress;
  async function upload(retry = false) {
    setPicking(true); setUploadNotice('');
    try {
      const picked = retry ? undefined : await DocumentPicker.getDocumentAsync({ type: ['image/*', 'video/*'], copyToCacheDirectory: true });
      if (picked?.canceled) return;
      const file = picked?.assets[0];
      const asset = retry ? transfer.matches(input.clientId, input.folderId) ? await transfer.retry() : undefined : file ? await transfer.transfer(input.clientId, input.folderId, { uri: file.uri, name: file.name, mimeType: file.mimeType ?? 'application/octet-stream', size: file.size ?? 0, file: file.file }) : undefined;
      if (!asset) return;
      setInput((current) => current.clientId === asset.clientId && current.folderId === asset.folderId ? { ...current, mediaIds: [...current.mediaIds, asset.id], coverId: current.coverId ?? (asset.kind === 'image' ? asset.id : null) } : current);
      if (currentInput.current.clientId !== asset.clientId || currentInput.current.folderId !== asset.folderId) setUploadNotice('O arquivo foi recebido na pasta original do envio. Como o cliente ou a pasta da publicação mudou, ele não foi anexado.');
      if (currentInput.current.clientId === asset.clientId) setLibrary((current) => ({ ...current, assets: [...current.assets.filter((item) => item.id !== asset.id), asset] }));
      try { const refreshed = await repository.library(asset.clientId); if (currentInput.current.clientId === asset.clientId) setLibrary(refreshed); await onRefresh(); }
      catch { onError('A mídia foi enviada e selecionada, mas a biblioteca não pôde ser atualizada. Não envie o mesmo arquivo novamente.'); }
    } catch (error) { onError(error instanceof Error ? error.message : 'Não foi possível enviar a mídia.'); }
    finally { setPicking(false); }
  }
  function next() { setAttempted(true); if (Object.keys(editorErrors(input, step)).length) { onError('Corrija os campos indicados para continuar.'); return; } onError(''); setAttempted(false); setStep(step + 1); }
  function removeMedia(id: string) { setInput((current) => ({ ...current, mediaIds: current.mediaIds.filter((mediaId) => mediaId !== id), coverId: current.coverId === id ? null : current.coverId })); }
  function moveMedia(id: string, offset: number) { setInput((current) => { const mediaIds = [...current.mediaIds]; const index = mediaIds.indexOf(id); const target = index + offset; if (index < 0 || target < 0 || target >= mediaIds.length) return current; [mediaIds[index], mediaIds[target]] = [mediaIds[target], mediaIds[index]]; return { ...current, mediaIds }; }); }
  return <>
    <ScreenMotion identity={String(step)} fill><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={ui.body}>
      {restored.current && <Info title="Rascunho recuperado" text="Confira as informações antes de salvar. Estas alterações ainda não foram enviadas ao servidor." />}
      <View style={{ flexDirection: 'row', gap: 8 }}>{['Formato', 'Conteúdo', 'Revisão'].map((label, index) => <View key={label} style={{ flex: 1, gap: 6 }}><View style={{ height: 4, borderRadius: 4, backgroundColor: index <= step ? colors.indigo : colors.border }} /><Txt kind="micro" color={index <= step ? colors.indigo : colors.muted}>{index + 1}. {label}</Txt></View>)}</View>
      {libraryLoading && <Info title="Carregando biblioteca…" />}
      {!!uploadNotice && <Info title="Arquivo recebido" text={uploadNotice} />}
      {!libraryLoading && !library.folders.some((folder) => folder.clientId === input.clientId) && <Action plain label="Recarregar biblioteca" onPress={() => setLibraryRetry((value) => value + 1)} />}
      {step === 0 && <>
        <Heading title="Dê forma à próxima ideia" subtitle="Escolha o cliente e o formato." />
        {existing || createdId ? <Info title="Cliente do conteúdo" text={client?.name} /> : <Selector label="Cliente *" value={input.clientId} options={data.clients.map((item) => ({ id: item.id, label: item.name }))} onChange={(id) => setInput((current) => ({ ...current, clientId: id, folderId: '', mediaIds: [], coverId: null }))} />}
        {errors.clientId && <ErrorText text={errors.clientId} />}
        <Field error={errors.title} label="Título interno *" placeholder="Como vamos chamar este conteúdo?" value={input.title} onChangeText={(value) => update('title', value)} maxLength={120} />
        <Txt kind="small" color={colors.muted}>Esse título organiza o trabalho da agência.</Txt>
        <Selector label="Formato da publicação" options={[{ id: 'image', label: 'Post com imagem' }, { id: 'carousel', label: 'Carrossel' }, { id: 'reels', label: 'Reel' }, { id: 'long_video', label: 'Vídeo longo' }, { id: 'vsl', label: 'VSL' }]} value={input.format} onChange={(id) => update('format', id as ContentFormat)} />
        <Selector label="Responsável" value={input.ownerId} options={data.people.map((person) => ({ id: person.id, label: person.name }))} onChange={(id) => update('ownerId', id)} />
        <Selector label="Pasta das mídias *" value={input.folderId} options={library.folders.filter((folder) => folder.clientId === input.clientId).map((folder) => ({ id: folder.id, label: folder.name }))} onChange={(id) => setInput((current) => ({ ...current, folderId: id, mediaIds: [], coverId: null }))} />
        {errors.folderId && <ErrorText text={errors.folderId} />}
        {!input.folderId && <Info title="Cadastre uma pasta primeiro" text="Abra a biblioteca de mídias deste cliente e crie uma pasta." />}
        <Info title="Sua publicação ganha vida" text="Adicione mídia, escolha a capa e confira a prévia no Instagram." />
      </>}
      {step === 1 && <>
        <Heading title="O que vamos publicar?" subtitle={`${client?.name ?? ''} · ${input.format === 'reels' ? 'Reel' : input.format === 'carousel' ? 'Carrossel' : 'Post'}`} />
        {input.mediaIds.map((id, index) => {
          const asset = library.assets.find((item) => item.id === id);
          return asset ? <EditorMedia key={id} asset={asset} post={preview} repository={repository} index={index} count={input.mediaIds.length} isCover={input.coverId === id || (!input.coverId && index === 0)} onMove={(offset) => moveMedia(id, offset)} onRemove={() => removeMedia(id)} /> : null;
        })}
        <Card><Txt kind="strong">Mídias da publicação</Txt><Txt kind="small" color={colors.muted}>Selecione na biblioteca ou envie um arquivo. Use Mover antes ou Mover depois para organizar o carrossel. Remover da publicação mantém o arquivo na biblioteca.</Txt><View style={{ gap: 8 }}>{folderAssets.map((asset) => <Action key={asset.id} soft={!input.mediaIds.includes(asset.id)} label={`${input.mediaIds.includes(asset.id) ? `${input.mediaIds.indexOf(asset.id) + 1}. ` : ''}${asset.name}`} onPress={() => input.mediaIds.includes(asset.id) ? removeMedia(asset.id) : update('mediaIds', [...input.mediaIds, asset.id])} />)}</View><Action label="Enviar imagem ou vídeo" soft busy={picking} onPress={() => void upload()} />{uploadProgress && <UploadStatus progress={uploadProgress} onCancel={transfer.cancel} onRetry={transfer.canRetry && transfer.matches(input.clientId, input.folderId) ? () => void upload(true) : undefined} />}</Card>
        <Selector label="Capa da publicação" value={input.coverId ?? ''} options={[{ id: '', label: 'Usar primeira mídia da publicação' }, ...folderAssets.filter((asset) => asset.kind === 'image' || asset.sample).map((asset) => ({ id: asset.id, label: asset.name }))]} onChange={(id) => update('coverId', id || null)} />
        <Field error={errors.caption} label="Legenda da publicação" placeholder="O que sua marca vai dizer?" value={input.caption} onChangeText={(value) => update('caption', value)} multiline maxLength={2200} style={{ minHeight: 160, textAlignVertical: 'top' }} /><Txt kind="micro" color={colors.muted}>{input.caption.length} / 2.200 caracteres</Txt>
        <EditorDateTime kind="date" error={errors.date} value={input.date} onChange={(value) => update('date', value)} />
        <EditorDateTime kind="time" error={errors.time} value={input.time} onChange={(value) => update('time', value)} />
        <Info title="Tudo pronto para conferir" text="Você poderá salvar em produção e enviar para aprovação depois de concluir as tarefas." />
      </>}
      {createdId && <Info title="Conteúdo já criado" text="Se o envio das mídias ou a atualização falhar, salve novamente para completar este mesmo conteúdo." />}
      {step === 2 && <><Heading title="Prévia no Instagram" subtitle="Confira a mídia, a legenda e a data." />{client && <InstagramPreview post={preview} client={client} assets={library.assets} repository={repository} />}<Info title="A aprovação vem antes da publicação" text="Salvar mantém o conteúdo em produção. O envio para aprovação fica no detalhe do conteúdo." /></>}
    </ScrollView></ScreenMotion>
    <View style={{ padding: 20, gap: 4, backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border }}><Action label={step < 2 ? step === 0 ? 'Continuar para conteúdo' : 'Conferir prévia' : existing || createdId ? 'Salvar alterações' : 'Criar conteúdo'} busy={busy || picking || libraryLoading} onPress={() => step < 2 ? next() : void onSave(input, existing?.id ?? createdId, setCreatedId)} />{step > 0 && <Action plain disabled={busy || picking} label="Voltar uma etapa" onPress={() => { setAttempted(false); setStep(step - 1); }} />}</View>
  </>;
}
