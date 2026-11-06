import { ClientPhoto } from './ClientPhoto';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { ActivityIndicator, View } from 'react-native';
import { SetClientClosingRequestSchema, UpdateClientRequestSchema } from '@ageniza/contracts';
import type { ClientDetailResponse, ClientListResponse, Context } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Avatar, Card, ErrorText, Field, Heading, Info, Tabs, Txt, colors, ui } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';
import { BrandStudy } from './BrandStudy';
import { ClientAccess } from './ClientAccess';

const registration = { name: 'Nome do cliente', legalName: 'Razão social', taxId: 'CPF ou CNPJ', segment: 'Segmento', website: 'Site (https://)', instagramHandle: 'Instagram', contactName: 'Nome do contato', contactPhone: 'Telefone do contato', contactEmail: 'E-mail do contato' };
type Registration = Record<keyof typeof registration, string>;
const registrationErrors: Record<keyof Registration, string> = { name: 'Informe um nome válido para o cliente.', legalName: 'Confira a razão social, com até 256 caracteres.', taxId: 'Informe um CPF com 11 ou CNPJ com 14 dígitos.', segment: 'Use até 120 caracteres no segmento.', website: 'Informe um site completo com http:// ou https://.', instagramHandle: 'Informe um usuário válido do Instagram, com até 30 caracteres.', contactName: 'Confira o nome do contato, com até 256 caracteres.', contactPhone: 'Confira o telefone, com até 32 caracteres.', contactEmail: 'Informe um e-mail de contato válido.' };
export function ClientManagement({ context, initialClientId = '', permissions, readOnly, onChanged, onContents }: { context: Extract<Context, { type: 'agency' }>; initialClientId?: string; permissions: string[]; readOnly: boolean; onChanged(): Promise<void>; onContents(clientId: string): void }) {
  const [clientId, setClientId] = useState(initialClientId);
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('general');
  const [form, setForm] = useState<Registration>({ name: '', legalName: '', taxId: '', segment: '', website: '', instagramHandle: '', contactName: '', contactPhone: '', contactEmail: '' });
  const [closing, setClosing] = useState('');
  const [formClientId, setFormClientId] = useState('');
  const inputs = useRef<Partial<Record<keyof Registration, TextInput | null>>>({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Registration, string>>>({});
  const [confirmArchive, setConfirmArchive] = useState(false);
  const root = `/agencies/${context.agencyId}/clients`;
  const has = (key: string) => permissions.includes(key);
  const load = useCallback(async (signal: AbortSignal) => clientId ? { detail: await api.request<ClientDetailResponse>(`${root}/${clientId}`, { signal }), list: undefined } : { detail: undefined, list: await api.request<ClientListResponse>(`${root}?status=${status}${query.trim() ? `&search=${encodeURIComponent(query.trim())}` : ''}&page=${page}&pageSize=20`, { signal }) }, [clientId, root, status, query, page]);
  const { data, loading, busy, error, notice, run } = useRemoteResource(load);
  const detail = data?.detail;
  useEffect(() => { if (detail) { setForm(Object.fromEntries(Object.keys(registration).map((key) => [key, detail[key as keyof Registration] ?? ''])) as Registration); setClosing(detail.closingDate ?? ''); setFieldErrors({}); setFormClientId(detail.id); } }, [detail]);
  const editable = !!detail && detail.status === 'active' && !readOnly;
  const tabs = [{ id: 'general', label: 'Geral' }, { id: 'brand', label: 'Marca' }, ...(has('cliente.convidar_usuario') ? [{ id: 'access', label: 'Acessos' }] : [])];
  function saveRegistration() {
    if (busy) return;
    const input = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, key === 'name' ? value : value.trim() || null]));
    const parsed = UpdateClientRequestSchema.safeParse(input);
    if (!parsed.success) {
      const errors: Partial<Record<keyof Registration, string>> = {};
      for (const issue of parsed.error.issues) { const key = issue.path[0] as keyof Registration; if (key in registration) errors[key] = registrationErrors[key]; }
      setFieldErrors(errors);
      const first = (Object.keys(registration) as (keyof Registration)[]).find((key) => errors[key]);
      if (first) inputs.current[first]?.focus();
      return;
    }
    setFieldErrors({});
    void run(async () => { await api.request(`${root}/${clientId}`, { method: 'PATCH', body: parsed.data }); await onChanged(); }, 'Cadastro do cliente atualizado.');
  }
  return <View style={{ gap: 16 }}><Heading title={detail?.name ?? 'Carteira de clientes'} subtitle={detail ? 'Informações e decisões da marca, no mesmo lugar.' : 'Clientes ativos e arquivados da agência.'} />
    {!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}{loading && <ActivityIndicator color={colors.indigo} />}
    {!data && !loading && <Action soft label="Tentar novamente" onPress={() => void run(async () => {}, 'Dados atualizados.')} />}
    {data?.list && <><Tabs value={status} options={[{ id: 'active', label: 'Ativos' }, { id: 'archived', label: 'Arquivados' }]} onChange={(value) => { setStatus(value); setPage(1); }} /><Field label="Buscar cliente" value={search} onChangeText={setSearch} onSubmitEditing={() => { setQuery(search); setPage(1); }} /><Action soft label="Buscar cliente" onPress={() => { setQuery(search); setPage(1); }} />{data.list.data.map((client) => <Card key={client.id} label={`Gerenciar ${client.name}`} onPress={() => { setClientId(client.id); setTab('general'); setConfirmArchive(false); }}><View style={ui.row}><Avatar name={client.name} /><View style={{ flex: 1 }}><Txt kind="strong">{client.name}</Txt><Txt kind="small" color={colors.muted}>{client.instagramHandle ? `@${client.instagramHandle}` : 'Instagram não informado'}{client.status === 'archived' ? ' · Arquivado' : ''}</Txt></View></View></Card>)}{!data.list.data.length && <Info title="Nenhum cliente encontrado" text={query.trim() ? 'Tente outro nome ou limpe a busca para ver a carteira.' : status === 'archived' ? 'Clientes arquivados aparecerão aqui, com o cadastro e o histórico preservados.' : 'A carteira reúne as marcas atendidas. Cadastrar um cliente não concede acesso ao portal automaticamente.'} />}<View style={[ui.row, { justifyContent: 'space-between' }]}><Action plain label="Anterior" disabled={page <= 1} onPress={() => setPage(page - 1)} /><Txt kind="small">Página {page}</Txt><Action plain label="Próxima" disabled={page >= data.list.meta.totalPages} onPress={() => setPage(page + 1)} /></View></>}
    {detail && formClientId === detail.id && <>
      {detail.status === 'archived' ? <><Info warning title="Cliente arquivado" text="O cadastro e o histórico estão preservados. Reativar devolve o portal às pessoas que tinham acesso; conteúdos cancelados não voltam automaticamente." />{has('cliente.arquivar') && !readOnly && <Action label="Reativar cliente" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/${clientId}/reactivate`, { method: 'POST' }); await onChanged(); }, 'Cliente reativado.')} />}</> : <><Tabs options={tabs} value={tab} onChange={setTab} />
        {tab === 'general' && <>
          <ClientPhoto root={`${root}/${clientId}`} name={detail.name} photoUrl={detail.photoUrl} editable={editable && has('cliente.operar')} onChanged={async () => { await onChanged(); await run(async () => {}, 'Cadastro atualizado.'); }} /><Card><Txt kind="strong">Resumo do cliente</Txt><Txt>{detail.summary.brandStudyFilled}/7 seções de marca preenchidas</Txt><Txt>{detail.summary.threadsAwaitingAgency} conversa(s) aguardando a agência</Txt>{has('cliente.convidar_usuario') && <Txt>{detail.summary.activePortalMembers} pessoa(s) com acesso ao portal</Txt>}</Card>
          {has('conteudo.visualizar') && <Action label="Abrir conteúdos deste cliente" onPress={() => onContents(clientId)} />}
          <Card><Txt kind="section">Cadastro</Txt>{(Object.keys(registration) as (keyof Registration)[]).map((key) => <Field key={key} ref={(value) => { inputs.current[key] = value; }} error={fieldErrors[key]} label={registration[key]} value={form[key]} editable={editable && has('cliente.operar')} onChangeText={(value) => { setForm({ ...form, [key]: value }); setFieldErrors((current) => ({ ...current, [key]: undefined })); }} keyboardType={key === 'contactEmail' ? 'email-address' : key === 'website' ? 'url' : key === 'contactPhone' ? 'phone-pad' : 'default'} autoCorrect={!['contactEmail', 'website', 'instagramHandle', 'taxId'].includes(key)} autoCapitalize={['contactEmail', 'website', 'instagramHandle'].includes(key) ? 'none' : 'sentences'} />)}{editable && has('cliente.operar') && <Action label="Salvar cadastro" busy={busy} onPress={saveRegistration} />}</Card>
          {has('cliente.arquivar') && editable && <Card><Txt kind="section">Contrato e encerramento</Txt><Txt kind="small" color={colors.muted}>Ao arquivar, o portal é bloqueado e conteúdos posteriores ao encerramento são cancelados. O histórico permanece disponível.</Txt><Field label="Último dia do contrato (AAAA-MM-DD)" value={closing} onChangeText={setClosing} /><Action soft label="Agendar encerramento" busy={busy} onPress={() => void run(async () => { const parsed = SetClientClosingRequestSchema.safeParse({ closingDate: closing }); if (!parsed.success) throw new Error('Informe uma data válida no formato AAAA-MM-DD.'); await api.request(`${root}/${clientId}/closing`, { method: 'PUT', body: parsed.data }); }, 'Encerramento agendado.')} />{detail.closingDate && <Action plain label="Desmarcar encerramento" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/${clientId}/closing`, { method: 'DELETE' }); }, 'Encerramento desmarcado.')} />}{confirmArchive ? <><Info warning title="Arquivar este cliente agora?" text="O portal será bloqueado e os conteúdos futuros serão cancelados. Reativar o cliente não restaura esses conteúdos automaticamente." /><Action label="Confirmar arquivamento" busy={busy} onPress={() => void run(async () => { await api.request(`${root}/${clientId}/archive`, { method: 'POST' }); await onChanged(); setConfirmArchive(false); }, 'Cliente arquivado.')} /><Action plain label="Manter cliente ativo" onPress={() => setConfirmArchive(false)} /></> : <Action plain label="Arquivar cliente" onPress={() => setConfirmArchive(true)} />}</Card>}
        </>}
        {tab === 'brand' && <BrandStudy root={`${root}/${clientId}`} canEdit={editable && has('cliente.operar')} />}
        {tab === 'access' && has('cliente.convidar_usuario') && <ClientAccess root={`${root}/${clientId}`} permissions={permissions} readOnly={readOnly} />}
      </>}
      <Action plain label="Ver toda a carteira" onPress={() => { setClientId(''); setConfirmArchive(false); }} />
    </>}
  </View>;
}
