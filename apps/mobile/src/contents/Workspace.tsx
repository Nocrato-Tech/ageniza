import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react-native';
import type { AgencyMeResponse, ClientListItem, ClientListResponse, Context, ContentListItem, ContentPeriodResponse, PortalContentPeriodResponse } from '@ageniza/contracts';
import { api, webUrl } from '../api/runtime';
import { Button, Copy, Empty, Field, Notice, styles, useTheme } from '../ui/components';
import { space } from '../ui/theme';
import { displayDay, formatNames, monthPeriod, statusNames } from './period';

export function Workspace({ context }: { context: Context }) {
  const t = useTheme();
  const [client, setClient] = useState<ClientListItem | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ClientListResponse | null>(null);
  const [contents, setContents] = useState<Pick<ContentListItem, 'id' | 'title' | 'format' | 'status' | 'publishOn'>[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const period = monthPeriod(offset);
  const listingClients = context.type === 'agency' && !client;
  const clientId = context.type === 'client' ? context.clientId : client?.id;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setResult(null); setContents(null);
    async function load() {
      try {
        if (context.type === 'agency') {
          const agency = await api.request<AgencyMeResponse>(`/agencies/${context.agencyId}/me`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setReadOnly(agency.plan.readOnly);
          if (!agency.permissions.includes('cliente.visualizar')) throw new Error('Seu acesso não permite consultar os clientes desta agência.');
          if (listingClients) {
            const data = await api.request<ClientListResponse>(`/agencies/${context.agencyId}/clients?page=${page}&pageSize=20${query ? `&search=${encodeURIComponent(query)}` : ''}`, { signal: controller.signal });
            if (!controller.signal.aborted) setResult(data);
          } else {
            if (!agency.permissions.includes('conteudo.visualizar')) throw new Error('Seu acesso não permite consultar conteúdos.');
            const data = await api.request<ContentPeriodResponse>(`/agencies/${context.agencyId}/clients/${clientId}/contents?from=${period.from}&to=${period.to}`, { signal: controller.signal });
            if (!controller.signal.aborted) setContents(data.data.contents.filter((item) => item.status !== 'cancelled'));
          }
        } else {
          const data = await api.request<PortalContentPeriodResponse>(`/clients/${context.clientId}/contents?from=${period.from}&to=${period.to}`, { signal: controller.signal });
          if (!controller.signal.aborted) setContents(data.data);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar. Tente de novo.');
      } finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void load();
    return () => controller.abort();
  }, [context, listingClients, clientId, page, query, period.from, period.to, revision]);
  function refresh() { setRevision((value) => value + 1); }
  return <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={t.muted} />} keyboardShouldPersistTaps="handled">
    {readOnly && <Copy muted>Agência em modo leitura. Consulte a assinatura no site para renovar o acesso às alterações.</Copy>}
    {!listingClients && context.type === 'agency' && <Button secondary label="Voltar para clientes" onPress={() => { setClient(null); setOffset(0); }} />}
    <Copy title>{listingClients ? 'Seus clientes' : context.type === 'client' ? 'Conteúdos da sua marca' : client?.name}</Copy>
    {listingClients ? <View style={{ gap: space.md }}><Field label="Buscar cliente" value={search} onChangeText={setSearch} autoCorrect={false} returnKeyType="search" onSubmitEditing={() => { setQuery(search.trim()); setPage(1); }} /><Button secondary label="Buscar" onPress={() => { setQuery(search.trim()); setPage(1); }} /></View> : <View style={[styles.row, { justifyContent: 'space-between' }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Mês anterior" onPress={() => setOffset(offset - 1)} style={{ padding: space.md }}><ChevronLeft color={t.text} /></Pressable>
      <Copy>{period.label}</Copy>
      <Pressable accessibilityRole="button" accessibilityLabel="Próximo mês" onPress={() => setOffset(offset + 1)} style={{ padding: space.md }}><ChevronRight color={t.text} /></Pressable>
    </View>}
    {busy && <ActivityIndicator accessibilityLabel="Carregando" color={t.action} />}
    {error && <View style={{ gap: space.md }}><Notice message={error} /><Button secondary label="Tentar de novo" onPress={refresh} /></View>}
    {!busy && !error && listingClients && result && <>
      {result.data.length === 0 ? <Empty title="Nenhum cliente por aqui" body={query ? 'Tente buscar outro nome.' : 'Cadastre seu primeiro cliente pelo site para começar.'} onRetry={refresh} /> : result.data.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Abrir conteúdos de ${item.name}`} onPress={() => { setClient(item); setOffset(0); }} style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
        <View style={styles.row}><FolderOpen color={t.muted} size={20} /><View style={{ flex: 1, gap: space.xs }}><Copy title>{item.name}</Copy><Copy muted>{item.instagramHandle ? `@${item.instagramHandle}` : 'Cliente da agência'}</Copy></View><ChevronRight color={t.muted} size={20} /></View>
        <Copy muted>{item.threadsAwaitingAgency ? `${item.threadsAwaitingAgency} conversas esperando a agência` : 'Abrir conteúdos'}</Copy>
      </Pressable>)}
      <View style={[styles.row, { justifyContent: 'space-between' }]}><Button secondary disabled={page <= 1} label="Anterior" onPress={() => setPage(page - 1)} /><Copy>{page} / {Math.max(1, result.meta.totalPages)}</Copy><Button secondary disabled={page >= result.meta.totalPages} label="Próxima" onPress={() => setPage(page + 1)} /></View>
    </>}
    {!busy && !error && contents && <>
      {contents.length === 0 ? <Empty title="Nenhum conteúdo neste mês" body="Mude o mês para consultar o planejamento ou atualize para conferir novidades." onRetry={refresh} /> : contents.map((item) => <View key={item.id} style={[styles.divider, { borderColor: t.border }]}>
        <Copy muted>{displayDay(item.publishOn)} · {formatNames[item.format]}</Copy><Copy title>{item.title}</Copy><Copy muted>{statusNames[item.status]}</Copy>
        <Button secondary label="Ver conteúdo no site" onPress={() => void Linking.openURL(context.type === 'client' ? `${webUrl}/portal/${context.clientId}/conteudos/${item.id}` : `${webUrl}/agencia/${context.agencyId}/conteudos/${clientId}/${item.id}`)} />
      </View>)}
    </>}
  </ScrollView>;
}
