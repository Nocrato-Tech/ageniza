import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Card, IconButton, Txt, ui, colors } from './ui';
import type { Post } from './types';

export function Calendar({ from, to, label, posts, onMonth, children }: { from: string; to: string; label: string; posts: Post[]; onMonth(direction: number): void; children(day: string): React.ReactNode }) {
  const [selected, setSelected] = useState('');
  const day = selected.startsWith(from.slice(0, 7)) ? selected : posts[0]?.date ?? from;
  const first = (new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7;
  const days = Array.from({ length: first + Number(to.slice(-2)) }, (_, index) => index < first ? null : `${from.slice(0, 8)}${String(index - first + 1).padStart(2, '0')}`);
  return <><View style={[ui.row, { justifyContent: 'space-between' }]}><Txt kind="section">{label.charAt(0).toUpperCase() + label.slice(1)}</Txt><View style={{ flexDirection: 'row' }}><IconButton label="Mês anterior" icon={ChevronLeft} onPress={() => onMonth(-1)} /><IconButton label="Próximo mês" icon={ChevronRight} onPress={() => onMonth(1)} /></View></View><Card><View style={{ flexDirection: 'row' }}>{['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map((text, index) => <View key={index} style={{ width: `${100 / 7}%`, alignItems: 'center' }}><Txt kind="micro" color={colors.muted}>{text}</Txt></View>)}</View><View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 }}>{days.map((date, index) => <View key={index} style={{ width: `${100 / 7}%`, alignItems: 'center' }}>{date && <Pressable accessibilityRole="button" accessibilityLabel={`Dia ${date}`} accessibilityState={{ selected: date === day }} onPress={() => setSelected(date)} style={{ width: 40, height: 44, gap: 3, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: date === day ? colors.indigo : 'transparent' }}><Txt kind="label" color={date === day ? '#FFFFFF' : colors.text}>{Number(date.slice(-2))}</Txt>{posts.some((post) => post.date === date) && <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: date === day ? '#FFFFFF' : colors.violet }} />}</Pressable>}</View>)}</View></Card><Txt kind="section">{new Date(`${day}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</Txt>{children(day)}</>;
}
