import { ApprovalScreen } from './src/auth/ApprovalScreen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, ScrollView, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import Sora_600SemiBold from './assets/fonts/Sora-SemiBold.ttf';
import Inter_400Regular from './assets/fonts/Inter-Regular.ttf';
import Inter_600SemiBold from './assets/fonts/Inter-SemiBold.ttf';
import type { Context } from '@ageniza/contracts';
import { api, browserPreview, webUrl } from './src/api/runtime';
import { ApiError } from './src/api/client';
import { EntryScreen, Login } from './src/auth/EntryScreen';
import { listContexts, resolveEntry, selectContext } from './src/auth/session';
import type { Entry } from './src/auth/session';
import { Button, Copy, Notice, styles, ThemeContext } from './src/ui/components';
import { dark, light, space } from './src/ui/theme';
import { MobileApp } from './src/product/MobileApp';
import { logoutLocally } from './src/auth/logout';
import { AccountAction } from './src/auth/AccountAction';
import { parseAccountLink } from './src/auth/links';
import type { AccountLink } from './src/auth/links';

export default function App() {
  const [fonts, fontError] = useFonts({ Sora: Sora_600SemiBold, Inter: Inter_400Regular, InterSemi: Inter_600SemiBold });
  const [entry, setEntry] = useState<Entry | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreFailure, setRestoreFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accountLink, setAccountLink] = useState<AccountLink | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const checking = useRef(false);
  const resolvingAccess = useRef(false);
  const active = entry?.kind === 'active';
  const t = active && entry.context.type === 'agency' ? dark : light;
  const expire = useCallback(() => { generation.current += 1; setEntry(null); setRestoring(false); setRestoreFailure(''); setError(''); }, []);
  useEffect(() => {
    let alive = true;
    const receive = (url: string) => { const link = parseAccountLink(url, webUrl); if (alive && link) { if (typeof window !== 'undefined' && window.location) { if (link.kind === 'approval' && window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search); else if (link.kind === 'verify' && window.location.pathname === '/app-mobile/') window.history.replaceState(null, '', window.location.pathname); } setAccountLink(link); } };
    void Linking.getInitialURL().then((url) => { if (url) receive(url); }).catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url));
    return () => { alive = false; subscription.remove(); };
  }, []);
  async function resolve(preferred?: string): Promise<Entry> {
    const current = generation.current;
    const next = await resolveEntry(api, preferred);
    if (generation.current === current) { setEntry(next); setError(''); setRestoreFailure(''); }
    return next;
  }
  async function restore() {
    setRestoring(true);
    try { await resolve(); }
    catch (cause) { if (!(cause instanceof ApiError && cause.status === 401)) setRestoreFailure(cause instanceof Error ? cause.message : 'Não foi possível recuperar sua sessão.'); }
    finally { setRestoring(false); }
  }
  useEffect(() => {
    api.onExpired(expire);
    api.onAccessRequired(() => {
      if (resolvingAccess.current) return;
      resolvingAccess.current = true; generation.current += 1; setEntry(null);
      void restore().finally(() => { resolvingAccess.current = false; });
    });
    if (browserPreview) { setRestoring(false); return; }
    void restore();
    return () => { api.onExpired(() => {}); api.onAccessRequired(() => {}); generation.current += 1; };
  }, [expire]);
  useEffect(() => {
    if (!entry) return;
    let alive = true;
    const check = async () => {
      if (!alive || checking.current || AppState.currentState !== 'active') return;
      checking.current = true;
      try { await api.request('/auth/session/check'); }
      catch (cause) { if (alive && cause instanceof ApiError && cause.status === 401) expire(); }
      finally { checking.current = false; }
    };
    const timer = setInterval(() => void check(), 45_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void check(); });
    return () => { alive = false; clearInterval(timer); subscription.remove(); };
  }, [entry, expire]);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir. Tente de novo.'); }
    finally { pending.current = false; setBusy(false); }
  }
  const select = (context: Context) => void run(async () => {
    const current = generation.current;
    const next = await selectContext(api, context);
    if (current === generation.current) setEntry(next);
  });
  async function logout() {
    try {
      const result = await logoutLocally(api, expire);
      if (result.revocationFailed) setError('Você saiu deste aparelho. A conexão falhou ao encerrar a sessão no servidor.');
    } catch { setError('O acesso foi bloqueado neste app, mas não foi possível apagar o armazenamento seguro. Tente sair novamente antes de compartilhar o aparelho.'); }
  }
  if (!fonts && !fontError) return <SafeAreaProvider><View style={{ flex: 1, justifyContent: 'center', backgroundColor: light.canvas }}><ActivityIndicator accessibilityLabel="Carregando fontes" color={light.action} /></View></SafeAreaProvider>;
  return <SafeAreaProvider>{accountLink ? <SafeAreaView style={{ flex: 1, backgroundColor: light.canvas }}>{accountLink.kind === 'approval' ? <ApprovalScreen key={accountLink.token} token={accountLink.token} onClose={() => setAccountLink(null)} /> : <AccountAction key={`${accountLink.kind}:${accountLink.token}`} link={accountLink} onDone={async (preferred) => { await resolve(preferred); setAccountLink(null); }} onClose={() => { setAccountLink(null); expire(); if (!browserPreview) void restore(); }} />}</SafeAreaView> : entry?.kind === 'active' ? <MobileApp key={`${entry.context.type}:${entry.context.type === 'agency' ? entry.context.agencyId : entry.context.clientId}`} context={entry.context} onExit={logout} onContext={async () => { setEntry(await listContexts(api)); }} /> : <ThemeContext.Provider value={light}><SafeAreaView style={[styles.page, { backgroundColor: light.canvas }]}>
    <StatusBar style={t === dark ? 'light' : 'dark'} />
    {!fonts && !fontError || restoring ? <View style={[styles.body, { justifyContent: 'center' }]}><ActivityIndicator accessibilityLabel="Abrindo Ageniza" color={t.action} /></View> : <>
      {entry && <View style={{ paddingHorizontal: space.xl, paddingVertical: space.md, gap: space.md, borderBottomWidth: 1, borderColor: t.border }}>
        <Copy title>Ageniza</Copy>
        <View style={styles.row}>{active && <View style={{ flex: 1 }}><Button secondary disabled={busy} label="Trocar acesso" onPress={() => void run(async () => { const next = await listContexts(api); setEntry(next); })} /></View>}<View style={{ flex: 1 }}><Button secondary label="Sair" busy={busy} onPress={() => void run(logout)} /></View></View>
      </View>}
      {error && <ScrollView style={{ maxHeight: 120 }} contentContainerStyle={{ padding: space.lg }}><Notice message={error} /></ScrollView>}
      {restoreFailure ? <View style={styles.body}><Copy title>Vamos recuperar seu acesso</Copy><Notice message={restoreFailure} /><Button label="Tentar novamente" onPress={() => void restore()} /><Button secondary label="Sair deste aparelho" onPress={() => void logout()} /></View> : !entry ? <Login onLogin={async () => { await resolve(); }} onLink={setAccountLink} /> : <EntryScreen key={entry.kind} entry={entry} busy={busy} onSelect={select} onContinue={resolve} onLink={setAccountLink} />}
    </>}
  </SafeAreaView></ThemeContext.Provider>}</SafeAreaProvider>;
}
