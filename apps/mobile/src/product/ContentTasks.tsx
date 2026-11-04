import { useState } from 'react';
import { View } from 'react-native';
import { Check, Circle } from 'lucide-react-native';
import { Action, Card, Field, Info, Selector, Txt, colors, ui } from './ui';
import type { Data, Post, Repository, Task } from './types';
import { displayDay } from '../contents/period';

export function ContentTasks({ post, data, repository, busy, onUpdate }: { post: Post; data: Data; repository: Repository; busy: boolean; onUpdate(action: () => Promise<Post>): Promise<boolean> }) {
  const [editing, setEditing] = useState<Task>();
  const [returning, setReturning] = useState<Task>();
  const [reason, setReason] = useState('');
  const can = (permission: string) => !data.readOnly && (data.permissions.includes('*') || data.permissions.includes(permission));
  const canEdit = can('conteudo.operar') && !['published', 'cancelled'].includes(post.status);
  const canReview = can('conteudo.visualizar') && (repository.demo || data.people.some((person) => person.self && person.id === post.ownerId) || can('conteudo.aprovar_pela_agencia'));
  return <Card><Txt kind="strong">Tarefas do conteúdo · {post.tasks.filter((task) => task.status === 'approved').length}/{post.tasks.length}</Txt>
    {post.tasks.map((task) => <View key={task.id} style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.border }}><View style={ui.row}>{task.status === 'approved' ? <Check size={20} color={colors.teal} /> : <Circle size={20} color={colors.muted} />}<View style={{ flex: 1 }}><Txt>{task.title}</Txt><Txt kind="small" color={colors.muted}>{data.people.find((person) => person.id === task.assigneeId)?.name ?? 'Responsável indisponível'} · {displayDay(task.dueOn)} · {task.status === 'pending' ? 'Pendente' : task.status === 'delivered' ? 'Entregue' : 'Aprovada'}</Txt>{task.description && <Txt kind="small">{task.description}</Txt>}</View></View>
      {can('conteudo.visualizar') && task.status === 'pending' && (repository.demo || data.people.some((person) => person.self && person.id === task.assigneeId)) && <Action soft busy={busy} label={`Entregar: ${task.title}`} onPress={() => void onUpdate(() => repository.task(post, task, 'deliver'))} />}
      {canReview && task.status === 'delivered' && <><Action soft busy={busy} label={`Aprovar tarefa: ${task.title}`} onPress={() => void onUpdate(() => repository.task(post, task, 'approve'))} /><Action plain label={`Devolver tarefa: ${task.title}`} onPress={() => { setReturning(task); setReason(''); }} /></>}
      {canEdit && <Action plain label={`Editar tarefa: ${task.title}`} onPress={() => setEditing({ ...task })} />}
    </View>)}
    {returning && <View style={{ gap: 12 }}><Info title={`Devolver: ${returning.title}`} text="Explique o que precisa ser ajustado antes de entregar novamente." /><Field label="Motivo da devolução" multiline value={reason} onChangeText={setReason} /><Action label="Confirmar devolução" disabled={!reason.trim()} busy={busy} onPress={() => void onUpdate(() => repository.task(post, returning, 'return', reason)).then((saved) => { if (saved) setReturning(undefined); })} /><Action plain label="Cancelar devolução" onPress={() => setReturning(undefined)} /></View>}
    {editing && <View style={{ gap: 12 }}><Txt kind="section">{editing.id ? 'Editar tarefa' : 'Nova tarefa'}</Txt><Field label="Título da tarefa" value={editing.title} onChangeText={(title) => setEditing({ ...editing, title })} /><Field label="Descrição da tarefa" value={editing.description ?? ''} multiline onChangeText={(description) => setEditing({ ...editing, description })} /><Selector label="Responsável pela tarefa" value={editing.assigneeId} options={data.people.map((person) => ({ id: person.id, label: person.name }))} onChange={(assigneeId) => setEditing({ ...editing, assigneeId })} /><Field label="Prazo da tarefa (AAAA-MM-DD)" value={editing.dueOn} onChangeText={(dueOn) => setEditing({ ...editing, dueOn })} /><Action label="Salvar tarefa" busy={busy} disabled={!editing.title.trim() || !editing.assigneeId} onPress={() => void onUpdate(() => editing.id ? repository.updateTask(post, editing) : repository.addTask(post, { title: editing.title, description: editing.description, dueOn: editing.dueOn, assigneeId: editing.assigneeId })).then((saved) => { if (saved) setEditing(undefined); })} /><Action plain label="Cancelar edição da tarefa" onPress={() => setEditing(undefined)} /></View>}
    {canEdit && !editing && <Action soft label="Adicionar tarefa" onPress={() => setEditing({ id: '', title: '', description: '', dueOn: post.date, assigneeId: data.people[0]?.id ?? '', status: 'pending' })} />}
  </Card>;
}
