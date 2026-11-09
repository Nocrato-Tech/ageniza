import { useCallback, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { ActivityIndicator, View } from 'react-native';
import { CollaboratorInvitationRequestSchema, UpdateCollaboratorRequestSchema } from '@ageniza/contracts';
import type { AgencyRolesResponse, Collaborator, CollaboratorInvitationCreatedResponse, CollaboratorListResponse, Context, PendingInvitationListResponse } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Avatar, Card, ErrorText, Field, Heading, Info, Selector, Tabs, Txt, colors, ui } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';
import { ScreenMotion } from '../product/motion';
import { Disclosure } from '../product/Disclosure';
import { FlowList } from '../product/FlowList';

export function TeamScreen({ context, permissions, readOnly }: { context: Extract<Context, { type: 'agency' }>; permissions: string[]; readOnly: boolean }) {
  const root = `/agencies/${context.agencyId}`;
  const has = (key: string) => permissions.includes(key);
  const [mode, setMode] = useState('active');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Collaborator>();
  const [email, setEmail] = useState('');
  const emailInput = useRef<TextInput>(null);
  const [emailError, setEmailError] = useState('');
  const [role, setRole] = useState('');
  const [job, setJob] = useState('');
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [invitationUrl, setInvitationUrl] = useState('');
  const canInvite = has('colaborador.convidar');
  const canRole = has('colaborador.alterar_papel');
  const load = useCallback(async (signal: AbortSignal) => {
    const [people, roles, invitations] = await Promise.all([
      api.request<CollaboratorListResponse>(`${root}/collaborators?status=${mode === 'removed' ? 'removed' : 'active'}&page=${page}&pageSize=24${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`, { signal }),
      canInvite || canRole ? api.request<AgencyRolesResponse>(`${root}/roles`, { signal }) : Promise.resolve({ data: [] }),
      canInvite ? api.request<PendingInvitationListResponse>(`${root}/invitations?page=${page}&pageSize=24`, { signal }) : Promise.resolve(undefined)
    ]);
    return { people, roles: roles.data, invitations };
  }, [root, mode, page, query, canInvite, canRole]);
  const resource = useRemoteResource(load);
  const { data, busy, run } = resource;
  const edit = (person: Collaborator) => { setSelected(person); setJob(person.jobTitle ?? ''); setRole(data?.roles.find((item) => item.key === person.role.key)?.id ?? ''); setConfirmRemoval(false); };
  const tabs = [{ id: 'active', label: 'Equipe' }, ...(canInvite ? [{ id: 'invitations', label: 'Convites' }] : []), ...(has('colaborador.remover') || canRole ? [{ id: 'removed', label: 'Removidos' }] : [])];
  return <View style={{ gap: 16 }}><Heading title={selected ? selected.name : 'Gente que faz acontecer.'} subtitle="Cargo descreve o trabalho. Papel define o acesso." />
    {!!resource.error && <ErrorText text={resource.error} />}{!!resource.notice && <Info title={resource.notice} />}
    {!selected && <Tabs options={tabs} value={mode} onChange={(value) => { setMode(value); setPage(1); setInvitationUrl(''); }} />}
    {resource.loading && <ActivityIndicator color={colors.indigo} />}
    {!data && !resource.loading && <Action soft label="Tentar novamente" onPress={() => void run(async () => {}, 'Dados atualizados.')} />}
    <ScreenMotion identity={selected ? `person:${selected.membershipId}` : `team:${mode}`} variant="peer"><View style={{ gap: 16 }}>
    {data && (selected ? <>
      <Card><View style={ui.row}><Avatar name={selected.name} accent /><View style={{ flex: 1 }}><Txt kind="strong">{selected.name}</Txt><Txt color={colors.muted}>{selected.email}</Txt></View></View><Txt>{selected.isOwner ? 'Proprietário' : selected.role.name} · {selected.status === 'active' ? 'Ativo' : 'Removido'}</Txt><Txt kind="small" color={colors.muted}>Desde {new Date(selected.joinedAt).toLocaleDateString('pt-BR')}</Txt></Card>
      {!selected.isOwner && <>
        {has('colaborador.alterar_funcao') && selected.status === 'active' && !readOnly && <><Field label="Cargo" value={job} onChangeText={setJob} /><Action soft label="Salvar cargo" busy={busy} onPress={() => void run(async () => { const parsed = UpdateCollaboratorRequestSchema.safeParse({ jobTitle: job }); if (!parsed.success) throw new Error('Informe um cargo válido com até 256 caracteres.'); await api.request(`${root}/collaborators/${selected.membershipId}`, { method: 'PATCH', body: parsed.data }); setSelected(undefined); })} /></>}
        {canRole && !selected.isSelf && !readOnly && <><Selector label="Papel de acesso" value={role} options={data.roles.map((item) => ({ id: item.id, label: item.name }))} onChange={setRole} /><Action soft label={selected.status === 'removed' ? 'Reativar com este papel' : 'Salvar papel'} busy={busy} disabled={!role} onPress={() => void run(async () => { await api.request(`${root}/collaborators/${selected.membershipId}${selected.status === 'removed' ? '/reactivate' : ''}`, { method: selected.status === 'removed' ? 'POST' : 'PATCH', body: { roleId: role } }); setSelected(undefined); })} /></>}
        {has('colaborador.remover') && !selected.isSelf && selected.status === 'active' && (confirmRemoval ? <Info warning title="Remover este acesso encerra todas as sessões da pessoa" text="O histórico é preservado. Um administrador poderá reativar o vínculo depois." /> : <Action plain label="Remover da equipe" onPress={() => setConfirmRemoval(true)} />)}
        <Disclosure open={confirmRemoval}>{confirmRemoval && <Action label="Confirmar remoção do acesso" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/collaborators/${selected.membershipId}/remove`, { method: 'POST' }); setSelected(undefined); })} />}</Disclosure>
      </>}<Action plain label="Voltar à equipe" onPress={() => setSelected(undefined)} />
    </> : <>

      {mode !== 'invitations' ? <><Field label="Buscar na equipe" value={search} onChangeText={setSearch} onSubmitEditing={() => { setQuery(search); setPage(1); }} /><Action soft label="Buscar" onPress={() => { setQuery(search); setPage(1); }} /><FlowList items={data.people.data.map((person) => ({ ...person, id: person.membershipId }))} renderItem={(person) => <Card key={person.membershipId} label={`Abrir ${person.name}`} onPress={() => edit(person)}><View style={ui.row}><Avatar name={person.name} accent /><View style={{ flex: 1 }}><Txt kind="strong">{person.name}</Txt><Txt kind="small" color={colors.muted}>{person.jobTitle || 'Cargo não informado'} · {person.isOwner ? 'Proprietário' : person.role.name}</Txt></View></View></Card>} />{!data.people.data.length && <Info title="Nenhuma pessoa encontrada" text={query.trim() ? 'Tente outro nome ou limpe a busca para ver toda a equipe.' : mode === 'removed' ? 'Pessoas removidas da equipe aparecerão aqui, com seu histórico preservado.' : 'A equipe reúne quem trabalha na agência. Pessoas do portal são gerenciadas no cadastro de cada cliente.'} />}</> : <>
        {canInvite && !readOnly && <Card><Txt kind="section">Convidar para a equipe</Txt><Txt kind="small" color={colors.muted}>Este convite dá acesso ao trabalho da agência. Para convidar um cliente, use Acessos no cadastro do cliente.</Txt><Field ref={emailInput} error={emailError} label="E-mail da pessoa" value={email} onChangeText={(value) => { setEmail(value); setEmailError(''); }} autoComplete="email" autoCorrect={false} autoCapitalize="none" keyboardType="email-address" /><Selector label="Papel do convite" value={role} options={data.roles.map((item) => ({ id: item.id, label: item.name }))} onChange={setRole} /><Action label="Enviar convite" busy={busy} disabled={!role || !email.trim()} onPress={() => { if (busy) return; const parsed = CollaboratorInvitationRequestSchema.safeParse({ email, roleId: role }); if (!parsed.success) { if (parsed.error.issues.some((issue) => issue.path[0] === 'email')) { setEmailError('Informe um e-mail válido.'); emailInput.current?.focus(); } else resource.setError('Escolha um papel de acesso válido.'); return; } setEmailError(''); void run(async () => { const response = await api.request<CollaboratorInvitationCreatedResponse>(`${root}/invitations/collaborators`, { method: 'POST', body: parsed.data }); setInvitationUrl(response.invitationUrl); setEmail(''); }, 'Convite enviado por e-mail.'); }} /></Card>}
        <Disclosure open={!!invitationUrl}>{!!invitationUrl && <Card><Txt kind="strong">Link deste convite</Txt><Txt>{invitationUrl}</Txt><Txt kind="small" color={colors.muted}>Guarde-o agora se precisar compartilhar. Ele não fica disponível na listagem.</Txt></Card>}</Disclosure>
        <FlowList items={data.invitations?.data ?? []} renderItem={(invitation) => <Card key={invitation.id}><Txt kind="strong">{invitation.email}</Txt><Txt>{invitation.role.name}</Txt><Txt kind="small" color={colors.muted}>Expira em {new Date(invitation.expiresAt).toLocaleDateString('pt-BR')}</Txt>{has('convite.reenviar') && !readOnly && <Action soft label={`Reenviar para ${invitation.email}`} busy={busy} onPress={() => void run(async () => { const result = await api.request<{ invitationUrl: string | null }>(`${root}/invitations/${invitation.id}/resend`, { method: 'POST' }); setInvitationUrl(result.invitationUrl ?? ''); }, 'Convite reenviado.')} />}{has('convite.cancelar') && <Action plain label={`Cancelar convite de ${invitation.email}`} busy={busy} onPress={() => void run(async () => { await api.request(`${root}/invitations/${invitation.id}`, { method: 'DELETE' }); }, 'Convite cancelado.')} />}</Card>} />{!data.invitations?.data.length && <Info title="Nenhum convite pendente" text="Convites aguardando aceite aparecerão aqui. Um convite para a equipe não concede acesso ao portal de um cliente." />}
      </>}
      <View style={[ui.row, { justifyContent: 'space-between' }]}><Action plain label="Anterior" disabled={page <= 1 || busy} onPress={() => setPage(page - 1)} /><Txt kind="small">Página {page}</Txt><Action plain label="Próxima" disabled={page >= (mode === 'invitations' ? data.invitations?.meta.totalPages ?? 1 : data.people.meta.totalPages) || busy} onPress={() => setPage(page + 1)} /></View>
    </>)}
    </View></ScreenMotion>
  </View>;
}
