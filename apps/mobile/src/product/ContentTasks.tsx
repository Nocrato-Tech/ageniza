import { Disclosure } from './Disclosure';
import { FlowList } from './FlowList';
import { EditorDateTime } from './EditorDateTime';
import { useState } from 'react';
import { View } from 'react-native';
import { CalendarDaySchema, ContentReasonSchema, ContentTaskDescriptionSchema, ContentTitleSchema } from '@ageniza/contracts';
import { Check, Circle } from './icons';
import { Action, Card, Field, Info, Selector, Txt, useColors, ui, ErrorText } from './ui';
import type { Data, Post, Repository, Task } from './types';
import { displayDay } from '../contents/period';

export function ContentTasks({ post, data, repository, busy, onUpdate }: { post: Post; data: Data; repository: Repository; busy: boolean; onUpdate(action: () => Promise<Post>, successMessage?: string): Promise<boolean> }) {
  const colors = useColors();
  const [editing, setEditing] = useState<Task>();
  const [returning, setReturning] = useState<Task>();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [returnAttempted, setReturnAttempted] = useState(false);
  const can = (permission: string) => !data.readOnly && (data.permissions.includes('*') || data.permissions.includes(permission));
  const canEdit = can('conteudo.operar') && !['published', 'cancelled'].includes(post.status);
  const canReview = can('conteudo.visualizar') && (repository.demo || data.people.some((person) => person.self && person.id === post.ownerId) || can('conteudo.aprovar_pela_agencia'));
  const errors = editing ? {
    title: ContentTitleSchema.safeParse(editing.title).success ? undefined : 'Informe um título de até 120 caracteres.',
    description: ContentTaskDescriptionSchema.safeParse(editing.description ?? '').success ? undefined : 'Reduza a descrição para salvar a tarefa.',
    dueOn: CalendarDaySchema.safeParse(editing.dueOn).success ? undefined : 'Informe uma data válida no formato AAAA-MM-DD.',
    assignee: data.people.some((person) => person.id === editing.assigneeId) ? undefined : 'Escolha uma pessoa responsável pela tarefa.'
  } : {};
  const reasonError = ContentReasonSchema.safeParse(reason).success ? undefined : 'Explique o ajuste necessário e reduza o texto se estiver muito longo.';
  async function saveTask() {
    setAttempted(true);
    if (!editing || Object.values(errors).some(Boolean) || !canEdit) return;
    const saved = await onUpdate(() => editing.id ? repository.updateTask(post, editing) : repository.addTask(post, { title: editing.title, description: editing.description, dueOn: editing.dueOn, assigneeId: editing.assigneeId }), `${editing.id ? 'Tarefa atualizada' : 'Tarefa criada'}: ${editing.title}.`);
    if (saved) { setEditing(undefined); setAttempted(false); }
  }
  async function returnTask() {
    setReturnAttempted(true);
    if (!returning || reasonError || !canReview) return;
    const saved = await onUpdate(() => repository.task(post, returning, 'return', reason), `Tarefa devolvida com orientação de ajuste: ${returning.title}.`);
    if (saved) { setReturning(undefined); setReason(''); setReturnAttempted(false); }
  }
  return <Card>
    <View accessibilityLiveRegion="polite"><Txt kind="strong">Tarefas do conteúdo · {post.tasks.filter((task) => task.status === 'approved').length}/{post.tasks.length}</Txt></View>
    {!post.tasks.length && <Info title="Nenhuma tarefa neste conteúdo" text={canEdit ? 'Adicione as etapas de produção e defina quem fará cada uma.' : 'As tarefas de produção aparecerão aqui quando forem adicionadas.'} />}
    <FlowList items={post.tasks} renderItem={(task) => <View key={task.id} style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.border }}>
      <View style={ui.row}>{task.status === 'approved' ? <Check size={20} color={colors.teal} /> : <Circle size={20} color={colors.muted} />}<View style={{ flex: 1 }}><Txt>{task.title}</Txt><Txt kind="small" color={colors.muted}>{data.people.find((person) => person.id === task.assigneeId)?.name ?? 'Responsável indisponível'} · {displayDay(task.dueOn)} · {task.status === 'pending' ? 'Pendente' : task.status === 'delivered' ? 'Entregue' : 'Aprovada'}</Txt>{task.description && <Txt kind="small">{task.description}</Txt>}</View></View>
      {can('conteudo.visualizar') && task.status === 'pending' && (repository.demo || data.people.some((person) => person.self && person.id === task.assigneeId)) && <Action soft busy={busy} label={`Entregar: ${task.title}`} onPress={() => void onUpdate(() => repository.task(post, task, 'deliver'), `Tarefa entregue para conferência: ${task.title}.`)} />}
      {canReview && task.status === 'delivered' && <><Action soft busy={busy} label={`Aprovar tarefa: ${task.title}`} onPress={() => void onUpdate(() => repository.task(post, task, 'approve'), `Tarefa aprovada: ${task.title}.`)} /><Action plain disabled={busy} label={`Devolver tarefa: ${task.title}`} onPress={() => { setReturning(task); setReason(''); setReturnAttempted(false); }} /></>}
      {canEdit && <Action plain disabled={busy} label={`Editar tarefa: ${task.title}`} onPress={() => { setEditing({ ...task }); setAttempted(false); }} />}
    </View>} />
    <Disclosure open={!!returning}>{returning && <View style={{ gap: 12 }}><Info title={`Devolver: ${returning.title}`} text="Explique o que precisa ser ajustado antes de entregar novamente." /><Field label="Motivo da devolução" error={returnAttempted ? reasonError : undefined} multiline value={reason} onChangeText={setReason} /><Action label="Confirmar devolução" busy={busy} onPress={() => void returnTask()} /><Action plain disabled={busy} label="Cancelar devolução" onPress={() => setReturning(undefined)} /></View>}</Disclosure>
    <Disclosure open={!!editing}>{editing && <View style={{ gap: 12 }}>
      <Txt kind="section">{editing.id ? 'Editar tarefa' : 'Nova tarefa'}</Txt>
      <Field label="Título da tarefa" error={attempted ? errors.title : undefined} value={editing.title} maxLength={120} onChangeText={(title) => setEditing({ ...editing, title })} />
      <Field label="Descrição da tarefa" error={attempted ? errors.description : undefined} value={editing.description ?? ''} multiline onChangeText={(description) => setEditing({ ...editing, description })} />
      <Selector label="Responsável pela tarefa" value={editing.assigneeId} options={data.people.map((person) => ({ id: person.id, label: person.name }))} onChange={(assigneeId) => setEditing({ ...editing, assigneeId })} />
      {attempted && errors.assignee && <ErrorText text={errors.assignee} />}
      <EditorDateTime kind="date" label="Prazo da tarefa (AAAA-MM-DD)" error={attempted ? errors.dueOn : undefined} value={editing.dueOn} onChange={(dueOn) => setEditing({ ...editing, dueOn })} />
      <Action label="Salvar tarefa" busy={busy} onPress={() => void saveTask()} /><Action plain disabled={busy} label="Cancelar edição da tarefa" onPress={() => setEditing(undefined)} />
    </View>}</Disclosure>
    {canEdit && !editing && <Action soft disabled={busy} label="Adicionar tarefa" onPress={() => { setAttempted(false); setEditing({ id: '', title: '', description: '', dueOn: post.date, assigneeId: data.people[0]?.id ?? '', status: 'pending' }); }} />}
  </Card>;
}
