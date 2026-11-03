import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CalendarDays, ChevronRight, Heart, MessageCircle, Send } from 'lucide-react-native';
import { Button, Copy, Field, Notice, styles, ThemeContext } from '../ui/components';
import { dark, light, space } from '../ui/theme';
import { monthPeriod, statusNames } from '../contents/period';
import { decidePost, demoClients, initialPosts } from './model';
import type { DemoPost } from './model';

export function DemoApp({ onExit }: { onExit(): void }) {
  const [side, setSide] = useState<'agency' | 'client'>('agency');
  const [clientId, setClientId] = useState('vida');
  const [screen, setScreen] = useState<'clients' | 'contents' | 'detail' | 'create'>('clients');
  const [posts, setPosts] = useState(initialPosts);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [day, setDay] = useState('15');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const t = side === 'agency' ? dark : light;
  const client = demoClients.find((item) => item.id === clientId)!;
  const post = posts.find((item) => item.id === selectedId);
  const period = monthPeriod();
  const clientPosts = posts.filter((item) => item.clientId === clientId).sort((a, b) => a.day - b.day);
  const pending = clientPosts.filter((item) => item.status === 'awaiting_approval').length;
  function navigate(next: typeof screen) { setScreen(next); setError(''); setNotice(''); setComment(''); }
  function switchSide() {
    setSide(side === 'agency' ? 'client' : 'agency');
    navigate('contents');
  }
  function decide(action: 'submit' | 'approve' | 'changes') {
    if (!post) return;
    if (action === 'changes' && !comment.trim()) { setError('Escreva o que precisa ser ajustado.'); return; }
    setPosts((current) => decidePost(current, post.id, action, comment));
    setError(''); setComment('');
    setNotice(action === 'approve' ? 'Conteúdo aprovado na demonstração.' : action === 'changes' ? 'Pedido de ajuste enviado na demonstração.' : 'Conteúdo enviado para aprovação na demonstração.');
  }
  function create() {
    const lastDay = Number(period.to.slice(-2));
    if (!title.trim() || !/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > lastDay) { setError(`Informe um título e um dia entre 1 e ${lastDay}.`); return; }
    const next: DemoPost = { id: `demo-${Date.now()}`, clientId, title: title.trim(), caption: caption.trim(), day: Number(day), status: 'in_production' };
    setPosts((current) => [...current, next]); setSelectedId(next.id); setTitle(''); setCaption(''); navigate('detail');
    setNotice('Conteúdo criado apenas nesta demonstração.');
  }
  return <ThemeContext.Provider value={t}><SafeAreaView style={[styles.page, { backgroundColor: t.canvas }]}>
    <StatusBar style={side === 'agency' ? 'light' : 'dark'} />
    <View style={{ padding: space.lg, gap: space.sm, borderBottomWidth: 1, borderColor: t.border }}>
      <Copy>Demonstração · dados fictícios</Copy>
      <View style={styles.row}><View style={{ flex: 1 }}><Button secondary label={side === 'agency' ? 'Testar como cliente' : 'Testar como agência'} onPress={switchSide} /></View><Button secondary label="Sair do teste" onPress={onExit} /></View>
    </View>
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Copy muted>Você está como {side === 'agency' ? 'agência de demonstração' : `cliente: ${client.name}`}. As alterações são apagadas ao sair ou recarregar.</Copy>
      {(screen === 'detail' || screen === 'create' || screen === 'contents' && side === 'agency') && <Button secondary label={screen === 'detail' || screen === 'create' ? 'Voltar para conteúdos' : 'Ver clientes'} onPress={() => navigate(screen === 'detail' || screen === 'create' ? 'contents' : 'clients')} />}
      {screen === 'clients' && <>
        <Copy title>Seus clientes</Copy><Field label="Buscar cliente de demonstração" value={search} onChangeText={setSearch} />
        {demoClients.filter((item) => item.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))).map((item) => <Pressable accessibilityRole="button" accessibilityLabel={`Abrir ${item.name}`} key={item.id} onPress={() => { setClientId(item.id); navigate('contents'); }} style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <View style={styles.row}><View style={{ flex: 1 }}><Copy title>{item.name}</Copy><Copy muted>@{item.handle}</Copy></View><ChevronRight color={t.muted} /></View>
          <Copy muted>{posts.filter((entry) => entry.clientId === item.id && entry.status === 'awaiting_approval').length} conteúdos aguardando o cliente</Copy>
        </Pressable>)}
        {search && !demoClients.some((item) => item.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))) && <Copy>Nenhum cliente encontrado. Tente outro nome.</Copy>}
      </>}
      {screen === 'contents' && <>
        <Copy title>{client.name}</Copy><View style={styles.row}><CalendarDays color={t.muted} size={20} /><Copy>{period.label}</Copy></View>
        <Copy muted>{pending ? `${pending} conteúdos aguardando aprovação` : 'Nenhuma aprovação pendente'}</Copy>
        {side === 'agency' && <Button label="Criar conteúdo de teste" onPress={() => navigate('create')} />}
        {clientPosts.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Abrir ${item.title}`} onPress={() => { setSelectedId(item.id); navigate('detail'); }} style={[styles.divider, { borderColor: t.border }]}>
          <Copy muted>{String(item.day).padStart(2, '0')}/{period.from.slice(5, 7)} · Instagram</Copy><Copy title>{item.title}</Copy><Copy muted>{statusNames[item.status]}</Copy><Copy>Ver conteúdo</Copy>
        </Pressable>)}
      </>}
      {screen === 'create' && <>
        <Copy title>Novo conteúdo de teste</Copy><Field label="Título" value={title} maxLength={120} onChangeText={setTitle} /><Field label="Dia da publicação" value={day} keyboardType="number-pad" onChangeText={setDay} maxLength={2} />
        <Field label="Legenda" value={caption} onChangeText={setCaption} multiline maxLength={2200} style={{ minHeight: 120 }} />
        {error && <Notice message={error} />}<Button label="Criar rascunho" onPress={create} />
      </>}
      {screen === 'detail' && post && <>
        <Copy title>{post.title}</Copy><Copy muted>{statusNames[post.status]}</Copy>
        {side === 'client' && post.status === 'in_production' ? <Copy>A agência está preparando este conteúdo. A legenda e a prévia ficarão disponíveis quando ele for enviado para aprovação.</Copy> : <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Copy>@{client.handle}</Copy>
          <View style={{ minHeight: 260, backgroundColor: t.canvas, padding: space.xl, justifyContent: 'center', gap: space.lg }}><Copy muted>Capa ilustrativa · sem mídia enviada</Copy><Copy title>{post.title}</Copy><Copy>{client.name}</Copy></View>
          <View style={styles.row}><Heart color={t.text} size={22} /><MessageCircle color={t.text} size={22} /><Send color={t.text} size={22} /></View>
          <Copy>{post.caption || 'Sem legenda.'}</Copy>
        </View>}
        {post.feedback && <View style={{ gap: space.sm }}><Copy>Ajuste solicitado</Copy><Copy>{post.feedback}</Copy></View>}
        {notice && <Copy>{notice}</Copy>}
        {side === 'agency' && ['in_production', 'adjusting'].includes(post.status) && <Button label="Simular envio para aprovação" onPress={() => decide('submit')} />}
        {side === 'client' && post.status === 'awaiting_approval' && <>
          <Button label="Aprovar conteúdo de teste" onPress={() => decide('approve')} />
          <Field label="O que precisa ser ajustado?" value={comment} onChangeText={setComment} multiline maxLength={1000} />
          {error && <Notice message={error} />}<Button secondary label="Pedir ajuste no teste" onPress={() => decide('changes')} />
        </>}
      </>}
    </ScrollView>
  </SafeAreaView></ThemeContext.Provider>;
}
