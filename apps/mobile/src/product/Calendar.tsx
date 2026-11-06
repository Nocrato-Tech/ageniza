import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Card, IconButton, Txt, ui, useColors } from './ui';
import type { Post } from './types';
import { statusNames } from '../contents/period';

function describeDay(date: string) { return new Date(`${date}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function describePosts(posts: Post[]) {
  const count = posts.length;
  const states = Object.entries(statusNames).flatMap(([status, name]) => { const total = posts.filter((post) => post.status === status).length; return total ? [`${total} ${name}`] : []; });
  return count ? `${count} ${count === 1 ? 'conteúdo' : 'conteúdos'} · ${states.join(' · ')}` : 'Nenhum conteúdo';
}
export function Calendar({ from, to, label, posts, onMonth, children, selectedDay, onSelectDay }: { from: string; to: string; label: string; posts: Post[]; onMonth(direction: number): void; children(day: string): React.ReactNode; selectedDay?: string; onSelectDay?(day: string): void }) {
  const colors = useColors();
  const [selected, setSelected] = useState('');
  const requested = selectedDay ?? selected;
  const validDay = (date: string) => date >= from && date <= to;
  const day = validDay(requested) ? requested : posts.find((post) => validDay(post.date))?.date ?? from;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const first = (new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7;
  const days = Array.from({ length: first + Number(to.slice(-2)) }, (_, index) => index < first ? null : `${from.slice(0, 8)}${String(index - first + 1).padStart(2, '0')}`);
  return <>
    <View style={[ui.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}><Txt kind="section">{label.charAt(0).toUpperCase() + label.slice(1)}</Txt><View style={{ flexDirection: 'row' }}><IconButton label="Mês anterior" icon={ChevronLeft} onPress={() => onMonth(-1)} /><IconButton label="Próximo mês" icon={ChevronRight} onPress={() => onMonth(1)} /></View></View>
    <Card style={{ padding: 4 }}>
      <View style={{ flexDirection: 'row', paddingVertical: 8 }}>{['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((text) => <View key={text} style={{ width: `${100 / 7}%`, alignItems: 'center' }}><Txt kind="label" color={colors.muted}>{text}</Txt></View>)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 }}>{days.map((date, index) => {
        const dayPosts = date ? posts.filter((post) => post.date === date) : [];
        const active = date === day;
        return <View key={date ?? index} style={{ width: `${100 / 7}%`, alignItems: 'center' }}>{date && <Pressable accessibilityRole="button" accessibilityLabel={`${describeDay(date)}${date === today ? ' · Hoje' : ''} · ${describePosts(dayPosts)}`} accessibilityState={{ selected: active }} aria-pressed={active} onPress={() => { if (selectedDay === undefined) setSelected(date); onSelectDay?.(date); }} style={{ width: '100%', minHeight: 56, gap: 2, borderRadius: 12, borderWidth: 1, borderColor: date === today ? colors.indigo : 'transparent', alignItems: 'center', justifyContent: 'center', backgroundColor: active ? colors.indigo : 'transparent' }}><Txt kind="strong" color={active ? colors.surface : colors.text}>{Number(date.slice(-2))}</Txt><Txt kind="micro" color={active ? colors.surface : colors.muted}>{dayPosts.length ? `${dayPosts.length} ${dayPosts.length === 1 ? 'item' : 'itens'}` : date === today ? 'Hoje' : ' '}</Txt></Pressable>}</View>;
      })}</View>
      <View style={{ padding: 8 }}><Txt kind="small" color={colors.muted}>O número de itens indica os conteúdos do dia. Hoje tem contorno; o dia selecionado tem fundo destacado.</Txt></View>
    </Card>
    <View style={{ gap: 4 }} accessibilityLiveRegion="polite"><Txt kind="section">{describeDay(day)}</Txt><Txt kind="small" color={colors.muted}>{describePosts(posts.filter((post) => post.date === day))}</Txt></View>
    {children(day)}
  </>;
}
