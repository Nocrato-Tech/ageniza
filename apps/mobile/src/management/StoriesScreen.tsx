import { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { CreateStoryScriptRequestSchema, UpdateStoryScriptRequestSchema } from '@ageniza/contracts';
import type { ContentPeriodResponse, Context, PortalStoryScript, StoryScript } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { monthPeriod, displayDay } from '../contents/period';
import { Action, Card, ErrorText, Field, Heading, Info, Selector, Txt, colors, ui } from '../product/ui';
import type { Client } from '../product/types';
import { useRemoteResource } from './useRemoteResource';

type Scene = { id?: string; text: string; guidance: string | null };
export function StoriesScreen({ context, clients, permissions, readOnly }: { context: Context; clients: Client[]; permissions: string[]; readOnly: boolean }) {
  const agency = context.type === 'agency';
  const [clientId, setClientId] = useState(context.type === 'client' ? context.clientId : clients[0]?.id ?? '');
  const [offset, setOffset] = useState(0);
  const period = monthPeriod(offset);
  const root = agency ? `/agencies/${context.agencyId}/clients/${clientId}` : `/clients/${clientId}`;
  const [selected, setSelected] = useState<StoryScript | PortalStoryScript>();
  const [creating, setCreating] = useState(false);
  const [day, setDay] = useState(period.from);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const load = useCallback(async (signal: AbortSignal) => {
    if (!clientId) return [];
    if (!agency) return (await api.request<{ data: PortalStoryScript[] }>(`${root}/story-scripts?from=${period.from}&to=${period.to}`, { signal })).data;
    const response = await api.request<ContentPeriodResponse>(`${root}/contents?from=${period.from}&to=${period.to}`, { signal });
    return Promise.all(response.data.storyScripts.map((script) => api.request<StoryScript>(`${root}/story-scripts/${script.id}`, { signal })));
  }, [agency, root, clientId, period.from, period.to]);
  const { data, loading, busy, error, notice, run } = useRemoteResource(load);
  const canEdit = agency && !readOnly && permissions.includes('conteudo.operar');
  const editing = canEdit && (creating || selected?.status === 'draft');
  function open(script: StoryScript | PortalStoryScript) { setSelected(script); setCreating(false); setDay(script.scriptOn); setScenes(script.scenes.map((scene) => ({ ...('id' in scene ? { id: scene.id } : {}), text: scene.text, guidance: scene.guidance }))); }
  return <View style={{ gap: 16 }}><Heading title="Roteiros de stories" subtitle="Planeje as cenas. O cliente acompanha e marca a gravação." />{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}
    {!selected && !creating ? <>{agency && <Selector label="Cliente do roteiro" value={clientId} options={clients.map((client) => ({ id: client.id, label: client.name }))} onChange={setClientId} />}<View style={[ui.row, { justifyContent: 'space-between' }]}><Action plain label="Mês anterior" onPress={() => setOffset(offset - 1)} /><Txt kind="label">{period.label}</Txt><Action plain label="Próximo mês" onPress={() => setOffset(offset + 1)} /></View>{loading && <ActivityIndicator color={colors.indigo} />}{data?.map((script) => <Card key={script.id} label={`Abrir roteiro de ${displayDay(script.scriptOn)}`} onPress={() => open(script)}><Txt kind="section">{displayDay(script.scriptOn)}</Txt><Txt>{script.scenes.length} cena(s) · {script.status === 'draft' ? 'Rascunho' : script.status === 'sent' ? 'Aguardando gravação' : 'Gravado'}</Txt></Card>)}{data && !data.length && <Info title="Nenhum roteiro neste período" />}{canEdit && <Action label="Criar roteiro" disabled={!clientId} onPress={() => { setCreating(true); setSelected(undefined); setDay(period.from); setScenes([{ text: '', guidance: null }]); }} />}</> : <>
      <Field label="Data do roteiro (AAAA-MM-DD)" value={day} onChangeText={setDay} editable={editing} />{scenes.map((scene, index) => <Card key={scene.id ?? `new-${index}`}><Txt kind="strong">Cena {index + 1}</Txt>{editing ? <><Field label={`Texto da cena ${index + 1}`} value={scene.text} multiline onChangeText={(value) => setScenes((items) => items.map((item, i) => i === index ? { ...item, text: value } : item))} /><Field label={`Orientação da cena ${index + 1}`} value={scene.guidance ?? ''} multiline onChangeText={(value) => setScenes((items) => items.map((item, i) => i === index ? { ...item, guidance: value } : item))} />{index > 0 && <Action plain label={`Mover cena ${index + 1} para cima`} onPress={() => setScenes((items) => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })} />}{!scene.id && <Action plain label={`Retirar cena nova ${index + 1}`} onPress={() => setScenes((items) => items.filter((_, i) => i !== index))} />}</> : <><Txt>{scene.text}</Txt>{scene.guidance && <Info title="Orientação" text={scene.guidance} />}</>}</Card>)}
      {editing && <><Action soft label="Adicionar cena" disabled={scenes.length >= 30} onPress={() => setScenes((items) => [...items, { text: '', guidance: null }])} /><Action label="Salvar roteiro" busy={busy} onPress={() => void run(async () => { const parsed = (creating ? CreateStoryScriptRequestSchema : UpdateStoryScriptRequestSchema).safeParse({ scriptOn: day, scenes }); if (!parsed.success) throw new Error('Confira a data e os textos das cenas. Máximo de 30 cenas.'); const result = await api.request<StoryScript>(`${root}/story-scripts${selected ? `/${selected.id}` : ''}`, { method: creating ? 'POST' : 'PATCH', body: parsed.data }); open(result); }, 'Roteiro salvo.')} />{selected?.status === 'draft' && <Action soft label="Enviar roteiro ao cliente" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/story-scripts/${selected.id}/send`, { method: 'POST' }); setSelected(undefined); }, 'Roteiro enviado.')} />}</>}
      {!agency && selected?.status === 'sent' && !readOnly && <Action label="Marcar como gravado" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/story-scripts/${selected.id}/recorded`, { method: 'POST' }); setSelected(undefined); }, 'Gravação registrada.')} />}
      {selected?.recordedAt && <Info title="Gravado" text={`${selected.recordedBy?.name ?? 'Cliente'} · ${new Date(selected.recordedAt).toLocaleDateString('pt-BR')}`} />}
      <Action plain label="Voltar aos roteiros" disabled={busy} onPress={() => { setSelected(undefined); setCreating(false); }} />
    </>}
  </View>;
}
