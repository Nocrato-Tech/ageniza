import { ScreenMotion, Touch, useReducedMotion } from './motion';
import { LiquidIndicator } from './motion/LiquidIndicator';
import { navigateSelection, useSelectionMotion } from './SelectionMotion';
import { OverlayMotion } from './OverlayMotion';
import { motionTokens } from './motion/tokens';
import { HugeIcon } from './HugeIcon';
import { createContext, forwardRef, useContext, useEffect, useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps, ViewStyle } from 'react-native';
import { ArrowLeft, Bell, Bookmark, Check, ChevronRight, Clock, Heart, Image as ImageIcon, MessageCircle, MoreHorizontal, Pencil, Send, X } from './icons';
import type { IconComponent } from './icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import type { Asset, Client, Post, Repository } from './types';
import { initials } from './types';
import { displayDay, formatNames } from '../contents/period';
import brand from '../../assets/figma/imgMarcaReferenciaOriginal.png';

export const colors = { canvas: '#F8FAFC', surface: '#FFFFFF', text: '#111827', muted: '#617087', border: '#E8ECF4', indigo: '#4F46E5', soft: '#EEF2FF', teal: '#0F766E', softTeal: '#E6F8F5', violet: '#7C3AED', softViolet: '#F3ECFF', amber: '#B45309', softAmber: '#FFF7ED', navy: '#1D2740', danger: '#B42318' };
export const ProductTheme = createContext(colors);
export const useColors = () => useContext(ProductTheme);
export function Txt({ children, kind = 'body', color, lines, center = false }: { children: ReactNode; kind?: 'title' | 'section' | 'body' | 'strong' | 'small' | 'label' | 'micro'; color?: string; lines?: number; center?: boolean }) {
  const c = useColors();
  return <Text numberOfLines={lines} style={[type[kind], { color: color ?? c.text, textAlign: center ? 'center' : 'left' }]}>{children}</Text>;
}
const fontFamily = (name: string) => Platform.OS === 'web' ? `${name}, system-ui, sans-serif` : name;
const type = StyleSheet.create({ title: { fontFamily: fontFamily('Sora'), fontSize: 26, lineHeight: 34 }, section: { fontFamily: fontFamily('Sora'), fontSize: 18, lineHeight: 26 }, body: { fontFamily: fontFamily('Inter'), fontSize: 14, lineHeight: 21 }, strong: { fontFamily: fontFamily('InterSemi'), fontSize: 14, lineHeight: 21 }, small: { fontFamily: fontFamily('Inter'), fontSize: 12, lineHeight: 18 }, label: { fontFamily: fontFamily('InterSemi'), fontSize: 12, lineHeight: 18 }, micro: { fontFamily: fontFamily('Inter'), fontSize: 10, lineHeight: 14 } });
export const ui = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, stack: { gap: 16 }, body: { padding: 20, paddingTop: 8, gap: 16, paddingBottom: 32 }, card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap: 12 }, line: { height: 1, backgroundColor: colors.border }, field: { minHeight: 48, padding: 14, borderWidth: 1, borderRadius: 16, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontFamily: fontFamily('Inter'), fontSize: 16, lineHeight: 24 }, icon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface } });
export function Card({ children, onPress, label, style }: { children: ReactNode; onPress?(): void; label?: string; style?: ViewStyle }) { const c = useColors(); const base = [ui.card, { backgroundColor: c.surface, borderColor: c.border }, style]; return onPress ? <Touch accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={base}>{children}</Touch> : <View style={base}>{children}</View>; }
export function Action({ label, onPress, soft = false, plain = false, disabled = false, busy = false }: { label: string; onPress(): void; soft?: boolean; plain?: boolean; disabled?: boolean; busy?: boolean }) { const c = useColors(); const foreground = plain || soft ? c.indigo : '#FFFFFF'; return <Touch accessibilityRole="button" accessibilityLabel={label} aria-busy={busy} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress} style={{ minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: plain ? 'transparent' : soft ? c.soft : c.indigo, opacity: disabled ? 0.45 : 1 }}><View style={[ui.row, { justifyContent: 'center', gap: 8 }]}>{busy && <ActivityIndicator color={foreground} size="small" />}<View style={{ flexShrink: 1 }}><Txt kind="strong" color={foreground} center>{label}</Txt></View></View></Touch>; }
export function IconButton({ icon: Icon, label, onPress }: { icon: IconComponent; label: string; onPress(): void }) {
  const c = useColors();
  return <Touch accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[ui.icon, { backgroundColor: c.surface }]}><Icon size={22} color={c.muted} /></Touch>;
}
export function Avatar({ name, size = 40, accent = false, imageUrl }: { name: string; size?: number; accent?: boolean; imageUrl?: string | null }) { const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [imageUrl]); if (imageUrl && !failed) return <Image accessibilityLabel={`Foto de ${name}`} source={{ uri: imageUrl }} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2 }} />; return <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: accent ? colors.soft : colors.softTeal }}><Txt kind="label" color={accent ? colors.indigo : colors.teal}>{initials(name)}</Txt></View>; }
export function Header({ title, onBack, clientName, profileName = 'Você', onNotifications, onProfile, contextLabel, contextType, onContext }: { title?: string; onBack?(): void; clientName?: string; profileName?: string; onNotifications?(): void; onProfile?(): void; contextLabel?: string; contextType?: 'agency' | 'client'; onContext?(): void }) {
  const c = useColors();
  const activeLabel = contextLabel ?? clientName;
  const typeLabel = contextType === 'client' || contextType === undefined && clientName ? 'Portal' : 'Agência';
  const context = activeLabel && <View style={{ flex: 1, minWidth: 0 }}><Txt kind="label" color={c.muted}>{typeLabel}</Txt><Txt kind="strong" lines={1}>{activeLabel}</Txt></View>;
  return <View style={[ui.row, { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18, minHeight: 78, justifyContent: 'space-between' }]}>
    {onBack ? <IconButton icon={ArrowLeft} label="Voltar" onPress={onBack} /> : activeLabel ? onContext ? <Pressable accessibilityRole="button" accessibilityLabel={`Trocar agência ou portal. ${typeLabel}: ${activeLabel}`} onPress={onContext} style={[ui.row, { flex: 1, minWidth: 0, minHeight: 44 }]}>{context}<ChevronRight color={c.muted} size={18} /></Pressable> : context : <View style={ui.row}><View style={{ width: 30, height: 30, overflow: 'hidden', borderRadius: 8 }}><Image source={brand} style={{ width: 236, height: 177, position: 'absolute', left: -20, top: -5 }} /></View><Txt kind="section">Ageniza</Txt></View>}
    {!!title && <View style={{ flex: 1 }}><Txt kind="strong" center>{title}</Txt></View>}
    <View style={ui.row}>{onNotifications && <IconButton icon={Bell} label="Notificações" onPress={onNotifications} />}{onProfile && <Pressable accessibilityRole="button" accessibilityLabel="Minha conta" onPress={onProfile} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Avatar name={profileName} size={32} accent /></Pressable>}{!onProfile && !onNotifications && <View style={{ width: 44 }} />}</View>
  </View>;
}
export function Heading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) { const c = useColors(); return <View style={{ gap: 4 }}><View style={[ui.row, { justifyContent: 'space-between' }]}><View style={{ flex: 1 }}><Txt kind="title">{title}</Txt></View>{action}</View>{!!subtitle && <Txt color={c.muted}>{subtitle}</Txt>}</View>; }
export const Field = forwardRef<TextInput, TextInputProps & { label: string; error?: string; hint?: string; trailing?: ReactNode; 'aria-describedby'?: string }>(function Field({ label, error, hint, trailing, ...props }, ref) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  const reduced = useReducedMotion();
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : '', props['aria-describedby'] ?? ''].filter(Boolean).join(' ') || undefined;
  return <View style={{ gap: 8 }}><Txt kind="label" color={c.muted}>{label}</Txt><View style={{ position: 'relative' }}><TextInput ref={ref} nativeID={props.nativeID ?? id} accessibilityLabel={label} placeholderTextColor={c.muted} {...props} aria-invalid={!!error} aria-describedby={describedBy} onFocus={(event) => { setFocused(true); props.onFocus?.(event); }} onBlur={(event) => { setFocused(false); props.onBlur?.(event); }} style={[ui.field, { backgroundColor: c.surface, color: c.text, borderColor: error ? c.danger : focused ? c.indigo : c.muted }, Platform.OS === 'web' ? { transitionProperty: 'border-color', transitionDuration: reduced ? '0ms' : `${motionTokens.fast}ms`, transitionTimingFunction: motionTokens.easing } as ViewStyle : undefined, trailing ? { paddingRight: 56 } : undefined, props.style]} />{trailing && <View style={{ position: 'absolute', right: 4, top: 0, bottom: 0, justifyContent: 'center' }}>{trailing}</View>}</View>{!!hint && <Text nativeID={`${id}-hint`} style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{hint}</Text>}{!!error && <View nativeID={`${id}-error`}><ErrorText text={error} /></View>}</View>;
});
export function ErrorText({ text }: { text: string }) {
  const c = useColors();
  return <ScreenMotion identity={text} variant="feedback"><View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}><View style={{ paddingTop: 2 }}><HugeIcon name="alert-circle" size={18} color={c.danger} trigger /></View><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flex: 1, fontFamily: fontFamily('Inter'), color: c.danger, fontSize: 14, lineHeight: 21 }}>{text}</Text></View></ScreenMotion>;
}
export function Info({ title, text, warning = false, tone = warning ? 'warning' : 'info', onDismiss }: { title: string; text?: string; warning?: boolean; tone?: 'info' | 'warning' | 'success'; onDismiss?(): void }) {
  const c = useColors();
  const foreground = tone === 'success' ? c.teal : tone === 'warning' ? c.amber : c.indigo;
  return <ScreenMotion identity={`${tone}:${title}`} variant="feedback" quiet={tone === 'info'}><View role={tone === 'success' ? 'status' : undefined} accessibilityLiveRegion={tone === 'success' ? 'polite' : undefined} style={{ backgroundColor: tone === 'success' ? c.softTeal : tone === 'warning' ? c.softAmber : c.soft, padding: 16, borderRadius: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
    {tone !== 'info' && <View style={{ paddingTop: 1 }}><HugeIcon name={tone === 'success' ? 'tick-02' : 'alert-circle'} size={20} color={foreground} trigger /></View>}
    <View style={{ flex: 1, gap: 4 }}><Txt kind="strong" color={foreground}>{title}</Txt>{!!text && <Txt kind="small" color={foreground}>{text}</Txt>}</View>
    {onDismiss && <Pressable accessibilityRole="button" accessibilityLabel="Dispensar mensagem" onPress={onDismiss} hitSlop={8} style={{ minWidth: 44, minHeight: 44, marginTop: -12, marginBottom: -12, marginRight: -12, alignItems: 'center', justifyContent: 'center' }}><X size={18} color={foreground} /></Pressable>}
  </View></ScreenMotion>;
}
export function Tabs({ options, value, onChange }: { options: { id: string; label: string }[]; value: string; onChange(id: string): void }) {
  const c = useColors();
  const [width, setWidth] = useState(320);
  const selection = useSelectionMotion(value);
  const scrollable = options.length > 3;
  const cell: ViewStyle = { ...(scrollable ? { width: Math.max(104, (width - 12) / 2.6), flexShrink: 0 } : { flex: 1 }), minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center', alignItems: 'center', borderRadius: 14 };
  const hasIndicator = Platform.OS === 'web' && !!selection.target;
  const tabs = <View role="tablist" {...selection.inputHandlers} style={{ flexDirection: 'row', gap: 6, position: 'relative' }}>
    {options.map((option) => <Pressable key={option.id} {...({ onKeyDown: (event: KeyboardEvent<HTMLElement>) => navigateSelection(event, options.map((item) => item.id), option.id, onChange) } as object)} tabIndex={value === option.id ? 0 : -1} accessibilityRole="tab" accessibilityLabel={option.label} accessibilityState={{ selected: value === option.id }} aria-selected={value === option.id} onLayout={(event) => selection.measure(option.id, event)} onPress={() => onChange(option.id)} style={[cell, { backgroundColor: value === option.id && !hasIndicator ? c.indigo : c.surface }]}><Txt kind="label" color={value === option.id && !hasIndicator ? '#FFFFFF' : c.muted} center>{option.label}</Txt></Pressable>)}
    {Platform.OS === 'web' && <LiquidIndicator target={selection.target} color={c.indigo} radius={14} immediate={selection.immediate} revision={options.map((option) => option.id).join(':')}>
      <View style={[StyleSheet.absoluteFill, { flexDirection: 'row', gap: 6 }]}>{options.map((option) => <View key={option.id} style={cell}><Txt kind="label" color="#FFFFFF" center>{option.label}</Txt></View>)}</View>
    </LiquidIndicator>}
  </View>;
  return scrollable ? <ScrollView horizontal accessibilityLabel="Abas. Deslize para ver mais opções." onLayout={(event) => setWidth(event.nativeEvent.layout.width)} showsHorizontalScrollIndicator contentContainerStyle={{ paddingRight: 12 }}>{tabs}</ScrollView> : tabs;
}
export function Selector({ label, value, options, onChange }: { label: string; value: string; options: { id: string; label: string }[]; onChange(id: string): void }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const visible = options.length > 8 ? options.filter((option) => normalize(option.label).includes(normalize(search.trim()))) : options;
  return <><View style={{ gap: 8 }}><Txt kind="label" color={c.muted}>{label}</Txt><Touch accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={() => { setSearch(''); setOpen(true); }} style={[ui.field, ui.row, { justifyContent: 'space-between' }]}><View style={{ flex: 1, minWidth: 0 }}><Txt>{options.find((option) => option.id === value)?.label ?? 'Selecionar'}</Txt></View><ChevronRight color={c.muted} size={18} /></Touch></View>
    <OverlayMotion open={open} onClose={() => setOpen(false)} style={{ backgroundColor: c.canvas, maxHeight: '75%', padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: 16 }}><View style={[ui.row, { justifyContent: 'space-between' }]}><View style={{ flex: 1 }}><Txt kind="section">{label}</Txt></View><IconButton icon={X} label="Fechar opções" onPress={() => setOpen(false)} /></View>
      {options.length > 8 && <Field label={`Buscar ${label}`} value={search} onChangeText={setSearch} autoCorrect={false} />}
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>{visible.map((option) => <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={`Selecionar ${option.label}`} accessibilityState={{ selected: option.id === value, disabled: !open }} disabled={!open} onPress={() => { onChange(option.id); setOpen(false); }} style={[ui.row, { minHeight: 52, paddingVertical: 12, justifyContent: 'space-between', borderBottomWidth: 1, borderColor: c.border }]}><View style={{ flex: 1, minWidth: 0 }}><Txt>{option.label}</Txt></View>{option.id === value && <Check size={18} color={c.indigo} />}</Pressable>)}</ScrollView>
      {!visible.length && <View accessibilityLiveRegion="polite"><Txt color={c.muted}>{options.length ? 'Nenhum resultado. Tente outro termo.' : 'Nenhuma opção disponível.'}</Txt></View>}
    </OverlayMotion></>;
}
export function ClientStrip({ clients, selected, onChange }: { clients: Client[]; selected: string; onChange(id: string): void }) { return <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Clientes. Deslize para ver mais clientes." contentContainerStyle={{ gap: 12, paddingRight: 20 }}>{[{ id: '', name: 'Todos', handle: '' }, ...clients].map((client) => <Pressable key={client.id} accessibilityRole="button" accessibilityLabel={`Filtrar ${client.name}`} accessibilityState={{ selected: client.id === selected }} onPress={() => onChange(client.id)} style={{ alignItems: 'center', width: 72, minHeight: 88, gap: 6 }}><View style={{ padding: 4, borderRadius: 32, borderWidth: client.id === selected ? 2 : 1, borderColor: client.id === selected ? colors.indigo : colors.border, backgroundColor: colors.surface }}><Avatar name={client.name === 'Todos' ? 'T' : client.name} size={48} /></View><Txt kind="small" color={client.id === selected ? colors.indigo : colors.muted} lines={2}>{client.name}</Txt></Pressable>)}</ScrollView>; }
export function Status({ status, client = false }: { status: Post['status']; client?: boolean }) { const states = { in_production: ['Em produção', colors.indigo, colors.soft], awaiting_approval: [client ? 'A aprovar' : 'Em aprovação', colors.amber, colors.softAmber], adjusting: ['Em ajuste', colors.violet, colors.softViolet], approved: [client ? 'Aprovado' : 'Pronto para publicar', colors.teal, colors.softTeal], published: ['Publicado', colors.muted, colors.border], cancelled: ['Cancelado', colors.muted, colors.border] }; const [label, color, bg] = states[status]; return <View style={{ backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' }}><Txt kind="label" color={color}>{label}</Txt></View>; }
export function Cover({ post, asset, repository, width, height, small = false }: { post: Pick<Post, 'title' | 'clientId'> & { id?: string }; asset?: Asset; repository?: Pick<Repository, 'assetUrl'>; width?: number | `${number}%`; height: number; small?: boolean; hideText?: boolean }) {
  const [resolved, setResolved] = useState(asset?.uri);
  useEffect(() => {
    let alive = true; setResolved(asset?.uri);
    if (asset && !asset.uri && repository) void repository.assetUrl(post.clientId, post.id, asset.id, 'thumbnail').then((uri) => { if (alive) setResolved(uri); }).catch(() => {});
    return () => { alive = false; };
  }, [asset?.id, asset?.uri, post.clientId, post.id, repository]);
  return <View style={{ width: width ?? '100%', height, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.border }}>{resolved ? <Image source={{ uri: resolved }} style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]} resizeMode="cover" onError={() => setResolved(undefined)} /> : <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}><ImageIcon size={small ? 18 : 32} color={colors.muted} /></View>}</View>;
}
export function PostCard({ post, client, person, asset, onPress }: { post: Post; client?: Client; person?: string; asset?: Asset; onPress(): void }) { return <Card label={`Abrir ${post.title}`} onPress={onPress} style={{ padding: 12, borderRadius: 18 }}><View style={[ui.row, { alignItems: 'flex-start' }]}><Cover post={post} asset={asset} width={76} height={96} small /><View style={{ flex: 1, gap: 6 }}><Txt kind="small" color={colors.muted}>{client?.name} · {formatNames[post.format]}</Txt><Txt kind="strong">{post.title}</Txt><Txt kind="small" color={colors.muted}>{displayDay(post.date)} · {post.time || 'Sem horário'}</Txt></View></View><View style={[ui.row, { justifyContent: 'space-between' }]}><Status status={post.status} /><Txt kind="small" color={colors.muted}>{person}</Txt></View></Card>; }
function Video({ uri, onError }: { uri: string; onError(): void }) {
  const player = useVideoPlayer(uri);
  useEffect(() => { const subscription = player.addListener('statusChange', ({ status }) => { if (status === 'error') onError(); }); return () => subscription.remove(); }, [player, onError]);
  return <VideoView player={player} style={{ width: '100%', height: 360 }} nativeControls contentFit="contain" />;
}
export function MediaDisplay({ asset, repository, post }: { asset: Asset; repository: Pick<Repository, 'assetUrl'>; post: Post }) {
  const [uri, setUri] = useState(asset.uri);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setError(''); setUri(asset.uri);
    if (!asset.uri) void repository.assetUrl(post.clientId, post.id, asset.id, 'original').then((url) => { if (active) setUri(url); }).catch(() => { if (active) setError('Não foi possível carregar a mídia.'); });
    return () => { active = false; };
  }, [asset.id, asset.uri, asset.sample, post.clientId, post.id, repository, retry]);
  const height = asset.kind === 'video' ? 360 : 410;
  const label = asset.name || post.title;
  return <View accessibilityLabel={`Prévia de ${label}`} style={{ width: '100%', height, justifyContent: 'center', backgroundColor: colors.canvas }}>
    {error ? <View style={{ padding: 16, gap: 12 }}><ErrorText text={error} /><Action soft label="Recarregar mídia" onPress={() => setRetry((value) => value + 1)} /></View> : !uri ? <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', gap: 12 }}><ActivityIndicator accessibilityLabel="Carregando mídia" color={colors.indigo} /><Txt color={colors.muted}>Carregando mídia…</Txt></View> : asset.kind === 'video' ? <Video key={`${asset.id}-${retry}`} uri={uri} onError={() => setError('O vídeo não carregou ou o link expirou. Tente recarregar.')} /> : <Image key={`${asset.id}-${retry}`} accessibilityLabel={label} source={{ uri }} style={{ width: '100%', height }} resizeMode="contain" onError={() => setError('A imagem não carregou ou o link expirou. Tente recarregar.')} />}
  </View>;
}
export function InstagramPreview({ post, client, assets, repository }: { post: Post; client: Client; assets: Asset[]; repository: Pick<Repository, 'assetUrl'> }) { const visible = post.mediaIds.map((id) => assets.find((asset) => asset.id === id) ?? { id, clientId: post.clientId, folderId: post.folderId, name: '', kind: post.mediaKinds?.[id] ?? (post.format === 'reels' || post.format === 'long_video' || post.format === 'vsl' ? 'video' as const : 'image' as const), size: 0 }); const [index, setIndex] = useState(0); const asset = visible[Math.min(index, Math.max(0, visible.length - 1))]; return <Card style={{ padding: 0, overflow: 'hidden' }}><View style={[ui.row, { padding: 12 }]}><Avatar name={client.name} size={32} /><View style={{ flex: 1 }}><Txt kind="strong">{client.handle || client.name}</Txt><Txt kind="micro" color={colors.muted}>Áudio original</Txt></View><MoreHorizontal size={20} color={colors.text} /></View>{asset ? <MediaDisplay key={asset.id} asset={asset} post={post} repository={repository} /> : <Info title="Sem mídia" text="Adicione uma imagem ou vídeo para conferir a publicação." />}{visible.length > 1 && <Tabs value={String(index)} options={visible.map((_, i) => ({ id: String(i), label: `${i + 1}/${visible.length}` }))} onChange={(value) => setIndex(Number(value))} />}<View style={{ padding: 16, gap: 12 }}><View style={ui.row}><Heart size={22} color={colors.text} /><MessageCircle size={22} color={colors.text} /><Send size={22} color={colors.text} /><View style={{ flex: 1 }} /><Bookmark size={22} color={colors.text} /></View><Txt><Txt kind="strong">{client.handle || client.name} </Txt>{post.caption || 'Sem legenda.'}</Txt><Txt kind="micro" color={colors.muted}>Prévia ilustrativa do Instagram · {displayDay(post.date)}</Txt></View></Card>; }
export type MainTab = 'home' | 'clients' | 'contents' | 'calendar' | 'more' | 'approvals';
export function BottomNav({ value, onChange, portal = false, hidden = [] }: { value: MainTab; onChange(tab: MainTab): void; portal?: boolean; hidden?: MainTab[] }) {
  const selection = useSelectionMotion(value);
  const items: { id: MainTab; label: string }[] = portal
    ? [{ id: 'home', label: 'Geral' }, { id: 'calendar', label: 'Calendário' }, { id: 'approvals', label: 'Aprovações' }]
    : [{ id: 'home', label: 'Início' }, { id: 'clients', label: 'Clientes' }, { id: 'contents', label: 'Conteúdos' }, { id: 'calendar', label: 'Calendário' }, { id: 'more', label: 'Mais' }];
  const visible = items.filter((item) => !hidden.includes(item.id));
  return <View role="tablist" {...selection.inputHandlers} style={{ flexDirection: 'row', padding: 8, minHeight: 68, backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border }}>
    <LiquidIndicator target={visible.some((item) => item.id === value) ? selection.target : null} color={colors.soft} radius={14} immediate={selection.immediate} revision={visible.map((item) => item.id).join(':')} />
    {visible.map(({ id, label }) => <Pressable key={id} {...({ onKeyDown: (event: KeyboardEvent<HTMLElement>) => navigateSelection(event, visible.map((item) => item.id), id, onChange) } as object)} tabIndex={value === id ? 0 : -1} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: value === id }} onLayout={(event) => selection.measure(id, event)} onPress={() => onChange(id)} style={{ flex: 1, height: 52, gap: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 14, zIndex: 2, backgroundColor: !selection.target && id === value ? colors.soft : 'transparent' }}><HugeIcon name={id === 'home' ? 'dashboard-square-01' : id === 'clients' ? 'user-group' : id === 'contents' ? 'file-01' : id === 'calendar' ? 'calendar-add-01' : id === 'approvals' ? 'tick-02' : 'more-horizontal'} size={20} color={id === value ? colors.indigo : colors.muted} trigger={value === id} /><Txt kind="micro" color={id === value ? colors.indigo : colors.muted}>{label}</Txt></Pressable>)}
  </View>;
}
export const statusIcons = { in_production: Clock, awaiting_approval: Clock, adjusting: Pencil, approved: Check, published: Check, cancelled: X };
