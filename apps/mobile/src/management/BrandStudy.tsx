import { useCallback, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ARCHETYPE_LABELS, BrandStudySectionUpdateRequestSchema, CreatePersonaRequestSchema, UpdatePersonaRequestSchema } from '@ageniza/contracts';
import type { BrandStudyResponse, Persona } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Field, Info, Txt, colors } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';
import { Conversations } from './Conversations';
import { Disclosure } from '../product/Disclosure';
import { FlowList } from '../product/FlowList';
import { StateSwap } from '../product/StateSwap';
import { BrandArchetype } from './BrandArchetype';
import { BrandPalette } from './BrandPalette';
import { BrandText } from './BrandText';
import { readBrandFields } from './brand-text';

const labels: Record<string, string> = { branding: 'Identidade da marca', tone_of_voice: 'Tom de voz', colors: 'Cores', positioning: 'Posicionamento', archetype: 'Arquétipo', personas: 'Personas', observations: 'Observações' };
type PersonaDraft = { id?: string; name: string; description: string; pains: string; desires: string; objections: string };
export function BrandStudy({ root, canEdit, agency = true, readOnly = false }: { root: string; canEdit: boolean; agency?: boolean; readOnly?: boolean }) {
  const load = useCallback((signal: AbortSignal) => api.request<BrandStudyResponse>(`${root}/brand-study`, { signal }), [root]);
  const { data, loading, busy, error, notice, run, setError } = useRemoteResource(load);
  const [editing, setEditing] = useState('');
  const [body, setBody] = useState('');
  const [archetype, setArchetype] = useState('');
  const [palette, setPalette] = useState<{ name: string; hex: string }[]>([]);
  const [persona, setPersona] = useState<PersonaDraft>();
  const [conversation, setConversation] = useState('');
  const editPersona = (value?: Persona) => setPersona({ id: value?.id, name: value?.name ?? '', description: value?.description ?? '', pains: value?.pains ?? '', desires: value?.desires ?? '', objections: value?.objections ?? '' });
  return <View style={{ gap: 16 }}>{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}{loading && <ActivityIndicator color={colors.indigo} />}
    {data && <><Info title={`${data.filled} de 7 seções preenchidas`} text={canEdit ? 'Mantenha as decisões da marca acessíveis à agência e ao cliente.' : 'As informações da marca são mantidas pela sua agência.'} />
      {data.sections.filter((section) => section.key !== 'personas').map((section) => <Card key={section.key}><Txt kind="section">{labels[section.key]}</Txt>
        <StateSwap identity={editing === section.key ? 'editing' : 'reading'}>{editing === section.key ? <>
          {section.key === 'archetype' ? <BrandArchetype value={archetype} onChange={setArchetype} /> : section.key === 'colors' ? <BrandPalette value={palette} onChange={setPalette} /> : <BrandText section={section.key} body={body} onChange={setBody} />}

          <Action label="Salvar seção" busy={busy} onPress={() => void run(async () => { if (!['colors', 'archetype'].includes(section.key) && !readBrandFields(section.key, body).some((value) => value.trim())) throw new Error('Preencha ao menos uma orientação da marca.'); const parsed = BrandStudySectionUpdateRequestSchema.safeParse(section.key === 'colors' ? { colors: palette } : section.key === 'archetype' ? { archetype } : { body }); if (!parsed.success) throw new Error('Confira o texto e os valores informados. Cores usam #RRGGBB.'); await api.request(`${root}/brand-study/sections/${section.key}`, { method: 'PUT', body: parsed.data }); setEditing(''); })} /><Action plain label="Cancelar edição" onPress={() => setEditing('')} />
        </> : <>{section.body && <BrandText section={section.key} body={section.body} />}{section.archetype && <Txt>{ARCHETYPE_LABELS[section.archetype]}</Txt>}{section.key === 'colors' && <BrandPalette value={section.colors ?? []} />}{section.key !== 'colors' && !section.body && !section.archetype && !section.colors?.length && <Txt color={colors.muted}>Ainda não preenchido.</Txt>}{canEdit && <Action soft label={`Editar ${labels[section.key]}`} onPress={() => { setEditing(section.key); setBody(section.body ?? ''); setArchetype(section.archetype ?? ''); setPalette(section.colors ?? []); }} />}</>}</StateSwap>
        <Action plain label={`Conversar sobre ${labels[section.key]}`} onPress={() => setConversation(conversation === section.key ? '' : section.key)} /><Disclosure open={conversation === section.key}>{conversation === section.key && <Conversations root={root} subject={{ sectionKey: section.key }} canWrite={!readOnly && (agency ? canEdit : true)} canResolve={agency && canEdit} />}</Disclosure>
      </Card>)}
      <Txt kind="section">Personas</Txt><FlowList items={data.personas} renderItem={(item) => <Card key={item.id}><Txt kind="strong">{item.name}</Txt>{item.description && <Txt>{item.description}</Txt>}{item.pains && <Txt>Dores: {item.pains}</Txt>}{item.desires && <Txt>Desejos: {item.desires}</Txt>}{item.objections && <Txt>Objeções: {item.objections}</Txt>}<><Action plain label={`Conversar sobre persona ${item.name}`} onPress={() => setConversation(conversation === `persona:${item.id}` ? '' : `persona:${item.id}`)} /><Disclosure open={conversation === `persona:${item.id}`}>{conversation === `persona:${item.id}` && <Conversations root={root} subject={{ personaId: item.id }} canWrite={!readOnly && (agency ? canEdit : true)} canResolve={agency && canEdit} />}</Disclosure></>{canEdit && <Action soft label={`Editar persona ${item.name}`} onPress={() => editPersona(item)} />}</Card>} />
      {canEdit && <Action soft label="Adicionar persona" onPress={() => editPersona()} />}
      <Disclosure open={!!persona}>{persona && <Card><Txt kind="section">{persona.id ? 'Editar persona' : 'Nova persona'}</Txt>{(['name', 'description', 'pains', 'desires', 'objections'] as const).map((key) => <Field key={key} label={{ name: 'Nome da persona', description: 'Descrição', pains: 'Dores', desires: 'Desejos', objections: 'Objeções' }[key]} value={persona[key]} onChangeText={(value) => setPersona({ ...persona, [key]: value })} multiline={key !== 'name'} />)}<Action label="Salvar persona" busy={busy} onPress={() => void run(async () => { const { id, ...input } = persona; const parsed = (id ? UpdatePersonaRequestSchema : CreatePersonaRequestSchema).safeParse(input); if (!parsed.success) { setError('Confira os campos da persona. Nome é obrigatório.'); throw new Error('Confira os campos da persona. Nome é obrigatório.'); } await api.request(`${root}/personas${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: parsed.data }); setPersona(undefined); })} /><Action plain label="Cancelar persona" onPress={() => setPersona(undefined)} /></Card>}</Disclosure>
    </>}
  </View>;
}
