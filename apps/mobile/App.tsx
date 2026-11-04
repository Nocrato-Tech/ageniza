import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Sora_600SemiBold } from '@expo-google-fonts/sora/600SemiBold';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import type { Context } from '@ageniza/contracts';
import { api, browserPreview } from './src/api/runtime';
import { ApiError } from './src/api/client';
import { EntryScreen, Login } from './src/auth/EntryScreen';
import { listContexts, resolveEntry, selectContext } from './src/auth/session';
import type { Entry } from './src/auth/session';
import { Button, Copy, Notice, styles, ThemeContext } from './src/ui/components';
import { dark, light, space } from './src/ui/theme';
import { MobileApp } from './src/product/MobileApp';

export default function App() {
  const [fonts, fontError] = useFonts({ Sora: Sora_600SemiBold, Inter: Inter_400Regular, InterSemi: Inter_600SemiBold });
  const [entry, setEntry] = useState<Entry | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [demo, setDemo] = useState(browserPreview);
  const generation = useRef(0);
  const pending = useRef(false);
  const checking = useRef(false);
  const active = entry?.kind === 'active';
  const t = active && entry.context.type === 'agency' ? dark : light;
  const expire = useCallback(() => { generation.current += 1; setEntry(null); setRestoring(false); setError(''); }, []);
  async function resolve() {
    const current = generation.current;
    const next = await resolveEntry(api);
    if (generation.current === current) { setEntry(next); setError(''); }
  }
  useEffect(() => {
    api.onExpired(expire);
    if (browserPreview) { setRestoring(false); return; }
    void resolve().catch((cause: unknown) => {
      if (!(cause instanceof ApiError && cause.status === 401)) setError(cause instanceof Error ? cause.message : 'Não foi possível recuperar sua sessão.');
    }).finally(() => setRestoring(false));
    return () => { api.onExpired(() => {}); generation.current += 1; };
  }, [expire]);
  useEffect(() => {
    if (!entry || demo) return;
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
  }, [entry, expire, demo]);
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
    await api.request('/auth/logout', { method: 'POST' });
    await api.clearSession(); expire();
  }
  if (!fonts && !fontError) return <SafeAreaProvider><View style={{ flex: 1, justifyContent: 'center', backgroundColor: light.canvas }}><ActivityIndicator accessibilityLabel="Carregando fontes" color={light.action} /></View></SafeAreaProvider>;
  return <SafeAreaProvider>{demo ? <MobileApp onExit={() => setDemo(false)} /> : entry?.kind === 'active' ? <MobileApp key={`${entry.context.type}:${entry.context.type === 'agency' ? entry.context.agencyId : entry.context.clientId}`} context={entry.context} onExit={logout} onContext={async () => { setEntry(await listContexts(api)); }} /> : <ThemeContext.Provider value={light}><SafeAreaView style={[styles.page, { backgroundColor: light.canvas }]}>
    <StatusBar style={t === dark ? 'light' : 'dark'} />
    {!fonts && !fontError || restoring ? <View style={[styles.body, { justifyContent: 'center' }]}><ActivityIndicator accessibilityLabel="Abrindo Ageniza" color={t.action} /></View> : <>
      {entry && <View style={{ paddingHorizontal: space.xl, paddingVertical: space.md, gap: space.md, borderBottomWidth: 1, borderColor: t.border }}>
        <Copy title>Ageniza</Copy>
        <View style={styles.row}>{active && <View style={{ flex: 1 }}><Button secondary disabled={busy} label="Trocar acesso" onPress={() => void run(async () => { const next = await listContexts(api); setEntry(next); })} /></View>}<View style={{ flex: 1 }}><Button secondary label="Sair" busy={busy} onPress={() => void run(logout)} /></View></View>
      </View>}
      {error && <ScrollView style={{ maxHeight: 120 }} contentContainerStyle={{ padding: space.lg }}><Notice message={error} /></ScrollView>}
      {!entry ? <Login onLogin={resolve} onDemo={() => setDemo(true)} /> : <EntryScreen key={entry.kind} entry={entry} busy={busy} onSelect={select} onContinue={resolve} />}
    </>}
  </SafeAreaView></ThemeContext.Provider>}</SafeAreaProvider>;
}
