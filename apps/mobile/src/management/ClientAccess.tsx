import { useCallback, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { ActivityIndicator, View } from 'react-native';
import { ClientMemberAddRequestSchema } from '@ageniza/contracts';
import type { ClientMemberListResponse } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Field, Info, Tabs, Txt, colors } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';

export function ClientAccess({ root, permissions, readOnly }: { root: string; permissions: string[]; readOnly: boolean }) {
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [email, setEmail] = useState('');
  const emailInput = useRef<TextInput>(null);
  const [emailError, setEmailError] = useState('');
  const [removal, setRemoval] = useState('');
  const load = useCallback((signal: AbortSignal) => api.request<ClientMemberListResponse>(`${root}/members?status=${status}&page=${page}&pageSize=20`, { signal }), [root, status, page]);
  const { data, loading, busy, error, notice, run } = useRemoteResource(load);
  return <View style={{ gap: 16 }}><Tabs value={status} options={[{ id: 'active', label: 'Ativos' }, { id: 'removed', label: 'Removidos' }]} onChange={(value) => { setStatus(value); setPage(1); }} />
    {!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}{loading && <ActivityIndicator color={colors.indigo} />}
    {!readOnly && <Card><Txt kind="strong">Adicionar pessoa ao portal</Txt><Txt kind="small" color={colors.muted}>O acesso é concedido ao e-mail informado. Todas as pessoas do portal podem aprovar e pedir ajustes.</Txt><Field ref={emailInput} error={emailError} label="E-mail para acesso" value={email} onChangeText={(value) => { setEmail(value); setEmailError(''); }} autoComplete="email" autoCorrect={false} autoCapitalize="none" keyboardType="email-address" /><Action label="Adicionar e enviar boas-vindas" busy={busy} onPress={() => { if (busy) return; const parsed = ClientMemberAddRequestSchema.safeParse({ email }); if (!parsed.success) { setEmailError('Informe um e-mail válido.'); emailInput.current?.focus(); return; } setEmailError(''); void run(async () => { await api.request(`${root}/members`, { method: 'POST', body: parsed.data }); setEmail(''); }, 'Acesso adicionado.'); }} /></Card>}
    {data?.data.map((member) => <Card key={member.accessId}><Txt kind="strong">{member.name ?? member.email}</Txt>{member.name && <Txt color={colors.muted}>{member.email}</Txt>}<Txt kind="small">{member.entered ? 'Já acessou o portal' : 'Ainda não entrou'}</Txt>
      {member.status === 'active' && !member.entered && !readOnly && <Action soft label={`Reenviar boas-vindas para ${member.email}`} busy={busy} onPress={() => void run(async () => { await api.request(`${root}/members/${member.accessId}/resend`, { method: 'POST' }); }, 'E-mail reenviado.')} />}
      {permissions.includes('cliente.remover_usuario') && (member.status === 'removed' ? !readOnly && <Action soft label={`Reativar ${member.email}`} busy={busy} onPress={() => void run(async () => { await api.request(`${root}/members/${member.accessId}/reactivate`, { method: 'POST' }); }, 'Acesso reativado.')} /> : removal === member.accessId ? <><Info warning title="As sessões desta pessoa serão encerradas" text="O acesso poderá ser reativado pela agência." /><Action label="Confirmar remoção do portal" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/members/${member.accessId}/remove`, { method: 'POST' }); setRemoval(''); }, 'Acesso removido.')} /><Action plain label="Manter acesso" onPress={() => setRemoval('')} /></> : <Action plain label={`Remover acesso de ${member.email}`} onPress={() => setRemoval(member.accessId)} />)}
    </Card>)}
    {data && !data.data.length && <Info title="Nenhum acesso nesta lista" text={status === 'removed' ? 'Pessoas removidas aparecerão aqui. O histórico de acesso é preservado.' : 'Cadastrar o cliente não concede acesso ao portal. Adicione uma pessoa pelo e-mail para que ela acompanhe e aprove os conteúdos.'} />}
    {data && <><Action plain label="Carregar página anterior" disabled={page <= 1 || busy} onPress={() => setPage(page - 1)} /><Action plain label="Carregar próxima página" disabled={page >= data.meta.totalPages || busy} onPress={() => setPage(page + 1)} /></>}
  </View>;
}
